/**
 * AnatField — a tiny signed-distance-field engine for procedural anatomy.
 * OWNER: anatomy agent.
 *
 * Deliberately dependency-free (no three.js) so it can be unit-probed from
 * plain node and so the hot loop stays on flat Float64Arrays.
 *
 * ## Why an SDF
 *
 * Every anatomical part is one primitive. Unioning them with a *polynomial
 * smooth-min* gives organic blending at every joint with no seam to weld, and
 * the analytic gradient gives us exact surface normals — which is what kills
 * the "low-poly / faceted" critique at a modest triangle count.
 *
 * ## The one primitive
 *
 * Everything is a **round cone** (tapered capsule) from `a` to `b` with radii
 * `ra`/`rb`, evaluated inside an optional local frame with a non-uniform
 * `squash`. That single shape degenerates into:
 *
 *   a == b, ra == rb                  -> sphere
 *   ra == rb                          -> capsule
 *   a == b + squash                   -> ellipsoid
 *   ra != rb                          -> tapered limb segment / muzzle / tail
 *
 * The local frame is either the world axes (`frame:'world'`, the default —
 * squash is then per world axis) or built from the segment direction
 * (`frame:'axis'` + a `normal` hint — used for the flattened ear pinnae).
 *
 * For a linear map `q = M (p - o)` the true distance is bounded by
 * `d_local / sigma_max(M)`. Our M is a rotation composed with `diag(1/s)`, so
 * `sigma_max = 1/min(s)` and `d_world = d_local * min(s)`. That keeps the field
 * Lipschitz-1 (never over-estimating), which is what the mesher's Newton
 * projection needs.
 */

// ---------------------------------------------------------------------------
// primitive memory layout
// ---------------------------------------------------------------------------
// ox oy oz | m00..m22 | lbx lby lbz | ra rb | lip k op | bbox min[3] max[3]
const STRIDE = 26;
const P_O = 0;   // 3 — local-frame origin (== world segment start `a`)
const P_M = 3;   // 9 — row-major 3x3, q = M * (p - o)
const P_LB = 12; // 3 — segment end in local space (start is the origin)
const P_RA = 15;
const P_RB = 16;
const P_LIP = 17; // min(squash) — converts local distance to world distance
const P_K = 18;   // smooth-blend radius
const P_OP = 19;  // +1 union, -1 subtract
const P_MIN = 20; // 3 — world bbox of the swept sphere, for the early-out
const P_MAX = 23; // 3

/** Polynomial smooth minimum (C1). `k` is the blend width in metres. */
export function smin(a, b, k) {
  if (k <= 1e-9) return a < b ? a : b;
  let h = 0.5 + 0.5 * (b - a) / k;
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  return b + (a - b) * h - k * h * (1 - h);
}

/** Smooth subtraction: remove `sub` from `base`. */
export function ssub(base, sub, k) {
  if (k <= 1e-9) return base > -sub ? base : -sub;
  let h = 0.5 - 0.5 * (base + sub) / k;
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  return base + (-sub - base) * h + k * h * (1 - h);
}

/**
 * Exact round-cone distance with the segment start pinned at the origin.
 * (Inigo Quilez's formulation, specialised for a == 0.)
 */
