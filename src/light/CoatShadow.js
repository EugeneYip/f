import * as THREE from 'three';
import { REGION_COUNT, CARD_SHAPE } from '../shaders/fur.glsl.js';
import { HASH, WORLEY3 } from '../shaders/noise.glsl.js';

/**
 * THE LOCK LATTICE THE SHADOW USES IS COARSER THAN THE COAT'S, ON PURPOSE.
 *
 * `CARD_SHAPE.clumpCell` is 16 mm: that is the lattice the cards clump on and
 * the scale of one lock on the animal. A 16 mm lock cannot throw a legible
 * shadow at this rig and the reason is physics, not the renderer. The sun
 * subtends 0.53 degrees, so a feature casting from distance d is blurred by
 * `d * 0.0093`; at a 6.6 degree sun the flank's shadow lands 2.6 m away and
 * the head's 3.9 m, which is 24 - 36 mm of penumbra. A 16 mm lock is smaller
 * than its own penumbra there and averages out to nothing. The VSM blur adds
 * to that: `shadow.radius` 4.5 over a 3.1 m frustum at 3072 is +-4.5 mm.
 *
 * What DOES survive at metre distances is the group — the ridge of several
 * locks that reads as one tuft. 32 mm is two lock cells, the smallest feature
 * that is still larger than the penumbra that erases it.
 */
const TUFT_CELL = CARD_SHAPE.clumpCell * 2.0;        // metres

/**
 * Peak-to-parting relief, as a fraction of the local coat depth.
 *
 * Not a look knob: `CARD_SHAPE.reachBand` is [1.10, 1.25], i.e. the drawn
 * guard hair stands 10-25 % past the shell tip the hull is built on, and the
 * partings between locks fall back to roughly the undercoat. 0.30 spans that
 * band and no more — 14 mm on the 47 mm flank, 20 mm on the 67 mm tail-mid.
 * Anything larger would be a shadow of an animal we do not draw.
 */
const TUFT_AMP = 0.30;

/**
 * Mean of the dome profile below, so the relief is zero-mean and the mean
 * extrusion — and therefore the width of the shadow — is left where it was.
 * Verified in image space rather than trusted: `measure()` reports the mean
 * offset with the relief on and off, and the probe reports the shadow's
 * pixel area, which must not fall.
 */
const TUFT_DC = 0.496;

/** Dome half-widths in Worley-F1 units. See TUFT_DC. */
const TUFT_LO = 0.24;
const TUFT_HI = 0.80;


/**
 * How far past the hull the guard-hair TIPS reach, as a fraction of the local
 * coat depth, and the two lattices the fringe layer is built on.
 *
 * Bounded by the fur system's own numbers, not chosen by eye:
 * CARD_SHAPE.reachBand is [1.10, 1.25] of the coat and uCardFloor may add up
 * to CARD_SHAPE.standFloorMax = 12 mm on top, so on the 47 mm flank the drawn
 * guard hair stands at 1.25 x 47 + 12 = 71 mm, i.e. 1.5 L. The fringe tips
 * here reach 1.42 L at the tallest lock. That is INSIDE what we draw, which
 * is the whole point: a shadow may not be hairier than the animal.
 */
const FRINGE_TIP = 1.42;

/**
 * Where the coat stops being OPAQUE, as a fraction of the shell-tip depth.
 *
 * The solid core cannot be the whole coat. A silhouette is a max over the
 * grazing strip, so a continuous hull's outline is smooth however much
 * relief is on it -- which means whatever radius the SOLID layer sits at is
 * where the smooth part of the shadow's outline lands. Putting the solid
 * layer at the shell tip therefore guarantees a smooth outline no matter
 * what the fringe does outside it.
 *
 * 0.82 is where the coat is actually opaque. The shells run 18 deep at high
 * and their alpha accumulates, so the outer fifth of the stack is mostly
 * air and guard hair; the drawn animal's own coverage matte falls off over
 * roughly that band. Below it the undercoat is solid. So the outer 0.60 L
 * -- from 0.82 to the 1.42 L tips -- is carried by the stochastic layer,
 * and that is the band the shadow's outline now falls in.
 */
const CORE_FRAC = 0.82;

