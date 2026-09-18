import * as THREE from 'three';
import { clamp, DEG } from '../util/math.js';
import {
  ATMO_PARS, ATMO_TRANSMITTANCE, ATMO_SAMPLE_TRANS, ATMO_SCATTER,
  SKY_SAMPLE, SUN_DISC, SKY_DITHER,
} from '../shaders/sky.glsl.js';

// ---------------------------------------------------------------------------
// CPU mirror of the GPU atmosphere.
//
// The same numbers, the same band compression. This exists so that
// sunColorAt() and the palette written back onto ctx are *provably* the same
// atmosphere the sky shader draws, with no GPU readback and no stall. If these
// constants ever diverge from src/shaders/sky.glsl.js the sun will stop
// matching the sky it hangs in.
// ---------------------------------------------------------------------------
const RG = 6371, RT = 6471, HR = 8, HM = 1.2;
const BR = [5.802e-3, 13.558e-3, 33.100e-3];
const BME = 1.450e-3;   // clean polar aerosol; see sky.glsl.js
const BO = [0.910e-3, 2.6334e-3, 0.119e-3];   // 1.4x polar ozone; see sky.glsl.js
const OZ_C = 25, OZ_W = 15;
const BAND_K = 0.805;

/** Extraterrestrial solar spectrum sampled at the RGB band centres. */
const SOLAR = [1.0, 0.975, 0.94];

/** The elevation the art bible's palette is authored for (§1: "4-8 deg"). */
const REF_ELEV_DEG = 5;

/**
 * Residual calibration. The physical model alone lands on #ffd0a2 at 5 deg;
 * the bible says #ffd2a1. This nudges the last 2% so the reference elevation
 * is exact while every other elevation stays model-driven.
 */
const CAL = [1.0, 1.05337, 0.98052];

function raySphereY(roy, rdx, rdy, R) {
  const b = roy * rdy;
  const c = roy * roy - R * R;
  const d = b * b - c;
  if (d < 0) return [1, -1];
  const s = Math.sqrt(d);
  return [-b - s, -b + s];
}

/** Optical depth from altitude h0 (km) along a ray with cos(zenith)=mu. */
function opticalDepth(h0, mu, N = 64) {
  const roy = RG + h0;
  const rdx = Math.sqrt(Math.max(0, 1 - mu * mu));
  const g = raySphereY(roy, rdx, mu, RG);
  if (g[1] > 0 && g[0] > -1e-3) return null;      // below the horizon
  const tMax = raySphereY(roy, rdx, mu, RT)[1];
  const t = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const f0 = i / N, f1 = (i + 1) / N;
    const ta = tMax * f0 * f0, tb = tMax * f1 * f1;
    const tm = 0.5 * (ta + tb), ds = tb - ta;
    const h = Math.max(0, Math.hypot(rdx * tm, roy + mu * tm) - RG);
    const dr = Math.exp(-h / HR), dm = Math.exp(-h / HM);
    const doz = Math.max(0, 1 - Math.abs(h - OZ_C) / OZ_W);
    for (let c = 0; c < 3; c++) t[c] += (BR[c] * dr + BME * dm + BO[c] * doz) * ds;
  }
  return t;
}

/** Band-compressed transmittance to space. Linear RGB, 0..1. */
function transmittance(h0, mu, k = BAND_K) {
  const t = opticalDepth(h0, mu);
  if (!t) return [0, 0, 0];
  return t.map((v) => Math.exp(-Math.log(1 + k * v) / k));
}

const LUM = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// ---------------------------------------------------------------------------

/**
 * Physically-plausible twilight sky + IBL.
 *
 * Structure:
 *   1. a 256x64 transmittance LUT  (altitude x cos-zenith)
 *   2. a 512x512 sky-view LUT      (|azimuth-to-sun| x warped elevation)
 *   3. a screen-space quad that samples (2), adds the solar disc analytically
 *      and dithers
 *   4. a sky-only scene fed to PMREMGenerator for scene.environment
 *
 * (1) and (2) are regenerated only when the sun moves. Per frame this system
 * costs one fullscreen textured quad.
 */
