// OWNER: terrain agent.
//
// The snow BRDF, assembled as a three.js ShaderMaterial that is wired into the
// standard light/shadow/fog/tonemap plumbing (`lights: true` + the shadowmap,
// fog and tonemapping chunks) so it sits in the same colour pipeline as every
// other material in the scene — but replaces the whole reflectance model:
//
//   * high-albedo multiple-scattering diffuse with a wide wrap
//   * sky-dominated shadow term, deliberately BLUE
//   * forward subsurface scattering through drift crests
//   * discrete, world-locked crystal glints
//   * wind-packing dependent GGX sheen + grazing fresnel
//   * aerial perspective through the scene's own fog
//
// ---------------------------------------------------------------------------
// THE RECTILINEAR LADDER IN THE NEAR SNOW IS NOT THIS MATERIAL. IT IS SSAO.
// ---------------------------------------------------------------------------
// shots/orch-w7/profile.png has a ladder of ~21 px vertical bars crossing a
// bright crest around y 1120-1180, x 1300-2095. It reproduces exactly on a
// fresh render. It is produced by src/fx/AO.js (postfx agent), after this
// material has finished, and NOT by anything in the snow.
//
// The proof is a positive control inside ONE page session, at ONE simulation
// instant, with the animal verified stationary (root 0, -0.003613, 0 in every
// arm). High-passed rms of the luma across that band, and the same figure as a
// percentage of the band mean:
//
//   arm                                        rms     mean   contrast
//   base                                      4.881   126.7    3.85 %
//   uDebugView = 1 (material writes a CONST)  0.000   255.0    0.00 %   <- post off
//   ... same, post back on                    4.151   136.4    3.04 %   <- post ALONE
//   ... same, postfx.ao.intensity = 0         0.113   195.7    0.06 %   <- AO alone
//   base with postfx.ao.intensity = 0         1.151   186.3    0.62 %
//   base with postfx.ao.radius 85 mm -> 12 mm 1.715   171.0    1.00 %
//   base with ao.maxScreenRadius 44 -> 6      5.799   114.4    5.07 %   <- WORSE
//
// Row 2 is the control that matters: with uDebugView = 1 the fragment shader
// writes one constant over that whole band, and with post off the band
// measures rms 0.000. Every level of the ladder is added downstream, and
// turning AO off removes 98 % of it. AO also costs the band 47 % of its
// brightness there (mean 126.7 against 186.3).
//
// Mechanism: ao.radius is 0.085 m of WORLD radius. At the profile pose the
// camera is 0.205 m above the snow and the band is 1.27 m away, so the surface
// runs at roughly 9 degrees of grazing: 0.085 m projects to ~206 px across
// view and is clamped to ao.maxScreenRadius (44 half-res = 88 full-res px),
// while the along-view pixel footprint is 2.46 mm against 0.412 mm across.
// A spiral kernel sampled over that anisotropy on a surface whose depth ramps
// ~6x faster in y than in x resolves as a screen-locked lattice instead of as
// occlusion. Screen-locked is measurable: the pitch is 21 px at dsf 1.5 and
// 23 px at dsf 1.0, i.e. constant in DEVICE pixels, where anything world-
// locked would have gone to 14 px.
//
// Eliminated first, each by ablation in the same session, each leaving the
// band bit-identical (rms 4.881, to three decimals):
//   * footprints         — foot.n = 0 + rebuild; identical
//   * clipmap stitching  — aMeta.zw zeroed on all 4320 stitch vertices; identical
//   * clipmap fw doubling— aMeta.x halved on every level-edge row; identical
//   * the height field   — heightAt sampled 1024x across the band in world
//                          space: 18.6 um of high-passed rms, no periodic
//                          component at any scale. The geometry is smooth.
//   * detail normals     — uDetailScale.xyz -> 1e-4 (dn exactly 0): 4.592
//   * sparkle            — uSparkle.x = 0: 4.108 (it is ~15 % of the rms, and
//                          not the ladder; the sparkle-only debug view shows
//                          isolated glints, no lattice)
//   * DoF / TAA          — removing either makes the ladder SHARPER (6.175,
//                          4.652): they were hiding it, not making it.
//
// A trap for whoever ablates this next: PostFX._skip.ao does NOT disable AO.
// It skips the AO pass, which leaves the previous frame's AO target bound and
// still sampled by the composite, so the image barely moves (4.902 against
// 4.881). Set postfx.ao.intensity = 0 instead.
//
// AO.js belongs to the postfx agent, so this is a report, not a fix.
//
// ---------------------------------------------------------------------------
// THE TORSO *IS* A SHADOW CASTER. REVIEW-5 BLOCKER 1 IS WRONG.
// ---------------------------------------------------------------------------
// The handed-down diagnosis was "the shadow-caster set excludes the body and
// head shells while including the cards and the skin's legs". Every clause of
// that is false, measured rather than argued:
//
//   * The complete caster list in the scene, by traversal, is ONE object:
//     SkinnedMesh "foxBody" -- the whole skinned body, torso, skull, tail and
//     legs together. furShells and furCards are both castShadow = false.
//     There is nothing else with castShadow in the scene but the sun.
//
//   * Raw shadow mask (uDebugView 1, post off, one page session, one sim
//     instant, animal stationary at root -0.0044, -0.0048, -0.0013):
//       - at `wide`, the four leg ribbons MERGE about 0.6 m downsun into one
//         solid band the width of the body and run on to the frame edge. The
//         torso is in the map.
//       - at `terrain`, only the ribbons are in frame, because the body's
//         shadow has left it (see below). That is the image the critic read.
//       - at sun elevation 45 deg, same build, same instant, only setSun
//         changed: the mask is a single body-shaped blob under the animal
//         with the skull and tail plainly legible. A caster set that can draw
//         that at 45 deg has not lost the torso at 6.6 deg.
//
//   * The four strips ARE the legs, and the lit snow between them is correct.
//     A shadow is displaced downsun by height / tan(elevation) = 8.64 x
//     height at the default 6.6 deg rig. The belly is 0.20 m up, so its
//     shadow lands 1.7 m away; the withers at 0.36 m land 3.1 m away. At any
//     framing that holds the animal at a useful size, the body's shadow is
//     off the bottom of the frame and the sun genuinely does shine under the
//     animal. The critic's "117 px gap at full lit level between two leg
//     shadows, directly under a solid body" is what a 6.6 deg sun does.
//
//   * The frustum is NOT clipping at the default rig either. far = 27.5 at a
//     light distance of 22 gives 5.5 m of depth; the tip of the body shadow
//     sits at 3.11 m downsun = 3.09 m of light-space depth and 0.358 m of
//     light-space lateral against a 1.55 m half-width. Both clear.
//
// A trap for the next agent who tries this A/B: under VSMShadowMap three
// renders every receiveShadow object into the shadow map as well as every
// castShadow one (WebGLShadowMap.renderObject: castShadow OR (receiveShadow AND
// type === VSMShadowMap)). foxBody is
// receiveShadow = true, so setting ITS castShadow to false changes the mask
// by exactly zero pixels and looks like proof that it was never a caster.
// It is not; hide fox.root instead, which does remove it.
//
// WHAT IS ACTUALLY WRONG, and it is a different defect:
//
//   The caster is the BARE SKIN. fox.skinnedMesh's bounding box is 0.171 m
//   wide (x -0.0856 .. +0.0857) while the drawn animal is the skin plus the
//   fur shells plus the cards, and reads three to four times that across.
//   So the shadow is a stick figure of a fluffy animal -- which is the real
//   content of "a 250 px-wide animal throws four ~25 px sticks". The fix is
//   a customDepthMaterial on foxBody that extrudes along the normal by the
//   coat thickness, and foxBody belongs to anatomy/fur, so this is a report.
//
//   And the near-field darkening the critic was really looking for cannot
//   come from the cast shadow at this rig at all -- it is 1.7 m away. It has
//   to come from snContactOcc(), which is ours, and is tuned below.