/**
 * WHY THESE LATTICES ARE COARSE, MEASURED RATHER THAN CHOSEN.
 *
 * The first version put the tufts on the cards' own 16 mm lock cell and the
 * pores on 8 mm, and the result was a soft grey halo with no structure in it:
 * the partial-occlusion band doubled (hero 0.019 -> 0.038 of the collar) and
 * the boundary's own wiggle moved 0.3 px. Two low-pass filters sit between a
 * caster feature and the snow, and both are larger than a lock:
 *
 *   - the VSM blur, shadow.radius 4.5 over a 3.1 m frustum at 3072, is
 *     +-4.5 mm in light space, a 9 mm kernel;
 *   - the sun subtends 0.53 deg, so a caster 2-4 m from its own shadow is
 *     blurred by 19-37 mm and nothing smaller than that survives at all.
 *
 * There is a second reason, and it is the one that actually decides the
 * shape. A silhouette is a MAX over the grazing strip of the surface, not a
 * sample of it, so random relief on a CONTINUOUS hull produces a smooth
 * envelope no matter how large the relief is -- which is exactly what the
 * measurements showed: 0.42 L of peak-to-peak relief on the hull moved the
 * boundary's own wiggle by 0.3 px at hero. Only HOLES break a silhouette,
 * and a hole has to be bigger than the blur to still be a hole when it
 * lands. Hence: tufts on a 40 mm lattice, pores on 28 mm, both comfortably
 * over the 9 mm kernel and on the order of the sun's own 19-37 mm penumbra
 * at this rig.
 *
 * AND THE PORES ARE ALIGNED WITH THE LIGHT RAY, not with the surface.
 *
 * This is the part that actually made it work. A hole punched in a shell
 * that is nearly TANGENT to the light does not let the ray past: the ray
 * skims along the inside and the shell closes over it again a few
 * centimetres later. The arc of surface feeding one light-space texel at
 * lateral offset d inside a radius-R silhouette is sqrt(2 R d) long, which
 * for R = 0.12 m and a 28 mm pore is 82 mm -- three pores long. So a
 * bind-space pore field cannot open the silhouette at all, whatever its
 * size, and the measurements said so.
 *
 * Evaluating the field in the plane PERPENDICULAR to the light instead makes
 * every hole a tube that runs all the way through the layer, so a hole is a
 * hole. It is still welded to the animal -- the coordinate is the bind
 * position with its along-ray component removed, and the ray is the sun in
 * bind space -- so it does not crawl frame to frame; it re-shuffles only
 * when the animal turns relative to the sun, which is when a different set
 * of hairs really would be doing the occluding.
 */
const FRINGE_CELL = CARD_SHAPE.clumpCell * 2.5;       // 40 mm
const PORE_CELL = CARD_SHAPE.clumpCell * 1.75;        // 28 mm
const PORE_OFFSET = 3.77;                             // decorrelate the lattices

