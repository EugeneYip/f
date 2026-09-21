import * as THREE from 'three';
import { rng, clamp, fbm1 } from '../util/math.js';
import { HASH, SIMPLEX3, CURL3 } from '../shaders/noise.glsl.js';
import { HDR_CLAMP } from '../shaders/sky.glsl.js';

/**
 * Airborne snow, in four GPU-advected layers.
 *
 * Everything moves in the vertex shader as a closed-form function of
 * ctx.time, so the CPU cost is a handful of uniform writes regardless of
 * particle count, and the same time always produces the same frame.
 *
 * The emitter volume is a box centred on the camera and the advected position
 * is wrapped into it with a mod(), so the field is effectively infinite --
 * you cannot outrun it and you never see an edge. Particles are faded out
 * near the box boundary so the teleport when they wrap is invisible.
 *
 * Curl is evaluated at the WRAPPED position, not the advected one. That costs
 * a pop at the wrap boundary (hidden by the fade) and buys spatially coherent
 * drift sheets, which is the entire point of using curl noise: evaluated at
 * the unwrapped position every particle gets an uncorrelated offset and the
 * result is just jitter.
 *
 * This system also owns ctx.windGust, because the atmosphere is what decides
 * how hard it is blowing. Fur, snow and anything else read it.
 */
export class SnowParticles {
  name = 'snowParticles';
  order = 310;

  constructor() {
    this.layers = [];
    this._gustOverride = null;
    this._lastGust = null;
    this._depthTex = null;
    this._counts = '';

    // Metres, m/s. share is the fraction of ctx.quality snowParticles.
    this.defs = {
      near: {
        share: 0.10, box: [8, 6, 8], size: 0.008, fall: 0.85,
        curlAmp: 0.40, curlFreq: 0.10, curlTime: 0.03, streak: 0.10, spin: 2.2,
        // Held back past the subject plane (every body framing sits at
        // 1.8-2.3 m). Nearer than that, a single flake crossing the ~2 px
        // nose pad swamps a 0.008-linear feature and trips the spec gate --
        // and the DoF turns it into a bokeh disc that reads as dirt on the
        // lens, which the bible forbids outright. Foreground flakes in
        // close framings are not worth either cost.
        near: [2.40, 5.00], opacity: 0.55, crystal: false, groundFade: 0.10, scatter: 1.0,
        sheet: 0.16, sheetK: 0.30, heightK: 0.26,
      },
      mid: {
        share: 0.34, box: [26, 14, 26], size: 0.009, fall: 0.70,
        curlAmp: 1.70, curlFreq: 0.045, curlTime: 0.05, streak: 0.12, spin: 1.1,
        near: [2.40, 5.50], opacity: 0.60, crystal: false, groundFade: 0.18, scatter: 0.95,
        sheet: 0.075, sheetK: 0.72, heightK: 0.32,
      },
      far: {
        share: 0.30, box: [62, 26, 62], size: 0.038, fall: 0.45,
        curlAmp: 0.90, curlFreq: 0.018, curlTime: 0.04, streak: 0.10, spin: 0.4,
        near: [5, 15], opacity: 0.20, crystal: false, groundFade: 0.4, scatter: 0.85,
        sheet: 0.035, sheetK: 0.85, heightK: 0.42,
      },
      // Streamers skating over the surface. This is the layer that actually
      // reads as "polar wind" -- snow in the air just reads as weather.
      spindrift: {
        share: 0.26, box: [48, 0.55, 48], size: 0.060, fall: 0.0,
        curlAmp: 0.55, curlFreq: 0.075, curlTime: 0.16, streak: 0.70, spin: 0.0,
        // A 0.3 m streamer 0.8 m from the lens is a 20-degree smear across
        // the sky, and heavily defocused it reads as a smudge on the
        // glass. Held well back; it still reads from 2 m out, which is
        // where every body-framing pose sits.
        near: [2.40, 5.00], opacity: 0.55, crystal: false, groundFade: 0.0, scatter: 1.15,
        ground: true, sheet: 0.09, sheetK: 0.62, heightK: 0.0,
      },
    };
  }

