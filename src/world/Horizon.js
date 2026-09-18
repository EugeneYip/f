import * as THREE from 'three';
import { ATMO_PARS, SKY_SAMPLE, SKY_DITHER } from '../shaders/sky.glsl.js';

/**
 * Distant landscape, so the world is not an infinite flat disc.
 *
 * Three concentric rings of snow ridges at increasing distance plus an ice-fog
 * band hugging the horizon line. All of it is background: ~3k triangles and
 * four draw calls total.
 *
 * The one idea worth stealing from this file: the ridges do not fade toward a
 * *constant* haze colour. They fade toward `sampleSky()` evaluated at the
 * horizon in that fragment's own direction. That means the range is warm where
 * it crosses the sun's glow and pink where it crosses the Belt of Venus, for
 * free, and the tops of the ridges dissolve into the sky with no seam because
 * they are literally converging on the sky's own value.
 */
export class Horizon {
  name = 'horizon';
  order = -80;

  constructor() {
    this.rings = [];
    // radius (m), ridge height (m), base (m), aerial mix at top/base, seed
    this.layout = [
      // min matters more than h: anything below the terrain rim is
      // invisible, so the low end of each profile has to clear the horizon
      // line or the range shows up as a couple of stray humps.
      // Radii are pinned between the terrain's outer clipmap ring (which can
      // reach ~480 m at ultra, with a skirt) and the 900 m far plane. Inside
      // that and the range is simply buried in the snowfield.
      { r: 560, h: 26, min: 7,  base: -140, aerialTop: 0.50, aerialBase: 0.70, seed: 7717, rough: 1.0 },
      { r: 690, h: 44, min: 13, base: -160, aerialTop: 0.66, aerialBase: 0.83, seed: 3391, rough: 0.85 },
      { r: 840, h: 66, min: 20, base: -180, aerialTop: 0.80, aerialBase: 0.93, seed: 9043, rough: 0.7 },
    ];
    this.fog = { r: 520, top: 30, bottom: -60 };
  }

  init(ctx) {
    this.ctx = ctx;
    const sky = ctx.sky;
    if (!sky?.shared) {
      // Without the sky LUT there is nothing sensible to fade into.
      console.warn('[horizon] no sky system; skipping');
      return;
    }
    this.group = new THREE.Group();
    this.group.name = 'horizon';
    this.group.frustumCulled = false;

    const snow = new THREE.Color(0xaac4e0);   // bible §3 aerial perspective target
    for (let i = 0; i < this.layout.length; i++) {
      const L = this.layout[i];
      const mesh = new THREE.Mesh(this._ridgeGeometry(L), this._ridgeMaterial(sky, L, snow));
      mesh.frustumCulled = false;
      mesh.renderOrder = -9000 + i;   // far ring first; they are opaque anyway
      this.group.add(mesh);
      this.rings.push(mesh);
    }

    this.fogBand = new THREE.Mesh(this._fogGeometry(), this._fogMaterial(sky));
    this.fogBand.frustumCulled = false;
    this.fogBand.renderOrder = -50;
    this.group.add(this.fogBand);

    ctx.scene.add(this.group);
    ctx.horizon = this;
  }

  dispose() {
    this.group?.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  }

  /**
   * Ridge profile. Integer frequencies only, so the function is *exactly*
   * periodic over the ring and the seam at azimuth 0 cannot show. A ridged
   * transform (1-|x|) on the low octaves gives peaks rather than dunes.
   */
  _profile(a, L) {
    const F = [2, 3, 5, 8, 13, 21, 34, 55, 89, 144];
    let s = 0, norm = 0;
    for (let k = 0; k < F.length; k++) {
      const n = F[k];
      // -0.58 rather than -1: a steeper spectrum collapses into one broad
      // hump, which reads as a smog bank rather than a ridge line.
      const amp = Math.pow(n, -0.58) * (k < 4 ? 1.0 : L.rough);
      const ph = (L.seed * (k + 1) * 0.61803398875) % 1 * Math.PI * 2;
      const v = Math.sin(n * a + ph);
      s += amp * (k < 6 ? (1 - Math.abs(v)) * 2 - 1 : v);
      norm += amp;
    }
    const t = s / norm;                       // roughly -1..1
    return Math.pow(Math.max(0, t * 0.5 + 0.5), 1.35);
  }