export class Sky {
  name = 'sky';
  order = -90;

  constructor() {
    this.elevationDeg = REF_ELEV_DEG;
    this.azimuthDeg = -155;
    this.envMap = null;
    this._lutDirty = true;
    this._envDirty = true;
    this._lastSun = new THREE.Vector3();
    this._envSize = 0;

    // Tunables. Grouped here because they are the only numbers in this file a
    // reviewer should ever need to touch.
    this.params = {
      /** Top-of-atmosphere solar irradiance in render units. Sets how bright
       *  the whole sky sits relative to ctx.sunIntensity. */
      sunIrradiance: 1.75,
      /** Isotropic multiple-scattering strength. This is what keeps the zenith
       *  a deep blue rather than black, and what puts the pink in the
       *  anti-solar band. Above ~1.4 it starts to look like fog. */
      msScale: 0.50,
      /** Aerosol anisotropy for the broad glow baked into the LUT. */
      mieG: 0.70,
      /** Snow. The lower hemisphere of the IBL is this, lit. */
      groundAlbedo: 0.82,
      /** Solar angular radius, radians. The real sun is 0.00465. */
      sunRadius: 0.00465,
      sunDiscScale: 42.0,
      sunGlowScale: 3.0,
      envGlowScale: 1.1,
      /** Anti-solar backscatter strength (Belt of Venus). See ATMO_SCATTER.
       *  Comparable in magnitude to the isotropic MS term it sits beside,
       *  which works out around 0.01; at 0.4 the whole anti-solar sky goes
       *  terracotta. A blush, not a stripe. */
      beltScale: 0.060,
      /** Relative dither amplitude. ~1 code value at 8 bit in the midtones. */
      dither: 0.010,
      scatterSteps: 40,
    };
  }

  // -- lifecycle ------------------------------------------------------------

  async init(ctx) {
    this.ctx = ctx;
    const p = this.params;

    const d = ctx.sunDirection;
    this.elevationDeg = Math.asin(clamp(d.y, -1, 1)) / DEG;
    this.azimuthDeg = Math.atan2(d.x, d.z) / DEG;

    // Preserve whatever intensity the orchestrator authored as the value that
    // belongs at the *starting* elevation, then scale relative to it.
    this._refIntensity = ctx.sunIntensity;
    this._refElevDeg = this.elevationDeg;
    this._refLum = this._sunLuminance(this.elevationDeg);

    this.baseSkyColor = new THREE.Color();
    this.baseGroundBounce = new THREE.Color();

    this.u = {
      uTransLut: { value: null },
      uTransTexel: { value: new THREE.Vector2(1 / 256, 1 / 64) },
      uSkyLut: { value: null },
      uSkyTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
      uSunDir: { value: new THREE.Vector3().copy(d) },
      uSunTint: { value: new THREE.Vector3(1, 1, 1) },
      uSunRadius: { value: p.sunRadius },
      uSunDiscScale: { value: p.sunDiscScale },
      uSunGlowScale: { value: p.sunGlowScale },
      uEnvGlowScale: { value: p.envGlowScale },
      uDither: { value: p.dither },
    };
    /** Other atmosphere systems reuse these uniform objects by reference so
     *  there is exactly one source of truth for the sky. */
    this.shared = this.u;

    this._buildLuts(ctx);
    this._buildSkyQuad(ctx);
    this._buildEnvScene(ctx);

    this.applyPalette(ctx);
    this._renderLuts(ctx);
    this._lutDirty = false;

    try {
      this._regenerateEnv(ctx);
    } catch (e) {
      // An IBL failure must not cost us the visible sky.
      console.warn('[sky] PMREM generation failed; falling back to no envMap', e);
    }
    this._envDirty = false;

    this._lastSun.copy(d);
    ctx.sky = this;
  }