  init(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'snowParticles';
    this.group.frustumCulled = false;
    ctx.scene.add(this.group);
    this._rebuild(ctx);
    this._buildPuffs(ctx);
    ctx.snowParticles = this;
  }

  // -- paw powder -----------------------------------------------------------

  /**
   * A burst of loose snow thrown up by a paw.
   *
   * §6 asks for four things where the animal meets the snow — displacement,
   * powder, footprints, paw sink — and review 3 found none of them. Three of
   * the four live in the terrain's deformation target; this is the fourth,
   * and it is the only one that is airborne, so it belongs here.
   *
   * Storage is a fixed ring of PUFF_SLOTS bursts x PUFF_GRAINS grains, all in
   * ONE instanced draw. A burst is described by four floats (origin, t0) plus
   * two (strength, heading) and every grain's trajectory is a closed form of
   * (ctx.time - t0), so nothing integrates on the CPU, nothing allocates per
   * press, and the same ctx.time always gives the same frame — which
   * AGENTS.md rule 6 requires and which a per-frame particle sim could not
   * give us in a harness that rewinds the clock.
   *
   * @param x,y,z world position of the contact
   * @param strength 0..1 — how much snow is thrown (speed x depth)
   * @param time ctx.time at the moment of contact
   */
  puff(x, y, z, strength, time, heading = 0) {
    if (!this._puff || !(strength > 0.02)) return;
    const s = this._puff;
    // Re-arm a slot that is already spent, or the oldest one.
    let slot = -1, oldest = 0, oldestT = Infinity;
    for (let i = 0; i < s.slots; i++) {
      const t0 = s.data[i * 8 + 3];
      if (time - t0 > s.life) { slot = i; break; }
      if (t0 < oldestT) { oldestT = t0; oldest = i; }
    }
    if (slot < 0) slot = oldest;
    const o = slot * 8;
    s.data[o] = x; s.data[o + 1] = y; s.data[o + 2] = z; s.data[o + 3] = time;
    s.data[o + 4] = Math.min(1, strength);
    s.data[o + 5] = heading;
    s.dirty = true;
  }

