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
      // aerialBase / aerialCrest: how much of the sky's own colour is mixed in
      // at the horizon line and at the peak. The crest values are near 1 on
      // purpose -- a distant ridge has to arrive at the sky's value before its
      // silhouette ends, or the eye finds the join.
      // The near line is the one that does the work. The clipmap rim reaches
      // 168 m at `low`, 210 m at `high` and 283 m at `ultra`, so 340 m is the
      // closest a ring can sit and still clear the snowfield at every tier;
      // at that range 2.2-10 m of drift is 0.2-1.5 degrees, i.e. 8-60 px of
      // ragged skyline in a 1800 px frame. The old nearest ring was at 560 m
      // and 44% hazed at its BASE, which is why three rings of geometry
      // measured as a flat +14/255 wash rather than as a profile.
      { r: 340, h: 10.5, min: 2.2, base: -120, aerialBase: 0.44, aerialCrest: 0.90, seed: 5153, rough: 1.0 },
      { r: 560, h: 26, min: 7,  base: -140, aerialBase: 0.38, aerialCrest: 0.88, seed: 7717, rough: 1.0 },
      { r: 690, h: 44, min: 13, base: -160, aerialBase: 0.58, aerialCrest: 0.94, seed: 3391, rough: 0.85 },
      { r: 840, h: 66, min: 20, base: -180, aerialBase: 0.78, aerialCrest: 0.972, seed: 9043, rough: 0.7 },
    ];
    // Ice fog. `top` is the cylinder's rim, not the visible height: the band
    // itself is the exponential below, and the rim only has to clear it.
    //
    // This used to be 30 m at 520 m = 3.3 degrees of geometry carrying a
    // 1.1-degree band, which left everything from ~1 to ~6 degrees above the
    // horizon showing the SKY MODEL's own horizon -- and that is the olive.
    // Along a 1000 km grazing path the Rayleigh source is extinguished
    // bluest-first, so a sky lit from above converges on a warm neutral; on
    // the sunward side of `wide` it measured B-R +2.4 and G-R -3.1, i.e.
    // green as the top channel, which is exactly the critic's (93,99,97).
    // No amount of snow-blink inside the scattering integral fixes that,
    // because the integral's own ceiling is about half the snow's radiance
    // (the ground is half the sphere). What actually sits there in a polar
    // photograph is not air, it is ICE FOG over a snowfield, and its
    // radiance does approach the snow's. So give the band the altitude the
    // real thing has and let it own that part of the frame.
    this.fog = { r: 520, top: 110, bottom: -60 };

    /**
     * Radiance of lit snow, republished every frame from Sky.diffuseWhite.
     *
     * Both materials used to key their brightness off the SKY they hang in
     * (`0.35 + 0.75 * luma(haze)`), and that is the wrong reference. A distant
     * snow ridge and a bank of ice fog over a snowfield are both lit mostly
     * from BELOW -- the snow is the bright thing in this world, not the
     * twilight sky -- so tying them to the sky made them track the darkest
     * source in frame and land 95 levels under bible section 3's #aac4e0.
     */
    this.uWhite = { value: 0.45 };
    /** #aac4e0 in linear, normalised to unit luminance so uWhite sets level. */
    this.uHaze = { value: new THREE.Vector3() };
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
    const hl = Math.max(1e-6, 0.2126 * snow.r + 0.7152 * snow.g + 0.0722 * snow.b);
    this.uHaze.value.set(snow.r / hl, snow.g / hl, snow.b / hl);
    for (let i = 0; i < this.layout.length; i++) {
      const L = this.layout[i];
      const mesh = new THREE.Mesh(this._ridgeGeometry(L), this._ridgeMaterial(sky, L, snow));
      mesh.frustumCulled = false;
      mesh.name = `ridge${i}`;
      // The near ring is at 340 m and the ice fog at 520 m, so most of the
      // fog column is BEHIND it and it has to draw over the band. Neither
      // writes depth (both are transparent), so render order is the only
      // thing deciding, and at -9000 the fog was painting the near ring out
      // completely -- the skyline went to a clean line the moment the band
      // got its real altitude. The far three stay behind it.
      mesh.renderOrder = i === 0 ? -40 : -9000 + i;
      this.group.add(mesh);
      this.rings.push(mesh);
    }

    this.fogBand = new THREE.Mesh(this._fogGeometry(), this._fogMaterial(sky));
    this.fogBand.name = 'icefog';
    this.fogBand.frustumCulled = false;
    this.fogBand.renderOrder = -50;
    this.group.add(this.fogBand);

    ctx.scene.add(this.group);
    ctx.horizon = this;
  }

  /**
   * One number per frame: the radiance of lit snow under the current rig.
   * Everything distant is keyed to it so the far field tracks exposure and
   * sun elevation instead of sitting at a constant that only ever agreed
   * with one lighting setup.
   */
  update(dt, ctx) {
    this.uWhite.value = ctx.sky?.diffuseWhite ?? 0.45;
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
    // A steeper exponent leaves most of the ring near `min` with occasional
    // hummocks reaching `h`. A snowfield horizon is a low ragged line with a
    // few drifts on it, not a continuous mountain profile, and the flat
    // stretches are what make the drifts read as drifts.
    return Math.pow(Math.max(0, t * 0.5 + 0.5), 2.05);
  }

  _ridgeGeometry(L) {
    const N = 512;
    const pos = new Float32Array((N + 1) * 2 * 3);
    const hv = new Float32Array((N + 1) * 2);      // 0 at base, 1 at ridge top
    const az = new Float32Array((N + 1) * 2);
    const tp = new Float32Array((N + 1) * 2);      // this column's crest height (m)
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
      tp[o] = top; tp[o + 1] = top;
      if (i < N) {
        const b = i * 2;
        idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aH', new THREE.BufferAttribute(hv, 1));
    g.setAttribute('aAz', new THREE.BufferAttribute(az, 1));
    g.setAttribute('aTop', new THREE.BufferAttribute(tp, 1));
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
        uAerial: { value: new THREE.Vector2(L.aerialBase, L.aerialCrest) },
        uDither: { value: 0.010 },
        uWhite: this.uWhite,
        uHaze: this.uHaze,
        uHazeMix: { value: 0.55 },
        uHazeGain: { value: 1.62 },
      },
      vertexShader: /* glsl */ `
        attribute float aH;
        attribute float aAz;
        attribute float aTop;
        varying float vH;
        varying float vAz;
        varying float vTop;
        varying vec3 vWorld;
        void main() {
          vH = aH; vAz = aAz; vTop = aTop;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uSunDir, uSnow, uHaze;
        uniform vec2 uAerial;
        uniform float uDither, uWhite, uHazeMix, uHazeGain;
        varying float vH, vAz, vTop;
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

          // Height above the HORIZON LINE, normalised by this column's own
          // crest -- not the 0..1 across the whole geometry. The geometry
          // starts 140 m below sea level so it can never leave a gap under the
          // terrain rim, which meant the visible band was only the top ~12% of
          // the old parameter and every gradient keyed to it came out flat.
          // This was what made the range read as a painted wall.
          float hN = clamp(vWorld.y / max(vTop, 0.5), 0.0, 1.0);

          // Snowfield / rock break-up, in patches rather than stripes.
          float det = vnoise(vAz * 62.0 + hN * 3.1) * 0.55
                    + vnoise(vAz * 17.0 - hN * 1.3) * 0.45;
          lit *= 0.93 + 0.14 * det;
          lit *= mix(0.88, 1.05, smoothstep(0.0, 0.9, hN));

          // Fade toward the sky's *own* value at the horizon in this direction,
          // so the ridge line dissolves instead of ending on an edge.
          // The colour a ridge dissolves INTO. Not the raw sky: at 340-840 m
          // the air between us and that ridge is the same snow-lit haze the
          // ice fog is made of, so the aerial-perspective target is bible
          // section 3's #aac4e0 at the snow's own level, with the sky mixed
          // through so the range still goes warm where it crosses the glow.
          vec3 haze = mix(sampleSky(normalize(vec3(dh.x, 0.010, dh.z)), uSunDir),
                          uHaze * uWhite * uHazeGain, uHazeMix);
          float aerial = mix(uAerial.x, uAerial.y, hN * hN);
          // Vary the haze along the ring; real distance comes and goes.
          float azVar = vnoise(vAz * 2.7 + 5.0) * 0.55 + vnoise(vAz * 6.1) * 0.45;
          aerial = clamp(aerial + (azVar - 0.5) * 0.20, 0.0, 0.995);
          vec3 col = mix(uSnow * lit * 0.62, haze, aerial);

          // Dissolve the crest. A distant ridge has the most air in front of
          // its top and the least snow on it, so the silhouette should thin
          // out and break up instead of ending on a clean line. The noise is
          // what stops the remaining edge reading as a drawn contour.
          //
          // The old band (fade 1.05 -> 0.45, solid below 0.46) threw away the
          // top HALF of every column, so the geometry's 0.2-1.5 degrees of
          // profile arrived on screen as 0.1-0.7 and the skyline went flat.
          // Carry the alpha to the actual crest and let the raggedness, not
          // the envelope, be what breaks the line.
          float edge = smoothstep(1.16, 0.70, hN);
          float ragged = vnoise(vAz * 39.0 + 2.0) * 0.6 + vnoise(vAz * 121.0) * 0.4;
          float a = clamp(edge * (0.62 + 0.72 * ragged), 0.0, 1.0);
          a = max(a, smoothstep(0.72, 0.42, hN));   // solid below, no see-through

          col *= 1.0 + triDither(gl_FragCoord.xy) * uDither;
          gl_FragColor = vec4(max(col, 0.0), a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
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
        uWhite: this.uWhite,
        uHaze: this.uHaze,
        uFogMix: { value: 0.90 },
        uFogGain: { value: 2.30 },
        uFogAlpha: { value: 0.92 },
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
        uniform float uDither, uWhite, uFogMix, uFogGain, uFogAlpha;
        uniform vec3 uHaze;
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
          // 42 m at 520 m is 4.6 degrees; the softer exponent carries a tail
          // to ~10 degrees, which is what dissolves the top edge instead of
          // ending the band on a line.
          float band = exp(-pow(max(0.0, (vWorld.y - 2.0)) / 42.0, 1.35))
                     * smoothstep(0.0, 0.22, t);
          float lumpy = 0.68 + 0.42 * (vnoise(az * 5.3 + 11.0) * 0.6 + vnoise(az * 17.0) * 0.4);
          // Taper to exactly zero before the cylinder's top rim, or the rim
          // itself draws a perfectly straight line across the sky.
          float rim = smoothstep(uRange.y, uRange.y * 0.45, vWorld.y);
          float a = clamp(band * lumpy * rim * uFogAlpha, 0.0, 1.0);

          vec3 haze = sampleSky(normalize(vec3(dh.x, 0.006, dh.z)), uSunDir);
          // Ice fog is suspended crystals hanging OVER a snowfield, not air.
          // Most of what lights it comes up off the snow, so its radiance
          // tracks lit snow (uWhite) and not the twilight sky it stands in
          // front of. The previous form scaled by the sky's own luminance,
          // which made the brightest object in the lower frame follow the
          // darkest one: measured (93,99,97) at hero against the bible's
          // #aac4e0. uHaze IS #aac4e0, normalised to unit luminance so the
          // level is set by the rig rather than by a constant that silently
          // goes wrong when exposure moves.
          //
          // A little of the sky is still mixed through, because the band has
          // to agree with whatever is behind it where it thins out -- warm
          // across the sun's glow, cold away from it.
          vec3 col = mix(haze, uHaze * uWhite * uFogGain, uFogMix);
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
