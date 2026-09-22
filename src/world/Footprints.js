// OWNER: terrain agent.
//
// Persistent snow deformation.
//
// A scrolling render target holds the compression field in a 24 m square that
// follows the fox, so it can walk indefinitely. Channels:
//
//   R  depression depth   (x S_FP_MAXDEPTH metres)
//   G  displaced rim      (x S_FP_MAXRIM metres)
//   B  compaction         (0..1 — bluer, glossier, far less sparkly)
//
// Stamps are composited with GL_MAX, and the whole buffer is multiplied by a
// per-channel decay every frame, so the field is exactly
//
//   max_over_stamps( profile_i * exp(-(t - t_i)/tau) )
//
// which is a closed form JS can evaluate for `heightAt()` without ever reading
// the texture back. That identity is the only reason the CPU and the GPU agree
// on where the snow is; do not add advection or any read-modify-write pass
// without giving the CPU side the same treatment.

import * as THREE from 'three';
import { SNOW, FOOT_STAMP_VERT, FOOT_STAMP_FRAG, FOOT_DECAY_FRAG, FULLSCREEN_VERT, snowResolve } from '../shaders/snow.glsl.js';
import { hash11 } from '../util/math.js';

const MAX_STAMPS = 224;       // live stamps tracked on the CPU
const MAX_PER_FRAME = 48;     // instanced stamp draws per frame
const MERGE_DIST = 0.022;     // m — a paw pressed again in the same spot

export class Footprints {
  constructor() {
    this.res = 1024;
    this.size = SNOW.FP_SIZE;

    // Live stamps, struct-of-arrays so the hot CPU loop stays allocation free.
    this.n = 0;
    this._x = new Float32Array(MAX_STAMPS);
    this._z = new Float32Array(MAX_STAMPS);
    this._r = new Float32Array(MAX_STAMPS);
    this._d = new Float32Array(MAX_STAMPS);
    this._s = new Float32Array(MAX_STAMPS);
    this._rot = new Float32Array(MAX_STAMPS);
    this._t0 = new Float32Array(MAX_STAMPS);

    this._pending = new Int32Array(MAX_PER_FRAME);
    this._nPending = 0;
    this._serial = 0;
    this.pressCount = 0;
    // Presses that came in through ctx.terrain.press(), i.e. from another
    // system. While this is zero the terrain drives its own contact prints.
    this.externalCount = 0;

    this.origin = new THREE.Vector2(0, 0);
    this.uniforms = {
      uFoot: { value: null },
      uFootOrigin: { value: new THREE.Vector3(0, 0, 1 / SNOW.FP_SIZE) },
    };
  }

  init(ctx) {
    this.res = Math.max(256, ctx.quality.get('footprintRes') | 0);
    this.enabled = ctx.quality.get('footprints') !== false;

    const opts = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };
    this.rtA = new THREE.WebGLRenderTarget(this.res, this.res, opts);
    this.rtB = new THREE.WebGLRenderTarget(this.res, this.res, opts);
    this.uniforms.uFoot.value = this.rtA.texture;

    // Clear both targets to zero, leaving the renderer's clear state as found.
    const prev = ctx.renderer.getRenderTarget();
    const prevClear = new THREE.Color();
    ctx.renderer.getClearColor(prevClear);
    const prevAlpha = ctx.renderer.getClearAlpha();
    ctx.renderer.setClearColor(0x000000, 0);
    for (const rt of [this.rtA, this.rtB]) {
      ctx.renderer.setRenderTarget(rt);
      ctx.renderer.clear(true, false, false);
    }
    ctx.renderer.setRenderTarget(prev);
    ctx.renderer.setClearColor(prevClear, prevAlpha);

    // The targets are now empty, so the CPU model has to be empty too. On a
    // tier change `onQuality` re-inits at a new resolution and the old trail
    // is gone from the GPU; leaving the stamps in the CPU list would have
    // `heightAt` reporting depressions the renderer is not drawing, which is
    // the same float-or-sink disagreement from the other direction.
    // Re-compositing them instead is NOT equivalent: the stamp shader writes
    // the undecayed amplitude and the decay pass ages it from that moment,
    // so replaying an old stamp would reset its age on the GPU while the CPU
    // kept the original t0.
    this.n = 0;
    this._nPending = 0;
    this._decayedTo = undefined;

