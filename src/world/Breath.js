import * as THREE from 'three';
import { rng, clamp, TAU } from '../util/math.js';
import { HASH, SIMPLEX3 } from '../shaders/noise.glsl.js';

/**
 * Condensation puffs from the fox's nose.
 *
 * The anatomy agent owns `ctx.fox.anchors.nose` and it may not exist yet, may
 * appear mid-session, or may never appear. Every read here is defensive: with
 * no anchor this system simply emits nothing and costs one early return per
 * frame.
 *
 * Each puff is a small cluster of billboards whose centre is integrated on the
 * CPU (there are at most 16 of them, so it is free) and whose expansion,
 * turbulence and fade happen in the shader from a single age parameter. Doing
 * the drift on the CPU means the puff can be pushed around by the real
 * ctx.wind without the shader needing to know anything about the world.
 */
export class Breath {
  name = 'breath';
  order = 320;

  constructor() {
    this.MAX_PUFFS = 14;
    this.BLOBS = 5;
    this.LIFE = 1.55;          // seconds, bible §7 "short-lived"
    this.enabled = true;
    this._phasePrev = 0;
    this._ownPhase = 0;
    this._nextIdx = 0;
    this.puffs = [];
  }

  init(ctx) {
    this.ctx = ctx;
    this.enabled = !!ctx.quality.get('breath');

    for (let i = 0; i < this.MAX_PUFFS; i++) {
      this.puffs.push({
        age: -1,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        scale: 1,
      });
    }

    const n = this.MAX_PUFFS * this.BLOBS;
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    quad.dispose();

    const r = rng(4242);
    const blob = new Float32Array(n * 4);   // puffIndex, dirX, dirY, dirZ
    const extra = new Float32Array(n * 4);  // size, phase, rot, radialT
    for (let i = 0; i < n; i++) {
      const pi = Math.floor(i / this.BLOBS);
      const k = i % this.BLOBS;
      // One blob on the axis, the rest scattered in a forward-biased cone.
      const u = r() * 2 - 1, a = r() * TAU;
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      blob[i * 4] = pi;
      blob[i * 4 + 1] = k === 0 ? 0 : s * Math.cos(a);
      blob[i * 4 + 2] = k === 0 ? 0 : u * 0.55;
      blob[i * 4 + 3] = k === 0 ? 0 : s * Math.sin(a);
      extra[i * 4] = k === 0 ? 1.0 : 0.55 + 0.5 * r();
      extra[i * 4 + 1] = r();
      extra[i * 4 + 2] = r() * TAU;
      extra[i * 4 + 3] = k === 0 ? 0 : 0.35 + 0.65 * r();
    }
    geo.setAttribute('aBlob', new THREE.InstancedBufferAttribute(blob, 4));
    geo.setAttribute('aExtra', new THREE.InstancedBufferAttribute(extra, 4));
    geo.instanceCount = n;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 50);

    // xyz = world position, w = normalised age (<0 means dead)
    this._puffData = new Float32Array(this.MAX_PUFFS * 4);
    for (let i = 0; i < this.MAX_PUFFS; i++) this._puffData[i * 4 + 3] = -1;

    this.uniforms = {
      uPuff: { value: this._puffData },
      uCamPos: { value: new THREE.Vector3() },
      uCamRight: { value: new THREE.Vector3(1, 0, 0) },
      uCamUp: { value: new THREE.Vector3(0, 1, 0) },
      uSunDir: { value: new THREE.Vector3() },
      uSunColor: { value: new THREE.Vector3() },
      uSkyColor: { value: new THREE.Vector3() },
      uBounce: { value: new THREE.Vector3() },
      uR0: { value: 0.012 },
      uR1: { value: 0.115 },
      uDensity: { value: 0.50 },
    };

