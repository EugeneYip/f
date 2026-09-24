// OWNER: terrain agent.
//
// The snowfield.
//
// Geometry is a nested clipmap: L square levels, each K x K cells, each level
// twice the spacing of the one inside it and hollowed out where the finer level
// covers it. That buys ~1.6 cm of tessellation under the fox (fine enough for a
// paw print to be real displaced geometry) and 200 m of coverage for ~130k
// triangles in a single draw call. The outer row of every level is stitched
// onto the coarser lattice so the T-junctions cannot crack, and the rim drops
// into a skirt so no gap can show against the sky.
//
// THE HARD HORIZONTAL EDGE ON THE RIGHT OF `profile` IS A DRIFT CREST, NOT A
// SEAM. It runs y 751 at x 1750 down to y 728 at x 2075 (2100x1350), peak
// |dL/dy| 4.7 levels/row at y 734. Tested by TRANSLATING THE CLIPMAP under a
// stationary field: the height field is a function of world xz, so moving
// `mesh.position.x` moves every ring boundary through the world and leaves the
// surface where it was. Shifted +1 m and +2 m, the edge stayed at y 734/732
// and y 728/727 -- a seam would have moved with the lattice. It also survives
// postfx.ao.intensity = 0 (2.18 against 2.21). Ray-marching `heightAt` through
// those pixels puts the ground 9.52 m out just above the line and 7.23 m just
// below it, which is the occlusion step of a crest hiding the ground behind.
// One real caveat: the edge is 2x softer with the lattice shifted (4.66 ->
// 2.45), so the crest is being SHARPENED by the current band-limiting phase.
// Several ring boundaries do project into that screen band (level 3's edge at
// x = -3.76 lands at y 739), which is why it looks like a seam; they are not
// what draws the line.
//
// Displacement is evaluated in the vertex shader from `sn_field()` and in JS
// from `_fieldRaw()` below. THOSE TWO MUST STAY IN LOCKSTEP — the foot IK calls
// `heightAt()` several times a frame and any disagreement makes the fox float
// or sink. Both read the same gradient table bytes and the same `SNOW`
// constants, and `_selfCheck()` renders the GPU height into a probe target and
// diffs it against the JS port in dev.

import * as THREE from 'three';
import { SNOW } from '../shaders/snow.glsl.js';
import { SnowMaterial, makePermTable } from './SnowMaterial.js';
import { Footprints } from './Footprints.js';
import { SnowTufts } from './SnowTufts.js';

const TABLE = SNOW.TABLE;
const PAWS = ['pawFL', 'pawFR', 'pawRL', 'pawRR'];
const _v = new THREE.Vector3();

export class Terrain {
  name = 'terrain';
  order = -50;

  constructor() {
    this._ready = false;
    this._bias = 0;
    this._padX = 0;
    this._padZ = 0;
    this._windX = 1;
    this._windZ = 0;
    this._heading = 0;
    this._checked = 0;
    this._lastPress = -1;
    this._speed = 0;
    // Scratch outputs of the field evaluation (never allocate in heightAt).
    this._oSast = 0; this._oExpo = 0; this._oPad = 0; this._oRip = 0;
  }

  async init(ctx) {
    this.ctx = ctx;
    ctx.terrain = this;

    const perm = makePermTable();
    this._perm = perm;
    // Dequantise once, in float32, so JS reads exactly the values the sampler
    // hands the shader.
    const n = TABLE * TABLE;
    this._gx = new Float32Array(n);
    this._gy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this._gx[i] = Math.fround((perm.data[i * 4] / 255) * 2 - 1);
      this._gy[i] = Math.fround((perm.data[i * 4 + 1] / 255) * 2 - 1);
    }

    this._syncWind(ctx);
    this._padX = 0;
    this._padZ = 0;
    this._bias = 0;
    this._bias = this._fieldRaw(this._padX, this._padZ, 0, true);

    this.foot = new Footprints();
    this.foot.init(ctx);