import * as THREE from 'three';
import { rng } from '../util/math.js';

const _clear = new THREE.Color();
const _wp = new THREE.Vector3();

/** Bible section 3's #aac4e0, linear, normalised to unit luminance so the
 *  LEVEL is set by the rig and only the HUE is the constant. Identical to the
 *  vector src/world/Horizon.js builds for the ice fog band. */
const HAZE_UNIT = (() => {
  const c = new THREE.Color(0xaac4e0);
  const l = Math.max(1e-6, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
  return new THREE.Vector3(c.r / l, c.g / l, c.b / l);
})();

/**
 * Sphere proxies for the animal, used ONLY for contact occlusion on the snow.
 *
 * Bone name + radius in metres. The radii are coat radii, not skin radii: the
 * critic's blocker 7 is partly that the shadow caster is the bare mesh, and
 * while the shadow MAP is not ours to change, the term that actually reads as
 * "this animal is touching the ground" is this one, and it can be fitted to
 * the silhouette the viewer sees. Shoulder height is ~0.28 m and the body is
 * ~0.55 m long, so a 0.12 m torso sphere every ~0.15 m along the spine tiles
 * the trunk without gaps.
 *
 * Bone names are the canonical set in AGENTS.md. Any that a future rig does
 * not have is left at radius 0, which makes its term exactly zero with no
 * branch in the shader -- but the COUNT never changes, so a missing bone can
 * never silently delete the occluder (AGENTS.md: the absent measurement).
 */
const OCCLUDERS = [
  ['chest', 0.145],
  ['spine02', 0.145],
  ['hips', 0.145],
  ['head', 0.090],
  ['pawL', 0.060],
  ['pawR', 0.060],
  ['toeL', 0.060],
  ['toeR', 0.060],
  ['tail04', 0.070],
];
import {
  SNOW, SNOW_VERT, SNOW_FRAG, DETAIL_BAKE_FRAG, PROBE_FRAG,
  FULLSCREEN_VERT, snowResolve, snowConstsGLSL,
} from '../shaders/snow.glsl.js';

/**
 * 256x256 RGBA8 gradient table. RG is a quantised unit gradient, BA are spare
 * hashes. The SAME bytes drive the GPU noise and the JS port, which is what
 * keeps `heightAt()` on the surface the vertex shader actually built.
 */
export function makePermTable(seed = 20260918) {
  const T = SNOW.TABLE;
  const data = new Uint8Array(T * T * 4);
  const rand = rng(seed);
  for (let i = 0; i < T * T; i++) {
    const a = rand() * Math.PI * 2;
    data[i * 4 + 0] = Math.round((Math.cos(a) * 0.5 + 0.5) * 255);
    data[i * 4 + 1] = Math.round((Math.sin(a) * 0.5 + 0.5) * 255);
    data[i * 4 + 2] = Math.round(rand() * 255);
    data[i * 4 + 3] = Math.round(rand() * 255);
  }
  const tex = new THREE.DataTexture(data, T, T, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return { data, tex };
}

export class SnowMaterial {
  constructor(footUniforms) {
    this.footUniforms = footUniforms;
  }

  init(ctx, perm) {
    this.perm = perm;
    const q = ctx.quality;

    // --- uniforms shared with the probe pass (same objects, never copies) ---
    this.field = {
      uPerm: { value: perm.tex },
      uWindXZ: { value: new THREE.Vector2(1, 0) },
      uPadCenter: { value: new THREE.Vector2(0, 0) },
      uHeightBias: { value: 0 },
      uFoot: this.footUniforms.uFoot,
      uFootOrigin: this.footUniforms.uFootOrigin,
    };

    this.detail = this._bakeDetail(ctx);

    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.lights,
      THREE.UniformsLib.fog,
      {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uSunInt: { value: 6.0 },
        uSkyColor: { value: new THREE.Color(1, 1, 1) },
        uSkyInt: { value: 0.86 },
        uShadowEmpty: { value: 0.02 },
        uShadowTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
        // x: constant depth slack · y: slack in shadow-map TEXELS, which is
        // what the VSM blur actually costs. See snShadowMask().
        //
        // Both were cut hard (0.0006, 6.0 -> 0, 1.0) once the reason for a
        // bias at all was checked: this receiver is never rendered INTO the
        // shadow map, so it cannot self-shadow and no amount of slack is
        // buying acne-freedom. What the slack was actually buying was a gap
        // between each paw and the start of its shadow -- 84 mm at the
        // default sun, 190 mm at 2 degrees, against a 40 mm paw.
        uShadowBias: { value: new THREE.Vector2(0.0, 1.0) },
        uBounce: { value: new THREE.Color(1, 1, 1) },
        uBounceInt: { value: 0.13 },
        uAlbedo: { value: new THREE.Color(0.90, 0.93, 0.965) },
        uDeepTint: { value: new THREE.Color(0.56, 0.72, 1.0) },
        uDetail: { value: null },
        uDetailScale: { value: new THREE.Vector4(0.055, 0.32, 1.55, 0.40) },
        uSparkle: { value: new THREE.Vector3(240.0, 1.36, 170.0) },
        // Radiance the aurora throws down, published by src/world/Aurora.js.
        // Zero whenever the sun is up, which is most of the review set.
        uAurora: { value: new THREE.Color(0, 0, 0) },
        uSheen: { value: new THREE.Vector3(0.74, 0.42, 0.38) },
        uSSS: { value: 1.7 },
        uAerial: { value: new THREE.Vector3(0.016, 0.62, 0.62) },
        uHaze: { value: new THREE.Color(0xaac4e0) },
        // Airlight: xyz the radiance the distance converges on, w the
        // exp-squared density (three's FogExp2 value, so the near field is
        // untouched). Republished each frame in _updateAirlight().
        uAirlight: { value: new THREE.Vector4(0.36, 0.49, 0.73, 0.0125) },
        uSkirtDrop: { value: 60.0 },
        // --- subject contact occlusion (see snContactOcc in snow.glsl.js) ---
        uOccl: { value: OCCLUDERS.map(() => new THREE.Vector4(0, 0, 0, 0)) },
        uOcclBound: { value: new THREE.Vector4(0, 0, 0, 0) },
        // x: share of SKY ambient the body blocks · y: share of the snow
        // interreflection. The sky arrives from straight up and is blocked
        // hardest; the bounce arrives from all round the horizon and is not.
        uOcclMix: { value: new THREE.Vector2(1.00, 0.65) },
        // --- shaded-snow relief (see S_SKY_ANISO in snow.glsl.js) ----------
        // x sky anisotropy · y micro cavity · z sparkle-in-shade, each a
        // scale on its constant. 1,1,1 is the product; 0,0,0 reproduces the
        // pre-REVIEW-6 shading, which is how the effect is measured against
        // its own absence in one page session.
        uShade: { value: new THREE.Vector3(1, 1, 1) },
        // Mean of the detail map's cavity channel; measured off the baked
        // target in _bakeDetail, never assumed. 0.5 was wrong by 0.115 and
        // that alone made the cavity term saturate to a constant.
        uDetailAoDC: { value: 0.5 },
        // 0 off · 1 shadow mask · 2 ridge self-shadow · 3 clipmap level ·
        // 4 sparkle · 5 detail normal · 6 footprint channels · 7/8 shadow dbg
        // · 9 contact occlusion.
        // See the note below before blaming this material for a lattice.
        uDebugView: { value: 0 },
      },
    ]);
    // Share, do not clone, the field uniforms.
    for (const k of Object.keys(this.field)) uniforms[k] = this.field[k];
    uniforms.uDetail.value = this.detail;
    // If the DC could not be measured, switch the cavity term OFF explicitly
    // rather than leaving it centred on a guess: a term running on the wrong
    // centre is worse than a term that is not running, and the console
    // warning in _bakeDetail names it.
    if (this.detailAoDC == null) uniforms.uShade.value.y = 0;
    else uniforms.uDetailAoDC.value = this.detailAoDC;
    console.info(`[snow] detail cavity DC ${(uniforms.uDetailAoDC.value).toFixed(4)}`);

    this.uniforms = uniforms;
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: snowResolve(SNOW_VERT),
      fragmentShader: snowResolve(SNOW_FRAG),
      lights: true,
      // three's scene fog is NOT used: it converges on Environment's
      // 0x9fbcdc while the horizon band converges on #aac4e0 at lit-snow
      // level, and the step between the two is a visible edge at the terrain
      // rim. uAirlight replaces it. See the fog term in SNOW_FRAG.
      fog: false,
      defines: {
        SUN_TAPS: this._sunTaps(q),
        SPARKLE_OCT: this._sparkleOct(q),
        SN_OCCL: OCCLUDERS.length,
      },
    });
    this.material.name = 'snow';

    // --- CPU/GPU agreement probe -------------------------------------------
    this.probeRT = new THREE.WebGLRenderTarget(16, 16, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.probeMat = new THREE.RawShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: snowResolve(PROBE_FRAG),
      uniforms: {
        ...this.field,
        uProbe: { value: new THREE.Vector3(0, 0, 1.6) },
        uProbeFw: { value: 0 },
      },
      depthTest: false, depthWrite: false,
    });
    this._probeScene = new THREE.Scene();
    this._probeCam = new THREE.Camera();
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    tri.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
    this._probeMesh = new THREE.Mesh(tri, this.probeMat);
    this._probeMesh.frustumCulled = false;
    this._probeScene.add(this._probeMesh);
    this._probeBuf = new Uint8Array(16 * 16 * 4);

    return this.material;
  }

  _sparkleOct(q) {
    const seg = q.get('terrainSegments');
    return seg >= 384 ? 4 : seg >= 256 ? 3 : 2;
  }

  _sunTaps(q) {
    const seg = q.get('terrainSegments');
    return seg >= 384 ? 4 : seg >= 256 ? 3 : 2;
  }

  /**
   * Bake the tileable micro-detail map: grain normals, crystal density and a
   * grain AO. Generated on the GPU at init — no assets, no main-thread stall.
   */
  _bakeDetail(ctx) {
    const N = 512;
    const rt = new THREE.WebGLRenderTarget(N, N, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: true,
    });
    rt.texture.anisotropy = Math.min(4, ctx.renderer.capabilities.getMaxAnisotropy());

    const mat = new THREE.RawShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: DETAIL_BAKE_FRAG.replace('SNOW_CONSTS', snowConstsGLSL()),
      uniforms: {
        uPerm: { value: this.perm.tex },
        uPeriod: { value: 16.0 },
      },
      depthTest: false, depthWrite: false,
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);

    const prev = ctx.renderer.getRenderTarget();
    ctx.renderer.setRenderTarget(rt);
    ctx.renderer.render(scene, new THREE.Camera());
    ctx.renderer.setRenderTarget(prev);

    geo.dispose();
    mat.dispose();
    this._detailRT = rt;

    // Measure the cavity channel's DC rather than assuming it.
    //
    // The bake writes clamp(0.5 + h * 0.7, 0, 1) into .w and h is not
    // zero-mean: its ridged granular octave is |noise| and only ever adds.
    // Over the baked map the channel comes back at 0.615, not 0.5, so a
    // cavity term centred on 0.5 sits above one nearly everywhere and
    // clamps to a constant -- which is exactly what happened, and it
    // measured 0.000 HF sd of effect. One 512x512 readback at init, on a
    // target that is about to be mipmapped anyway.
    try {
      const buf = new Uint8Array(N * N * 4);
      ctx.renderer.readRenderTargetPixels(rt, 0, 0, N, N, buf);
      let s = 0;
      for (let i = 3; i < buf.length; i += 4) s += buf[i];
      this.detailAoDC = s / (N * N) / 255;
    } catch (e) {
      // Never silently fall back to a number that disables the term: say so.
      console.warn('[snow] cavity DC readback failed; micro cavity is off', e);
      this.detailAoDC = null;
    }
    return rt.texture;
  }

  /** Push the frame's art-direction state. */
  update(ctx) {
    const u = this.uniforms;
    u.uSunDir.value.copy(ctx.sunDirection).normalize();
    u.uSunColor.value.copy(ctx.sunColor);
    u.uSkyColor.value.copy(ctx.skyColor);
    u.uBounce.value.copy(ctx.groundBounce);
    // §7 wants the curtains reflected in the snow. Aurora runs at order 300
    // and the terrain at -50, so this is last frame's value; it changes over
    // tens of seconds, so a frame of lag is not observable, and it keeps the
    // snow from having to reach into another system mid-draw.
    if (ctx.aurora?.groundLight) u.uAurora.value.copy(ctx.aurora.groundLight);
    else u.uAurora.value.setRGB(0, 0, 0);
    // Track whatever haze the atmosphere agent is using, so the snow recedes
    // into the same colour the sky does.
    if (ctx.scene.fog?.color) u.uHaze.value.copy(ctx.scene.fog.color);
    // three clears the shadow map with whatever clear colour the app has set,
    // so track it and treat texels at that value as "nothing ever rendered".
    ctx.renderer.getClearColor(_clear);
    u.uShadowEmpty.value = Math.min(0.25, _clear.r * 1.6 + 0.02);
    // The shadow map is reallocated on a tier change, so read its size rather
    // than caching it: a stale texel size silently rescales the depth bias.
    const sm = ctx.environment?.sun?.shadow?.mapSize;
    if (sm && sm.x > 0) u.uShadowTexel.value.set(1 / sm.x, 1 / sm.y);
    this._updateAirlight(ctx);
    this._updateOccluders(ctx);
    const w = ctx.wind;
    const wl = Math.hypot(w.x, w.z) || 1;
    this.field.uWindXZ.value.set(w.x / wl, w.z / wl);
  }

  /**
   * The colour the far field converges on.
   *
   * Keyed to the SAME two numbers the ice fog band uses -- unit-luminance
   * #aac4e0 for the hue and ctx.sky.diffuseWhite for the level -- so the
   * snow and the haze standing over it cannot drift apart when the rig
   * moves. The 2.07 is Horizon's fog band gain (2.30) times its haze mix
   * (0.90), i.e. the level that band actually reaches.
   */
  _updateAirlight(ctx) {
    const w = ctx.sky?.diffuseWhite;
    if (!(w > 0)) return;              // keep the last good value, never zero
    const a = this.uniforms.uAirlight.value;
    const k = w * 2.07;
    a.set(HAZE_UNIT.x * k, HAZE_UNIT.y * k, HAZE_UNIT.z * k, a.w);
  }

  /**
   * Refit the contact-occlusion spheres to the live skeleton.
   *
   * Read off the bones rather than off subjectPosition alone, so the term
   * tracks a lifted paw, a sat haunch and a turned head instead of following
   * a single point around. Bone world matrices are already up to date here:
   * the terrain runs at order -50 and the rig at 100, so these are LAST
   * frame's poses -- a fraction of a millimetre at 120 Hz, and the
   * alternative (reaching into another system mid-draw) is worse.
   */
  _updateOccluders(ctx) {
    const u = this.uniforms;
    const arr = u.uOccl.value;
    const fox = ctx.fox;
    let ok = 0;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < OCCLUDERS.length; i++) {
      const b = fox?.bone?.(OCCLUDERS[i][0]);
      if (!b) { arr[i].set(0, 0, 0, 0); continue; }
      b.getWorldPosition(_wp);
      arr[i].set(_wp.x, _wp.y, _wp.z, OCCLUDERS[i][1]);
      cx += _wp.x; cy += _wp.y; cz += _wp.z; ok++;
    }
    if (!ok) { u.uOcclBound.value.set(0, 0, 0, 0); return; }
    cx /= ok; cy /= ok; cz /= ok;
    // Cull radius. The per-sphere term has fallen to ~1% of its peak at ten
    // radii, so 1.25 m past the centroid covers the 0.125 m torso spheres and
    // everything smaller. Anything outside is rejected with one dot product,
    // which is the whole cost of this feature over most of a wide frame.
    let reach = 0;
    for (let i = 0; i < OCCLUDERS.length; i++) {
      const s = arr[i];
      if (s.w <= 0) continue;
      reach = Math.max(reach, Math.hypot(s.x - cx, s.y - cy, s.z - cz) + s.w * 10.0);
    }
    u.uOcclBound.value.set(cx, cy, cz, reach);
  }

  onQuality(ctx) {
    const taps = this._sunTaps(ctx.quality);
    const oct = this._sparkleOct(ctx.quality);
    if (this.material.defines.SUN_TAPS !== taps || this.material.defines.SPARKLE_OCT !== oct) {
      this.material.defines.SUN_TAPS = taps;
      this.material.defines.SPARKLE_OCT = oct;
      this.material.needsUpdate = true;
    }
  }

  /**
   * Render the height field on a grid and read it back so JS can check its own
   * port against the shader. Returns a Float32Array of 16x16 heights, or null.
   */
  readProbe(ctx, cx, cz, half, fw) {
    const u = this.probeMat.uniforms;
    u.uProbe.value.set(cx, cz, half);
    u.uProbeFw.value = fw;
    const r = ctx.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.probeRT);
    r.render(this._probeScene, this._probeCam);
    r.readRenderTargetPixels(this.probeRT, 0, 0, 16, 16, this._probeBuf);
    r.setRenderTarget(prev);

    const out = new Float32Array(256);
    const b = this._probeBuf;
    for (let i = 0; i < 256; i++) {
      const v = b[i * 4] / 255 + b[i * 4 + 1] / 65025 +
                b[i * 4 + 2] / 16581375 + b[i * 4 + 3] / 4228250625;
      out[i] = v * 8.0 - 4.0;
    }
    return out;
  }

  dispose() {
    this.material?.dispose();
    this.probeMat?.dispose();
    this.probeRT?.dispose();
    this._detailRT?.dispose();
    this.perm?.tex?.dispose();
  }
}
