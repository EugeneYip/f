import * as THREE from 'three';
import { rng, gauss, clamp, lerp, fbm1, TAU } from '../util/math.js';
import { ATMO_PARS, SKY_SAMPLE, HDR_CLAMP } from '../shaders/sky.glsl.js';

/**
 * High-altitude emissive curtains, plus the star field they hang in.
 *
 * Restraint is the brief (bible §7: "Dim. Restrained."), so the defaults here
 * are deliberately low. `ctx.aurora.intensity` is the one knob.
 *
 * Three decisions worth explaining:
 *
 * 1. Everything is in REAL kilometres against a spherical earth, with the
 *    emitting shell at 90-150 km. That is what makes the arcs converge and
 *    compress toward the horizon instead of hanging like a flat banner. It
 *    costs nothing extra -- the ray is the same ray -- and it is the single
 *    thing that separates aurora that reads as 100 km up from aurora that
 *    reads as a quad 50 m away.
 *
 * 2. The sheets are crossed ANALYTICALLY, not marched. The camera sits on the
 *    arc's axis, so a ray's across-arc coordinate is exactly linear in t and
 *    the crossing is solvable; bump() has a closed-form integral, so the
 *    chord through a sheet is one expression. See sheet() in the fragment
 *    shader for what the 16-step march was costing -- in short, every defect
 *    REVIEW-6 section 7 lists.
 *
 * 3. The filament structure is baked into one small texture rather than
 *    evaluated with simplex noise. Three independent curtain fields live in
 *    R/G/B and the along-arc envelope in A, so a whole sheet is ONE texture
 *    fetch and the effect is three.
 *
 * Depth: the dome and the stars draw with depthTest OFF at a very negative
 * renderOrder, so they are painted immediately after the sky and then covered
 * by every opaque thing in the scene. That gives correct occlusion by terrain,
 * ridges and the fox without having to fit the geometry inside the 900 m far
 * plane.
 */
export class Aurora {
  name = 'aurora';
  order = 300;

  constructor() {
    /** 0..1, read by anything that wants to know how lit the sky is. */
    this.intensity = 0;
    /** The greenish ambient the aurora adds to the snow. */
    this.skyLightColor = new THREE.Color(0x8fe8c4);
    /** Radiance the curtains throw down onto the snow. Read by SnowMaterial. */
    this.groundLight = new THREE.Color(0, 0, 0);
    // Review 4 measured the aurora pose at +3.5 levels of green excess with a
    // sky-wide mean of -2.48 -- net magenta -- and concluded there was no
    // aurora. There is one, but only below the horizon gate (see update()),
    // and at the old 0.62 it was still thin where it existed: 9.8% of the sky
    // above +5 levels of green and a sky-wide mean of -1.6, i.e. still net
    // magenta at a sun of -6 degrees. Section 7 asks for dim and restrained,
    // not for invisible.
    this.baseIntensity = 1.0;
    this._drift = 0;
    this._steps = 0;

    /**
     * Baked-curtain spectrum. Kept as data rather than literals so a probe can
     * sweep it without editing the shader -- REVIEW-6 blocker 7 needed four
     * variants measured against one structure-tensor instrument.
     *
     * `x` is along-arc and carries the filaments; `y` is ALTITUDE. Every
     * altitude frequency that is not 1 tilts or chops the filaments, because
     * the along-arc coordinate of a ray is constant down a screen column (the
     * camera sits on the arc's axis) while altitude runs UP the column. The
     * old [2,2,3,4] therefore broke each ray into ~80 px dashes; only the
     * coarsest octave keeps a y term, and it is there so rays end at
     * different heights instead of forming a perfect comb.
     */
    this.curtainSpec = {
      XF: [18, 46, 128, 340],
      YF: [2, 1, 1, 1],
      AMP: [0.30, 0.25, 0.26, 0.19],
      gain: 2.80, bias: 0.88, gamma: 1.05,
      // Along-arc envelope: the arc comes and goes ALONG itself. A y term
      // here cuts the curtain into horizontal blobs, which is most of what
      // the critic photographed.
      ENV: [[3, 1, 8191], [6, 1, 6427], [12, 1, 4231]],
      ENVAMP: [0.55, 0.3, 0.15],
      envGain: 2.15, envBias: 0.62, envGamma: 0.85,
    };
  }