  _ridgeGeometry(L) {
    const N = 512;
    const pos = new Float32Array((N + 1) * 2 * 3);
    const hv = new Float32Array((N + 1) * 2);      // 0 at base, 1 at ridge top
    const az = new Float32Array((N + 1) * 2);
    const idx = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const x = Math.sin(a) * L.r, z = Math.cos(a) * L.r;
      const top = L.min + (L.h - L.min) * this._profile(a, L);
      const o = i * 2;
      pos[o * 3 + 0] = x; pos[o * 3 + 1] = L.base; pos[o * 3 + 2] = z;
      pos[o * 3 + 3] = x; pos[o * 3 + 4] = top;    pos[o * 3 + 5] = z;
      hv[o] = 0; hv[o + 1] = 1;
      az[o] = a; az[o + 1] = a;
      if (i < N) {
        const b = i * 2;
        idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aH', new THREE.BufferAttribute(hv, 1));
    g.setAttribute('aAz', new THREE.BufferAttribute(az, 1));
    g.setIndex(idx);
    return g;
  }

  _ridgeMaterial(sky, L, snow) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uSkyLut: sky.shared.uSkyLut,
        uSkyTexel: sky.shared.uSkyTexel,
        uSunDir: sky.shared.uSunDir,
        uSnow: { value: new THREE.Vector3(snow.r, snow.g, snow.b) },
        uAerial: { value: new THREE.Vector2(L.aerialTop, L.aerialBase) },
        uDither: { value: 0.010 },
      },
      vertexShader: /* glsl */ `
        attribute float aH;
        attribute float aAz;
        varying float vH;
        varying float vAz;
        varying vec3 vWorld;
        void main() {
          vH = aH; vAz = aAz;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uSunDir, uSnow;
        uniform vec2 uAerial;
        uniform float uDither;
        varying float vH, vAz;
        varying vec3 vWorld;
        ${ATMO_PARS}
        ${SKY_SAMPLE}
        ${SKY_DITHER}

        float h11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
        float vnoise(float x){
          float i = floor(x), f = fract(x);
          f = f*f*(3.0-2.0*f);
          return mix(h11(i), h11(i+1.0), f);
        }

        void main() {
          vec3 dh = normalize(vec3(vWorld.x - cameraPosition.x, 0.0, vWorld.z - cameraPosition.z));
          vec2 sxz = vec2(uSunDir.x, uSunDir.z);
          float sunFacing = dot(normalize(dh.xz), normalize(sxz + vec2(1e-6)));

          // A range lying between the camera and the sun is backlit: its snow
          // glows and its faces go pale. Away from the sun it flattens out.
          float lit = 0.66 + 0.60 * smoothstep(-0.45, 0.95, sunFacing);

          // Snowfield / rock break-up. Frequency matters more than amplitude:
          // at 260 cycles/radian this landed at ~5 px per cycle on screen and
          // read as corduroy. Lower frequencies, and varying with height as
          // well as azimuth, give patches instead of stripes.
          float det = vnoise(vAz * 62.0 + vH * 3.1) * 0.55
                    + vnoise(vAz * 17.0 - vH * 1.3) * 0.45;
          lit *= 0.93 + 0.14 * det;
          // Ridge tops catch skylight; the flanks fall away.
          lit *= mix(0.86, 1.06, smoothstep(0.0, 0.85, vH));

          // Fade toward the sky's *own* value at the horizon in this direction,
          // so the ridge line dissolves instead of ending on an edge.
          vec3 haze = sampleSky(normalize(vec3(dh.x, 0.010, dh.z)), uSunDir);
          float aerial = mix(uAerial.y, uAerial.x, smoothstep(0.0, 1.0, vH));
          // Vary the haze along the ring. A range at one constant aerial
          // strength reads as a cardboard cutout no matter how good the ridge
          // line is; real distance comes and goes with the air.
          float azVar = vnoise(vAz * 2.7 + 5.0) * 0.55 + vnoise(vAz * 6.1) * 0.45;
          aerial = clamp(aerial + (azVar - 0.5) * 0.24, 0.0, 0.98);
          vec3 col = mix(uSnow * lit * 0.62, haze, aerial);

          col *= 1.0 + triDither(gl_FragCoord.xy) * uDither;
          gl_FragColor = vec4(max(col, 0.0), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: THREE.DoubleSide,
      depthWrite: true,
      depthTest: true,
    });
  }

  _fogGeometry() {
    const N = 192, f = this.fog;
    const g = new THREE.CylinderGeometry(f.r, f.r, f.top - f.bottom, N, 1, true);
    g.translate(0, (f.top + f.bottom) * 0.5, 0);
    return g;
  }

  _fogMaterial(sky) {
    const f = this.fog;
    return new THREE.ShaderMaterial({
      uniforms: {
        uSkyLut: sky.shared.uSkyLut,
        uSkyTexel: sky.shared.uSkyTexel,
        uSunDir: sky.shared.uSunDir,
        uRange: { value: new THREE.Vector2(f.bottom, f.top) },
        uDither: { value: 0.010 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uSunDir;
        uniform vec2 uRange;
        uniform float uDither;
        varying vec3 vWorld;
        ${ATMO_PARS}
        ${SKY_SAMPLE}
        ${SKY_DITHER}
        float h11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
        float vnoise(float x){
          float i = floor(x), f = fract(x);
          f = f*f*(3.0-2.0*f);
          return mix(h11(i), h11(i+1.0), f);
        }
        float luma3(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
        void main() {
          vec3 dh = normalize(vec3(vWorld.x - cameraPosition.x, 0.0, vWorld.z - cameraPosition.z));
          float az = atan(dh.x, dh.z);
          // Ice fog sits ON the horizon line and thins upward fast.
          float t = (vWorld.y - uRange.x) / (uRange.y - uRange.x);
          float band = exp(-pow(max(0.0, (vWorld.y - 2.0)) / 17.0, 1.7))
                     * smoothstep(0.0, 0.22, t);
          float lumpy = 0.68 + 0.42 * (vnoise(az * 5.3 + 11.0) * 0.6 + vnoise(az * 17.0) * 0.4);
          float a = clamp(band * lumpy * 0.52, 0.0, 1.0);

          vec3 haze = sampleSky(normalize(vec3(dh.x, 0.006, dh.z)), uSunDir);
          // Ice fog is suspended crystals, not air: it scatters near-neutrally
          // and reads brighter and cooler than the sky it hangs in front of.
          // Tinting it with the sky made it mathematically invisible.
          vec3 col = mix(haze, vec3(0.62, 0.72, 0.88) * (0.35 + 0.75 * luma3(haze)), 0.55) * 1.18;
          col *= 1.0 + triDither(gl_FragCoord.xy) * uDither;
          gl_FragColor = vec4(max(col, 0.0), a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
  }
}
