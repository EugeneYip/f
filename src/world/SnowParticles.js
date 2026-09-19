import * as THREE from 'three';
import { rng, clamp, fbm1 } from '../util/math.js';
import { HASH, SIMPLEX3, CURL3 } from '../shaders/noise.glsl.js';

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
        // Bigger/closer than this and the post DoF turns them into bokeh
        // discs that read as dirt on the lens, which the bible forbids
        // outright. Held back to where the CoC can still resolve them.
        near: [0.95, 2.6], opacity: 0.55, crystal: false, groundFade: 0.10, scatter: 1.0,
        sheet: 0.16, sheetK: 0.30,
      },
      mid: {
        share: 0.34, box: [26, 14, 26], size: 0.009, fall: 0.70,
        curlAmp: 1.70, curlFreq: 0.045, curlTime: 0.05, streak: 0.12, spin: 1.1,
        near: [1.0, 2.9], opacity: 0.60, crystal: false, groundFade: 0.18, scatter: 0.95,
        sheet: 0.075, sheetK: 0.72,
      },
      far: {
        share: 0.30, box: [62, 26, 62], size: 0.038, fall: 0.45,
        curlAmp: 0.90, curlFreq: 0.018, curlTime: 0.04, streak: 0.10, spin: 0.4,
        near: [5, 15], opacity: 0.20, crystal: false, groundFade: 0.4, scatter: 0.85,
        sheet: 0.035, sheetK: 0.85,
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
        near: [1.7, 4.2], opacity: 0.55, crystal: false, groundFade: 0.0, scatter: 1.15,
        ground: true, sheet: 0.09, sheetK: 0.62,
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
    ctx.snowParticles = this;
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
        uResolution: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: /* glsl */ `
        precision highp float;
        attribute vec4 aSeed;
        attribute vec4 aRand;
        uniform float uTime, uFall, uCurlAmp, uCurlFreq, uCurlTime;
        uniform float uSize, uStreak, uSpin, uGroundY, uGroundFade, uOpacity, uHop, uGust;
        uniform vec2 uSheet;
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

          float sz = uSize * (0.55 + 0.95 * aRand.x);
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

          vOpacity = fNear * fEdge * fGround * gate * uOpacity * (0.45 + 0.55 * aRand.w);
          vRot = aRand.y * 6.2831853 + uTime * uSpin * (aRand.y * 2.0 - 1.0);
          vUv = uv;
          vWorld = world;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uCamPos, uSunDir, uSunColor, uSkyColor, uBounce;
        uniform float uScatter, uSoftRange;
        uniform sampler2D uDepthTex;
        uniform vec2 uCamPlanes, uResolution;
        varying vec2 vUv;
        varying float vRot, vOpacity;
        varying vec3 vWorld;

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
          float phase = 0.085 + 0.50 * pow(fwd, 3.0) + 2.9 * pow(fwd, 14.0);
          vec3 col = uSunColor * phase * uScatter + uSkyColor * 0.30 + uBounce * 0.18;

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
      u.uGust.value = gust;
      if (!l.def.ground) u.uOpacity.value = l.def.opacity * (0.50 + 0.65 * gust);
      u.uSunDir.value.copy(ctx.sunDirection);
      u.uSunColor.value.set(sun.r * si, sun.g * si, sun.b * si);
      u.uSkyColor.value.set(ctx.skyColor.r, ctx.skyColor.g, ctx.skyColor.b);
      u.uBounce.value.set(ctx.groundBounce.r, ctx.groundBounce.g, ctx.groundBounce.b);
    }

    // Opportunistically pick up a depth buffer if post-processing exposes one.
    if (!this._depthTex) {
      const d = ctx.postfx?.depthTexture || ctx.depthTexture || null;
      if (d) this.setDepthTexture(d, ctx.camera.near, ctx.camera.far);
    }
  }

  onQuality() { this._dirty = true; }
}