  init(ctx) {
    this.ctx = ctx;
    this.enabled = !!ctx.quality.get('aurora');
    const sky = ctx.sky;
    if (!sky?.shared) { console.warn('[aurora] no sky system; skipping'); return; }

    this.group = new THREE.Group();
    this.group.name = 'aurora';
    this.group.frustumCulled = false;

    this._curtainTex = this._bakeCurtain();
    this._buildCurtains(ctx, sky);
    this._buildStars(ctx, sky);
    ctx.scene.add(this.group);
    ctx.aurora = this;
  }

  dispose() {
    this._curtainTex?.dispose();
    this.group?.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  }

  /** Re-bake the curtain texture after `curtainSpec` changed. Probe hook. */
  rebakeCurtain() {
    if (!this.uniforms) return;
    const old = this._curtainTex;
    this._curtainTex = this._bakeCurtain();
    this.uniforms.uCurtain.value = this._curtainTex;
    old?.dispose();
  }

  // -- baked curtain structure ----------------------------------------------

  /**
   * Four periodic 2D value-noise fields. X is along-arc and carries the fine
   * striations; Y is altitude and is deliberately LOW frequency so the
   * striations stay vertically coherent -- filaments follow magnetic field
   * lines, they do not fizz.
   */
  _bakeCurtain() {
    const W = 1024, H = 64;
    const lattices = [];
    const makeLattice = (nx, ny, seed) => {
      const r = rng(seed);
      const a = new Float32Array(nx * ny);
      for (let i = 0; i < a.length; i++) a[i] = r();
      return { nx, ny, a };
    };
    const sample = (L, x, y) => {
      const fx = x * L.nx, fy = y * L.ny;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      const tx = fx - ix, ty = fy - iy;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const g = (i, j) => L.a[(((j % L.ny) + L.ny) % L.ny) * L.nx + (((i % L.nx) + L.nx) % L.nx)];
      return lerp(lerp(g(ix, iy), g(ix + 1, iy), sx), lerp(g(ix, iy + 1), g(ix + 1, iy + 1), sx), sy);
    };

    // Three curtain fields (fine, high-frequency in x) ...
    //
    // The SPECTRUM here is the whole effect. It used to be [0.5, 0.26, 0.15,
    // 0.09] over [24, 48, 96, 192] cells, i.e. 78% of the energy in the two
    // COARSEST octaves. Against uSFreq the coarsest is one feature every
    // 32 km, which at 150 km subtends 12 degrees — so what reached the screen
    // was a 12-degree horizontal blob with a 9%-amplitude filament ripple on
    // it, and review 3 measured exactly that: "three horizontal lenticular
    // blobs", no filaments. Filaments are not a garnish on an auroral arc,
    // they ARE the arc: the emission follows magnetic field lines and the
    // rays are hundreds of metres to a few km across. So flatten the
    // spectrum and push it fine.
    //
    // Measured for this pose: the ray's along-arc coordinate advances
    // 0.12 / 0.22 / 0.38 km per screen pixel at the three bands, so 340 cells
    // (2.26 km) is a filament 19 / 10 / 6 px wide and 128 cells (6.0 km) is
    // 50 / 27 / 16 px. Those are the numbers that matter, not the subtended
    // angle at the shell.
    const { XF, YF, AMP, ENV, ENVAMP, gain, bias, gamma, envGain, envBias, envGamma }
      = this.curtainSpec;
    for (let b = 0; b < 3; b++) {
      lattices.push(XF.map((nx, k) => makeLattice(nx, YF[k], 1301 + b * 977 + k * 37)));
    }
    // ... and one slow along-arc envelope, so the arc comes and goes.
    const envL = ENV.map(([nx, ny, seed]) => makeLattice(nx, ny, seed));
    const envAmp = ENVAMP;

    const data = new Uint8Array(W * H * 4);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const x = i / W, y = j / H;
        const o = (j * W + i) * 4;
        for (let b = 0; b < 3; b++) {
          let v = 0, n = 0;
          for (let k = 0; k < XF.length; k++) { v += AMP[k] * sample(lattices[b][k], x, y); n += AMP[k]; }
          v /= n;
          // Sharpen into distinct striations separated by dark gaps rather
          // than a soft cloud. The gaps have to reach actual zero or the
          // curtain integrates into a smooth green gradient.
          v = Math.pow(clamp(v * gain - bias, 0, 1), gamma);
          data[o + b] = Math.round(v * 255);
        }
        let e = 0, en = 0;
        for (let k = 0; k < envL.length; k++) { e += envAmp[k] * sample(envL[k], x, y); en += envAmp[k]; }
        e = clamp((e / en) * envGain - envBias, 0, 1);
        data[o + 3] = Math.round(Math.pow(e, envGamma) * 255);
      }
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    // Mipmapped: the march samples this at up to ~1000 km, where adjacent
    // pixels step several texels and the filaments moire badly. Automatic LOD
    // is useless inside a raymarch (the UV jumps between steps), so the
    // shader picks the level explicitly from the sample distance.
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  // -- curtains -------------------------------------------------------------