  _buildPuffs(ctx) {
    const SLOTS = 14, GRAINS = 26;
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    quad.dispose();

    const n = SLOTS * GRAINS;
    const slotIdx = new Float32Array(n);
    const grain = new Float32Array(n * 4);
    const r = rng(0x9d0f);
    for (let i = 0; i < SLOTS; i++) {
      for (let g = 0; g < GRAINS; g++) {
        const k = i * GRAINS + g;
        slotIdx[k] = i;
        // Cone of ejecta: mostly forward and up, a few sideways, with a
        // spread of speeds so the burst has a leading edge and a tail.
        const a = r() * Math.PI * 2;
        const up = 0.35 + 0.85 * r();
        const sp = 0.30 + 1.35 * Math.pow(r(), 1.6);
        grain[k * 4] = Math.cos(a) * (0.25 + 0.75 * r());
        grain[k * 4 + 1] = up;
        grain[k * 4 + 2] = Math.sin(a) * (0.25 + 0.75 * r());
        grain[k * 4 + 3] = sp;
      }
    }
    geo.setAttribute('aSlot', new THREE.InstancedBufferAttribute(slotIdx, 1));
    geo.setAttribute('aGrain', new THREE.InstancedBufferAttribute(grain, 4));
    geo.instanceCount = n;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    const data = new Float32Array(SLOTS * 8);
    for (let i = 0; i < SLOTS; i++) data[i * 8 + 3] = -1e4;   // all spent
    const tex = new THREE.DataTexture(data, 2, SLOTS, THREE.RGBAFormat, THREE.FloatType);
    tex.needsUpdate = true;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.NoColorSpace;

    const mat = new THREE.ShaderMaterial({
      defines: { PUFF_SLOTS: SLOTS },
      uniforms: {
        uPuff: { value: tex },
        uTime: { value: 0 },
        uLife: { value: 1.45 },
        uWind: { value: new THREE.Vector3() },
        uCamPos: { value: new THREE.Vector3() },
        uCamRight: { value: new THREE.Vector3(1, 0, 0) },
        uCamUp: { value: new THREE.Vector3(0, 1, 0) },
        uSunDir: { value: new THREE.Vector3() },
        uSunColor: { value: new THREE.Vector3() },
        uSkyColor: { value: new THREE.Vector3() },
        uBounce: { value: new THREE.Vector3() },
        uMaxRadiance: { value: 2.2 },
      },
      vertexShader: /* glsl */ `
        precision highp float;
        attribute float aSlot;
        attribute vec4 aGrain;
        uniform sampler2D uPuff;
        uniform float uTime, uLife;
        uniform vec3 uWind, uCamPos, uCamRight, uCamUp;
        varying float vA;
        varying vec3 vWorld;
        varying vec2 vUv;
        void main() {
          vec4 A = texture2D(uPuff, vec2(0.25, (aSlot + 0.5) / float(PUFF_SLOTS)));
          vec4 B = texture2D(uPuff, vec2(0.75, (aSlot + 0.5) / float(PUFF_SLOTS)));
          float age = uTime - A.w;
          float k = age / uLife;
          if (k < 0.0 || k > 1.0 || B.x <= 0.0) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // off-screen, no cost
            vA = 0.0; vUv = uv; vWorld = vec3(0.0);
            return;
          }
          float c = cos(B.y), sn = sin(B.y);
          vec3 dir = vec3(aGrain.x * c - aGrain.z * sn, aGrain.y, aGrain.x * sn + aGrain.z * c);
          float sp = aGrain.w * (0.55 + 0.9 * B.x);
          // Ballistic, with air drag folded into an exponential so grains
          // shed their launch speed and then just ride the wind.
          float drag = 1.0 - exp(-age * 3.1);
          vec3 p = vec3(A.xyz)
                 + dir * sp * drag * 0.34
                 + uWind * (age * 0.55)
                 - vec3(0.0, 1.0, 0.0) * (0.9 * age * age);
          // Grains puff out as they lose speed: a burst spreads, it does not
          // stay a hard clump.
          float sz = (0.012 + 0.055 * k) * (0.6 + 0.8 * B.x);
          vec3 world = p + uCamRight * (position.x * sz) + uCamUp * (position.y * sz);
          vA = (1.0 - k) * (1.0 - k) * smoothstep(0.0, 0.10, k) * B.x;
          vUv = uv;
          vWorld = world;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uCamPos, uSunDir, uSunColor, uSkyColor, uBounce;
        uniform float uMaxRadiance;
        varying float vA;
        varying vec3 vWorld;
        varying vec2 vUv;
        ${HDR_CLAMP}
        void main() {
          if (vA <= 0.002) discard;
          vec2 c = vUv - 0.5;
          float a = exp(-dot(c, c) * 11.0) * vA;
          if (a <= 0.003) discard;
          vec3 V = normalize(vWorld - uCamPos);
          float fwd = max(dot(V, uSunDir), 0.0);
          float phase = 0.10 + 0.55 * pow(fwd, 3.0);
          vec3 col = uSunColor * phase + uSkyColor * 0.38 + uBounce * 0.22;
          col = clampRadiance(col, uMaxRadiance);
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          gl_FragColor.rgb *= gl_FragColor.a;
        }
      `,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 21;
    mesh.name = 'snow-powder';
    mesh.onBeforeRender = (renderer, scene, camera) => {
      const u = mat.uniforms;
      const m = camera.matrixWorld.elements;
      u.uCamRight.value.set(m[0], m[1], m[2]).normalize();
      u.uCamUp.value.set(m[4], m[5], m[6]).normalize();
      u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    };
    this.group.add(mesh);
    this._puff = { slots: SLOTS, grains: GRAINS, data, tex, mesh, mat, life: 1.45, dirty: false };
  }

  dispose() {
    this.group?.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  }

  /** Hand us the scene depth buffer and flakes stop cutting hard into geometry. */
  setDepthTexture(tex, near, far) {
    this._depthTex = tex || null;
    for (const l of this.layers) {
      const u = l.mesh.material.uniforms;
      u.uDepthTex.value = tex || null;
      if (near != null) u.uCamPlanes.value.set(near, far);
      const want = tex ? 1 : 0;
      if ((l.mesh.material.defines.SOFT_DEPTH || 0) !== want) {
        l.mesh.material.defines.SOFT_DEPTH = want;
        l.mesh.material.needsUpdate = true;
      }
    }
  }

  // -- construction ---------------------------------------------------------

  _activeLayers(ctx) {
    const n = clamp(ctx.quality.get('snowLayers') || 1, 1, 3);
    if (n >= 3) return ['near', 'mid', 'far', 'spindrift'];
    if (n === 2) return ['mid', 'far', 'spindrift'];
    return ['mid', 'spindrift'];
  }

  _rebuild(ctx) {
    for (const l of this.layers) {
      this.group.remove(l.mesh);
      l.mesh.geometry.dispose();
      l.mesh.material.dispose();
    }
    this.layers = [];

    const total = ctx.quality.get('snowParticles') || 4000;
    const names = this._activeLayers(ctx);
    const shareSum = names.reduce((s, k) => s + this.defs[k].share, 0);

    for (const name of names) {
      const def = this.defs[name];
      const count = Math.max(32, Math.round(total * (def.share / shareSum)));
      this.layers.push(this._makeLayer(ctx, name, def, count));
    }
    this._counts = names.map((n, i) => `${n}:${this.layers[i].count}`).join(' ');
    // A tier change throws the old materials away, so anything handed to us
    // earlier has to be re-applied to the new ones.
    if (this._depthTex) {
      const t = this._depthTex;
      this._depthTex = null;
      this.setDepthTexture(t, ctx.camera.near, ctx.camera.far);
    }
  }

  _makeLayer(ctx, name, def, count) {
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    quad.dispose();

    const r = rng(0x5e0f + name.length * 7919 + count);
    const seed = new Float32Array(count * 4);
    const rand = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      seed[i * 4] = r(); seed[i * 4 + 1] = r(); seed[i * 4 + 2] = r(); seed[i * 4 + 3] = r();
      rand[i * 4] = r(); rand[i * 4 + 1] = r(); rand[i * 4 + 2] = r(); rand[i * 4 + 3] = r();
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    geo.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 4));
    geo.instanceCount = count;

    const mat = new THREE.ShaderMaterial({
      defines: {
        CRYSTAL: def.crystal ? 1 : 0,
        USE_CURL: def.curlAmp > 0 ? 1 : 0,
        SOFT_DEPTH: 0,
      },
      uniforms: {
        uTime: { value: 0 },
        uBox: { value: new THREE.Vector3(...def.box) },
        uCenter: { value: new THREE.Vector3() },
        uWind: { value: new THREE.Vector3() },
        uFall: { value: def.fall },
        uCurlAmp: { value: def.curlAmp },
        uCurlFreq: { value: def.curlFreq },
        uCurlTime: { value: def.curlTime },
        uSize: { value: def.size },
        uStreak: { value: def.streak },
        uSpin: { value: def.spin },
        uSheet: { value: new THREE.Vector2(def.sheet ?? 0.08, def.sheetK ?? 0.6) },
        uGust: { value: 0 },
        // x: 1/e-folding height of the suspension layer (m^-1)
        // y: world metres per backbuffer pixel, per metre of distance
        // z: minimum sprite half-size in pixels
        uProfile: { value: new THREE.Vector3(0.20, 0.0005, 0.85) },
        uNear: { value: new THREE.Vector2(def.near[0], def.near[1]) },
        uGroundY: { value: 0 },
        uGroundFade: { value: def.groundFade },
        uOpacity: { value: def.opacity },
        uScatter: { value: def.scatter },
        uHop: { value: def.ground ? 1 : 0 },
        uCamPos: { value: new THREE.Vector3() },
        uCamRight: { value: new THREE.Vector3(1, 0, 0) },
        uCamUp: { value: new THREE.Vector3(0, 1, 0) },
        uSunDir: { value: new THREE.Vector3() },
        uSunColor: { value: new THREE.Vector3() },
        uSkyColor: { value: new THREE.Vector3() },
        uBounce: { value: new THREE.Vector3() },
        uDepthTex: { value: null },
        uCamPlanes: { value: new THREE.Vector2(0.05, 900) },
        uSoftRange: { value: 0.45 },
        uMaxRadiance: { value: 2.2 },
        uResolution: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: /* glsl */ `
        precision highp float;
        attribute vec4 aSeed;
        attribute vec4 aRand;
        uniform float uTime, uFall, uCurlAmp, uCurlFreq, uCurlTime;
        uniform float uSize, uStreak, uSpin, uGroundY, uGroundFade, uOpacity, uHop, uGust;
        uniform vec2 uSheet;
        uniform vec3 uProfile;
        uniform vec3 uBox, uCenter, uWind, uCamPos, uCamRight, uCamUp;
        uniform vec2 uNear;
        varying vec2 vUv;
        varying float vRot, vOpacity;
        varying vec3 vWorld;
        ${HASH}
        ${SIMPLEX3}
        ${CURL3}

        void main() {
          vec3 full = uBox * 2.0;
          float sv = 0.70 + 0.60 * aSeed.w;
          vec3 vel = uWind * sv + vec3(0.0, -uFall * sv, 0.0);

          // Advect, then wrap into the camera-following volume.
          vec3 pw = mod(aSeed.xyz * full + vel * uTime - uCenter + uBox, full) - uBox + uCenter;

          vec3 cv = vec3(0.0);
          #if USE_CURL
            cv = curlNoise(pw * uCurlFreq + vec3(0.0, uTime * uCurlTime, 0.0)) * uCurlAmp;
          #endif
          vec3 p = pw + cv;

          // Saltation: ground streamers hop rather than fly.
          if (uHop > 0.5) {
            float ph = aRand.z * 6.2831853 + uTime * (1.3 + aRand.x);
            p.y = uGroundY + uBox.y * (0.10 + 0.90 * pow(0.5 + 0.5 * sin(ph), 2.0));
          }

          vec3 R = uCamRight, U = uCamUp;
          vec3 vd = vel + cv * 0.6;
          vec2 vs = vec2(dot(vd, R), dot(vd, U));
          float vl = length(vs);
          vec2 vdir = vl > 1e-4 ? vs / vl : vec2(0.0, 1.0);
          vec2 perp = vec2(-vdir.y, vdir.x);

          float dist0 = length(p - uCamPos);
          // Sub-pixel sprites are a lie the rasteriser cannot tell well: a
          // quad smaller than a pixel still shades that pixel at full alpha,
          // so the far layer came out as 709 hard white specks against the
          // sky in aurora.png -- read by a critic as stars, and for the same
          // reason the ground sparkle read as confetti. Hold the sprite at a
          // minimum screen size and pay for it in ALPHA, which conserves the
          // flake's contribution and turns distant snow into the haze §7
          // asks for instead of a point field.
          float sz = uSize * (0.55 + 0.95 * aRand.x);
          float szMin = uProfile.z * uProfile.y * dist0;
          float szFix = max(sz, szMin);
          float subPix = sz / max(szFix, 1e-6);
          sz = szFix;
          // Only slightly elongated for the airborne layers. A streaked
          // sprite that is also heavily defocused reads as a smudge on the
          // lens; a round one reads as bokeh. Spindrift keeps its long
          // streaks because it sits near the focal plane and is what sells
          // the wind.
          // Capped: ctx.windSpeed is authored elsewhere and a high value would
          // otherwise turn every flake into a screen-long smear, which is both
          // ugly and a fill-rate cliff.
          float stretch = min(1.30 + uStreak * vl, 5.0);
          vec2 d2 = position.x * perp * sz + position.y * vdir * (sz * stretch);
          vec3 world = p + R * d2.x + U * d2.y;

          float dist = length(p - uCamPos);
          float fNear = smoothstep(uNear.x, uNear.y, dist);
          vec3 e = abs(p - uCenter) / uBox;
          float fEdge = 1.0 - smoothstep(0.76, 1.0, max(max(e.x, e.y), e.z));
          float fGround = uGroundFade > 0.0
            ? smoothstep(uGroundY, uGroundY + uGroundFade, p.y) : 1.0;

          // Blowing snow arrives in sheets, not as a uniform fog. One low
          // frequency noise lookup gates whole regions of the volume in and
          // out, and the gate opens as the gust rises.
          float sheet = snoise(pw * uSheet.x + vec3(0.0, 0.0, uTime * 0.06));
          float gate = mix(1.0, smoothstep(-0.55 + uGust * 0.55, 0.45, sheet), uSheet.y);

          // Blowing snow is a suspension layer, not a uniform fill: the
          // concentration falls off exponentially with height above the
          // surface. Without this the far layer put flakes 26 m up, which is
          // exactly the part of the volume a looking-up framing sees against
          // the sky.
          float fHeight = exp(-max(0.0, p.y - uGroundY) * uProfile.x);

          vOpacity = fNear * fEdge * fGround * gate * fHeight * subPix * subPix
                   * uOpacity * (0.45 + 0.55 * aRand.w);
          vRot = aRand.y * 6.2831853 + uTime * uSpin * (aRand.y * 2.0 - 1.0);
          vUv = uv;
          vWorld = world;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uCamPos, uSunDir, uSunColor, uSkyColor, uBounce;
        uniform float uScatter, uSoftRange, uMaxRadiance;
        uniform sampler2D uDepthTex;
        uniform vec2 uCamPlanes, uResolution;
        varying vec2 vUv;
        varying float vRot, vOpacity;
        varying vec3 vWorld;
        ${HDR_CLAMP}

        void main() {
          if (vOpacity <= 0.001) discard;
          vec2 c = vUv - 0.5;
          float sr = sin(vRot), cr = cos(vRot);
          c = mat2(cr, -sr, sr, cr) * c;
          float r2 = dot(c, c) * 4.0;
          float a = exp(-r2 * 3.0);
          // NOTE: a six-fold radial term here produced literal clip-art
          // snowflakes at near-field sizes. Real airborne flakes at any
          // distance the camera can see are motion-smeared blobs; the crystal
          // read belongs to the sparkle on the ground, not to these.
          #if CRYSTAL
            a *= 0.90 + 0.10 * cos(2.0 * atan(c.y, c.x) + vRot);
          #endif
          a *= vOpacity;
          if (a <= 0.003) discard;

          vec3 V = normalize(vWorld - uCamPos);
          // Snow crystals forward-scatter hard, so a flake between the camera
          // and the sun lights up far brighter than one beside it.
          float fwd = max(dot(V, uSunDir), 0.0);
          // Same trap as the breath plume: a 2.9 peak against a ~7 linear sun
          // reached ~28, which bloomed into what read as dirt on the lens. Ice
          // crystals do glint, so the ceiling here is higher than the breath's
          // -- but it is a ceiling.
          float phase = 0.085 + 0.50 * pow(fwd, 3.0) + 0.9 * pow(fwd, 14.0);
          vec3 col = uSunColor * phase * uScatter + uSkyColor * 0.30 + uBounce * 0.18;
          col = clampRadiance(col, uMaxRadiance);

          #if SOFT_DEPTH
            vec2 suv = gl_FragCoord.xy / uResolution;
            float dz = texture2D(uDepthTex, suv).x;
            float n = uCamPlanes.x, f = uCamPlanes.y;
            float sceneZ = (2.0 * n * f) / (f + n - (dz * 2.0 - 1.0) * (f - n));
            float fragZ = (2.0 * n * f) / (f + n - (gl_FragCoord.z * 2.0 - 1.0) * (f - n));
            a *= smoothstep(0.0, uSoftRange, sceneZ - fragZ);
          #endif

          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          // Premultiply AFTER the output transform, so the tonemap sees the
          // flake's real colour rather than a faded one.
          gl_FragColor.rgb *= gl_FragColor.a;
        }
      `,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 20;
    mesh.name = `snow-${name}`;
    mesh.onBeforeRender = (renderer, scene, camera) => {
      const u = mat.uniforms;
      const m = camera.matrixWorld.elements;
      u.uCamRight.value.set(m[0], m[1], m[2]).normalize();
      u.uCamUp.value.set(m[4], m[5], m[6]).normalize();
      u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
      const t = renderer.getRenderTarget();
      u.uResolution.value.set(
        t ? t.width : renderer.domElement.width,
        t ? t.height : renderer.domElement.height,
      );
    };
    this.group.add(mesh);
    return { name, def, count, mesh };
  }

  // -- per frame ------------------------------------------------------------

  /**
   * Gust structure. fbm rather than a sine because real wind is intermittent:
   * long lulls with occasional surges, not a metronome. The power curve biases
   * toward calm so a gust reads as an event.
   */
  _tickGust(ctx) {
    const raw = fbm1(ctx.time * 0.19, 4, 11);
    let g = clamp(raw * 1.45 + 0.34, 0, 1);
    g = Math.pow(g, 1.7);

    // If something else wrote ctx.windGust (FoxDebug.setWind, a UI slider),
    // latch it and stop animating rather than fighting over the value.
    if (this._lastGust !== null && Math.abs(ctx.windGust - this._lastGust) > 1e-6) {
      this._gustOverride = ctx.windGust;
    }
    const out = this._gustOverride !== null ? this._gustOverride : g;
    ctx.windGust = out;
    this._lastGust = out;
    return out;
  }

  update(dt, ctx) {
    const gust = this._tickGust(ctx);
    if (this._dirty) { this._rebuild(ctx); this._dirty = false; }
    if (!this.layers.length) return;

    const cam = ctx.camera.position;
    const groundY = ctx.terrain?.heightAt ? ctx.terrain.heightAt(cam.x, cam.z) : 0;

    const speed = (ctx.windSpeed ?? 2.4) * (1 + 1.4 * gust);
    const sun = ctx.sunColor, si = ctx.sunIntensity ?? 7;
    // World metres per backbuffer pixel at one metre of distance.
    const bh = ctx.bufferSize?.height || ctx.size?.y || 800;
    const pxWorld = 2 * Math.tan(ctx.camera.fov * Math.PI / 360) / bh;

    for (const l of this.layers) {
      const u = l.mesh.material.uniforms;
      u.uTime.value = ctx.time;
      u.uWind.value.copy(ctx.wind).multiplyScalar(speed);
      u.uGroundY.value = groundY;
      if (l.def.ground) {
        u.uCenter.value.set(cam.x, groundY + l.def.box[1], cam.z);
        // Spindrift only exists when it is actually blowing.
        u.uOpacity.value = l.def.opacity * clamp(gust * 1.2 + 0.30, 0, 1);
      } else {
        u.uCenter.value.set(cam.x, cam.y, cam.z);
      }
      // Bound as a multiple of scene diffuse white, not a constant, so the
      // ceiling tracks exposure and sun-intensity changes.
      u.uMaxRadiance.value = (ctx.sky?.diffuseWhite ?? 0.45) * 4.5;
      u.uGust.value = gust;
      u.uProfile.value.set(l.def.heightK ?? 0.20, pxWorld, 1.15);
      if (!l.def.ground) u.uOpacity.value = l.def.opacity * (0.50 + 0.65 * gust);
      u.uSunDir.value.copy(ctx.sunDirection);
      u.uSunColor.value.set(sun.r * si, sun.g * si, sun.b * si);
      u.uSkyColor.value.set(ctx.skyColor.r, ctx.skyColor.g, ctx.skyColor.b);
      u.uBounce.value.set(ctx.groundBounce.r, ctx.groundBounce.g, ctx.groundBounce.b);
    }

    const pf = this._puff;
    if (pf) {
      if (pf.dirty) { pf.tex.needsUpdate = true; pf.dirty = false; }
      const u = pf.mat.uniforms;
      u.uTime.value = ctx.time;
      u.uWind.value.copy(ctx.wind).multiplyScalar(speed * 0.8);
      u.uSunDir.value.copy(ctx.sunDirection);
      u.uSunColor.value.set(sun.r * si, sun.g * si, sun.b * si);
      u.uSkyColor.value.set(ctx.skyColor.r, ctx.skyColor.g, ctx.skyColor.b);
      u.uBounce.value.set(ctx.groundBounce.r, ctx.groundBounce.g, ctx.groundBounce.b);
      u.uMaxRadiance.value = (ctx.sky?.diffuseWhite ?? 0.45) * 3.5;
    }

    // Opportunistically pick up a depth buffer if post-processing exposes one.
    if (!this._depthTex) {
      const d = ctx.postfx?.depthTexture || ctx.depthTexture || null;
      if (d) this.setDepthTexture(d, ctx.camera.near, ctx.camera.far);
    }
  }

  onQuality() { this._dirty = true; }
}
