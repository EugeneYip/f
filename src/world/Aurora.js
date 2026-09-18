import * as THREE from 'three';
import { rng, gauss, clamp, lerp, fbm1, TAU } from '../util/math.js';
import { ATMO_PARS, SKY_SAMPLE } from '../shaders/sky.glsl.js';

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
    this.baseIntensity = 0.62;
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
    const XF = [24, 48, 96, 192];
    const YF = [2, 3, 5, 8];
    const AMP = [0.5, 0.26, 0.15, 0.09];
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
          // than a soft cloud.
          v = Math.pow(clamp(v * 2.05 - 0.50, 0, 1), 1.30);
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
    tex.minFilter = THREE.LinearFilter;
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
    u.uBandThick.value.set(4.5 * k, 7.0 * k, 11.0 * k);
    u.uScale.value = this.BASE_SCALE / k;
  }

  _buildCurtains(ctx, sky) {
    const steps = Math.max(4, ctx.quality.get('auroraSteps') || 12);
    this._steps = steps;
    this.BASE_SCALE = 0.0125;

    // Arc frame. Rotated so the bands run ACROSS the `aurora` pose's view
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
      uSFreq: { value: 0.0009 },
      uShear: { value: 0.016 },
      // Across-arc distances in km. These set the ELEVATION each curtain
      // appears at: atan(90 / |z|). -110/-200/-340 puts them at roughly
      // 39/24/15 degrees, so the top band clears the sun's glow.
      uBandZ: { value: new THREE.Vector3(-110, -200, -340) },
      uBandThick: { value: new THREE.Vector3(4.5, 7.0, 11.0) },
      uBandAmp: { value: new THREE.Vector3(1.0, 0.72, 0.45) },
      uFoldPos: { value: new THREE.Vector2(0, 0) },
      uFoldW: { value: new THREE.Vector2(150, 230) },
      uColLow: { value: new THREE.Color(0x7dffc4) },
      uColMid: { value: new THREE.Color(0x62f0b4) },
      uColHigh: { value: new THREE.Color(0xa77dff) },
      uColTop: { value: new THREE.Color(0xff5d84) },
      uScale: { value: 0.0125 },
      uSkyKill: { value: 4.5 },
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
        uniform float uTime, uDrift, uIntensity, uSFreq, uShear, uScale, uSkyKill;
        uniform vec2 uArcRot, uFoldPos, uFoldW;
        uniform vec3 uBandZ, uBandThick, uBandAmp;
        uniform vec3 uColLow, uColMid, uColHigh, uColTop;
        varying vec3 vDir;
        ${ATMO_PARS}
        ${SKY_SAMPLE}

        const float AUR_H0 = 90.0;
        const float AUR_H1 = 150.0;

        float ign(vec2 px){ return fract(52.9829189 * fract(0.06711056*px.x + 0.00583715*px.y)); }

        void main() {
          vec3 dir = normalize(vDir);
          if (dir.y < -0.02 || uIntensity <= 0.0) discard;

          vec3 ro = vec3(0.0, Rg + 0.002, 0.0);
          float t0 = raySphere(ro, dir, Rg + AUR_H0).y;
          float t1 = raySphere(ro, dir, Rg + AUR_H1).y;
          if (t1 <= t0) discard;

          float dt = (t1 - t0) / float(AUR_STEPS);
          float jit = ign(gl_FragCoord.xy);
          vec3 acc = vec3(0.0);

          for (int i = 0; i < AUR_STEPS; i++) {
            vec3 p = ro + dir * (t0 + dt * (float(i) + jit));
            float v = clamp((length(p) - Rg - AUR_H0) / (AUR_H1 - AUR_H0), 0.0, 1.0);

            vec2 q = vec2(p.x * uArcRot.x - p.z * uArcRot.y,
                          p.x * uArcRot.y + p.z * uArcRot.x);
            float s = q.x;

            // One fetch: R/G/B are three independent curtain fields, A is the
            // along-arc envelope. uShear twists the filaments slightly with
            // altitude so they are not perfectly parallel.
            vec4 F = texture2D(uCurtain, vec2(s * uSFreq + uDrift + v * uShear, v * 0.86 + 0.07));

            // Travelling curtain folds.
            float f1 = exp(-pow((s - uFoldPos.x) / uFoldW.x, 2.0));
            float f2 = exp(-pow((s - uFoldPos.y) / uFoldW.y, 2.0));
            float fold = f1 + 0.7 * f2;
            float foldWarp = fold * 26.0;

            float dens = 0.0;
            float w1 = 16.0 * sin(s * 0.0042 + uDrift * 9.0) + 7.0 * sin(s * 0.0131 - uDrift * 5.0);
            float d1 = q.y - uBandZ.x - w1 - foldWarp;
            dens += exp(-d1 * d1 / (uBandThick.x * uBandThick.x)) * F.r * uBandAmp.x;

            float w2 = 26.0 * sin(s * 0.0027 - uDrift * 6.0 + 1.9) + 11.0 * sin(s * 0.0093 + uDrift * 3.0);
            float d2 = q.y - uBandZ.y - w2 - foldWarp * 0.7;
            dens += exp(-d2 * d2 / (uBandThick.y * uBandThick.y)) * F.g * uBandAmp.y;

            float w3 = 40.0 * sin(s * 0.0018 + uDrift * 4.0 + 4.1);
            float d3 = q.y - uBandZ.z - w3;
            dens += exp(-d3 * d3 / (uBandThick.z * uBandThick.z)) * F.b * uBandAmp.z;

            dens *= F.a * (1.0 + 1.25 * fold);

            // The lower border has to RIPPLE along the arc. Leaving it at a
            // constant altitude draws a dead-straight line across the whole
            // frame, which is the most synthetic thing an aurora can do.
            float bw = 0.075 * sin(s * 0.0155 + uDrift * 11.0)
                     + 0.045 * sin(s * 0.0361 - uDrift * 7.0);
            float vv = clamp(v - bw, 0.0, 1.0);

            // Bright lower border, diffuse fade to the top.
            // Weighted hard toward the lower border. A curtain that spends its
            // energy on a diffuse body reads as green cloud; concentrating it
            // into the border is what makes the eye see an edge-on sheet.
            float vert = smoothstep(0.0, 0.03, vv) * (0.10 + 0.55 * exp(-vv * 3.4))
                       + 1.90 * exp(-pow((vv - 0.045) / 0.034, 2.0));

            vec3 col = mix(uColLow, uColMid, smoothstep(0.0, 0.45, vv));
            col = mix(col, uColHigh, smoothstep(0.42, 0.88, vv));
            col = mix(col, uColTop, smoothstep(0.86, 1.0, vv) * 0.6);

            acc += col * dens * vert;
          }

          acc *= dt * uScale * uIntensity;

          // Extinction through the air below it, and suppression wherever the
          // twilight is bright -- aurora is invisible next to the sun.
          float am = 1.0 / max(dir.y + 0.06, 0.06);
          acc *= exp(-0.28 * (am - 1.0));
          float lum = dot(sampleSky(dir, uSunDir), vec3(0.2126, 0.7152, 0.0722));
          acc *= 1.0 / (1.0 + lum * uSkyKill);

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

    if (!this.enabled) { this.intensity = 0; if (this.uniforms) this.uniforms.uIntensity.value = 0; return; }

    // Gentle breathing. Never fully off, never a laser show.
    const breathe = 0.5 + 0.5 * fbm1(t * 0.055, 3, 91);
    this.intensity = clamp(this.baseIntensity * (0.55 + 0.62 * breathe), 0, 1);

    // A pure function of ctx.time, not an accumulator: AGENTS.md requires
    // the same time to give the same image regardless of the dt sequence.
    this._drift = t * 0.0042;
    const u = this.uniforms;
    u.uTime.value = t;
    u.uDrift.value = this._drift;
    u.uIntensity.value = this.intensity;
    // Folds travel along the arc and wrap over a long period.
    u.uFoldPos.value.set(
      ((t * 16.0 + 900) % 3400) - 1700,
      ((-t * 9.5 + 2200) % 3400) - 1700,
    );

    this.starUniforms.uTime.value = t;
    this.starUniforms.uPix.value = ctx.renderer.getPixelRatio();

    // A faint greenish lift on the ambient so the snow registers the aurora.
    // Rebuilt from the sky's base colour every frame -- adding to ctx.skyColor
    // in place would compound without bound.
    const sky = ctx.sky;
    if (sky?.baseSkyColor) {
      ctx.skyColor.copy(sky.baseSkyColor).lerp(this.skyLightColor, 0.055 * this.intensity);
    }
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