  /**
   * Was: widen the sheets as the step count falls, because at `low` (6 steps)
   * most rays missed them entirely. There is no march any more -- each sheet
   * is crossed analytically -- so the curtain is now identical at every tier
   * and this hook only exists to keep `onQuality` honest about the star count.
   */
  _applySteps() {
    const u = this.uniforms;
    if (!u) return;
    const f = u.uFoldW.value;
    u.uInvFoldW2.value.set(1 / (f.x * f.x), 1 / (f.y * f.y));
    u.uScale.value = this.BASE_SCALE;
  }

  _buildCurtains(ctx, sky) {
    const steps = Math.max(4, ctx.quality.get('auroraSteps') || 12);
    this._steps = steps;
    // Retuned after the postfx pipeline landed: the new exposure and
    // tonemap put the curtains far below where they were authored. Raised
    // again for review 4 -- see baseIntensity for the measurement.
    //
    // x3.75 when the sheets came down from 4.5-11.0 km to 1.2-2.9 km: the
    // analytic crossing integrates bump() over the WHOLE chord, so brightness
    // is exactly proportional to sheet thickness and the ratio is the only
    // honest way to keep the previous exposure.
    this.BASE_SCALE = 0.042 * 3.75;

    // Arc frame. Rotated so the bands run ACROSS the aurora pose's view
    // rather than straight away from it.
    const th = 33 * Math.PI / 180;

    this.uniforms = {
      uCurtain: { value: this._curtainTex },
      uSkyLut: sky.shared.uSkyLut,
      uSkyTexel: sky.shared.uSkyTexel,
      uSunDir: sky.shared.uSunDir,
      uTime: { value: 0 },
      uDrift: { value: 0 },
      uIntensity: { value: 0 },
      uArcRot: { value: new THREE.Vector2(Math.cos(th), Math.sin(th)) },
      uSFreq: { value: 0.0013 },
      uMaxRadiance: { value: 1.1 },
      uShear: { value: 0.016 },
      // Across-arc distances in km. These set the ELEVATION each curtain
      // appears at: atan(90 / |z|). -110/-200/-340 puts them at roughly
      // 39/24/15 degrees, so the top band clears the sun's glow.
      uBandZ: { value: new THREE.Vector3(-110, -200, -340) },
      // Sheet thickness in km. It was 4.5 / 7.0 / 11.0, which is 5-10x what a
      // real auroral curtain is (a few hundred metres to about a kilometre),
      // and that single number was what destroyed the filaments: the ray
      // crosses the sheet obliquely, so it averages `thick * |n/m|` of
      // ALONG-ARC distance. At 4.5 km that is 5.4 km at the right of this
      // framing -- 2.4 whole periods of the 2.26 km filament octave, i.e. the
      // filaments were integrated away before anything else touched them.
      // At 1.2 km it is 0.75 km, a third of a period, and they survive.
      uBandThick: { value: new THREE.Vector3(1.2, 1.87, 2.93) },
      uInvFoldW2: { value: new THREE.Vector2() },
      // Vertical emission profile, in altitude fraction vv (0 at 90 km, 1 at
      // 150 km). vv runs UP the screen inside each band's footprint, so this
      // vec4 IS the band's brightness profile from its lower border upwards:
      // (floor, decaying amplitude, decay rate, lower-edge toe).
      //
      // It used to be (0.06, 0.40, 3.6) against a border spike of 2.70 at
      // width 1/29.4, which put 25x more light into the bottom 11% of the
      // band than into the whole body above it. The band's screen footprint
      // is 347 / 243 / 163 px tall, so 11% of it is 38 / 27 / 18 px -- the
      // same size as a filament is wide, and that is precisely why REVIEW-6
      // photographed "a diagonal string of soft blobs" instead of filaments.
      // A curtain has to be TALL on screen before anything in it can read as
      // vertical.
      uVert: { value: new THREE.Vector4(0.14, 0.46, 1.70, 0.035) },
      // Bright lower border: (centre in vv, 1/half-width, amplitude).
      uBorder: { value: new THREE.Vector3(0.05, 14.0, 1.00) },
      uPxAngle: { value: 0.0013 },
      uBandAmp: { value: new THREE.Vector3(1.0, 0.58, 0.32) },
      uFoldPos: { value: new THREE.Vector2(0, 0) },
      uFoldW: { value: new THREE.Vector2(150, 230) },
      uColLow: { value: new THREE.Color(0x7dffc4) },
      uColMid: { value: new THREE.Color(0x62f0b4) },
      uColHigh: { value: new THREE.Color(0xa77dff) },
      uColTop: { value: new THREE.Color(0xff5d84) },
      uScale: { value: 0.0125 },
      // Lower suppression lets the 15-24 degree bands survive the sun's
      // glow. Those are the ones seen closest to side-on, and therefore
      // the ones whose vertical striations actually project large
      // enough to read in a wide framing.
      uSkyKill: { value: 2.8 },
    };

    this._applySteps(steps);

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uCurtain;
        uniform vec3 uSunDir;
        uniform float uTime, uDrift, uIntensity, uSFreq, uShear, uScale, uSkyKill, uPxAngle, uMaxRadiance;
        uniform vec4 uVert;
        uniform vec3 uBorder;
        uniform vec2 uArcRot, uFoldPos, uFoldW, uInvFoldW2;
        uniform vec3 uBandZ, uBandThick, uBandAmp;
        uniform vec3 uColLow, uColMid, uColHigh, uColTop;
        varying vec3 vDir;
        ${ATMO_PARS}
        ${SKY_SAMPLE}
        ${HDR_CLAMP}

        const float AUR_H0 = 90.0;
        const float AUR_H1 = 150.0;
        const float AUR_INVH = 1.0 / (AUR_H1 - AUR_H0);

        // Drop-in for exp(-x*x), taking x*x. A cubed parabola matches the
        // Gaussian to within a few percent over the range that is visible and
        // costs no transcendental, and unlike a Gaussian its integral is
        // finite and closed-form -- which is what makes the analytic crossing
        // below possible at all.
        float bump(float x2) {
          float g = max(0.0, 1.0 - 0.283 * x2);
          return g * g * g;
        }
        // integral of bump(x*x) dx over its whole support, (32/35)/sqrt(0.283)
        const float BUMP_INT = 1.71859;

        /*
          ONE curtain sheet, crossed ANALYTICALLY.

          There used to be a 16-step raymarch here, and it was the cause of
          every defect REVIEW-6 section 7 lists. The camera sits on the arc
          axis, so the across-arc coordinate along a ray is exactly linear in
          t -- the sheet is crossed at ONE solvable t, and a bump() has a
          closed-form integral. A march therefore bought nothing and cost:

            * the shell slab is ~165 km deep and a sheet is a few km, so at
              16 steps ONE step landed inside a curtain. The estimate was a
              1-sample Monte Carlo, and the sample position came from
              interleaved-gradient noise keyed to gl_FragCoord -- a FIXED
              screen pattern, identical on every accumulated TAA sample, so
              nothing could average it. It shipped as the ordered-dither
              screen the critic measured at high-pass sd 2.84 against 1.15 in
              plain sky. Measured here: it was the ENTIRE structure signal --
              the tensor read Jxx 33.2 with it and Jxx 0.64 without.
            * jittering that one sample over a 10 km step moved the sampled
              along-arc coordinate by +-2.6 km, which is one whole period of
              the finest filament octave. Whatever the dither did not ruin,
              the jitter smeared flat.

          Solving instead costs three texture fetches for the whole effect,
          is identical at every quality tier, and has no stochastic term at
          all -- so there is nothing left to dither.

          Returns vec2(emission, emission * altitude) so the caller can take
          one emission-weighted colour lookup over all three sheets.
        */
        vec2 sheet(vec3 ro, vec3 dir, float invm, float aim, float n,
                   float Zc, float thick, vec3 warpC, float foldMul,
                   vec3 chan, float amp) {
          // The sheet's across-arc position is warped by the fold sines,
          // which are functions of the ALONG-ARC coordinate -- so solving for
          // the crossing is a fixed point. Two passes: the correction is
          // ~1 km near the centre of frame, where the ray runs across the
          // arc, and ~35 km at the edge, where it runs along it.
          float t = Zc * invm;
          if (t <= 0.0) return vec2(0.0);
          vec3 sv = vec3(0.0);
          float fold = 0.0;
          float s = n * t;
          for (int i = 0; i < 2; i++) {
            sv = vec3(sin(s * 0.0125 + uDrift * 9.0),
                      sin(s * 0.0345 - uDrift * 5.0),
                      sin(s * 0.0082 - uDrift * 6.0 + 1.9));
            float f1 = s - uFoldPos.x;
            float f2 = s - uFoldPos.y;
            fold = bump(f1 * f1 * uInvFoldW2.x) + 0.7 * bump(f2 * f2 * uInvFoldW2.y);
            t = (Zc + dot(warpC, sv) + fold * 26.0 * foldMul) * invm;
            if (t <= 0.0) return vec2(0.0);
            s = n * t;
          }

          vec3 p = ro + dir * t;
          float v = clamp((length(p) - Rg - AUR_H0) * AUR_INVH, 0.0, 1.0);

          // Explicit LOD from how many texels one pixel spans at this
          // distance. Without it the filaments alias into a cross-hatch
          // moire, which is exactly what fine striations turn into when you
          // sample them past Nyquist.
          float texPerPx = uSFreq * t * uPxAngle * 1024.0;
          float lod = max(0.0, log2(max(texPerPx, 1.0)));
          vec4 F = textureLod(uCurtain,
                              vec2(s * uSFreq + uDrift + v * uShear, v * 0.86 + 0.07), lod);
          float fil = dot(F.rgb, chan);

          // Rippling lower border -- a constant-altitude border draws a
          // dead-straight line across the frame. The offset is combed by the
          // filament field as well as by the fold sines, so the bright lower
          // edge ends in rays hanging below it rather than in a drawn line;
          // that ragged bottom edge is the most recognisable thing about a
          // real curtain and section 7 asks for it by name.
          float vv = clamp(v - (0.075 * sv.y + 0.045 * sv.x) - 0.075 * (fil - 0.35), 0.0, 1.0);
          float b = (vv - uBorder.x) * uBorder.y;
          float vert = smoothstep(0.0, uVert.w, vv) * (uVert.x + uVert.y * exp(-vv * uVert.z))
                     + uBorder.z * bump(b * b);
          // Fade out at the top of the emitting shell, or the curtain ends on
          // a drawn line where v clamps.
          vert *= smoothstep(1.0, 0.78, v);

          // Closed form for the chord: integral over t of bump(d*d/thick*thick)
          // where d = m*t - centre, which is thick * BUMP_INT / |m|.
          float w = fil * amp * F.a * (1.0 + 1.25 * fold) * vert * (thick * BUMP_INT * aim);
          return vec2(w, w * vv);
        }

        void main() {
          vec3 dir = normalize(vDir);
          if (dir.y < -0.02 || uIntensity <= 0.0) discard;

          // Cheap attenuation FIRST. Near the horizon the air kills it and
          // beside the sun the twilight drowns it, and in the aurora pose
          // that is a third of the dome. No point solving those pixels.
          float am = 1.0 / max(dir.y + 0.06, 0.06);
          float ext = exp(-0.28 * (am - 1.0));
          float lum = dot(sampleSky(dir, uSunDir), vec3(0.2126, 0.7152, 0.0722));
          float atten = ext / (1.0 + lum * uSkyKill);
          if (atten < 0.035) discard;

          vec3 ro = vec3(0.0, Rg + 0.002, 0.0);
          float m = dir.x * uArcRot.y + dir.z * uArcRot.x;
          if (abs(m) < 1e-3) discard;
          float invm = 1.0 / m;
          // A ray running along a sheet has an unbounded chord through it.
          // Cap the geometric gain at 6x; past that the crossing is so far
          // away that it leaves the emitting shell anyway.
          float aim = min(abs(invm), 6.0);
          float n = dir.x * uArcRot.x - dir.z * uArcRot.y;

          vec2 acc = sheet(ro, dir, invm, aim, n, uBandZ.x, uBandThick.x,
                           vec3(16.0, 7.0, 0.0), 1.0, vec3(1.0, 0.0, 0.0), uBandAmp.x)
                   + sheet(ro, dir, invm, aim, n, uBandZ.y, uBandThick.y,
                           vec3(0.0, 11.0, 26.0), 0.7, vec3(0.0, 1.0, 0.0), uBandAmp.y)
                   + sheet(ro, dir, invm, aim, n, uBandZ.z, uBandThick.z,
                           vec3(0.0, 0.0, 40.0), 0.0, vec3(0.0, 0.0, 1.0), uBandAmp.z);

          if (acc.x <= 1e-6) discard;
          // Emission-weighted altitude, then look the colour up ONCE.
          float vv = acc.y / acc.x;
          vec3 col = mix(uColLow, uColMid, smoothstep(0.0, 0.45, vv));
          col = mix(col, uColHigh, smoothstep(0.42, 0.88, vv));
          col = mix(col, uColTop, smoothstep(0.86, 1.0, vv) * 0.6);

          // Additive into the same HDR target; bounded for the same reason.
          vec3 out3 = clampRadiance(col * (acc.x * uScale * uIntensity * atten), uMaxRadiance);
          gl_FragColor = vec4(max(out3, 0.0), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: THREE.BackSide,
      transparent: false,        // stays in the opaque queue, sorted by renderOrder
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: true,
    });

    // thetaLength 1.78 rad => +90 deg down to about -12 deg elevation.
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(100, 40, 20, 0, TAU, 0, 1.78), mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -9800;
    // No onBeforeRender seed here, deliberately. Every other stochastic
    // system in this scene has to decorrelate its dither against
    // ctx.postfx.taaSampleIndex; this one has no dither left to decorrelate,
    // because the sheets are solved rather than sampled.
    this.group.add(this.dome);
  }