function roundCone(qx, qy, qz, bx, by, bz, r1, r2) {
  const l2 = bx * bx + by * by + bz * bz;
  if (l2 < 1e-14) return Math.sqrt(qx * qx + qy * qy + qz * qz) - (r1 > r2 ? r1 : r2);

  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  if (a2 <= 1e-12) {
    // One end-sphere swallows the other: fall back to the bigger sphere.
    if (r1 >= r2) return Math.sqrt(qx * qx + qy * qy + qz * qz) - r1;
    const dx = qx - bx, dy = qy - by, dz = qz - bz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) - r2;
  }

  const il2 = 1 / l2;
  const y = qx * bx + qy * by + qz * bz;
  const z = y - l2;
  const xx = qx * l2 - bx * y;
  const xy = qy * l2 - by * y;
  const xz = qz * l2 - bz * y;
  const x2 = xx * xx + xy * xy + xz * xz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = (rr < 0 ? -1 : rr > 0 ? 1 : 0) * rr * rr * x2;

  if ((z < 0 ? -1 : 1) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if ((y < 0 ? -1 : 1) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

const _v = (o, d = 0) => (o == null ? d : o);

function norm3(x, y, z) {
  const l = Math.hypot(x, y, z);
  return l < 1e-12 ? [0, 0, 1] : [x / l, y / l, z / l];
}

export class Field {
  constructor() {
    /** Authoring-time primitive records (kept for the slow `sample` path). */
    this.prims = [];
    this.compiled = false;
    this._blocks = null;
  }

  /**
   * Add one anatomical primitive.
   *
   * @param {object} s
   *   a, b        world-space segment endpoints (`b` defaults to `a`)
   *   ra, rb      nominal world radii at a / b (`rb` defaults to `ra`)
   *   squash      per-local-axis radius multiplier, default [1,1,1]
   *   frame       'world' (squash is XYZ) | 'axis' (squash is
   *               [thickness along `normal`, width, along-segment])
   *   normal      required for frame:'axis' — the flatten direction
   *   k           smooth-blend radius in metres (default 0.02)
   *   op          'union' (default) | 'subtract'
   *   region      integer region id carried to the vertices it owns
   *   furLength / furStiffness             scalar fur field values
   *   flowDir     [x,y,z] hair direction (need not be unit)
   *   flowRadial  0..1 blend toward "radially out from my own axis"
   *   flowDown    0..1 blend toward world -Y
   *   tint        0xRRGGBB temporary vertex tint (review material only)
   */
  add(s) {
    const a = s.a;
    const b = s.b ?? s.a;
    const ra = s.ra;
    const rb = s.rb ?? s.ra;
    const sq = s.squash ?? [1, 1, 1];

    let e0, e1, e2;
    if (s.frame === 'axis') {
      e2 = norm3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const n = norm3(s.normal[0], s.normal[1], s.normal[2]);
      // Gram–Schmidt the flatten direction against the segment axis.
      const d = n[0] * e2[0] + n[1] * e2[1] + n[2] * e2[2];
      e0 = norm3(n[0] - e2[0] * d, n[1] - e2[1] * d, n[2] - e2[2] * d);
      e1 = [
        e2[1] * e0[2] - e2[2] * e0[1],
        e2[2] * e0[0] - e2[0] * e0[2],
        e2[0] * e0[1] - e2[1] * e0[0],
      ];
    } else {
      e0 = [1, 0, 0]; e1 = [0, 1, 0]; e2 = [0, 0, 1];
    }

    const s0 = sq[0], s1 = sq[1], s2 = sq[2];
    // Rows of M: e_i / s_i, so q_i = ((p - o) . e_i) / s_i.
    const m = [
      e0[0] / s0, e0[1] / s0, e0[2] / s0,
      e1[0] / s1, e1[1] / s1, e1[2] / s1,
      e2[0] / s2, e2[1] / s2, e2[2] / s2,
    ];
    const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
    const lb = [
      (bx * m[0] + by * m[1] + bz * m[2]),
      (bx * m[3] + by * m[4] + bz * m[5]),
      (bx * m[6] + by * m[7] + bz * m[8]),
    ];

    const smax = Math.max(s0, s1, s2);
    const rmaxWorld = Math.max(ra, rb) * smax;

    const p = {
      a, b, ra, rb, m, lb,
      o: a,
      lip: Math.min(s0, s1, s2),
      k: _v(s.k, 0.02),
      op: s.op === 'subtract' ? -1 : 1,
      region: _v(s.region, 0) | 0,
      furLength: _v(s.furLength, 0.02),
      furStiffness: _v(s.furStiffness, 0.5),
      flowDir: norm3(...(s.flowDir ?? [0, 0, -1])),
      flowRadial: _v(s.flowRadial, 0),
      flowDown: _v(s.flowDown, 0),
      tint: s.tint ?? 0xfdfcfa,
      name: s.name ?? '',
      // world bbox of the swept sphere, used by the block accelerator
      min: [Math.min(a[0], b[0]) - rmaxWorld, Math.min(a[1], b[1]) - rmaxWorld, Math.min(a[2], b[2]) - rmaxWorld],
      max: [Math.max(a[0], b[0]) + rmaxWorld, Math.max(a[1], b[1]) + rmaxWorld, Math.max(a[2], b[2]) + rmaxWorld],
    };
    this.prims.push(p);
    this.compiled = false;
    return p;
  }

  /** Mirror an already-added spec across X (for the paired limbs / ears). */
  addMirrored(s) {
    const flip = (v) => (v ? [-v[0], v[1], v[2]] : v);
    this.add(s);
    const m = { ...s, a: flip(s.a), b: s.b ? flip(s.b) : undefined };
    if (s.normal) m.normal = flip(s.normal);
    if (s.flowDir) m.flowDir = flip(s.flowDir);
    return this.add(m);
  }

  /** Flatten to typed arrays + build the block accelerator. Idempotent. */
  compile(blockSize = 0.035) {
    // Subtractions must run after every union.
    this.prims.sort((a, b) => b.op - a.op);
    this.nUnion = this.prims.filter((p) => p.op > 0).length;

    const n = this.prims.length;
    const d = new Float64Array(n * STRIDE);
    for (let i = 0; i < n; i++) {
      const p = this.prims[i], o = i * STRIDE;
      d[o + P_O] = p.o[0]; d[o + P_O + 1] = p.o[1]; d[o + P_O + 2] = p.o[2];
      for (let j = 0; j < 9; j++) d[o + P_M + j] = p.m[j];
      d[o + P_LB] = p.lb[0]; d[o + P_LB + 1] = p.lb[1]; d[o + P_LB + 2] = p.lb[2];
      d[o + P_RA] = p.ra; d[o + P_RB] = p.rb;
      d[o + P_LIP] = p.lip; d[o + P_K] = p.k; d[o + P_OP] = p.op;
      for (let c = 0; c < 3; c++) { d[o + P_MIN + c] = p.min[c]; d[o + P_MAX + c] = p.max[c]; }
    }
    this.data = d;
    this.count = n;

    // --- domain -------------------------------------------------------------
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of this.prims) {
      if (p.op < 0) continue;              // subtractions never grow the shape
      for (let c = 0; c < 3; c++) {
        lo[c] = Math.min(lo[c], p.min[c] - p.k);
        hi[c] = Math.max(hi[c], p.max[c] + p.k);
      }
    }
    this.bounds = { min: lo, max: hi };

    // --- block accelerator --------------------------------------------------
    // Each block keeps the primitives that can possibly change the field
    // inside it. A primitive contributes nothing to smin() once it is further
    // than `k` from the running minimum, so bbox-inflation by k (plus the
    // block's own diagonal) is a safe, conservative test.
    const pad = 0.02;
    const bmin = [lo[0] - pad, lo[1] - pad, lo[2] - pad];
    const bmax = [hi[0] + pad, hi[1] + pad, hi[2] + pad];
    const dim = [0, 0, 0];
    for (let c = 0; c < 3; c++) dim[c] = Math.max(1, Math.ceil((bmax[c] - bmin[c]) / blockSize));

    const starts = new Int32Array(dim[0] * dim[1] * dim[2] + 1);
    const lists = [];
    let cursor = 0;
    for (let bz = 0; bz < dim[2]; bz++) {
      for (let by = 0; by < dim[1]; by++) {
        for (let bx = 0; bx < dim[0]; bx++) {
          const bi = bx + dim[0] * (by + dim[1] * bz);
          starts[bi] = cursor;
          const c = [bmin[0] + (bx + 0.5) * blockSize, bmin[1] + (by + 0.5) * blockSize, bmin[2] + (bz + 0.5) * blockSize];
          for (let i = 0; i < n; i++) {
            const p = this.prims[i];
            // Box-vs-box already accounts for the block's extent, so adding
            // half its diagonal on top double-counted and pulled 2-3x more
            // primitives into every block than smin can possibly need.
            const half = blockSize * 0.5 + p.k * 1.5 + 0.012;
            let hit = true;
            for (let a2 = 0; a2 < 3; a2++) {
              if (c[a2] + half < p.min[a2] || c[a2] - half > p.max[a2]) { hit = false; break; }
            }
            if (hit) { lists.push(i); cursor++; }
          }
        }
      }
    }
    starts[dim[0] * dim[1] * dim[2]] = cursor;
    this._blocks = {
      dim, size: blockSize, min: bmin,
      starts, list: Int32Array.from(lists),
    };
    this.compiled = true;
    return this;
  }

  _blockIndex(x, y, z) {
    const b = this._blocks;
    let ix = ((x - b.min[0]) / b.size) | 0;
    let iy = ((y - b.min[1]) / b.size) | 0;
    let iz = ((z - b.min[2]) / b.size) | 0;
    if (ix < 0) ix = 0; else if (ix >= b.dim[0]) ix = b.dim[0] - 1;
    if (iy < 0) iy = 0; else if (iy >= b.dim[1]) iy = b.dim[1] - 1;
    if (iz < 0) iz = 0; else if (iz >= b.dim[2]) iz = b.dim[2] - 1;
    return ix + b.dim[0] * (iy + b.dim[1] * iz);
  }

  /** Raw distance of one primitive (world space), ignoring blending. */
  primDistance(i, x, y, z) {
    const d = this.data, o = i * STRIDE;
    const px = x - d[o + P_O], py = y - d[o + P_O + 1], pz = z - d[o + P_O + 2];
    const qx = px * d[o + P_M] + py * d[o + P_M + 1] + pz * d[o + P_M + 2];
    const qy = px * d[o + P_M + 3] + py * d[o + P_M + 4] + pz * d[o + P_M + 5];
    const qz = px * d[o + P_M + 6] + py * d[o + P_M + 7] + pz * d[o + P_M + 8];
    return roundCone(qx, qy, qz, d[o + P_LB], d[o + P_LB + 1], d[o + P_LB + 2],
      d[o + P_RA], d[o + P_RB]) * d[o + P_LIP];
  }

  /**
   * Conservative distance for a query whose block holds no primitives.
   *
   * The block builder only drops a primitive once it is provably further away
   * than its blend radius, so "empty block" means the surface is at least the
   * smallest margin term (12 mm) away. Returning the larger of that and the
   * distance to the whole-field AABB keeps the field Lipschitz-1, which is
   * exactly what sphere tracing in `raycast`/`project` depends on. Returning
   * a sentinel here instead (as an earlier revision did) made `raycast` step
   * straight past the animal.
   */
  _emptyDistance(x, y, z) {
    const lo = this.bounds.min, hi = this.bounds.max;
    const dx = Math.max(lo[0] - x, 0, x - hi[0]);
    const dy = Math.max(lo[1] - y, 0, y - hi[1]);
    const dz = Math.max(lo[2] - z, 0, z - hi[2]);
    const outside = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return outside > 0.012 ? outside : 0.012;
  }

  /**
   * Signed distance to the fox skin. The hot path: called ~500k times during
   * meshing, so it is allocation-free and block-culled.
   */
  distance(x, y, z) {
    const b = this._blocks;
    const bi = this._blockIndex(x, y, z);
    const s = b.starts[bi], e = b.starts[bi + 1];
    if (s === e) return this._emptyDistance(x, y, z);
    const list = b.list, d = this.data;
    let acc = 1e9;
    for (let t = s; t < e; t++) {
      const i = list[t];
      const o = i * STRIDE;
      const k = d[o + P_K];
      const union = d[o + P_OP] > 0;

      // Cheap reject: a union primitive whose bounding box is already further
      // than (acc + k) cannot change the smooth minimum. ~12 flops against
      // ~60 for the full round-cone evaluation.
      if (union && acc < 1e8) {
        const lim = acc + k;
        if (lim > 0) {
          let bx = d[o + P_MIN] - x; const bx2 = x - d[o + P_MAX];
          if (bx2 > bx) bx = bx2; if (bx < 0) bx = 0;
          let by = d[o + P_MIN + 1] - y; const by2 = y - d[o + P_MAX + 1];
          if (by2 > by) by = by2; if (by < 0) by = 0;
          let bz = d[o + P_MIN + 2] - z; const bz2 = z - d[o + P_MAX + 2];
          if (bz2 > bz) bz = bz2; if (bz < 0) bz = 0;
          if (bx * bx + by * by + bz * bz > lim * lim) continue;
        }
      }

      const di = this.primDistance(i, x, y, z);
      if (union) {
        acc = di < acc - k ? di : (di > acc + k ? acc : smin(acc, di, k));
      } else {
        acc = ssub(acc, di, k);
      }
    }
    // A block holding only subtractions can leave acc untouched.
    return acc > 1e8 ? this._emptyDistance(x, y, z) : acc;
  }

  /**
   * Tetrahedral 4-tap gradient — 4 field evaluations instead of 6. Used by the
   * Newton projection in the mesher, where it runs ~500k times; the final
   * shading normals still use the more accurate central difference.
   */
  gradient4(x, y, z, h, out) {
    const d1 = this.distance(x + h, y - h, z - h);
    const d2 = this.distance(x - h, y - h, z + h);
    const d3 = this.distance(x - h, y + h, z - h);
    const d4 = this.distance(x + h, y + h, z + h);
    const inv = 1 / (4 * h);          // the tetrahedral basis is 4h long
    out[0] = (d1 - d2 - d3 + d4) * inv;
    out[1] = (-d1 - d2 + d3 + d4) * inv;
    out[2] = (-d1 + d2 - d3 + d4) * inv;
    return out;
  }

  /** Central-difference gradient. Not normalised. */
  gradient(x, y, z, h, out) {
    const gx = this.distance(x + h, y, z) - this.distance(x - h, y, z);
    const gy = this.distance(x, y + h, z) - this.distance(x, y - h, z);
    const gz = this.distance(x, y, z + h) - this.distance(x, y, z - h);
    const inv = 0.5 / h;
    out[0] = gx * inv; out[1] = gy * inv; out[2] = gz * inv;
    return out;
  }

  /** Unit surface normal at (or near) the isosurface. */
  normal(x, y, z, h, out) {
    this.gradient(x, y, z, h, out);
    const l = Math.hypot(out[0], out[1], out[2]);
    if (l < 1e-12) { out[0] = 0; out[1] = 1; out[2] = 0; return out; }
    out[0] /= l; out[1] /= l; out[2] /= l;
    return out;
  }

  /**
   * Push a point onto the isosurface with a couple of Newton steps.
   * The field is Lipschitz-1 so this converges fast and monotonically.
   */
  project(p, h, steps = 2, maxStep = 1e9) {
    const g = this._projG || (this._projG = [0, 0, 0]);
    for (let s = 0; s < steps; s++) {
      const d = this.distance(p[0], p[1], p[2]);
      if (Math.abs(d) < 1e-6) break;
      this.gradient4(p[0], p[1], p[2], h, g);
      const g2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
      if (g2 < 1e-14) break;
      let t = d / g2;
      const mv = Math.abs(t) * Math.sqrt(g2);
      if (mv > maxStep) t *= maxStep / mv;
      p[0] -= g[0] * t; p[1] -= g[1] * t; p[2] -= g[2] * t;
    }
    return p;
  }

  /** March a ray until it crosses the surface; returns t or -1. */
  raycast(ox, oy, oz, dx, dy, dz, tMax = 1.0, eps = 2e-5) {
    let t = 0;
    let prev = this.distance(ox, oy, oz);
    for (let i = 0; i < 512 && t < tMax; i++) {
      const step = Math.max(Math.abs(prev) * 0.85, 4e-4);
      const nt = t + step;
      const d = this.distance(ox + dx * nt, oy + dy * nt, oz + dz * nt);
      if ((prev > 0) !== (d > 0)) {
        // Bisect to eps.
        let lo = t, hi = nt, dl = prev;
        for (let j = 0; j < 40 && hi - lo > eps; j++) {
          const mid = 0.5 * (lo + hi);
          const dm = this.distance(ox + dx * mid, oy + dy * mid, oz + dz * mid);
          if ((dl > 0) !== (dm > 0)) hi = mid; else { lo = mid; dl = dm; }
        }
        return 0.5 * (lo + hi);
      }
      t = nt; prev = d;
    }
    return -1;
  }

  /**
   * The slow, rich sample — called once per final vertex (~16k times).
   * Blends the authored fur fields over every union primitive with an
   * exponential (softmax-style) weight so the result is smooth everywhere,
   * and reports the *nearest* primitive's region as the hard integer id.
   *
   * @param sigma blend falloff in metres. Larger = softer gradients.
   */
  sample(x, y, z, sigma, out) {
    const prims = this.prims;
    const n = this.nUnion;
    const blk = this._blocks;
    const bi = this._blockIndex(x, y, z);
    const bs = blk.starts[bi], be = blk.starts[bi + 1];
    const near = this._nearScratch || (this._nearScratch = new Int32Array(prims.length));
    const ds = this._dsScratch || (this._dsScratch = new Float64Array(prims.length));
    let nn = 0;
    for (let t = bs; t < be; t++) { const i = blk.list[t]; if (i < n) near[nn++] = i; }
    if (nn === 0) for (let i = 0; i < n; i++) near[nn++] = i;

    let dmin = 1e9, argmin = near[0];
    for (let k = 0; k < nn; k++) {
      const i = near[k];
      const di = this.primDistance(i, x, y, z);
      ds[i] = di;
      if (di < dmin) { dmin = di; argmin = i; }
    }

    let wsum = 0, len = 0, stiff = 0;
    let fx = 0, fy = 0, fz = 0;
    let cr = 0, cg = 0, cb = 0;
    const inv = 1 / Math.max(sigma, 1e-4);
    for (let k = 0; k < nn; k++) {
      const i = near[k];
      const t = (ds[i] - dmin) * inv;
      if (t > 6) continue;                   // exp(-6) — negligible
      const w = Math.exp(-t * t * 0.5);      // gaussian in distance excess
      const p = prims[i];
      wsum += w;
      // Fur length spans more than an order of magnitude (0.6 mm on the
      // rhinarium to 58 mm on the tail), so blend it GEOMETRICALLY. An
      // arithmetic mean of 3 mm muzzle and 45 mm ruff is 24 mm, which buried
      // the short face fur that ART_DIRECTION §4b says sells the face; the
      // geometric mean is 11 mm and keeps falling as the ruff's weight drops.
      len += w * Math.log(p.furLength > 1e-5 ? p.furLength : 1e-5);
      stiff += w * p.furStiffness;

      // radial direction away from this primitive's own axis
      let rx = 0, ry = 0, rz = 0;
      if (p.flowRadial > 0) {
        const ax = p.a[0], ay = p.a[1], az = p.a[2];
        const bx = p.b[0] - ax, by = p.b[1] - ay, bz = p.b[2] - az;
        const l2 = bx * bx + by * by + bz * bz;
        let u = 0;
        if (l2 > 1e-12) {
          u = ((x - ax) * bx + (y - ay) * by + (z - az) * bz) / l2;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
        }
        rx = x - (ax + bx * u); ry = y - (ay + by * u); rz = z - (az + bz * u);
        const rl = Math.hypot(rx, ry, rz);
        if (rl > 1e-9) { rx /= rl; ry /= rl; rz /= rl; } else { rx = 0; ry = 1; rz = 0; }
      }
      const d0 = p.flowDir;
      const vx = d0[0] + rx * p.flowRadial;
      const vy = d0[1] + ry * p.flowRadial - p.flowDown;
      const vz = d0[2] + rz * p.flowRadial;
      const vl = Math.hypot(vx, vy, vz) || 1;
      fx += w * vx / vl; fy += w * vy / vl; fz += w * vz / vl;

      const tint = p.tint;
      cr += w * ((tint >> 16) & 255); cg += w * ((tint >> 8) & 255); cb += w * (tint & 255);
    }
    if (wsum < 1e-9) wsum = 1;

    out.region = prims[argmin].region;
    out.nearest = argmin;
    out.furLength = Math.exp(len / wsum);
    out.furStiffness = stiff / wsum;
    const fl = Math.hypot(fx, fy, fz);
    if (fl > 1e-9) { out.flow[0] = fx / fl; out.flow[1] = fy / fl; out.flow[2] = fz / fl; }
    else { out.flow[0] = 0; out.flow[1] = 0; out.flow[2] = -1; }
    out.tint[0] = cr / wsum / 255; out.tint[1] = cg / wsum / 255; out.tint[2] = cb / wsum / 255;
    return out;
  }

  static newSample() {
    return { region: 0, nearest: 0, furLength: 0, furStiffness: 0, flow: [0, 0, -1], tint: [1, 1, 1] };
  }
}