    this.snow = new SnowMaterial(this.foot.uniforms);
    const material = this.snow.init(ctx, perm);
    this.snow.field.uPadCenter.value.set(this._padX, this._padZ);
    this.snow.field.uHeightBias.value = this._bias;
    this.snow.update(ctx);

    this._buildMesh(ctx, material);

    this.tufts = new SnowTufts();
    this.tufts.init(ctx, this);

    this._ready = true;
    this._seedTrail(ctx);
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  _clipmapParams(ctx) {
    const seg = ctx.quality.get('terrainSegments') | 0;
    const radius = ctx.quality.get('terrainRadius');
    const K = Math.max(32, Math.min(108, 4 * Math.round(seg / 19.2)));
    // Base spacing tracks the footprint target's texel size. It used to be
    // 1.75x that, which put the finest triangles at 2.05 cm at `high` — and a
    // paw print is ~4.7 cm in radius, so a whole footprint was 4.6 cells
    // across and its raised lip was well under one. Displacement cannot
    // render a feature narrower than its own triangles; it renders a spike.
    // Matching the texel (1.17 cm at `high`) puts 8 cells across a print and
    // ~2.5 under the lip, costs one more clipmap level (+13k triangles
    // against a 3.5M budget), and as a side effect pushes the outer rim from
    // 210 m to 240 m.
    const texel = SNOW.FP_SIZE / Math.max(256, ctx.quality.get('footprintRes') | 0);
    const s0 = Math.max(0.010, texel);
    let L = 1;
    while (K * s0 * Math.pow(2, L - 1) * 0.5 < radius && L < 11) L++;
    return { K, s0, L, radius };
  }

