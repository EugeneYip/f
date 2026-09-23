import * as THREE from 'three';
import { rng, gauss, clamp, lerp, fbm1, TAU } from '../util/math.js';
import { ATMO_PARS, SKY_SAMPLE, HDR_CLAMP } from '../shaders/sky.glsl.js';

/**
 * High-altitude emissive curtains, plus the star field they hang in.
 *
 * Restraint is the brief (bible §7: "Dim. Restrained."), so the defaults here
 * are deliberately low. `ctx.aurora.intensity` is the one knob.
 *
 * Two decisions worth explaining:
 *
 * 1. The march runs in REAL kilometres against a spherical earth, with the
 *    emitting shell at 90-150 km. That is what makes the arcs converge and
 *    compress toward the horizon instead of hanging like a flat banner. It
 *    costs nothing extra -- the ray is the same ray -- and it is the single
 *    thing that separates aurora that reads as 100 km up from aurora that
 *    reads as a quad 50 m away.
 *
 * 2. The filament structure is baked into one small texture rather than
 *    evaluated with simplex noise per step. Three independent curtain fields
 *    live in R/G/B and the along-arc envelope in A, so the whole inner loop is
 *    ONE texture fetch. Per-step simplex would have been ~6x the cost for
 *    structure the eye cannot tell apart at this distance.
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
    // spectrum and push it fine. 128 and 340 cells are filaments 6.0 km and
    // 2.3 km wide, which at 150 km is 2.3 and 0.9 degrees — 75 px and 28 px
    // in a 2800 px frame, and that is what a curtain looks like.
    const XF = [18, 46, 128, 340];
    const YF = [2, 2, 3, 4];
    const AMP = [0.30, 0.25, 0.26, 0.19];
    for (let b = 0; b < 3; b++) {
      lattices.push(XF.map((nx, k) => makeLattice(nx, YF[k], 1301 + b * 977 + k * 37)));
    }
    // ... and one slow along-arc envelope, so the arc comes and goes.
    const envL = [makeLattice(3, 2, 8191), makeLattice(6, 3, 6427), makeLattice(12, 4, 4231)];
    const envAmp = [0.55, 0.3, 0.15];

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
          v = Math.pow(clamp(v * 2.80 - 0.88, 0, 1), 1.05);
          data[o + b] = Math.round(v * 255);
        }
        let e = 0, en = 0;
        for (let k = 0; k < envL.length; k++) { e += envAmp[k] * sample(envL[k], x, y); en += envAmp[k]; }
        e = clamp((e / en) * 2.15 - 0.62, 0, 1);
        data[o + 3] = Math.round(Math.pow(e, 0.85) * 255);
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
   * Curtain sheets are a few km thick and the shell they live in is 100-300 km
   * deep along the ray, so at `low` (6 steps) most rays would miss the sheets
   * entirely and the aurora would break into speckle. Widen the sheets as the
   * step count falls and divide the brightness back out, which trades detail
   * for smoothness exactly where detail was never going to survive anyway.
   */
  _stepLod(steps) {
    return clamp(16 / steps, 1.0, 2.6);
  }

  _applySteps(steps) {
    const k = this._stepLod(steps);
    const u = this.uniforms;
    const t = u.uBandThick.value.set(4.5 * k, 7.0 * k, 11.0 * k);
    u.uInvThick2.value.set(1 / (t.x * t.x), 1 / (t.y * t.y), 1 / (t.z * t.z));
    const f = u.uFoldW.value;
    u.uInvFoldW2.value.set(1 / (f.x * f.x), 1 / (f.y * f.y));
    u.uScale.value = this.BASE_SCALE / k;
    // At 6 steps a per-pixel jitter has nothing to average against and the
    // interleaved-gradient pattern shows through as a fixed screen hatch --
    // far worse than the banding it was there to hide, which the thickened
    // sheets of the same LOD already smooth out. Off below ~10 steps.
    // Capped at 0.5 even at high: a full-step jitter leaves a visible
    // interleaved-gradient hatch across the curtains, and with sheets
    // this soft there is very little banding for it to hide.
    u.uJitter.value = clamp((steps - 6) / 8, 0, 1) * 0.5;
  }

  _buildCurtains(ctx, sky) {
    const steps = Math.max(4, ctx.quality.get('auroraSteps') || 12);
    this._steps = steps;
    // Retuned after the postfx pipeline landed: the new exposure and
    // tonemap put the curtains far below where they were authored. Raised
    // again for review 4 -- see baseIntensity for the measurement.
    this.BASE_SCALE = 0.042;

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
      uBandThick: { value: new THREE.Vector3(4.5, 7.0, 11.0) },
      uInvThick2: { value: new THREE.Vector3() },
      uInvFoldW2: { value: new THREE.Vector2() },
      uJitter: { value: 1 },
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
      defines: { AUR_STEPS: steps },
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
        uniform float uTime, uDrift, uIntensity, uSFreq, uShear, uScale, uSkyKill, uJitter, uPxAngle, uMaxRadiance;
        uniform vec2 uArcRot, uFoldPos, uFoldW, uInvFoldW2;
        uniform vec3 uBandZ, uBandThick, uBandAmp, uInvThick2;
        uniform vec3 uColLow, uColMid, uColHigh, uColTop;
        varying vec3 vDir;
        ${ATMO_PARS}
        ${SKY_SAMPLE}
        ${HDR_CLAMP}

        const float AUR_H0 = 90.0;
        const float AUR_H1 = 150.0;
        const float AUR_INVH = 1.0 / (AUR_H1 - AUR_H0);

        float ign(vec2 px){ return fract(52.9829189 * fract(0.06711056*px.x + 0.00583715*px.y)); }

        // Drop-in for exp(-x*x), taking x*x. A cubed parabola matches the
        // Gaussian to within a few percent over the range that is visible and
        // costs no transcendental. With 16 steps x 3 bands x 2 folds that is
        // the difference between this effect fitting its budget and not.
        float bump(float x2) {
          float g = max(0.0, 1.0 - 0.283 * x2);
          return g * g * g;
        }

        void main() {
          vec3 dir = normalize(vDir);
          if (dir.y < -0.02 || uIntensity <= 0.0) discard;

          // Cheap attenuation FIRST. Near the horizon the air kills it and
          // beside the sun the twilight drowns it, and in the aurora pose
          // that is a third of the dome. No point marching those pixels.
          float am = 1.0 / max(dir.y + 0.06, 0.06);
          float ext = exp(-0.28 * (am - 1.0));
          float lum = dot(sampleSky(dir, uSunDir), vec3(0.2126, 0.7152, 0.0722));
          float atten = ext / (1.0 + lum * uSkyKill);
          if (atten < 0.035) discard;

          vec3 ro = vec3(0.0, Rg + 0.002, 0.0);
          float t0 = raySphere(ro, dir, Rg + AUR_H0).y;
          float t1 = raySphere(ro, dir, Rg + AUR_H1).y;
          if (t1 <= t0) discard;

          // The camera sits on the polar axis, so the across-arc coordinate
          // along the ray is exactly linear: q.y(t) = m * t. That means we can
          // solve for the slab of t that could possibly contain a curtain and
          // put all our steps there, instead of spreading them over a 300 km
          // shell traversal that is mostly empty. Rays that can never reach a
          // band -- the whole half-sky on the far side of the arc system --
          // leave without marching at all.
          float m = dir.x * uArcRot.y + dir.z * uArcRot.x;
          float W = 3.0 * uBandThick.z + 95.0;
          float lo = min(min(uBandZ.x, uBandZ.y), uBandZ.z) - W;
          float hi = max(max(uBandZ.x, uBandZ.y), uBandZ.z) + W;
          if (abs(m) > 1e-4) {
            float ta = lo / m, tb = hi / m;
            float nt0 = max(t0, min(ta, tb));
            float nt1 = min(t1, max(ta, tb));
            if (nt1 <= nt0) discard;
            t0 = nt0; t1 = nt1;
          } else if (0.0 < lo || 0.0 > hi) {
            discard;
          }

          float dt = (t1 - t0) / float(AUR_STEPS);
          float jit = 0.5 + (ign(gl_FragCoord.xy) - 0.5) * uJitter;

          // Accumulate emission and emission-weighted altitude, then look the
          // colour up ONCE. Per-step colour ramping was three smoothsteps and
          // three vec3 mixes for a gradient that is across pixels, not along
          // the ray.
          float accD = 0.0;
          float accV = 0.0;

          // Along-arc state, refreshed every other step. s moves slowly
          // along the ray -- the view crosses the curtains, it does not run
          // down them -- so the filament fetch and the warp sines can be held
          // for two steps. The altitude term still updates every step, which
          // is where the visible structure is. This roughly halves the texture
          // traffic, which is what the march is actually bound by.
          vec4 F = vec4(0.0);
          float sA = 0.0, sB = 0.0, sC = 0.0;

          for (int i = 0; i < AUR_STEPS; i++) {
            vec3 p = ro + dir * (t0 + dt * (float(i) + jit));
            float v = clamp((length(p) - Rg - AUR_H0) * AUR_INVH, 0.0, 1.0);

            vec2 q = vec2(p.x * uArcRot.x - p.z * uArcRot.y,
                          p.x * uArcRot.y + p.z * uArcRot.x);
            float s = q.x;

            if (i % 2 == 0) {
              // Explicit LOD from how many texels one pixel spans at this
              // distance. Without it the filaments alias into a cross-hatch
              // moire, which is exactly what fine striations turn into when
              // you sample them past Nyquist.
              float texPerPx = uSFreq * (t0 + dt * float(i)) * uPxAngle * 1024.0;
              float lod = max(0.0, log2(max(texPerPx, 1.0)));
              F = textureLod(uCurtain, vec2(s * uSFreq + uDrift + v * uShear, v * 0.86 + 0.07), lod);
              // Fold frequencies. At 0.0042 / 0.0131 / 0.0027 per km these
              // had periods of 1496 / 480 / 2327 km, and a wide framing only
              // spans ~200 km of arc, so the curtain showed at most a quarter
              // of one bend: an arc with no folding in it, which is half of
              // why it read as a smear. 3x up puts one or two folds inside
              // the frame, which is what a real arc does.
              sA = sin(s * 0.0125 + uDrift * 9.0);
              sB = sin(s * 0.0345 - uDrift * 5.0);
              sC = sin(s * 0.0082 - uDrift * 6.0 + 1.9);
            }

            float f1 = (s - uFoldPos.x);
            float f2 = (s - uFoldPos.y);
            float fold = bump(f1 * f1 * uInvFoldW2.x) + 0.7 * bump(f2 * f2 * uInvFoldW2.y);
            float foldWarp = fold * 26.0;

            float d1 = q.y - uBandZ.x - (16.0 * sA + 7.0 * sB) - foldWarp;
            float d2 = q.y - uBandZ.y - (26.0 * sC + 11.0 * sB) - foldWarp * 0.7;
            float d3 = q.y - uBandZ.z - (40.0 * sC);

            float dens = bump(d1 * d1 * uInvThick2.x) * F.r * uBandAmp.x
                       + bump(d2 * d2 * uInvThick2.y) * F.g * uBandAmp.y
                       + bump(d3 * d3 * uInvThick2.z) * F.b * uBandAmp.z;
            dens *= F.a * (1.0 + 1.25 * fold);
            if (dens <= 0.0) continue;

            // Rippling lower border -- a constant-altitude border draws a
            // dead-straight line across the frame. The offset is combed by
            // the filament field as well as by the fold sines, so the bright
            // lower edge ends in rays hanging below it rather than in a
            // drawn line; that ragged bottom edge is the most recognisable
            // thing about a real curtain and §7 asks for it by name.
            float vv = clamp(v - (0.075 * sB + 0.045 * sA) - 0.075 * (F.r - 0.35), 0.0, 1.0);
            float b = (vv - 0.045) * 29.41;
            float vert = smoothstep(0.0, 0.03, vv) * (0.06 + 0.40 * exp(-vv * 3.6))
                       + 2.70 * bump(b * b);

            float w = dens * vert;
            accD += w;
            accV += w * vv;
          }

          if (accD <= 1e-6) discard;
          float vv = accV / accD;
          vec3 col = mix(uColLow, uColMid, smoothstep(0.0, 0.45, vv));
          col = mix(col, uColHigh, smoothstep(0.42, 0.88, vv));
          col = mix(col, uColTop, smoothstep(0.86, 1.0, vv) * 0.6);

          // Additive into the same HDR target; bounded for the same reason.
          vec3 acc = clampRadiance(col * (accD * dt * uScale * uIntensity * atten), uMaxRadiance);
          gl_FragColor = vec4(max(acc, 0.0), 1.0);
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
    const steps = Math.max(4, ctx.quality.get('auroraSteps') || 12);
    if (steps !== this._steps && this.dome) {
      this._steps = steps;
      this._applySteps(steps);
      this.dome.material.defines.AUR_STEPS = steps;
      this.dome.material.needsUpdate = true;
    }
  }
}