/**
 * THE ANIMAL'S SHADOW IS CAST BY ITS SKIN, NOT ITS COAT.
 *
 * Measured, not argued. The complete caster set in this scene is ONE object:
 * the SkinnedMesh `foxBody` -- torso, skull, tail and legs in a single skinned
 * mesh. `furShells` and `furCards` are both castShadow = false, and nothing
 * else in the scene casts at all. So the shadow is the silhouette of the bare
 * skin, whose bounding box is **0.171 m wide**, while the drawn animal is that
 * skin plus a coat that measures up to **52.9 mm deep** on top of it. The
 * drawn animal reads three to four times wider than the shadow it throws,
 * which is the real content of the critic's "a 250 px animal throws four 25 px
 * sticks".
 *
 * The fix is not to make the shells cast. Nineteen alpha-stochastic shells in
 * a variance shadow map would be nineteen extra shadow draws of the whole
 * animal for a mask that dithers, and VSM stores moments -- a stochastic
 * caster writes noise into the variance and the penumbra falls apart. The fix
 * is to give `foxBody` a customDepthMaterial that extrudes the skin outwards
 * by the coat depth, so the depth pass draws the OUTER surface of the coat
 * while the beauty pass keeps drawing the skin under it.
 *
 * ## The extrusion is the coat depth field, not a constant
 *
 * The coat is not uniform and a uniform offset would be wrong in both
 * directions at once. ART_DIRECTION 4f gives the flank at 48 mm inside a
 * sourced 40-60 mm band, 4h restates the muzzle as "whatever is needed for no
 * bare skin to show" (the anatomy agent measured 8 mm there against a 26 mm
 * skull), and the one properly sourced fact about regional depth is a RANKING
 * (Underwood & Reynolds via Prestrud 1991): deepest at the lateral trunk and
 * lower leg, shallowest at the head, distal legs and belly. A constant would
 * flatten exactly the gradient the art direction is built on.
 *
 * So this reads the SAME field the shells draw with, vertex for vertex:
 *
 *     L = furLength * uCoatScale * uRegionA[region].y * crush
 *
 * `furLength` is the anatomy agent's per-vertex coat thickness attribute,
 * `uCoatScale` and `uRegionA[].y` are the fur agent's global and per-region
 * multipliers, and `crush` is the impact compression the coat already gets on
 * a landing. All three uniform OBJECTS are shared with the fur system by
 * reference, not copied, so a tier change or a gallop landing moves the shadow
 * and the coat together by construction -- there is no second copy of the
 * number to drift.
 *
 * The tangential `lay` shear is included for the same reason: the outermost
 * shell is at `nb * L + tb * L * lay`, not `nb * L`, and the hair lying down
 * along the flow is a real part of where the outer surface is.
 *
 * Measured coat depth per region, in mm, from the fur agent's own probe:
 *   nose 1.6 - muzzle 14.6 - jaw 14.1 - cheek 33.2 - forehead 16.6 -
 *   skull 38.3 - throat 33.0 - neck 43.7 - ruff 45.0 - chest 42.2 -
 *   shoulder 41.5 - back 43.0 - flank 47.4 - belly 22.2 - croup 43.8 -
 *   haunch 42.9 - legFU 37.6 - legFL 21.2 - pawF 23.2 - hock 16.8 -
 *   tailBase 51.4 - tailMid 67.1 - tailTip 48.0
 *
 * ## Two traps, both of which have already cost an agent a round here
 *
 * 1. Under `VSMShadowMap`, three renders every `receiveShadow` object into the
 *    shadow map as well as every `castShadow` one (WebGLShadowMap.renderObject:
 *    `castShadow || (receiveShadow && type === VSMShadowMap)`). `foxBody` is
 *    receiveShadow = true, so clearing its `castShadow` moves the shadow mask
 *    by exactly zero pixels and looks like proof it was never the caster. To
 *    take the animal out of the map you must hide `fox.root`.
 *
 * 2. Nothing on the animal samples the shadow map -- the fur base, shell and
 *    card materials carry no shadowmap chunk -- so inflating the caster cannot
 *    produce self-shadow acne on the fox. The only receiver is the snow, via
 *    `snShadowMask()` in snow.glsl.js. That is why this is safe to do at full
 *    coat depth rather than at some fraction of it.
 *
 * ## And the hull alone still threw a shadow with no hair in it
 *
 * The extrusion above fixed the shadow's WIDTH and REVIEW-6 blocker 6 is
 * what was left: the outline of that shadow is a vector curve. Measured on
 * the raw mask (uDebugView 1, post off, tone mapping off, everything but the
 * terrain and the animal hidden): the boundary's RMS wiggle about a
 * 31-scanline moving average is 0.23 px at terrain, 0.42 px at hero and
 * 0.73 px at paws, over 280-1560 scanlines, and the 0.92 -> 0.08 ramp is
 * 3 px wide. A ruler, in other words, around an animal whose own outline is
 * a mass of spikes.
 *
 * Relief on the hull cannot fix that and the reason is geometric: a
 * silhouette is a MAX over the grazing strip of a surface, not a sample of
 * it, so a continuous hull has a smooth envelope however lumpy it is. 0.42 L
 * of peak-to-peak relief moved the boundary 0.3 px. What breaks a silhouette
 * is HOLES, so the caster is now TWO depth layers:
 *
 *   - the CORE, this material, solid, at CORE_FRAC = 0.82 of the coat --
 *     where the undercoat is actually opaque;
 *   - the FRINGE, a second SkinnedMesh over the same geometry and skeleton
 *     drawn only into the shadow map, reaching the 1.42 L guard-hair tips
 *     and alpha-tested into separate tufts.
 *
 * A hole in the fringe falls back to the core's depth rather than to no
 * caster at all, so the outer 0.60 L of the silhouette is stochastic and the
 * body never leaks light. See the FRINGE block below for why the lattices
 * are coarse and why the pores are aligned with the light ray.
 *
 * Owns nothing but the depth material and that second mesh: `foxBody`, its
 * geometry and the fur uniforms all belong to other agents and are only READ
 * here.
 */