    // --- decay + scroll pass -----------------------------------------------
    this._quad = new THREE.BufferGeometry();
    this._quad.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this._quad.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
    this._decayMat = new THREE.RawShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: FOOT_DECAY_FRAG,
      uniforms: {
        uSrc: { value: null },
        uShift: { value: new THREE.Vector2() },
        uRes: { value: new THREE.Vector2(this.res, this.res) },
        uInvRes: { value: new THREE.Vector2(1 / this.res, 1 / this.res) },
        uDecay: { value: new THREE.Vector3(1, 1, 1) },
      },
      depthTest: false, depthWrite: false,
    });
    this._decayMesh = new THREE.Mesh(this._quad, this._decayMat);
    this._decayMesh.frustumCulled = false;

    // --- instanced paw stamps ----------------------------------------------
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -1, -1, 0, 1, -1, 0, 1, 1, 0,
      -1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
    this._iXform = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_FRAME * 4), 4);
    this._iDepth = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_FRAME * 2), 2);
    this._iXform.setUsage(THREE.DynamicDrawUsage);
    this._iDepth.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iXform', this._iXform);
    g.setAttribute('iDepth', this._iDepth);
    g.instanceCount = 0;
    this._stampGeo = g;
    this._stampMat = new THREE.RawShaderMaterial({
      vertexShader: FOOT_STAMP_VERT,
      fragmentShader: snowResolve(FOOT_STAMP_FRAG),
      uniforms: { uFootOrigin: this.uniforms.uFootOrigin },
      depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this._stampMesh = new THREE.Mesh(g, this._stampMat);
    this._stampMesh.frustumCulled = false;

    this._rtScene = new THREE.Scene();
    this._rtCam = new THREE.Camera();
    this._rtScene.add(this._decayMesh);
    this._rtScene.add(this._stampMesh);
    this._decayMesh.visible = true;
    this._stampMesh.visible = false;
  }

  /** Queue a depression. Returns the stamp slot, or -1 if it was dropped. */
  press(x, z, radius, depth, sharpness, heading, time, external) {
    if (!this.enabled) return -1;
    if (external) this.externalCount++;
    radius = radius > 0 ? Math.min(radius, 0.5) : 0.05;
    // Clamped to 1 on both sides: the GPU stores the profile in a 0..1 channel,
    // so the CPU must not model anything deeper than the texture can hold.
    depth = Math.min(Math.max(depth, 0), 1);
    sharpness = Math.min(Math.max(sharpness, 0), 1);

    // Merge a re-press of the same paw so a paw held in stance for a second
    // does not spawn 120 stamps.
    for (let i = 0; i < this.n; i++) {
      const dx = this._x[i] - x, dz = this._z[i] - z;
      if (dx * dx + dz * dz < MERGE_DIST * MERGE_DIST && Math.abs(this._r[i] - radius) < 0.02) {
        const old = this._d[i] * Math.exp(-(time - this._t0[i]) / SNOW.FP_TAU_DEPTH);
        this._d[i] = Math.max(depth, old);
        this._s[i] = sharpness;
        this._t0[i] = time;
        this._queue(i);
        return i;
      }
    }

    let slot = this.n;
    if (slot >= MAX_STAMPS) {
      // Evict the weakest (oldest) stamp; by construction it is nearly gone.
      let worst = 0, worstW = Infinity;
      for (let i = 0; i < this.n; i++) {
        const w = this._d[i] * Math.exp(-(time - this._t0[i]) / SNOW.FP_TAU_DEPTH);
        if (w < worstW) { worstW = w; worst = i; }
      }
      slot = worst;
    } else {
      this.n++;
    }

    this._x[slot] = x;
    this._z[slot] = z;
    this._r[slot] = radius;
    this._d[slot] = depth;
    this._s[slot] = sharpness;
    // Heading + a deterministic per-stamp jitter so a trail is not rubber-stamped.
    this._rot[slot] = heading + (hash11((this._serial++ * 2654435761) | 0) - 0.5) * 0.30;
    this._t0[slot] = time;
    this._queue(slot);
    this.pressCount++;
    return slot;
  }

  _queue(i) {
    if (this._nPending >= MAX_PER_FRAME) return;
    for (let k = 0; k < this._nPending; k++) if (this._pending[k] === i) return;
    this._pending[this._nPending++] = i;
  }

  /**
   * MAX-composite of every live stamp at one world point, i.e. exactly what
   * one texel of the render target holds. Writes this._md / this._mr.
   */
  _texel(x, z, time) {
    let depth = 0, rim = 0;
    for (let i = 0; i < this.n; i++) {
      const r = this._r[i];
      const dx = x - this._x[i], dz = z - this._z[i];
      const ext = r * 1.85;
      if (dx * dx + dz * dz > ext * ext) continue;
      const c = Math.cos(this._rot[i]), s = Math.sin(this._rot[i]);
      // Inverse of the stamp rotation.
      const qx = (dx * c + dz * s) / r;
      const qy = (-dx * s + dz * c) / r;
      const age = Math.exp(-(time - this._t0[i]) / SNOW.FP_TAU_DEPTH);
      const ageR = Math.exp(-(time - this._t0[i]) / SNOW.FP_TAU_RIM);
      const d = pawSDF(qx, qy);
      const sh = this._s[i];
      const w = SNOW.FP_WALL0 + (SNOW.FP_WALL1 - SNOW.FP_WALL0) * sh;
      let prof = 1 - smoothstep01(-w, 0.03, d);
      prof = Math.pow(prof, SNOW.FP_POW0 + (SNOW.FP_POW1 - SNOW.FP_POW0) * sh);
      const rimP = Math.exp(-Math.pow((d - SNOW.FP_RIM_D) / SNOW.FP_RIM_W, 2)) * (0.35 + 0.65 * sh);
      const dv = prof * this._d[i] * age;
      const rv = rimP * this._d[i] * 0.85 * ageR;
      if (dv > depth) depth = dv;
      if (rv > rim) rim = rv;
    }
    this._md = depth;
    this._mr = rim;
  }

  /**
   * Vertical displacement in metres at (x,z). Allocation free.
   *
   * This deliberately reproduces the GPU's *sampling*, not just its maths: the
   * shader reads a bilinear tap out of a 1.2 cm texel grid, and a paw print's
   * wall is only a texel or two wide, so evaluating the continuous profile here
   * would disagree with the displaced geometry by over a centimetre at the rim.
   * Compositing at the four surrounding texel centres and interpolating gives
   * the same number the vertex shader used.
   */
  heightAt(x, z, time) {
    if (this.n === 0) return 0;
    const res = this.res;
    const texel = this.size / res;
    const fx = (x - this.origin.x) / texel + res * 0.5 - 0.5;
    const fz = (z - this.origin.y) / texel + res * 0.5 - 0.5;
    if (fx < -0.5 || fz < -0.5 || fx > res - 0.5 || fz > res - 0.5) return 0;
    const i0 = Math.floor(fx), j0 = Math.floor(fz);
    const tx = fx - i0, tz = fz - j0;
    const ox = this.origin.x - this.size * 0.5 + texel * 0.5;
    const oz = this.origin.y - this.size * 0.5 + texel * 0.5;

    this._texel(ox + i0 * texel, oz + j0 * texel, time);
    const d00 = this._md, r00 = this._mr;
    this._texel(ox + (i0 + 1) * texel, oz + j0 * texel, time);
    const d10 = this._md, r10 = this._mr;
    this._texel(ox + i0 * texel, oz + (j0 + 1) * texel, time);
    const d01 = this._md, r01 = this._mr;
    this._texel(ox + (i0 + 1) * texel, oz + (j0 + 1) * texel, time);
    const d11 = this._md, r11 = this._mr;

    const a = d00 + (d10 - d00) * tx, b = d01 + (d11 - d01) * tx;
    const c = r00 + (r10 - r00) * tx, e = r01 + (r11 - r01) * tx;
    let depth = a + (b - a) * tz;
    let rim = c + (e - c) * tz;
    if (depth === 0 && rim === 0) return 0;
    depth = Math.min(depth, 1);
    rim = Math.min(rim, 1);
    return rim * SNOW.FP_MAXRIM * (1 - depth) - depth * SNOW.FP_MAXDEPTH;
  }

  /** GPU-side update: scroll, decay, then composite the frame's new stamps. */
  prerender(ctx, subject) {
    if (!this.enabled || !this.rtA) return;
    const texel = this.size / this.res;

    // Snap the window centre to a whole texel so scrolling is an exact integer
    // translation — a fractional shift would blur the trail away in seconds.
    const tx = Math.round(subject.x / texel) * texel;
    const tz = Math.round(subject.z / texel) * texel;
    // In whole TEXELS, and rounded, because the decay pass addresses the
    // source by integer index now. `tx` is already snapped to the texel
    // lattice, so the round only removes float noise from the division.
    const shiftX = Math.round((tx - this.origin.x) / texel);
    const shiftZ = Math.round((tz - this.origin.y) / texel);
    this.origin.set(tx, tz);

    // DECAY IS A FUNCTION OF ABSOLUTE SIM TIME, NOT OF RENDER COUNT.
    //
    // This used to be `Math.min(ctx.dt, 0.25)`, applied once per prerender —
    // i.e. once per RENDERED FRAME. The CPU model in `heightAt` is the closed
    // form `exp(-(ctx.time - t0)/tau)`. Those two agree only if exactly one
    // render happens per sim advance of `dt`, and on this project that is
    // simply not true:
    //
    //   * the review harness pauses the sim and then calls `D.render()` 20+
    //     times per pose for TAA, so every one of those renders decayed the
    //     field again at the last frame's dt with the clock standing still —
    //     the fourteenth pose of a run was looking at a trail that had been
    //     eroded by several hundred extra decay steps;
    //   * the loading screen's own rAF ticks render before the sim is driven;
    //   * `min(dt, 0.25)` silently DISCARDS decay after any hitch longer than
    //     a quarter second, which pushes the error the other way.
    //
    // So the disagreement was a race with the frame counter, and the number
    // it produced was a random variable. Measured at one identical sim state
    // (t = 2.5 s, walk, the same 34 stamps, the same CPU value of -63.868 mm
    // at (-0.10, -0.50)) the GPU came back at -55.8 mm on one run and
    // -50.3 mm on the next; `tools/gate.mjs` has reported 0.8, 3.9, 4.0, 9.8
    // and 29.9 mm for this check on builds that differ in no relevant way.
    // It was blamed on a powder commit that does not touch the height field,
    // and reverting that commit made it WORSE (9.8 mm against 3.9 mm), which
    // is how a random variable behaves under bisection.
    //
    // Decaying by the sim time actually elapsed since the last decay restores
    // the identity by construction: repeated renders at one `ctx.time` decay
    // by zero, a sim that advanced three fixed steps between renders decays
    // by all three, and nothing is clamped away. A backward jump in the clock
    // (spec.mjs rewinds it) re-bases instead of inverting the decay.
    if (this._decayedTo === undefined || ctx.time < this._decayedTo) {
      this._decayedTo = ctx.time;
    }
    const dt = ctx.time - this._decayedTo;
    this._decayedTo = ctx.time;
    const u = this._decayMat.uniforms;
    u.uSrc.value = this.rtA.texture;
    u.uShift.value.set(shiftX, shiftZ);
    u.uDecay.value.set(
      Math.exp(-dt / SNOW.FP_TAU_DEPTH),
      Math.exp(-dt / SNOW.FP_TAU_RIM),
      Math.exp(-dt / SNOW.FP_TAU_COMP),
    );

    const o = this.uniforms.uFootOrigin.value;
    o.set(tx, tz, 1 / this.size);

    const renderer = ctx.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    // Pass 1 — scroll + decay into B.
    this._decayMesh.visible = true;
    this._stampMesh.visible = false;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.rtB);
    renderer.render(this._rtScene, this._rtCam);

    // Pass 2 — MAX-composite this frame's stamps on top.
    if (this._nPending > 0) {
      const xf = this._iXform.array, dp = this._iDepth.array;
      for (let k = 0; k < this._nPending; k++) {
        const i = this._pending[k];
        xf[k * 4 + 0] = this._x[i];
        xf[k * 4 + 1] = this._z[i];
        xf[k * 4 + 2] = this._r[i];
        xf[k * 4 + 3] = this._rot[i];
        dp[k * 2 + 0] = Math.min(this._d[i], 1);
        dp[k * 2 + 1] = this._s[i];
      }
      this._iXform.needsUpdate = true;
      this._iDepth.needsUpdate = true;
      this._stampGeo.instanceCount = this._nPending;
      this._decayMesh.visible = false;
      this._stampMesh.visible = true;
      renderer.autoClear = false;
      renderer.render(this._rtScene, this._rtCam);
      this._nPending = 0;
    }

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);

    const t = this.rtA; this.rtA = this.rtB; this.rtB = t;
    this.uniforms.uFoot.value = this.rtA.texture;

    // Retire stamps that have faded or left the window.
    //
    // Retirement is the one place the CPU model can disagree with the GPU on
    // purpose: the moment a stamp leaves this list `heightAt` stops counting
    // it, while the texture still holds its residue and goes on decaying it.
    // So the threshold IS the residual error, in units of the depth channel:
    // 0.012 was 1.1 mm of S_FP_MAXDEPTH. Now that the subtractive epsilon is
    // gone from FOOT_DECAY_FRAG and this is the only remaining term, take it
    // down to 0.004 — 0.38 mm, comfortably inside the self-check's 2 mm — at
    // a cost of a few more live slots out of 224.
    const time = ctx.time;
    const half = this.size * 0.5 - 0.5;
    for (let i = this.n - 1; i >= 0; i--) {
      const w = this._d[i] * Math.exp(-(time - this._t0[i]) / SNOW.FP_TAU_DEPTH);
      const out = Math.abs(this._x[i] - tx) > half || Math.abs(this._z[i] - tz) > half;
      if (w < 0.004 || out) {
        const last = this.n - 1;
        if (i !== last) {
          this._x[i] = this._x[last]; this._z[i] = this._z[last];
          this._r[i] = this._r[last]; this._d[i] = this._d[last];
          this._s[i] = this._s[last]; this._rot[i] = this._rot[last];
          this._t0[i] = this._t0[last];
        }
        this.n--;
      }
    }
  }

  onQuality(ctx) {
    const res = Math.max(256, ctx.quality.get('footprintRes') | 0);
    if (res === this.res) return;
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.rtA = this.rtB = null;
    this.init(ctx);
  }

  dispose() {
    this.rtA?.dispose();
    this.rtB?.dispose();
    this._quad?.dispose();
    this._stampGeo?.dispose();
    this._decayMat?.dispose();
    this._stampMat?.dispose();
  }
}

// --- JS mirror of FOOT_PAW_GLSL --------------------------------------------
// Keep byte-for-byte equivalent to sn_paw / sn_pawProfile in snow.glsl.js.

function smin(a, b, k) {
  const h = Math.min(Math.max(0.5 + 0.5 * (b - a) / k, 0), 1);
  return (b + (a - b) * h) - k * h * (1 - h);
}

function smoothstep01(e0, e1, x) {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

export function pawSDF(qx, qy) {
  const ex = qx / 0.62, ey = (qy + 0.30) / 0.50;
  let d = (Math.sqrt(ex * ex + ey * ey) - 1) * 0.50;
  d = smin(d, Math.hypot(qx + 0.13, qy - 0.52) - 0.235, 0.15);
  d = smin(d, Math.hypot(qx - 0.21, qy - 0.50) - 0.225, 0.15);
  d = smin(d, Math.hypot(qx + 0.50, qy - 0.28) - 0.215, 0.15);
  d = smin(d, Math.hypot(qx - 0.55, qy - 0.24) - 0.205, 0.15);
  return d;
}