  // -- stars ----------------------------------------------------------------

  _buildStars(ctx, sky) {
    const n = (ctx.quality.get('auroraSteps') || 12) <= 6 ? 1400 : 3200;
    const r = rng(90218);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const siz = new Float32Array(n);
    const pha = new Float32Array(n);

    const mMin = -1.2, mMax = 6.6;
    const span = Math.pow(10, 0.6 * (mMax - mMin));
    for (let i = 0; i < n; i++) {
      // Uniform on the sphere.
      const u = r() * 2 - 1, a = r() * TAU;
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      pos[i * 3] = s * Math.cos(a) * 100;
      pos[i * 3 + 1] = u * 100;
      pos[i * 3 + 2] = s * Math.sin(a) * 100;

      // Real magnitude distribution: N(<m) grows as 10^(0.6m), so the sky is
      // overwhelmingly faint stars with a handful of bright ones.
      const m = mMin + Math.log10(1 + r() * (span - 1)) / 0.6;
      // Gamma-compressed brightness. The true 10^(-0.4 dm) range over 7.8
      // magnitudes is 1300:1, and the faint end would quantise to nothing.
      const b = Math.pow(10, -0.4 * (m - mMin) * 0.62);

      // Colour index. Real naked-eye stars are mostly near-white with a faint
      // blue or amber cast; saturated stars are a dead giveaway.
      const bv = clamp(gauss(r, 0.58, 0.42), -0.32, 1.65);
      const t = clamp((bv + 0.35) / 2.0, 0, 1);
      col[i * 3] = lerp(0.74, 1.0, t) * b;
      col[i * 3 + 1] = lerp(0.85, 0.86, t) * b;
      col[i * 3 + 2] = lerp(1.0, 0.74, t) * b;

      siz[i] = 1.45 + 3.1 * Math.pow(b, 0.42);
      pha[i] = r();
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(pha, 1));

    this.starUniforms = {
      uSkyLut: sky.shared.uSkyLut,
      uSkyTexel: sky.shared.uSkyTexel,
      uSunDir: sky.shared.uSunDir,
      uTime: { value: 0 },
      uPix: { value: 1 },
      uOpacity: { value: 1.0 },
      uSkyKill: { value: 11.0 },
      uGain: { value: 2.4 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.starUniforms,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aPhase;
        uniform float uTime, uPix;
        varying vec3 vCol;
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          // Scintillation, not blinking: two incommensurate slow terms whose
          // amplitude rises with airmass, because twinkling is an atmospheric
          // path-length effect and stars overhead barely do it.
          float am = 1.0 / max(vDir.y + 0.05, 0.05);
          float amp = 0.030 + 0.042 * min(am, 6.0);
          float tw = 1.0 + amp * (0.62 * sin(uTime * 2.1 + aPhase * 71.0)
                                + 0.38 * sin(uTime * 3.37 + aPhase * 133.0));
          vCol = aColor * max(tw, 0.0);
          gl_PointSize = aSize * uPix;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uSunDir;
        uniform float uOpacity, uSkyKill, uGain;
        varying vec3 vCol;
        varying vec3 vDir;
        ${ATMO_PARS}
        ${SKY_SAMPLE}
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float a = exp(-dot(c, c) * 13.5);
          vec3 dir = normalize(vDir);
          // Drown them out in the twilight glow instead of cutting them off.
          float lum = dot(sampleSky(dir, uSunDir), vec3(0.2126, 0.7152, 0.0722));
          float vis = exp(-lum * uSkyKill);
          float am = 1.0 / max(dir.y + 0.05, 0.05);
          vis *= exp(-0.30 * (am - 1.0));
          vec3 c3 = vCol * a * vis * uOpacity * uGain;
          gl_FragColor = vec4(max(c3, 0.0), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: false,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    this.stars = new THREE.Points(g, mat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -9700;
    this.group.add(this.stars);
  }

  // -- per frame ------------------------------------------------------------

  update(dt, ctx) {
    if (!this.group) return;
    const t = ctx.time;

    // Follow the camera so the dome and the star sphere never clip.
    this.group.position.copy(ctx.camera.position);

    if (!this.enabled) {
      this.intensity = 0;
      this.groundLight.setRGB(0, 0, 0);
      if (this.uniforms) this.uniforms.uIntensity.value = 0;
      if (this.starUniforms) this.starUniforms.uOpacity.value = 0;
      return;
    }

    // Gentle breathing. Never fully off, never a laser show.
    const breathe = 0.5 + 0.5 * fbm1(t * 0.055, 3, 91);
    // ... and gated on how far the sun is below the horizon. See
    // Sky._updateNight for the photometry: an aurora is ~1e-4 cd/m^2 and a
    // sky with the sun at +6 deg is ~1e3, so a "dim, restrained" arc in a
    // lit sky is not dim, it is impossible — it can only arrive as a flat
    // green film with no structure, which is precisely what review 3 saw.
    const night = ctx.sky?.nightFactor ?? 1;
    this.intensity = clamp(this.baseIntensity * (0.55 + 0.62 * breathe) * night, 0, 1);

    // A pure function of ctx.time, not an accumulator: AGENTS.md requires
    // the same time to give the same image regardless of the dt sequence.
    this._drift = t * 0.0042;
    const u = this.uniforms;
    u.uTime.value = t;
    u.uDrift.value = this._drift;
    u.uIntensity.value = this.intensity;
    // The ceiling has to rise with the curtains or it becomes the thing that
    // sets their brightness. At a -6 degree sun diffuseWhite is 0.26, so 2.2x
    // was clipping the bright cores flat.
    u.uMaxRadiance.value = (ctx.sky?.diffuseWhite ?? 0.45) * 4.0;
    // Folds travel along the arc and wrap over a long period.
    u.uFoldPos.value.set(
      ((t * 16.0 + 900) % 3400) - 1700,
      ((-t * 9.5 + 2200) % 3400) - 1700,
    );

    // Angular size of one pixel, for the curtain texture's LOD selection.
    const bh = ctx.bufferSize?.height || ctx.size.y || 800;
    u.uPxAngle.value = 2 * Math.tan(ctx.camera.fov * Math.PI / 360) / bh;

    this.starUniforms.uTime.value = t;
    this.starUniforms.uPix.value = ctx.renderer.getPixelRatio();
    // Stars live or die by the same clock the aurora does. The per-pixel
    // sky-luminance kill was not enough on its own: at the default +6.6 deg
    // sun the zenith is dark enough in TONEMAPPED terms for exp(-lum*11) to
    // let third-magnitude stars through, and review 3 read them straight off
    // aurora.png next to a blazing solar disc. A star at m=3 is ~1e-6 of a
    // civil-twilight zenith; nothing about that is a matter of taste.
    this.starUniforms.uOpacity.value = ctx.sky?.nightFactor ?? 1;

    // A faint greenish lift on the ambient so the snow registers the aurora.
    // Rebuilt from the sky's base colour every frame -- adding to ctx.skyColor
    // in place would compound without bound.
    const sky = ctx.sky;
    if (sky?.baseSkyColor) {
      ctx.skyColor.copy(sky.baseSkyColor).lerp(this.skyLightColor, 0.075 * this.intensity);
    }

    // §7: "faint reflection in the snow". A 5% hue lerp on ctx.skyColor is
    // not a reflection — it is a hue nudge that survives into the frame as
    // nothing. The curtain is a large, dim, OVERHEAD source, so what it
    // actually does to snow is a broad green wash on upward-facing surfaces
    // that gets stronger as the twilight it competes with dies. Published in
    // the same units as the other light terms (a fraction of the radiance of
    // a white lambertian surface under the current rig) so it cannot drift
    // out of scale with exposure.
    this.groundLight.copy(this.skyLightColor)
      .multiplyScalar(1.60 * this.intensity * (sky?.diffuseWhite ?? 0.45));
  }

  onQuality(e, ctx) {
    this.enabled = !!ctx.quality.get('aurora');
    // The curtains no longer depend on the step count -- there is no march --
    // so a tier change costs no recompile and `low` now gets exactly the same
    // curtain as `ultra`. auroraSteps still picks the star count.
    this._steps = Math.max(4, ctx.quality.get('auroraSteps') || 12);
  }
}
