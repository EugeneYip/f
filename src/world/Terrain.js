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
    this._bias = this._fieldRaw(this._padX, this._padZ, 0);

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
    const K = Math.max(32, Math.min(112, 4 * Math.round(seg / 16)));
    // Base spacing tracks the footprint target's texel size: there is no point
    // tessellating finer than the deformation we sample.
    const texel = SNOW.FP_SIZE / Math.max(256, ctx.quality.get('footprintRes') | 0);
    const s0 = Math.max(0.014, texel * 1.4);
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
    this.foot.press(x, z, radius, depth, sharpness, this._heading, this.ctx.time);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt, ctx) {
    if (!this._ready) return;
    if (this._syncWind(ctx)) {
      this._bias = 0;
      this._bias = this._fieldRaw(this._padX, this._padZ, 0);
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

    // Paw prints point where the animal points.
    const root = ctx.fox?.root;
    if (root) {
      const e = root.matrixWorld.elements;
      const dx = e[8], dz = e[10];
      if (dx * dx + dz * dz > 1e-8) this._heading = Math.atan2(-dx, dz);
    }

    this.tufts?.update(dt, ctx);

    if (import.meta.env?.DEV && this._ready) {
      if (ctx.frame === 45 || (ctx.frame > 45 && ctx.frame % 1800 === 0)) this._selfCheck(ctx);
    }

    // Keep a trail under the animal if nothing else is driving footprints, so
    // the snow is never a pristine sheet the fox is pasted onto.
    if (this.foot.pressCount <= this._seeded && ctx.time - this._trailAt > 42) {
      this._seedTrail(ctx);
    }
  }

  prerender(ctx) {
    if (!this._ready) return;
    const s = ctx.subjectPosition || this.mesh.position;
    this.foot.prerender(ctx, s);
  }

  onQuality(e, ctx) {
    if (!this._ready || e.type !== 'tier') return;
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
        0.55, 0.06, ctx.time);
    }
    this._seeded = this.foot.pressCount;
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

  /** Height before the pad-centre bias. Mirrors sn_field() exactly. */
  _fieldRaw(x, z, fw) {
    const S = SNOW;
    const wx = this._windX, wz = this._windZ;
    const ax = -wz, az = wx;
    const al = x * wx + z * wz;
    const ac = x * ax + z * az;

    let h = 0;
    h += S.DUNE1_AMP * this._gn(ac * S.DUNE1_AC, al * S.DUNE1_AL) * this._lod(S.DUNE1_SIZE, fw);
    h += S.DUNE2_AMP * this._gn(ac * S.DUNE2_AC + 13.71, al * S.DUNE2_AL + 5.13) * this._lod(S.DUNE2_SIZE, fw);

    let expo = 0.5 + 0.5 * this._gn(ac * S.EXPO_AC + 71.3, al * S.EXPO_AL + 41.7) * this._lod(S.EXPO_SIZE, fw);
    expo = expo < 0 ? 0 : expo > 1 ? 1 : expo;
    this._oExpo = expo;

    const wob = this._gn(x * S.PAD_WOB_F + 57.2, z * S.PAD_WOB_F + 23.8) * this._lod(S.PAD_WOB_SIZE, fw);
    const dx = x - this._padX, dz = z - this._padZ;
    const pr = Math.sqrt(dx * dx + dz * dz) * (1 + S.PAD_WOBBLE * wob);
    let pt = (pr - S.PAD_R0) / (S.PAD_R1 - S.PAD_R0);
    pt = pt < 0 ? 0 : pt > 1 ? 1 : pt;
    const pad = S.PAD_MIN + (pt * pt * (3 - 2 * pt)) * (1 - S.PAD_MIN);
    this._oPad = pad;

    const mnd = this._gn(ac * S.MEAND_AC + 31.13, al * S.MEAND_AL + 7.31) * this._lod(S.MEAND_SIZE, fw);
    const alw = al + S.MEAND_AMP * mnd;
    const acw = ac + S.MEAND_AMP2 * this._gn(al * S.MEAND2_AL + 3.37, ac * S.MEAND2_AC + 19.41) * this._lod(S.MEAND2_SIZE, fw);

    const s0 = this._ridge(acw * (1 / S.SAST_ACROSS), alw * (1 / S.SAST_ALONG)) * this._lod(S.SAST_ACROSS, fw);
    const alS = alw - S.SAST_SKEW * s0;

    let s = this._ridge(acw * (1 / S.SAST_ACROSS), alS * (1 / S.SAST_ALONG)) * this._lod(S.SAST_ACROSS, fw)
      + S.SAST_G2 * this._ridge(acw * (S.SAST_L2 / S.SAST_ACROSS) + 11.21, alS * (S.SAST_L2 / S.SAST_ALONG) + 3.77) * this._lod(S.SAST_ACROSS / S.SAST_L2, fw)
      + S.SAST_G3 * this._ridge(acw * (S.SAST_L3 / S.SAST_ACROSS) + 27.53, alS * (S.SAST_L3 / S.SAST_ALONG) + 8.19) * this._lod(S.SAST_ACROSS / S.SAST_L3, fw);
    s *= 1 / (1 + S.SAST_G2 + S.SAST_G3);
    this._oSast = s;
    h += S.SAST_AMP * pad * (0.55 + 0.8 * expo) * s;

    let r = this._ridge(alw * (1 / S.RIP_LEN), acw * (1 / S.RIP_ACROSS)) * this._lod(S.RIP_LEN, fw)
      + S.RIP_G2 * this._ridge(alw * (S.RIP_L2 / S.RIP_LEN) + 5.71, acw * (S.RIP_L2 / S.RIP_ACROSS) + 13.33) * this._lod(S.RIP_LEN / S.RIP_L2, fw);
    r *= 1 / (1 + S.RIP_G2);
    this._oRip = r;
    let rg = (expo - S.RIP_GATE0) / (S.RIP_GATE1 - S.RIP_GATE0);
    rg = rg < 0 ? 0 : rg > 1 ? 1 : rg;
    h += S.RIP_AMP * (rg * rg * (3 - 2 * rg)) * r;

    return h;
  }
}