  _buildMesh(ctx, material) {
    const { K, s0, L } = this._clipmapParams(ctx);
    this._K = K; this._s0 = s0; this._L = L;

    const half = K * s0 * Math.pow(2, L - 1) * 0.5;
    this._extent = half;

    const stride = K + 1;
    const maxV = L * stride * stride + 4 * K + 8;
    const maxI = L * K * K * 6 + K * 24 + 64;
    const pos = new Float32Array(maxV * 3);
    const meta = new Float32Array(maxV * 4);
    const idx = new Uint32Array(maxI);
    const map = new Int32Array(stride * stride);
    let vc = 0, ic = 0;
    const h2 = K >> 1;
    const holeLo = K >> 2, holeHi = K - (K >> 2);

    let ringIdx = null;

    for (let l = 0; l < L; l++) {
      const s = s0 * Math.pow(2, l);
      const isLast = l === L - 1;
      map.fill(-1);

      // Mark the vertices the surviving cells need.
      for (let j = 0; j < K; j++) {
        const holeJ = j >= holeLo && j < holeHi;
        for (let i = 0; i < K; i++) {
          if (l > 0 && holeJ && i >= holeLo && i < holeHi) continue;
          map[j * stride + i] = 0;
          map[j * stride + i + 1] = 0;
          map[(j + 1) * stride + i] = 0;
          map[(j + 1) * stride + i + 1] = 0;
        }
      }

      for (let j = 0; j <= K; j++) {
        for (let i = 0; i <= K; i++) {
          const m = j * stride + i;
          if (map[m] !== 0) continue;
          const edge = (i === 0 || i === K || j === 0 || j === K);
          let fw = s, sx = 0, sz = 0;
          if (edge && !isLast) {
            // This row abuts a lattice with twice the spacing: filter at the
            // coarse rate so both sides agree, and pin the off-lattice
            // vertices onto the coarse chord.
            fw = 2 * s;
            if ((i === 0 || i === K) && (j & 1)) sz = s;
            else if ((j === 0 || j === K) && (i & 1)) sx = s;
          }
          pos[vc * 3] = (i - h2) * s;
          pos[vc * 3 + 2] = (j - h2) * s;
          meta[vc * 4] = fw;
          meta[vc * 4 + 2] = sx;
          meta[vc * 4 + 3] = sz;
          map[m] = vc++;
        }
      }

      for (let j = 0; j < K; j++) {
        const holeJ = j >= holeLo && j < holeHi;
        for (let i = 0; i < K; i++) {
          if (l > 0 && holeJ && i >= holeLo && i < holeHi) continue;
          const a = map[j * stride + i];
          const b = map[j * stride + i + 1];
          const c = map[(j + 1) * stride + i];
          const d = map[(j + 1) * stride + i + 1];
          idx[ic++] = a; idx[ic++] = c; idx[ic++] = d;
          idx[ic++] = a; idx[ic++] = d; idx[ic++] = b;
        }
      }

      if (isLast) {
        // Boundary ring, wound so that (-dz, dx) points inward.
        ringIdx = new Int32Array(4 * K + 1);
        let r = 0;
        for (let i = 0; i < K; i++) ringIdx[r++] = map[0 * stride + i];
        for (let j = 0; j < K; j++) ringIdx[r++] = map[j * stride + K];
        for (let i = K; i > 0; i--) ringIdx[r++] = map[K * stride + i];
        for (let j = K; j > 0; j--) ringIdx[r++] = map[j * stride + 0];
        ringIdx[r++] = ringIdx[0];
      }
    }

    // Skirt: a curtain hanging from the rim so the horizon can never show a gap.
    if (ringIdx) {
      const base = vc;
      for (let k = 0; k < ringIdx.length; k++) {
        const v = ringIdx[k];
        pos[vc * 3] = pos[v * 3];
        pos[vc * 3 + 2] = pos[v * 3 + 2];
        meta[vc * 4] = meta[v * 4];
        meta[vc * 4 + 1] = 1;
        vc++;
      }
      for (let k = 0; k < ringIdx.length - 1; k++) {
        const bP = ringIdx[k], bQ = ringIdx[k + 1];
        const sP = base + k, sQ = base + k + 1;
        idx[ic++] = bP; idx[ic++] = sP; idx[ic++] = sQ;
        idx[ic++] = bP; idx[ic++] = sQ; idx[ic++] = bQ;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, vc * 3), 3));
    geo.setAttribute('aMeta', new THREE.BufferAttribute(meta.subarray(0, vc * 4), 4));
    geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, ic), 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -20, 0), half * 1.6 + 80);
    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(-half, -80, -half), new THREE.Vector3(half, 20, half));

    this.geometry = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.name = 'snowfield';
    // NOT receiveShadow, deliberately. Under VSMShadowMap three renders every
    // receiveShadow object into the shadow map as a caster, and it does so with
    // a plain depth material — which ignores this material's displacement and
    // therefore stamps the snowfield in as a flat plane at y=0. At a six degree
    // sun that flat plane self-shadows the real surface in contour bands. The
    // fragment shader samples the shadow map directly (see snShadowMask), so
    // the fox's shadow still lands on the snow; we just stay out of the map.
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = true;
    this.mesh.renderOrder = -5;
    ctx.scene.add(this.mesh);
    this.stats = { vertices: vc, triangles: ic / 3, levels: L, cells: K, spacing: s0 };
  }

  // -------------------------------------------------------------------------
  // Public contract
  // -------------------------------------------------------------------------

  /** World Y of the snow surface at (x,z), including footprint compression. */
  heightAt(x, z) {
    if (!this._ready) return 0;
    return this._fieldRaw(x, z, 0) - this._bias +
      this.foot.heightAt(x, z, this.ctx.time);
  }

  normalAt(x, z, out) {
    out = out || new THREE.Vector3();
    if (!this._ready) return out.set(0, 1, 0);
    const e = SNOW.NRM_EPS;
    const t = this.ctx.time;
    const h0 = this._fieldRaw(x, z, 0) - this._bias + this.foot.heightAt(x, z, t);
    const hx = this._fieldRaw(x + e, z, 0) - this._bias + this.foot.heightAt(x + e, z, t);
    const hz = this._fieldRaw(x, z + e, 0) - this._bias + this.foot.heightAt(x, z + e, t);
    return out.set(-(hx - h0) / e, 1, -(hz - h0) / e).normalize();
  }

  /**
   * Stamp a depression. `radius` is the paw's half-width in metres, `depth`
   * 0..1 of the maximum compression, `sharpness` 0..1 trades a soft furry
   * blur for a crisp rim.
   */
  press(x, z, radius = 0.05, depth = 0.7, sharpness = 0.5) {
    if (!this._ready) return;
    const slot = this.foot.press(x, z, radius, depth, sharpness,
      this._heading, this.ctx.time, true);
    this._powder(x, z, radius, depth, slot);
  }

  /**
   * Throw loose snow from a contact. §6 asks for powder as well as
   * displacement; the displacement lives in the deformation target and the
   * powder is airborne, so it belongs to SnowParticles.
   *
   * Only NEW stamps throw powder. A paw held in stance re-presses every frame
   * and merges into the same slot, and a puff per frame would be a permanent
   * fog round a standing animal rather than a kick. `Footprints.press`
   * returns the slot it used and bumps `pressCount` only on a fresh one, so
   * that counter is the edge detector.
   *
   * THE AMPLITUDE IS NOT THE STAMP'S DEPTH, and that was the bug. Measured at
   * a walk: 5, 6, 4, 0, 0, 0, 0 live bursts at t = 0.5 .. 4.0 s. Powder simply
   * stopped. The two callers of press() interact with the edge detector in a
   * way that guarantees it:
   *
   *   * `Locomotion._pressSnow` ramps a foot's depth through stance
   *     (`want = maxDepth * (0.34 + 0.66*load)`) and only re-presses when it
   *     has grown by 0.022. The FIRST press of a footfall makes the new stamp
   *     — at `load = 0`, i.e. the SHALLOWEST depth of the whole contact — and
   *     every deeper press after it merges into that slot and is suppressed
   *     here as a repeat.
   *   * `Fox._pressFootprints` presses a flat 0.10 on a timer, and those merge
   *     too.
   *
   * So the old `strength = depth * ...` was evaluated at the one moment in the
   * contact when depth is smallest: 0.05 x 0.34 x 0.88 = 0.015 at a walk,
   * under `puff()`'s own 0.02 floor, so most footfalls threw nothing and the
   * rest threw a burst whose peak alpha was 0.024. Invisible either way.
   *
   * What actually decides how much snow leaves the ground is the SPEED of the
   * contact and the area of the paw. Depth stays in as a weak gate only — it
   * separates a paw set down on crust from one punching in — with a floor, so
   * the shallow leading edge of a footfall still throws its share.
   */
  _powder(x, z, radius, depth, slot) {
    if (slot < 0) return;
    const n = this.foot.pressCount;
    if (n === this._lastPress) return;
    this._lastPress = n;
    const sp = this.ctx.subjectSpeed ?? this._speed ?? 0;
    // Slow contacts barely lift anything; a running paw throws a lot.
    const gait = 0.30 + 0.70 * Math.min(sp / 2.6, 1);
    const bite = 0.55 + 0.45 * Math.min(depth / 0.12, 1.4);
    const strength = Math.min(1, gait * bite * (radius / 0.047));
    this.ctx.snowParticles?.puff(x, this.heightAt(x, z) + 0.01, z,
      strength, this.ctx.time, this._heading);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt, ctx) {
    if (!this._ready) return;
    if (this._syncWind(ctx)) {
      this._bias = 0;
      this._bias = this._fieldRaw(this._padX, this._padZ, 0, true);
      this.snow.field.uHeightBias.value = this._bias;
    }
    this.snow.update(ctx);

    const subject = ctx.subjectPosition;
    if (subject) {
      // Snap the clipmap to its own base lattice: the surface is evaluated in
      // world space, so sliding the tessellation is the only thing that moves,
      // and snapping keeps that below a fraction of a cell.
      const s = this._s0;
      this.mesh.position.x = Math.round(subject.x / s) * s;
      this.mesh.position.z = Math.round(subject.z / s) * s;
    }

    // Ground speed of the animal, for how much powder a contact throws.
    // Derived here rather than read off another system: nothing publishes it
    // on ctx, and a finite difference of subjectPosition is exact enough for
    // a particle amplitude.
    if (subject) {
      if (this._lastSubX !== undefined && dt > 1e-5) {
        const vx = (subject.x - this._lastSubX) / dt;
        const vz = (subject.z - this._lastSubZ) / dt;
        this._speed += (Math.hypot(vx, vz) - this._speed) * Math.min(1, dt * 6);
      }
      this._lastSubX = subject.x; this._lastSubZ = subject.z;
    }

    // Paw prints point where the animal points.
    const root = ctx.fox?.root;
    if (root) {
      const e = root.matrixWorld.elements;
      const dx = e[8], dz = e[10];
      if (dx * dx + dz * dz > 1e-8) this._heading = Math.atan2(-dx, dz);
    }

    this._contactPrints(ctx);
    this.tufts?.update(dt, ctx);

    // Keep a trail under the animal if nothing else is driving footprints, so
    // the snow is never a pristine sheet the fox is pasted onto.
    if (this.foot.externalCount === 0 && ctx.time - this._trailAt > 42) {
      this._seedTrail(ctx);
    }
  }

  /**
   * Contact compression, from the penetration the TERRAIN measures.
   *
   * This used to be a fallback -- "while nothing external has pressed, stamp
   * where the paws actually are; the moment a real press() arrives this stops
   * for good". It does not stop any more, and the reason is measured.
   *
   * Every external caller passes a depth it decided without asking where the
   * snow is, and all of them are far too shallow to see:
   *
   *   settle 2.5 s, `idle`:  4 stamps under the paws at depth 0.104
   *                          = 9.9 mm, from Fox._pressFootprints' flat 0.10.
   *   settle 2.5 s, `walk`:  25 fresh stamps at depth 0.050 = 4.75 mm, from
   *                          Locomotion's maxDepth * (0.34 + 0.66 * load).
   *
   * 4.75 mm is a fifth of the +-25 mm of sastrugi the print is stamped into,
   * so a walking animal leaves nothing -- which is exactly REVIEW-5's "no
   * gait leaves a track", and it is true. For contrast, the nine seeded trail
   * stamps ahead of the animal carry depth 0.50-0.84 (47-80 mm) and measure
   * -26.5 to +20.9 levels against the snow beside them in the delivered
   * `terrain` png, post and all. So the mechanism, the profile, the rim and
   * the compaction channel are all fine at a real depth and invisible at
   * these. The defect is the number, and the number is the one thing the
   * terrain is in a position to know.
   *
   * Running both is safe by construction, not by luck: Footprints.press
   * merges any stamp within MERGE_DIST of an existing one and takes
   * max(new, decayed old) for its depth, so the terrain can only ever DEEPEN
   * a print a gait already placed, never add one beside it. `_powder` is
   * edge-triggered on pressCount, which a merge does not bump, so a
   * re-pressed slot still throws no extra puff.
   *
   * And it cannot run away, which is the obvious worry given that heightAt()
   * feeds the IK that places the paw that this measures. At equilibrium the
   * paw rests on the floor of its own hole: pen is pinned at the 30 mm
   * tolerance, depth is pinned at 0.31, and the depression stays 29 mm below
   * the CLEAN field because that is what the stamp profile is relative to.
   */
  _contactPrints(ctx) {
    const anchors = ctx.fox?.anchors;
    if (!anchors) return;
    for (let i = 0; i < PAWS.length; i++) {
      const a = anchors[PAWS[i]];
      if (!a || !a.matrixWorld) continue;
      a.updateWorldMatrix(true, false);
      _v.setFromMatrixPosition(a.matrixWorld);
      // Press whenever the paw is ON the snow, not only when the rig has
      // driven it THROUGH the snow. A paw resting a centimetre proud left no
      // mark at all, which is most of why review 3 read "no snow interaction
      // with the animal at any speed": the machinery was all here and the
      // gate in front of it almost never opened. 3 cm of tolerance covers
      // the rig's own placement error, and the depth still scales with how
      // hard the paw is actually pushing.
      const pen = this.heightAt(_v.x, _v.z) + 0.030 - _v.y;
      if (pen <= 0) continue;
      const d = Math.min(0.62, 0.10 + pen * 7);
      const slot = this.foot.press(_v.x, _v.z, 0.052, d, 0.55, this._heading, ctx.time, false);
      this._powder(_v.x, _v.z, 0.052, d, slot);
    }
  }

  prerender(ctx) {
    if (!this._ready) return;
    const s = ctx.subjectPosition || this.mesh.position;
    this.foot.prerender(ctx, s);

    // AFTER the footprint composite, not before it.
    //
    // This used to run in update(), which is ahead of prerender() in the same
    // frame — so every stamp pressed this frame was already in the CPU model
    // and not yet on the GPU, and the check measured that one-frame lag as a
    // CPU/GPU disagreement. Harmless while the fallback contact prints almost
    // never fired; the moment they fire every frame during a walk it reported
    // 24 mm of "divergence" on a field that agrees to 2 microns. An
    // instrument that fails when the thing it watches starts working is worse
    // than no instrument.
    if (import.meta.env?.DEV) {
      if (ctx.frame === 45 || (ctx.frame > 45 && ctx.frame % 1800 === 0)) this._selfCheck(ctx);
    }
  }

  onQuality(e, ctx) {
    if (!this._ready || e.type !== 'tier') return;
    this._fixStaleShadowMapPass(ctx);
    this.foot.onQuality(ctx);
    this.snow.onQuality(ctx);
    const p = this._clipmapParams(ctx);
    if (p.K !== this._K || p.L !== this._L || Math.abs(p.s0 - this._s0) > 1e-6) {
      ctx.scene.remove(this.mesh);
      this.geometry.dispose();
      this._buildMesh(ctx, this.snow.material);
    }
    this.tufts?.onQuality(ctx, this);
  }

  dispose() {
    this.geometry?.dispose();
    this.snow?.dispose();
    this.foot?.dispose();
    this.tufts?.dispose();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * WORKAROUND, not ours to own: src/core/Environment.js disposes and nulls
   * sun.shadow.map on a tier change, but three allocates the VSM blur's
   * intermediate target `shadow.mapPass` only when it is null
   * (WebGLShadowMap.js, "if ( shadow.mapPass === null )"). So after switching
   * down from `high` the blur runs between a 1024 map and a stale 3072
   * intermediate, the moments come out garbage, and NOTHING casts a shadow at
   * `low` — verified by disposing mapPass alone, which restores the shadow
   * with the map left at 1024.
   *
   * The real fix is one line in Environment.applyQuality (dispose mapPass
   * beside map); this keeps the review tiers usable until then, and turns
   * into a no-op the moment that lands.
   */
  _fixStaleShadowMapPass(ctx) {
    const shadow = ctx.environment?.sun?.shadow;
    if (!shadow || shadow.map !== null || !shadow.mapPass) return;
    shadow.mapPass.dispose();
    shadow.mapPass = null;
  }

  _syncWind(ctx) {
    const w = ctx.wind;
    const l = Math.hypot(w.x, w.z) || 1;
    const wx = w.x / l, wz = w.z / l;
    if (Math.abs(wx - this._windX) < 1e-7 && Math.abs(wz - this._windZ) < 1e-7) return false;
    this._windX = wx;
    this._windZ = wz;
    return true;
  }

  /** A short approach trail so the field reads as walked-on, not pristine. */
  _seedTrail(ctx) {
    this._trailAt = ctx.time;
    const n = 9;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const side = (i & 1) ? 1 : -1;
      const x = -0.30 + t * 0.26 + side * 0.055;
      const z = -3.1 + t * 2.62;
      // Fake the age in the DEPTH, never in the timestamp: the GPU starts
      // decaying a stamp when it is composited, so a backdated t0 would make
      // the JS mirror disagree with the texture.
      const age = (1 - t) * 6.0;
      this.foot.press(x, z, 0.047, (0.66 + 0.18 * t) * Math.exp(-age / SNOW.FP_TAU_DEPTH),
        0.55, 0.06, ctx.time, false);
    }
  }

  _selfCheck(ctx) {
    if (this._checked > 3) return;
    this._checked++;
    let portErr = 0, lodErr = 0, fieldErr = 0;
    try {
      // Two probes: one over the fox (exercises the footprint field too) and
      // one far away on clean snow, so a divergence can be localised.
      for (const [cx, cz, clean] of [[this._padX, this._padZ, false], [41.3, -27.7, true]]) {
        const gpu = this.snow.readProbe(ctx, cx, cz, 1.6, this._s0);
        for (let j = 0; j < 16; j++) {
          for (let i = 0; i < 16; i++) {
            const px = cx + ((i + 0.5) / 16 - 0.5) * 3.2;
            const pz = cz + ((j + 0.5) / 16 - 0.5) * 3.2;
            const foot = this.foot.heightAt(px, pz, ctx.time);
            const cpuLod = this._fieldRaw(px, pz, this._s0) - this._bias + foot;
            const cpuFull = this._fieldRaw(px, pz, 0) - this._bias + foot;
            const e = Math.abs(cpuLod - gpu[j * 16 + i]);
            if (clean) fieldErr = Math.max(fieldErr, e);
            else portErr = Math.max(portErr, e);
            lodErr = Math.max(lodErr, Math.abs(cpuFull - cpuLod));
          }
        }
      }
    } catch (err) {
      console.info('[terrain] height probe unavailable:', err?.message ?? err);
      return;
    }
    this.agreement = { portErr, fieldErr, lodErr };
    const msg = `[terrain] CPU/GPU height: with-footprints ${(portErr * 1000).toFixed(3)} mm, ` +
      `clean-field ${(fieldErr * 1000).toFixed(3)} mm, band-limit ${(lodErr * 1000).toFixed(3)} mm`;
    if (portErr > 0.002 || lodErr > 0.002) {
      console.warn(`${msg} — DIVERGED (>2 mm): the fox will float or sink.`);
    } else if (this._checked === 1) {
      console.info(msg);
    }
  }

  // --- JS port of sn_field(). Mirror of the GLSL, allocation free. ----------

  _gn(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    let tx = ix % TABLE; if (tx < 0) tx += TABLE;
    let ty = iy % TABLE; if (ty < 0) ty += TABLE;
    const tx1 = tx + 1 === TABLE ? 0 : tx + 1;
    const ty1 = ty + 1 === TABLE ? 0 : ty + 1;
    const gx = this._gx, gy = this._gy;
    const i00 = ty * TABLE + tx, i10 = ty * TABLE + tx1;
    const i01 = ty1 * TABLE + tx, i11 = ty1 * TABLE + tx1;
    const a = gx[i00] * fx + gy[i00] * fy;
    const b = gx[i10] * (fx - 1) + gy[i10] * fy;
    const c = gx[i01] * fx + gy[i01] * (fy - 1);
    const d = gx[i11] * (fx - 1) + gy[i11] * (fy - 1);
    const ab = a + (b - a) * ux;
    const cd = c + (d - c) * ux;
    return (ab + (cd - ab) * uy) * 1.44;
  }

  _lod(w, fw) {
    let t = (fw - w * SNOW.LOD_LO) / (w * SNOW.LOD_HI - w * SNOW.LOD_LO);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return 1 - t * t * (3 - 2 * t);
  }

  _ridge(qx, qy) {
    const n = this._gn(qx, qy);
    const r = 1 - Math.abs(n);
    return r + SNOW.RIDGE_ROUND * (r * r - r) - SNOW.RIDGE_MEAN;
  }

  /**
   * Mirrors sn_field() exactly. Callers subtract `_bias`; pass raw=true to
   * get the unbiased, un-cored value (only used to measure the bias itself).
   */
  _fieldRaw(x, z, fw, raw) {
    const S = SNOW;
    const wx = this._windX, wz = this._windZ;
    const ax = -wz, az = wx;
    const al = x * wx + z * wz;
    const ac = x * ax + z * az;

    let h = 0;
    h += S.DUNE0_AMP * this._gn(ac * S.DUNE0_AC, al * S.DUNE0_AL) * this._lod(S.DUNE0_SIZE, fw);
    h += S.DUNE1_AMP * this._gn(ac * S.DUNE1_AC, al * S.DUNE1_AL) * this._lod(S.DUNE1_SIZE, fw);

    const d2 = this._gn(ac * S.DUNE2_AC + 13.71, al * S.DUNE2_AL + 5.13) * this._lod(S.DUNE2_SIZE, fw);
    h += S.DUNE2_AMP * d2;
    let expo = 0.5 + 0.5 * d2;
    expo = expo < 0 ? 0 : expo > 1 ? 1 : expo;
    this._oExpo = expo;

    const wob = this._gn(x * S.PAD_WOB_F + 57.2, z * S.PAD_WOB_F + 23.8) * this._lod(S.PAD_WOB_SIZE, fw);
    const dx = x - this._padX, dz = z - this._padZ;
    const pr = Math.sqrt(dx * dx + dz * dz) * (1 + S.PAD_WOBBLE * wob);
    let pt = (pr - S.PAD_R0) / (S.PAD_R1 - S.PAD_R0);
    pt = pt < 0 ? 0 : pt > 1 ? 1 : pt;
    const pad = S.PAD_MIN + (pt * pt * (3 - 2 * pt)) * (1 - S.PAD_MIN);
    let ct = (pr - S.CORE_R0) / (S.CORE_R1 - S.CORE_R0);
    ct = ct < 0 ? 0 : ct > 1 ? 1 : ct;
    const core = S.CORE_MIN + (ct * ct * (3 - 2 * ct)) * (1 - S.CORE_MIN);
    this._oPad = pad * core;

    const mnd = this._gn(ac * S.MEAND_AC + 31.13, al * S.MEAND_AL + 7.31) * this._lod(S.MEAND_SIZE, fw);
    const alw = al + S.MEAND_AMP * mnd;
    const acw = ac;

    const s0 = this._ridge(acw * (1 / S.SAST_ACROSS), alw * (1 / S.SAST_ALONG)) * this._lod(S.SAST_ACROSS, fw);
    const alS = alw - S.SAST_SKEW * s0;

    let s = this._ridge(acw * (1 / S.SAST_ACROSS), alS * (1 / S.SAST_ALONG)) * this._lod(S.SAST_ACROSS, fw)
      + S.SAST_G2 * this._ridge(acw * (S.SAST_L2 / S.SAST_ACROSS) + 11.21, alS * (S.SAST_L2 / S.SAST_ALONG) + 3.77) * this._lod(S.SAST_ACROSS / S.SAST_L2, fw)
      + S.SAST_G3 * this._ridge(acw * (S.SAST_L3 / S.SAST_ACROSS) + 27.53, alS * (S.SAST_L3 / S.SAST_ALONG) + 8.19) * this._lod(S.SAST_ACROSS / S.SAST_L3, fw);
    s *= 1 / (1 + S.SAST_G2 + S.SAST_G3);
    this._oSast = s;
    h += S.SAST_AMP * pad * (0.55 + 0.8 * expo) * s;

    const r = this._ridge(alw * (1 / S.RIP_LEN), acw * (1 / S.RIP_ACROSS)) * this._lod(S.RIP_LEN, fw);
    this._oRip = r;
    let rg = (expo - S.RIP_GATE0) / (S.RIP_GATE1 - S.RIP_GATE0);
    rg = rg < 0 ? 0 : rg > 1 ? 1 : rg;
    h += S.RIP_AMP * (rg * rg * (3 - 2 * rg)) * r;

    if (raw) return h;
    // Flat core under the animal — see CORE_* in snow.glsl.js. Note this is
    // applied to the BIASED height, so heightAt(padCentre) is exactly 0.
    return (h - this._bias) * core + this._bias;
  }
}