/** Extra attributes and uniforms the stock depth shader does not declare. */
const COAT_PARS = /* glsl */ `
attribute float furLength;
attribute float furStiffness;
attribute vec3  furTangent;
attribute float region;
uniform float uCoatScale;
uniform float uLay;
uniform float uCoatCompress;
uniform float uCoatSquash;
uniform float uCoatShadow;
uniform float uCoatTuft;
uniform float uHullFrac;
uniform vec4  uRegionA[${REGION_COUNT}];
${HASH}
${WORLEY3}

/**
 * Lock-group relief on the coat hull, zero-mean, in units of the local coat
 * depth. Evaluated in BIND space so it is welded to the animal: it must not
 * swim when the tail swings or the sun moves, or the shadow crawls.
 *
 * NO BACKTICKS IN THIS COMMENT: it is inside a template literal and one
 * would close the string tens of lines from where the error is reported.
 * (AGENTS.md; this has now cost the project seven build breaks.)
 *
 * dome is one tuft -- 1 at the Worley site, 0 in the parting. lockLen gives
 * each tuft its own length draw, the same idea as the cards' lenMul, so the
 * ridge line is not a field of identical bumps.
 */
float coatTuft(vec3 bindPos){
  vec3 cid;
  vec2 wf = worley3(bindPos * ${(1 / TUFT_CELL).toFixed(4)}, cid);
  float dome = 1.0 - smoothstep(${TUFT_LO.toFixed(3)}, ${TUFT_HI.toFixed(3)}, wf.x);
  float lockLen = 0.55 + 0.90 * hash13(cid + 11.7);
  return lockLen * dome - ${TUFT_DC.toFixed(3)};
}
`;

/**
 * Object-space offset from the skin to the outer surface of the coat.
 *
 * Injected immediately after begin_vertex, i.e. BEFORE skinning_vertex, so the
 * offset is skinned along with the vertex exactly as the shell shader does it
 * (see furVertexShader: sk * vec4(position + offB, 1.0)). Injecting it after
 * skinning would rotate the coat off the body on every bent joint.
 *
 * uCoatShadow is the A/B lever: 0 reproduces the old skin-only caster to the
 * pixel, 1 is the full measured coat. It is a uniform rather than a define so
 * an A/B costs no recompile and cannot accidentally compare two programs.
 */
const COAT_OFFSET_HEAD = /* glsl */ `
{
  int  ri = int(clamp(region, 0.0, ${REGION_COUNT - 1}.0) + 0.5);
  vec4 ra = uRegionA[ri];
  float crush = clamp(1.0 - uCoatCompress * uCoatSquash, 0.62, 1.30);
  float L = furLength * uCoatScale * ra.y * crush * uCoatShadow;
  float soft = 1.0 - furStiffness;
  float lay = uLay * ra.z * (0.30 + 1.05 * soft);
  float Lc = L * uHullFrac;
  // A smooth hull throws a shadow whose outline is a vector curve: measured
  // at 0.23 px RMS of wiggle over 610 scanlines at the terrain pose, against
  // a coat whose own outline is a mass of spikes. This is the lock relief,
  // zero-mean so the shadow does not get narrower, and capped by the fur
  // system's own reach band so it is not a shadow of an animal we do not
  // draw. uCoatTuft is the named A/B lever: 1 ships, 0 is the smooth hull.
  float relief = 1.0 + uCoatTuft * ${TUFT_AMP.toFixed(3)} * coatTuft(position);
  L *= relief; Lc *= relief;
  transformed += normalize(normal) * Lc + furTangent * (Lc * lay);
`;

const COAT_OFFSET_TAIL = /* glsl */ `
}
`;

/* ------------------------------------------------------------------ fringe --
 * A SECOND depth layer at the guard-hair tips, alpha-tested into tufts.
 *
 * Why a second draw and not holes in the first one: a hole in the only layer
 * is a hole through the ANIMAL, and at a 6.6 degree sun almost the whole
 * dorsal surface is near-tangent to the light, so any silhouette test that
 * uses N.L classifies the entire back as rim and dapples light straight
 * through the torso. With two layers the core stays solid and the porous
 * layer only ever ADDS occlusion outside it -- a hole in the fringe falls
 * back to the core's depth, 14 mm further in, so it costs a wobble in the
 * outline and never a leak through the body.
 */
