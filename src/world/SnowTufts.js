// OWNER: terrain agent.
//
// Wind-blasted sedge poking through the drift. Sparse, dark, and scattered onto
// the exposed sastrugi crests (never right under the fox), purely so the ground
// reads as a place rather than an empty plane. One instanced draw call.

import * as THREE from 'three';
import { rng } from '../util/math.js';

const SEGMENTS = 4;
const BLADES = 4;

export class SnowTufts {
  init(ctx, terrain) {
    this.ctx = ctx;
    this._build(ctx, terrain);
  }

  _build(ctx, terrain) {
    const count = Math.min(2000, (ctx.quality.get('grassTufts') | 0) * 0.8 | 0);
    this.count = count;
    if (!count) return;

    // --- one cluster of blades, instanced ----------------------------------
    const vpb = (SEGMENTS + 1) * 2;
    const verts = BLADES * vpb;
    const tris = BLADES * SEGMENTS * 2;
    const pos = new Float32Array(verts * 3);
    const at = new Float32Array(verts);
    const idx = new Uint16Array(tris * 3);
    let v = 0, ii = 0;
    const rand = rng(90210);
    for (let b = 0; b < BLADES; b++) {
      const yaw = (b / BLADES) * Math.PI * 2 + rand() * 0.9;
      const lean = 0.05 + rand() * 0.20;
      const hs = 0.7 + rand() * 0.55;
      const w0 = 0.0075 + rand() * 0.005;
      const cx = Math.cos(yaw) * 0.012 * rand();
      const cz = Math.sin(yaw) * 0.012 * rand();
      const base = v;
      for (let k = 0; k <= SEGMENTS; k++) {
        const t = k / SEGMENTS;
        const hw = w0 * 0.5 * Math.pow(1 - t, 0.75);
        // Blades arc over as they rise.
        const arc = lean * t * t;
        const ox = Math.cos(yaw) * arc, oz = Math.sin(yaw) * arc;
        const dirx = -Math.sin(yaw), dirz = Math.cos(yaw);
        for (let s = -1; s <= 1; s += 2) {
          pos[v * 3 + 0] = cx + ox + dirx * hw * s;
          pos[v * 3 + 1] = t * hs;
          pos[v * 3 + 2] = cz + oz + dirz * hw * s;
          at[v] = t;
          v++;
        }
      }
      for (let k = 0; k < SEGMENTS; k++) {
        const a = base + k * 2;
        idx[ii++] = a; idx[ii++] = a + 2; idx[ii++] = a + 3;
        idx[ii++] = a; idx[ii++] = a + 3; idx[ii++] = a + 1;
      }
    }

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aT', new THREE.BufferAttribute(at, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));

    // --- scatter -----------------------------------------------------------
    const iPos = new Float32Array(count * 3);
    const iParam = new Float32Array(count * 4);
    const r2 = rng(13377);
    const R = 22;
    let n = 0, guard = 0;
    const up = new THREE.Vector3();
    // Sedge grows in clumps, not as an even sprinkle: pick a patch centre every
    // few plants and jitter around it. An even scatter reads as a decal.
    let cx = 0, cz = 0, inClump = 0;
    while (n < count && guard++ < count * 40) {
      let x, z;
      if (inClump <= 0) {
        const a = r2() * Math.PI * 2;
        const rr = Math.sqrt(r2()) * R;
        cx = Math.cos(a) * rr; cz = Math.sin(a) * rr;
        inClump = 2 + Math.floor(r2() * 6);
      }
      inClump--;
      const ja = r2() * Math.PI * 2;
      const jr = Math.pow(r2(), 0.65) * 0.85;
      x = cx + Math.cos(ja) * jr;
      z = cz + Math.sin(ja) * jr;
      if (x * x + z * z < 1.45 * 1.45) continue;             // clear of the fox
      const h = terrain._fieldRaw(x, z, 0) - terrain._bias;
      // Sedge survives where the wind scours it clear: crests, exposed ground.
      const crest = terrain._oSast, expo = terrain._oExpo;
      if (crest < 0.02) continue;
      if (r2() > 0.25 + expo * 0.75 * (0.3 + crest * 2.2)) continue;
      terrain.normalAt(x, z, up);
      if (up.y < 0.86) continue;
      iPos[n * 3] = x; iPos[n * 3 + 1] = h; iPos[n * 3 + 2] = z;
      iParam[n * 4 + 0] = r2() * Math.PI * 2;
      iParam[n * 4 + 1] = 0.032 + r2() * r2() * 0.062;        // height, metres
      iParam[n * 4 + 2] = r2() * 30;                          // sway phase
      iParam[n * 4 + 3] = 0.55 + r2() * 0.45;                 // stiffness
      n++;
    }
    this.count = n;
    geo.instanceCount = n;
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
    geo.setAttribute('iParam', new THREE.InstancedBufferAttribute(iParam, 4));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), R + 2);

    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uWind: { value: new THREE.Vector3(1, 0, 0) },
          uWindPow: { value: new THREE.Vector2(0.3, 0) },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uSunColor: { value: new THREE.Color(1, 1, 1) },
          uSkyColor: { value: new THREE.Color(1, 1, 1) },
          uFade: { value: 16 },
        },
      ]),
      vertexShader: TUFT_VERT,
      fragmentShader: TUFT_FRAG,
      fog: true,
      side: THREE.DoubleSide,
      transparent: false,
    });
    this.material.name = 'snowTufts';

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'snowTufts';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.geometry = geo;
    ctx.scene.add(this.mesh);
  }

  update(dt, ctx) {
    if (!this.material) return;
    const u = this.material.uniforms;
    u.uTime.value = ctx.time;
    u.uWind.value.copy(ctx.wind);
    u.uWindPow.value.set(ctx.windSpeed, ctx.windGust);
    u.uSunDir.value.copy(ctx.sunDirection);
    u.uSunColor.value.copy(ctx.sunColor);
    u.uSkyColor.value.copy(ctx.skyColor);
  }

  onQuality(ctx, terrain) {
    const want = Math.min(2000, (ctx.quality.get('grassTufts') | 0) * 0.8 | 0);
    if (want === this.count) return;
    this.dispose();
    if (this.mesh) ctx.scene.remove(this.mesh);
    this.mesh = null;
    this.material = null;
    this._build(ctx, terrain);
  }

  dispose() {
    this.geometry?.dispose();
    this.material?.dispose();
  }
}