  dispose() {
    this._transRT?.dispose();
    this._skyRT?.dispose();
    this._envRT?.dispose();
    this._pmrem?.dispose();
    this.quad?.geometry.dispose();
    this.quad?.material.dispose();
    this._passScene?.children[0]?.geometry.dispose();
    this._transMat?.dispose();
    this._skyMat?.dispose();
    this._envDome?.geometry.dispose();
    this._envDome?.material.dispose();
  }

  // -- public contract ------------------------------------------------------

  /**
   * Direct sun colour at a given elevation. Normalised so the brightest
   * channel is 1 (intensity lives in ctx.sunIntensity).
   * @param {number} elevationRadians
   * @returns {THREE.Color}
   */
  sunColorAt(elevationRadians) {
    const mu = Math.sin(elevationRadians);
    const T = transmittance(0.002, mu);
    let c = [T[0] * SOLAR[0] * CAL[0], T[1] * SOLAR[1] * CAL[1], T[2] * SOLAR[2] * CAL[2]];
    const m = Math.max(c[0], c[1], c[2]);
    if (m <= 1e-6) {
      // Sun below the horizon: hold the last lit hue rather than going black.
      c = [1, 0.62, 0.30];
    } else {
      c = c.map((v) => v / m);
    }
    return new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
  }