const FRINGE_PARS = /* glsl */ `
varying vec4 vFrng;         // xyz bind position, w the lock's own tip draw
uniform float uFringe;      // 1 ships; 0 collapses this layer onto the core
`;

const FRINGE_VERT = /* glsl */ `
{
  vec3 lid;
  vec2 lw = worley3(position * ${(1 / FRINGE_CELL).toFixed(4)}, lid);
  float ldome = 1.0 - smoothstep(${TUFT_LO.toFixed(3)}, ${TUFT_HI.toFixed(3)}, lw.x);
  float ldraw = (0.35 + 0.65 * hash13(lid + 4.31)) * ldome;
  vFrng = vec4(position, ldraw);
  transformed += normalize(normal) * (L * ${(FRINGE_TIP - CORE_FRAC).toFixed(3)} * uFringe * ldraw);
}
`;

const FRINGE_FRAG_PARS = /* glsl */ `
varying vec4 vFrng;
uniform float uFringe;
uniform vec3  uLightBind;   // sun direction in the body's own bind space
`;

/*
 * Punch the tips into strands. The cut rises with the lock's tip draw, so the
 * base of the fringe is nearly solid and only the far tips are open -- which
 * is the density profile of real hair and the reason the boundary comes out
 * graded instead of stepped.
 *
 * Deliberately NOT a screen-space dither. A stochastic per-pixel alpha in a
 * variance shadow map writes noise into the second moment and the penumbra
 * falls apart; this pattern is welded to bind space, so it is the same holes
 * in the same places every frame and the moments stay clean.
 */
const FRINGE_FRAG = /* glsl */ `
{
  // Drop the along-ray component: every hole becomes a tube through the
  // layer instead of a puncture the ray skims past. See the note above.
  vec3 q = vFrng.xyz - uLightBind * dot(vFrng.xyz, uLightBind);
  vec3 pid;
  vec2 pw = worley3(q * ${(1 / PORE_CELL).toFixed(4)} + ${PORE_OFFSET.toFixed(2)}, pid);
  float strand = 1.0 - smoothstep(0.18, 0.72, pw.x);
  float cut = mix(0.04, 0.58, clamp(vFrng.w, 0.0, 1.0));
  if (uFringe > 0.001 && strand < cut) discard;
}
`;

const NEEDED = ['furLength', 'furStiffness', 'furTangent', 'region'];
const _m4 = new THREE.Matrix4();

export class CoatShadow {
  name = 'coatShadow';
  order = 260;            // after fox (0) and fur (200) have published