const TUFT_VERT = /* glsl */ `
attribute float aT;
attribute vec3 iPos;
attribute vec4 iParam;

uniform float uTime;
uniform vec3 uWind;
uniform vec2 uWindPow;
uniform float uFade;

varying float vT;
varying vec3 vWorld;
varying float vFacing;

#include <common>
#include <fog_pars_vertex>

void main(){
  float yaw = iParam.x;
  float hs = iParam.y;
  float phase = iParam.z;
  float stiff = iParam.w;

  vec3 p = position;
  p.y *= hs / 0.9;
  p.xz *= 0.85 + 0.4 * hs * 8.0;

  float c = cos(yaw), s = sin(yaw);
  p = vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);

  // Wind bend: quadratic along the blade, gust-driven, with a travelling
  // per-blade phase so the patch never moves as one object.
  float gust = uWindPow.y;
  float sway = sin(uTime * 2.1 + phase) * 0.55 + sin(uTime * 4.7 + phase * 1.7) * 0.22;
  float amt = (uWindPow.x * 0.035 + gust * 0.30 + sway * (0.03 + 0.10 * gust)) / stiff;
  float t2 = aT * aT;
  p.xz += uWind.xz * amt * t2 * (p.y + 0.02);
  p.y -= abs(amt) * t2 * 0.25 * p.y;

  vec3 world = iPos + p;
  vWorld = world;
  vT = aT;

  vec4 mvPosition = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // Screen-space widening keeps a sub-pixel blade from flickering out.
  vFacing = 1.0 - smoothstep(uFade * 0.55, uFade, length(cameraPosition - world));

  #include <fog_vertex>
}
`;

const TUFT_FRAG = /* glsl */ `
precision highp float;
varying float vT;
varying vec3 vWorld;
varying float vFacing;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;

#include <common>
#include <fog_pars_fragment>

void main(){
  if (vFacing <= 0.01) discard;
  vec3 V = normalize(cameraPosition - vWorld);
  // Frozen sedge: dark warm straw at the tip, snow-buried at the base.
  vec3 dry = mix(vec3(0.052, 0.043, 0.034), vec3(0.20, 0.162, 0.108), vT);
  float trans = pow(saturate(dot(V, -uSunDir)), 3.0) * (0.25 + 0.75 * vT);
  vec3 col = dry * (uSkyColor * 0.55 + 0.25)
           + uSunColor * trans * 0.55
           + uSkyColor * 0.10 * vT;
  // Snow packed round the base.
  col = mix(vec3(0.42, 0.50, 0.62), col, smoothstep(0.0, 0.22, vT));
  col = mix(vec3(0.55, 0.62, 0.74), col, vFacing * 0.85 + 0.15);

  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