  /** Drive time of day. Azimuth is measured from +Z toward +X, like Debug.setSun. */
  setElevation(deg, azimuthDeg = this.azimuthDeg) {
    const ctx = this.ctx;
    if (!ctx) return;
    const e = deg * DEG, a = azimuthDeg * DEG;
    ctx.sunDirection.set(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)).normalize();
    ctx.sunDirty = true;
    this.elevationDeg = deg;
    this.azimuthDeg = azimuthDeg;
    this._lutDirty = true;
    this._envDirty = true;
  }

  /**
   * Writes the sun, sky-fill and snow-bounce colours back onto ctx from the
   * scattering model, so the lighting rig can never disagree with the sky.
   *
   * Sun hue is fully model-driven. Sky and bounce are anchored to the bible's
   * palette at the reference elevation and then shifted by the *ratio* of the
   * sun tint, with an exponent < 1 because skylight reddens more slowly than
   * the direct beam. Luminance is renormalised so moving the sun changes hue
   * without silently changing the ambient level.
   */
  applyPalette(ctx) {
    const elevRad = Math.asin(clamp(ctx.sunDirection.y, -1, 1));
    this.elevationDeg = elevRad / DEG;
    this.azimuthDeg = Math.atan2(ctx.sunDirection.x, ctx.sunDirection.z) / DEG;

    ctx.sunColor.copy(this.sunColorAt(elevRad));

    const lum = this._sunLuminance(this.elevationDeg);
    ctx.sunIntensity = this._refIntensity * clamp(lum / Math.max(this._refLum, 1e-6), 0.3, 2.1);

    const ref = this._sunTintNorm(this._refElevDeg);
    const now = this._sunTintNorm(this.elevationDeg);
    const ratio = [
      now[0] / Math.max(ref[0], 1e-5),
      now[1] / Math.max(ref[1], 1e-5),
      now[2] / Math.max(ref[2], 1e-5),
    ];

    const shift = (hex, power, out) => {
      const b = new THREE.Color(hex);
      const base = [b.r, b.g, b.b];
      const c = base.map((v, i) => v * Math.pow(Math.max(ratio[i], 1e-4), power));
      const k = LUM(base) / Math.max(LUM(c), 1e-6);
      out.setRGB(c[0] * k, c[1] * k, c[2] * k, THREE.LinearSRGBColorSpace);
      return out;
    };

    shift(0x8fb4e8, 0.35, this.baseSkyColor);
    shift(0xcfe2f7, 0.55, this.baseGroundBounce);
    ctx.skyColor.copy(this.baseSkyColor);
    ctx.groundBounce.copy(this.baseGroundBounce);

    // Sun radiance reaching the camera, for the disc and the aureole.
    const T = transmittance(0.002, Math.sin(elevRad));
    const I = this.params.sunIrradiance;
    this.u.uSunTint.value.set(
      Math.max(T[0], 1e-4) * SOLAR[0] * I,
      Math.max(T[1], 1e-4) * SOLAR[1] * I,
      Math.max(T[2], 1e-4) * SOLAR[2] * I,
    );
    this.u.uSunDir.value.copy(ctx.sunDirection);
  }

  _sunTintNorm(elevDeg) {
    const T = transmittance(0.002, Math.sin(elevDeg * DEG));
    const c = [T[0] * SOLAR[0], T[1] * SOLAR[1], T[2] * SOLAR[2]];
    const m = Math.max(c[0], c[1], c[2], 1e-6);
    return c.map((v) => v / m);
  }

  _sunLuminance(elevDeg) {
    const T = transmittance(0.002, Math.sin(elevDeg * DEG));
    return LUM([T[0] * SOLAR[0], T[1] * SOLAR[1], T[2] * SOLAR[2]]);
  }

  // -- LUTs -----------------------------------------------------------------

  _rt(w, h) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    rt.texture.colorSpace = THREE.NoColorSpace;
    return rt;
  }

  _buildLuts(ctx) {
    this._transRT = this._rt(256, 64);
    this._skyRT = this._rt(512, 512);
    this.u.uTransLut.value = this._transRT.texture;
    this.u.uSkyLut.value = this._skyRT.texture;
    this.u.uTransTexel.value.set(1 / 256, 1 / 64);
    this.u.uSkyTexel.value.set(1 / 512, 1 / 512);

    // Fullscreen pass plumbing, reused for both LUTs.
    this._passScene = new THREE.Scene();
    this._passCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._passMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this._passMesh.frustumCulled = false;
    this._passScene.add(this._passMesh);

    const VS = /* glsl */ `
      void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
    `;

    this._transMat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: new THREE.Vector2(256, 64) } },
      vertexShader: VS,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec2 uSize;
        ${ATMO_PARS}
        ${ATMO_TRANSMITTANCE}
        void main() {
          // Texel i holds parameter i/(N-1), so the endpoints are exact and a
          // half-texel-corrected lookup is an identity at the texel centres.
          vec2 p = (gl_FragCoord.xy - 0.5) / (uSize - 1.0);
          float h, mu;
          transFromUv(p, h, mu);
          gl_FragColor = vec4(computeTransmittance(h, mu), 1.0);
        }
      `,
      depthTest: false, depthWrite: false, toneMapped: false,
    });

    const groundLinear = new THREE.Color(0xf2f6fb);
    this._skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: new THREE.Vector2(512, 512) },
        uCamAlt: { value: 0.0015 },
        uSunDirLocal: { value: new THREE.Vector3(0, 0, 1) },
        uTransLut: this.u.uTransLut,
        uTransTexel: this.u.uTransTexel,
        uSunIrradiance: { value: new THREE.Vector3() },
        uMsScale: { value: this.params.msScale },
        uMieG: { value: this.params.mieG },
        uGroundAlbedo: {
          value: new THREE.Vector3(groundLinear.r, groundLinear.g, groundLinear.b)
            .multiplyScalar(this.params.groundAlbedo),
        },
        uGroundAmbient: { value: new THREE.Vector3() },
        uBeltTint: { value: new THREE.Vector3(1, 0.5, 0.35) },
        uBeltScale: { value: 0 },
      },
      vertexShader: VS,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec2 uSize;
        uniform float uCamAlt;
        uniform vec3 uSunDirLocal;
        ${ATMO_PARS}
        ${ATMO_SAMPLE_TRANS}
        ${ATMO_SCATTER}
        void main() {
          vec2 p = (gl_FragCoord.xy - 0.5) / (uSize - 1.0);
          vec3 rd;
          skyViewFromUv(p, 0.0, rd);
          vec3 ro = vec3(0.0, Rg + uCamAlt, 0.0);
          gl_FragColor = vec4(atmoScatter(ro, rd, uSunDirLocal, ${this.params.scatterSteps}), 1.0);
        }
      `,
      depthTest: false, depthWrite: false, toneMapped: false,
    });
  }

  _renderLuts(ctx) {
    const r = ctx.renderer;
    const prevRT = r.getRenderTarget();
    const prevTone = r.toneMapping;
    r.toneMapping = THREE.NoToneMapping;

    // The sky LUT lives in a sun-relative frame: azimuth 0 points at the sun,
    // so a full 360 degrees of sky fits in 180 degrees of texture.
    const elev = Math.asin(clamp(ctx.sunDirection.y, -1, 1));
    const su = this._skyMat.uniforms;
    su.uSunDirLocal.value.set(0, Math.sin(elev), Math.cos(elev));

    const I = this.params.sunIrradiance;
    su.uSunIrradiance.value.set(SOLAR[0] * I, SOLAR[1] * I, SOLAR[2] * I);
    su.uMsScale.value = this.params.msScale;
    su.uMieG.value = this.params.mieG;

    // Irradiance arriving at the snow from the sky dome, used only to light the
    // lower hemisphere of the IBL. Rayleigh-tinted, and it never goes to zero
    // because a twilight sky is still a large bright source.
    // groundBoost: Environment.js runs a hemisphere light, a snow-bounce
    // directional and a rim directional on top of this IBL, so the snow is
    // lit by considerably more than the sky alone. Without the boost the
    // IBL's lower hemisphere is much darker than the terrain it is supposed
    // to be a picture of.
    const groundBoost = 2.4;
    const amb = 0.10 * I * groundBoost * Math.max(0.28, Math.sin(elev) + 0.34);
    su.uGroundAmbient.value.set(0.175 * amb, 0.410 * amb, 1.0 * amb);

    // Grazing-limb colour: the transmittance of a ray skimming the limb at
    // 5 km. Normalised to peak 1 so beltScale alone sets the strength, and
    // faded out as the sun climbs -- there is no Belt of Venus at midday, and
    // barely one until the sun is near the horizon.
    const bt = transmittance(5.0, 0.012, 0.805);
    const bm = Math.max(bt[0], bt[1], bt[2], 1e-6);
    su.uBeltTint.value.set(bt[0] / bm, bt[1] / bm, bt[2] / bm);
    const elevDeg = elev / DEG;
    su.uBeltScale.value = this.params.beltScale *
      (1 - Math.min(1, Math.max(0, (elevDeg - 1) / 13)));

    this._passMesh.material = this._transMat;
    r.setRenderTarget(this._transRT);
    r.render(this._passScene, this._passCam);

    this._passMesh.material = this._skyMat;
    r.setRenderTarget(this._skyRT);
    r.render(this._passScene, this._passCam);

    r.setRenderTarget(prevRT);
    r.toneMapping = prevTone;
  }

  // -- visible sky ----------------------------------------------------------

  _buildSkyQuad(ctx) {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.u,
        uInvVP: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
      },
      vertexShader: /* glsl */ `
        uniform mat4 uInvVP;
        uniform vec3 uCamPos;
        varying vec3 vRay;
        void main() {
          vec4 p = uInvVP * vec4(position.xy, 1.0, 1.0);
          vRay = p.xyz / p.w - uCamPos;
          gl_Position = vec4(position.xy, 1.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uSunDir;
        uniform vec3 uSunTint;
        uniform float uSunRadius, uSunDiscScale, uSunGlowScale, uDither;
        varying vec3 vRay;
        ${ATMO_PARS}
        ${SKY_SAMPLE}
        ${SUN_DISC}
        ${SKY_DITHER}
        void main() {
          vec3 dir = normalize(vRay);
          vec3 col = sampleSkyAbove(dir, uSunDir);
          float above = smoothstep(-0.035, 0.015, uSunDir.y);
          col += sunDiscAndAureole(sunTheta(dir, uSunDir), uSunTint,
                                   uSunRadius, uSunDiscScale, uSunGlowScale) * above;
          col *= 1.0 + triDither(gl_FragCoord.xy) * uDither;
          gl_FragColor = vec4(max(col, 0.0), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    this.quad.name = 'sky';
    this.quad.frustumCulled = false;
    this.quad.renderOrder = -10000;
    // Derive the view ray from the camera actually being used, at draw time:
    // that keeps us correct under TAA jitter, which mutates projectionMatrix
    // after prerender() has run.
    this.quad.onBeforeRender = (renderer, scene, camera) => {
      const u = mat.uniforms;
      u.uInvVP.value.copy(camera.projectionMatrix).invert().premultiply(camera.matrixWorld);
      u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    };
    ctx.scene.add(this.quad);
  }

  // -- IBL ------------------------------------------------------------------

  _buildEnvScene(ctx) {
    this._envScene = new THREE.Scene();
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uSunDir;
        uniform vec3 uSunTint;
        uniform float uSunRadius, uEnvGlowScale;
        varying vec3 vDir;
        ${ATMO_PARS}
        ${SKY_SAMPLE}
        ${SUN_DISC}
        void main() {
          vec3 dir = normalize(vDir);
          vec3 col = sampleSky(dir, uSunDir);
          // Aureole only. The DirectionalLight already carries the disc's
          // energy; putting the core in here too would double-count the sun.
          col += sunDiscAndAureole(sunTheta(dir, uSunDir), uSunTint,
                                   uSunRadius, 0.0, uEnvGlowScale);
          gl_FragColor = vec4(max(col, 0.0), 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
      toneMapped: false,
    });
    this._envDome = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 32), mat);
    this._envDome.frustumCulled = false;
    this._envScene.add(this._envDome);
  }

  _regenerateEnv(ctx) {
    const size = ctx.quality.get('envMapSize') || 128;
    if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(ctx.renderer);
    const prev = this._envRT;
    this._envRT = this._pmrem.fromScene(this._envScene, 0, 1, 40, { size });
    prev?.dispose();
    this._envSize = size;
    this.envMap = this._envRT.texture;
    ctx.scene.environment = this.envMap;
    // Environment.js still runs a HemisphereLight, a snow-bounce directional
    // and a rim directional, all sized for a world with no IBL. Until those go
    // away the two ambient systems stack, so the image-based half is dialled
    // back rather than doubling the fill. Set ONCE, not on every regeneration,
    // so another system can override it without us fighting over the value.
    if (!this._envIntensitySet) {
      ctx.scene.environmentIntensity = 0.6;
      this._envIntensitySet = true;
    }
  }

  // -- per frame ------------------------------------------------------------

  update(dt, ctx) {
    // ctx.sunDirty is consumed by Environment (order -100) before we run, so
    // we watch the vector itself. That also catches FoxDebug.setSun().
    if (!this._lastSun.equals(ctx.sunDirection)) {
      this._lastSun.copy(ctx.sunDirection);
      this._lutDirty = true;
      this._envDirty = true;
    }
  }

  prerender(ctx) {
    if (this._lutDirty) {
      this.applyPalette(ctx);
      this._renderLuts(ctx);
      this._lutDirty = false;
    }
    if (this._envDirty) {
      try {
        this._regenerateEnv(ctx);
      } catch (e) {
        console.warn('[sky] PMREM regeneration failed', e);
      }
      this._envDirty = false;
    }
  }

  onQuality(e, ctx) {
    if ((ctx.quality.get('envMapSize') || 128) !== this._envSize) this._envDirty = true;
  }
}