  init(ctx) {
    this.ctx = ctx;
    this.installed = false;
    this.scale = 1.0;
    this.tuft = 1.0;        // ships ON; 0 is the smooth hull
    this.fringe = 1.0;      // ships ON; 0 collapses the tips onto the core
    this.report = { ok: false, reason: 'not initialised' };

    const fox = ctx.fox;
    const fur = ctx.fur;
    const mesh = fox?.skinnedMesh;
    if (!mesh) { this._fail('no ctx.fox.skinnedMesh'); return; }

    // An unmeasurable input is a hard failure with a name, never a silent
    // skip: a coat shadow that quietly did not install would look exactly
    // like the defect it exists to fix.
    const g = mesh.geometry;
    const missing = NEEDED.filter((a) => !g.getAttribute(a));
    if (missing.length) {
      this._fail(`foxBody geometry is missing ${missing.join(', ')} — the ` +
        'coat depth field cannot be read, so the shadow stays skin-shaped');
      return;
    }
    const fu = fur?.uniforms;
    if (!fu?.uCoatScale || !fu?.uRegionA) {
      this._fail('fur system published no uCoatScale/uRegionA — there is no ' +
        'coat depth field to extrude by, so the shadow stays skin-shaped');
      return;
    }

    this.uCoatShadow = { value: this.scale };
    this.uCoatTuft = { value: this.tuft };
    this.uHullFrac = { value: CORE_FRAC };
    this.uFringe = { value: this.fringe };
    this.uLightBind = { value: new THREE.Vector3(0, 0, 1) };

    // SHARE the fur uniform objects rather than copying their values: a tier
    // change or a landing must move the shadow and the coat together.
    const bindFur = (shader) => {
      shader.uniforms.uCoatScale = fu.uCoatScale;
      shader.uniforms.uLay = fu.uLay;
      shader.uniforms.uCoatCompress = fu.uCoatCompress;
      shader.uniforms.uCoatSquash = fu.uCoatSquash;
      shader.uniforms.uRegionA = fu.uRegionA;
      shader.uniforms.uCoatShadow = this.uCoatShadow;
      shader.uniforms.uCoatTuft = this.uCoatTuft;
      shader.uniforms.uHullFrac = this.uHullFrac;
    };

    const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    mat.name = 'foxCoatDepth';
    mat.onBeforeCompile = (shader) => {
      bindFur(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${COAT_PARS}`)
        .replace('#include <begin_vertex>',
          `#include <begin_vertex>\n${COAT_OFFSET_HEAD}${COAT_OFFSET_TAIL}`);
    };
    mat.customProgramCacheKey = () => 'foxCoatDepth.v4';
    this.material = mat;
    this.mesh = mesh;
    this.setInstalled(true);

    this._buildFringe(ctx, mesh, bindFur);

    this.report = this.measure();
    const r = this.report;
    console.info(`[coatShadow] caster extruded by the measured coat field: ` +
      `${r.meanMm.toFixed(1)} mm mean, ${r.maxMm.toFixed(1)} mm max over ` +
      `${r.vertices} verts · skin bbox ${(r.skinWidth * 1000).toFixed(0)} mm ` +
      `wide -> coat hull ${(r.coatWidth * 1000).toFixed(0)} mm ` +
      `(${(r.coatWidth / Math.max(r.skinWidth, 1e-6)).toFixed(2)}x) · ` +
      `core at ${(CORE_FRAC * 100).toFixed(0)}% of it, alpha-tested fringe to ` +
      `${(FRINGE_TIP * 100).toFixed(0)}% on a ${(FRINGE_CELL * 1000).toFixed(0)} mm ` +
      `tuft / ${(PORE_CELL * 1000).toFixed(0)} mm pore lattice` +
      `${this.fringeInstalled ? '' : ' [FRINGE NOT INSTALLED]'}`);
    ctx.coatShadow = this;
  }

  /**
   * The fringe layer: a second SkinnedMesh over the SAME geometry and the
   * SAME skeleton, drawn only into the shadow map.
   *
   * Getting a second depth draw into three's shadow pass is fiddlier than it
   * looks and every obvious route is blocked, so the reasoning is written
   * down rather than rediscovered:
   *
   *   - `object.visible = false` removes it from the shadow pass too
   *     (WebGLShadowMap.renderObject returns early on it).
   *   - `material.visible = false` is checked in the shadow pass as well as
   *     in projectObject, so it removes it from both.
   *   - layers do not separate the two passes either: the shadow pass tests
   *     `object.layers.test(camera.layers)` against the MAIN camera.
   *
   * So the mesh is genuinely in both passes, and the beauty pass is made free
   * instead: a vertex shader that puts every vertex at the same clip position
   * behind the far plane, so every triangle is degenerate AND clipped, with
   * colour and depth writes off. One draw call, no fragments.
   */
  _buildFringe(ctx, mesh, bindFur) {
    const fmat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    fmat.name = 'foxCoatFringeDepth';
    fmat.onBeforeCompile = (shader) => {
      bindFur(shader);
      shader.uniforms.uFringe = this.uFringe;
      shader.uniforms.uLightBind = this.uLightBind;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${COAT_PARS}\n${FRINGE_PARS}`)
        .replace('#include <begin_vertex>',
          `#include <begin_vertex>\n${COAT_OFFSET_HEAD}${FRINGE_VERT}${COAT_OFFSET_TAIL}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${HASH}\n${WORLEY3}\n${FRINGE_FRAG_PARS}`)
        .replace('#include <alphatest_fragment>',
          `#include <alphatest_fragment>\n${FRINGE_FRAG}`);
    };
    fmat.customProgramCacheKey = () => 'foxCoatFringeDepth.v4';

    const nullMat = new THREE.ShaderMaterial({
      vertexShader: 'void main(){ gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }',
      fragmentShader: 'void main(){ gl_FragColor = vec4(0.0); }',
      colorWrite: false, depthWrite: false, depthTest: false,
    });
    nullMat.name = 'foxCoatFringeNull';

    const fringe = new THREE.SkinnedMesh(mesh.geometry, nullMat);
    fringe.name = 'foxCoatFringe';
    fringe.bindMode = mesh.bindMode;
    fringe.bind(mesh.skeleton, mesh.bindMatrix);
    fringe.castShadow = true;
    fringe.receiveShadow = false;
    // The shader moves the surface outwards, so the geometry's own bounds
    // understate it; and it must be in the shadow map even when the camera
    // cannot see it. Never cull it.
    fringe.frustumCulled = false;
    fringe.customDepthMaterial = fmat;
    // Parented and bound exactly as FurSystem parents its shells and cards:
    // a sibling under fox.root, bound to the body's own bindMatrix. Three
    // then derives matrixWorld at the right moment in render(), with no
    // one-frame lag between the fringe and the core that a hand-copied
    // matrixWorld in prerender() would have had on a walking animal.
    fringe.renderOrder = 3;
    (mesh.parent ?? ctx.scene).add(fringe);
    fringe.position.copy(mesh.position);
    fringe.quaternion.copy(mesh.quaternion);
    fringe.scale.copy(mesh.scale);

    this.fringeMesh = fringe;
    this.fringeMaterial = fmat;
    this.fringeNull = nullMat;
    this.fringeInstalled = true;
    this._syncLight();
  }

  /** foxBody's own local transform is identity today, but do not assume it:
   *  if anatomy ever animates it, the fringe has to move with it. */
  update() {
    const f = this.fringeMesh, m = this.mesh;
    if (!f || !m) return;
    f.position.copy(m.position);
    f.quaternion.copy(m.quaternion);
    f.scale.copy(m.scale);
    this._syncLight();
  }

  /**
   * The sun, in the space the position attribute lives in. Pulled back
   * through foxBody's own world matrix, which is what maps that attribute to
   * the world once the bones are folded in. Bone deformation makes this an
   * approximation on a bent limb, and that is fine: the field only has to be
   * ray-aligned to within a few degrees for a hole to stay a hole.
   */
  _syncLight() {
    const d = this.ctx?.sunDirection;
    if (!d || !this.uLightBind || !this.mesh) return;
    _m4.copy(this.mesh.matrixWorld).invert();
    this.uLightBind.value.copy(d).transformDirection(_m4).normalize();
  }

  _fail(reason) {
    this.report = { ok: false, reason };
    console.error(`[coatShadow] ${reason}`);
    this.ctx.coatShadow = this;
  }

  /**
   * Install or remove the depth material. This is the honest cost A/B: with it
   * removed three falls back to its own shared MeshDepthMaterial and the
   * shadow pass runs exactly the work it ran before this system existed.
   * `setScale(0)` is the SILHOUETTE A/B and keeps the same program.
   */
  setInstalled(on) {
    if (!this.material || !this.mesh) return false;
    this.mesh.customDepthMaterial = on ? this.material : undefined;
    this.installed = !!on;
    return this.installed;
  }

  /** 0 reproduces the skin-only caster; 1 is the full measured coat. */
  setScale(s) {
    this.scale = s;
    if (this.uCoatShadow) this.uCoatShadow.value = s;
    return s;
  }

  /**
   * Lock relief on the hull. 1 ships. 0 is the smooth hull this replaced and
   * is the only honest control for it; values above 1 exist so the metric can
   * be swept and shown to move with the thing it claims to measure, not so
   * the look can be dialled past what the coat actually does.
   */
  setTuft(t) {
    this.tuft = t;
    if (this.uCoatTuft) this.uCoatTuft.value = t;
    return t;
  }

  /**
   * Guard-hair tips. 1 ships. 0 collapses the fringe layer exactly onto the
   * core and disables its alpha test, so it is a true null at IDENTICAL cost
   * and with no recompile -- the silhouette A/B. For the COST A/B use
   * setFringeInstalled(false), which takes the draw out of the pass.
   */
  setFringe(f) {
    this.fringe = f;
    if (this.uFringe) this.uFringe.value = f;
    // With the tips gone the core has to carry the whole coat again, or
    // "fringe off" would silently also mean "18 % less shadow" and every
    // A/B against it would credit the fringe with width it did not add.
    if (this.uHullFrac) this.uHullFrac.value = f > 0.001 ? CORE_FRAC : 1.0;
    return f;
  }

  /** Remove or restore the fringe DRAW. This is the honest cost control. */
  setFringeInstalled(on) {
    if (!this.fringeMesh) return false;
    this.fringeMesh.visible = !!on;
    this.fringeInstalled = !!on;
    return this.fringeInstalled;
  }

  /**
   * What the extrusion actually is, measured off the same attributes and
   * uniforms the shader reads, plus the bind-space bounding box of the skin
   * and of the extruded hull. Reported in the console at boot and readable
   * from the harness, so the number in the report is the number the GPU used.
   *
   * Bind space, not world: the skin matrix is common to both boxes, so the
   * ratio is the thing this measures and it does not move with the pose.
   */
  measure() {
    const g = this.mesh?.geometry;
    const fu = this.ctx.fur?.uniforms;
    if (!g || !fu) return { ok: false, reason: 'geometry or fur uniforms gone' };
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const fl = g.getAttribute('furLength');
    const rg = g.getAttribute('region');
    const st = g.getAttribute('furStiffness');
    const tn = g.getAttribute('furTangent');
    if (!pos || !nrm || !fl || !rg || !st || !tn) {
      return { ok: false, reason: 'an attribute the shader reads is missing' };
    }
    const ra = fu.uRegionA.value;
    const cs = fu.uCoatScale.value;
    const lay0 = fu.uLay.value;
    const crush = Math.min(1.30, Math.max(0.62,
      1 - fu.uCoatCompress.value * fu.uCoatSquash.value));

    let min = Infinity, max = 0, sum = 0;
    const sLo = [Infinity, Infinity, Infinity], sHi = [-Infinity, -Infinity, -Infinity];
    const cLo = [Infinity, Infinity, Infinity], cHi = [-Infinity, -Infinity, -Infinity];
    const n = pos.count;
    for (let v = 0; v < n; v++) {
      const i = Math.min(REGION_COUNT - 1, Math.max(0, Math.round(rg.getX(v))));
      const r = ra[i];
      const L = fl.getX(v) * cs * (r.y || 1) * crush * this.scale;
      if (L < min) min = L;
      if (L > max) max = L;
      sum += L;
      const lay = lay0 * (r.z || 1) * (0.30 + 1.05 * (1 - st.getX(v)));
      const p = [pos.getX(v), pos.getY(v), pos.getZ(v)];
      const nn = [nrm.getX(v), nrm.getY(v), nrm.getZ(v)];
      const nl = Math.hypot(nn[0], nn[1], nn[2]) || 1;
      const t = [tn.getX(v), tn.getY(v), tn.getZ(v)];
      for (let k = 0; k < 3; k++) {
        if (p[k] < sLo[k]) sLo[k] = p[k];
        if (p[k] > sHi[k]) sHi[k] = p[k];
        const q = p[k] + (nn[k] / nl) * L + t[k] * (L * lay);
        if (q < cLo[k]) cLo[k] = q;
        if (q > cHi[k]) cHi[k] = q;
      }
    }
    return {
      ok: true, vertices: n, installed: this.installed, scale: this.scale,
      tuft: this.tuft,
      // These millimetres are the hull BEFORE the lock relief. The relief is
      // a GLSL Worley field and cannot be re-evaluated here without a second
      // copy of it that could drift from the shader's, so it is deliberately
      // NOT folded in: it is zero-mean by construction (TUFT_DC) and its
      // effect on the shadow's WIDTH is checked in image space instead.
      tuftAmp: TUFT_AMP, tuftCellMm: TUFT_CELL * 1000,
      hullFrac: this.uHullFrac?.value ?? 1, fringe: this.fringe,
      fringeTip: FRINGE_TIP, fringeCellMm: FRINGE_CELL * 1000,
      poreCellMm: PORE_CELL * 1000, fringeInstalled: !!this.fringeInstalled,
      minMm: min * 1000, meanMm: (sum / n) * 1000, maxMm: max * 1000,
      skinWidth: sHi[0] - sLo[0], coatWidth: cHi[0] - cLo[0],
      skinHeight: sHi[1] - sLo[1], coatHeight: cHi[1] - cLo[1],
      skinDepth: sHi[2] - sLo[2], coatDepth: cHi[2] - cLo[2],
    };
  }

  dispose() {
    if (this.mesh) this.mesh.customDepthMaterial = undefined;
    this.material?.dispose();
    this.fringeMesh?.parent?.remove(this.fringeMesh);
    this.fringeMaterial?.dispose();
    this.fringeNull?.dispose();
  }
}