    const mat = new THREE.ShaderMaterial({
      defines: { MAX_PUFFS: this.MAX_PUFFS },
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        precision highp float;
        attribute vec4 aBlob;
        attribute vec4 aExtra;
        uniform vec4 uPuff[MAX_PUFFS];
        uniform vec3 uCamRight, uCamUp;
        uniform float uR0, uR1;
        varying vec2 vUv;
        varying float vAge, vFade, vSeed, vRot;
        varying vec3 vWorld;

        void main() {
          vec4 P = uPuff[int(aBlob.x)];
          float age = P.w;
          if (age < 0.0 || age > 1.0) {
            // Dead: collapse to a degenerate triangle so it costs no fill.
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            vFade = 0.0; vUv = vec2(0.0); vAge = 0.0; vSeed = 0.0; vRot = 0.0;
            vWorld = vec3(0.0);
            return;
          }
          // Expand fast then decelerate -- a puff loses momentum to the still
          // air around it almost immediately.
          float e = 1.0 - pow(1.0 - age, 2.4);
          float radius = mix(uR0, uR1, e) * aExtra.x;
          vec3 c = P.xyz + aBlob.yzw * mix(uR0, uR1 * 1.35, e) * aExtra.w;

          float sz = radius * 2.0;
          vec3 world = c + uCamRight * (position.x * sz) + uCamUp * (position.y * sz);

          // Fade in over the first 12%, then thin out as it expands.
          vFade = smoothstep(0.0, 0.12, age) * (1.0 - smoothstep(0.35, 1.0, age));
          vAge = age;
          vSeed = aExtra.y;
          vRot = aExtra.z + age * 1.1;
          vUv = uv;
          vWorld = world;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uCamPos, uSunDir, uSunColor, uSkyColor, uBounce;
        uniform float uDensity;
        varying vec2 vUv;
        varying float vAge, vFade, vSeed, vRot;
        varying vec3 vWorld;
        ${HASH}
        ${SIMPLEX3}

        void main() {
          if (vFade <= 0.002) discard;
          vec2 c = vUv - 0.5;
          float sr = sin(vRot), cr = cos(vRot);
          c = mat2(cr, -sr, sr, cr) * c;
          float r = length(c) * 2.0;
          float a = smoothstep(1.0, 0.15, r);
          if (a <= 0.0) discard;

          // Turbulent break-up, coarsening as the puff expands and mixes.
          vec3 np = vec3(c * (7.0 - 3.2 * vAge), vSeed * 37.0 + vAge * 1.6);
          float n = snoise(np) * 0.5 + snoise(np * 2.3) * 0.28;
          a *= clamp(0.62 + 0.75 * n, 0.0, 1.0);
          a *= vFade * uDensity;
          if (a <= 0.003) discard;

          // Water droplets forward-scatter even harder than snow: an exhale
          // between you and a low sun is a bright little cloud.
          vec3 V = normalize(vWorld - uCamPos);
          float fwd = max(dot(V, uSunDir), 0.0);
          float phase = 0.10 + 0.55 * pow(fwd, 2.5) + 2.2 * pow(fwd, 11.0);
          vec3 col = uSunColor * phase + uSkyColor * 0.42 + uBounce * 0.22;

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

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 25;
    this.mesh.name = 'breath';
    this.mesh.visible = false;
    this.mesh.onBeforeRender = (renderer, scene, camera) => {
      const m = camera.matrixWorld.elements;
      this.uniforms.uCamRight.value.set(m[0], m[1], m[2]).normalize();
      this.uniforms.uCamUp.value.set(m[4], m[5], m[6]).normalize();
      this.uniforms.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    };
    ctx.scene.add(this.mesh);
    ctx.breath = this;
  }

  dispose() {
    this.mesh?.geometry.dispose();
    this.mesh?.material.dispose();
  }

  _emit(ctx, origin, forward) {
    const p = this.puffs[this._nextIdx];
    this._nextIdx = (this._nextIdx + 1) % this.MAX_PUFFS;
    p.age = 0;
    p.pos.copy(origin);
    // Out of the nose and slightly down, the way a muzzle actually points.
    p.vel.copy(forward).multiplyScalar(0.62).add(new THREE.Vector3(0, -0.1, 0));
  }

  update(dt, ctx) {
    if (!this.mesh) return;
    if (!this.enabled) { this.mesh.visible = false; return; }

    const fox = ctx.fox;
    const nose = fox?.anchors?.nose;

    if (nose) {
      // Prefer the fox's own breathing cycle; fall back to ~0.4 Hz.
      let phase = fox.breathPhase;
      if (typeof phase !== 'number' || !Number.isFinite(phase)) {
        // Time-derived rather than accumulated, so the exhale lands at the
        // same ctx.time no matter how the frame was stepped.
        this._ownPhase = (ctx.time * 0.4) % 1;
        phase = this._ownPhase;
      }
      // Exhale starts as the cycle passes the halfway point.
      const crossed = this._phasePrev < 0.5 && phase >= 0.5;
      const wrapped = phase < this._phasePrev && this._phasePrev > 0.5 && phase < 0.5;
      this._phasePrev = phase;

      if (crossed || wrapped) {
        nose.updateWorldMatrix(true, false);
        const origin = new THREE.Vector3().setFromMatrixPosition(nose.matrixWorld);
        const fwd = new THREE.Vector3(0, 0, 1)
          .applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(nose.matrixWorld));
        if (!Number.isFinite(fwd.x) || fwd.lengthSq() < 1e-8) fwd.set(0, 0, 1);
        this._emit(ctx, origin, fwd.normalize());
      }
    }

    // Integrate the live puffs.
    const wind = ctx.wind;
    const speed = (ctx.windSpeed ?? 2.4) * (1 + 1.4 * (ctx.windGust ?? 0));
    let any = false;
    for (let i = 0; i < this.MAX_PUFFS; i++) {
      const p = this.puffs[i];
      if (p.age < 0) { this._puffData[i * 4 + 3] = -1; continue; }
      p.age += dt / this.LIFE;
      if (p.age >= 1) { p.age = -1; this._puffData[i * 4 + 3] = -1; continue; }
      any = true;
      // Ejection momentum bleeds off fast; wind and a little buoyancy take over.
      const drag = Math.exp(-4.2 * dt);
      p.vel.multiplyScalar(drag);
      p.vel.x += wind.x * speed * 0.55 * dt;
      p.vel.y += (0.18 - p.vel.y * 0.5) * dt;
      p.vel.z += wind.z * speed * 0.55 * dt;
      p.pos.addScaledVector(p.vel, dt);
      this._puffData[i * 4] = p.pos.x;
      this._puffData[i * 4 + 1] = p.pos.y;
      this._puffData[i * 4 + 2] = p.pos.z;
      this._puffData[i * 4 + 3] = clamp(p.age, 0, 1);
    }

    this.mesh.visible = any;
    if (!any) return;

    const u = this.uniforms;
    u.uPuff.value = this._puffData;
    const sun = ctx.sunColor, si = ctx.sunIntensity ?? 7;
    u.uSunDir.value.copy(ctx.sunDirection);
    u.uSunColor.value.set(sun.r * si, sun.g * si, sun.b * si);
    u.uSkyColor.value.set(ctx.skyColor.r, ctx.skyColor.g, ctx.skyColor.b);
    u.uBounce.value.set(ctx.groundBounce.r, ctx.groundBounce.g, ctx.groundBounce.b);
  }

  onQuality(e, ctx) { this.enabled = !!ctx.quality.get('breath'); }
}
