/**
 * AnatMesher — Surface Nets (naive dual contouring) over an SDF, plus a
 * constrained relax pass and analytic normals.
 * OWNER: anatomy agent.
 *
 * Why Surface Nets rather than classic Marching Cubes:
 *   - one vertex per straddling cell -> far fewer sliver triangles, and a
 *     much more even vertex distribution for the fur agent's shell offsets;
 *   - quads map cleanly onto a 2-triangle split along the shorter diagonal;
 *   - watertight and manifold for shapes thicker than ~1.5 cells (we keep
 *     every part of the fox — including the ear pinnae — above that).
 *
 * The three things that kill faceting:
 *   1. vertices sit exactly ON the isosurface (Newton projection), so the
 *      silhouette error is second order — h^2/8R, i.e. sub-pixel at our
 *      review framings;
 *   2. normals come from the analytic SDF gradient at the FINAL vertex
 *      position, not from cell corners or face averaging;
 *   3. a Laplacian relax (re-projected every iteration) evens out the
 *      staircase that the grid bakes into the tangential direction.
 */

const TILE = 8;          // grid points per axis in a cull tile
const SQRT3 = Math.sqrt(3);

/** 12 cube edges as corner-index pairs; corner bits are (x, y<<1, z<<2). */
const EDGES = [];
for (let i = 0; i < 8; i++) {
  for (let j = i + 1; j < 8; j++) {
    const x = i ^ j;
    if (x === 1 || x === 2 || x === 4) EDGES.push(i, j);
  }
}
const CORNER = new Float32Array(24);
for (let c = 0; c < 8; c++) {
  CORNER[c * 3] = c & 1;
  CORNER[c * 3 + 1] = (c >> 1) & 1;
  CORNER[c * 3 + 2] = (c >> 2) & 1;
}

/**
 * Evaluate the field on a uniform grid, skipping tiles the surface cannot
 * reach. The field is Lipschitz-1, so |d(centre)| > tileHalfDiagonal proves
 * the whole tile has one sign.
 */
export function sampleGrid(field, min, h, dims) {
  const [nx, ny, nz] = dims;                // number of grid POINTS
  const g = new Float32Array(nx * ny * nz);
  const halfDiag = 0.5 * (TILE - 1) * h * SQRT3;
  let evals = 0, culled = 0;

  for (let tz = 0; tz < nz; tz += TILE) {
    const ez = Math.min(tz + TILE, nz);
    for (let ty = 0; ty < ny; ty += TILE) {
      const ey = Math.min(ty + TILE, ny);
      for (let tx = 0; tx < nx; tx += TILE) {
        const ex = Math.min(tx + TILE, nx);
        const cx = min[0] + (tx + (ex - tx - 1) * 0.5) * h;
        const cy = min[1] + (ty + (ey - ty - 1) * 0.5) * h;
        const cz = min[2] + (tz + (ez - tz - 1) * 0.5) * h;
        const dc = field.distance(cx, cy, cz);
        if (Math.abs(dc) > halfDiag + 1e-6) {
          const fill = dc > 0 ? dc - halfDiag : dc + halfDiag;
          for (let k = tz; k < ez; k++) {
            for (let j = ty; j < ey; j++) {
              let o = tx + nx * (j + ny * k);
              for (let i = tx; i < ex; i++) g[o++] = fill;
            }
          }
          culled += (ex - tx) * (ey - ty) * (ez - tz);
          continue;
        }
        for (let k = tz; k < ez; k++) {
          const pz = min[2] + k * h;
          for (let j = ty; j < ey; j++) {
            const py = min[1] + j * h;
            let o = tx + nx * (j + ny * k);
            for (let i = tx; i < ex; i++) {
              g[o++] = field.distance(min[0] + i * h, py, pz);
            }
            evals += ex - tx;
          }
        }
      }
    }
  }
  return { g, evals, culled };
}

/** Surface Nets over a sampled grid. Returns positions + quad indices. */
export function surfaceNets(g, min, h, dims) {
  const [nx, ny, nz] = dims;
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cellVert = new Int32Array(cx * cy * cz).fill(-1);
  const pos = [];
  const corner = new Float64Array(8);

  const SX = 1, SY = nx, SZ = nx * ny;
  const coff = [0, SX, SY, SX + SY, SZ, SX + SZ, SY + SZ, SX + SY + SZ];

  let nv = 0;
  for (let k = 0; k < cz; k++) {
    for (let j = 0; j < cy; j++) {
      let base = nx * (j + ny * k);
      for (let i = 0; i < cx; i++, base++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = g[base + coff[c]];
          corner[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;

        let vx = 0, vy = 0, vz = 0, n = 0;
        for (let e = 0; e < 12; e++) {
          const a = EDGES[e * 2], b = EDGES[e * 2 + 1];
          const ga = corner[a], gb = corner[b];
          if ((ga < 0) === (gb < 0)) continue;
          let t = ga / (ga - gb);
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          vx += CORNER[a * 3] + t * (CORNER[b * 3] - CORNER[a * 3]);
          vy += CORNER[a * 3 + 1] + t * (CORNER[b * 3 + 1] - CORNER[a * 3 + 1]);
          vz += CORNER[a * 3 + 2] + t * (CORNER[b * 3 + 2] - CORNER[a * 3 + 2]);
          n++;
        }
        if (!n) continue;
        const inv = 1 / n;
        cellVert[i + cx * (j + cy * k)] = nv++;
        pos.push(
          min[0] + (i + vx * inv) * h,
          min[1] + (j + vy * inv) * h,
          min[2] + (k + vz * inv) * h,
        );
      }
    }
  }

  // --- faces ---------------------------------------------------------------
  // For each straddling axis edge leaving a cell's corner-0, the four cells
  // sharing that edge all straddle the surface, so all four have vertices.
  const quads = [];
  const CX = 1, CY = cx, CZ = cx * cy;
  for (let k = 0; k < cz; k++) {
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        const ci = i + cx * (j + cy * k);
        if (cellVert[ci] < 0) continue;
        const base = i + nx * (j + ny * k);
        const s0 = g[base] < 0;

        // axis X -> quad spans (Y, Z)
        if (i + 1 < nx && s0 !== (g[base + SX] < 0) && j > 0 && k > 0) {
          pushQuad(quads, cellVert, ci, CY, CZ, s0);
        }
        // axis Y -> quad spans (Z, X)
        if (j + 1 < ny && s0 !== (g[base + SY] < 0) && k > 0 && i > 0) {
          pushQuad(quads, cellVert, ci, CZ, CX, s0);
        }
        // axis Z -> quad spans (X, Y)
        if (k + 1 < nz && s0 !== (g[base + SZ] < 0) && i > 0 && j > 0) {
          pushQuad(quads, cellVert, ci, CX, CY, s0);
        }
      }
    }
  }
  return { pos: Float64Array.from(pos), quads: Int32Array.from(quads), nv };
}

function pushQuad(out, cellVert, ci, du, dv, flip) {
  const a = cellVert[ci];
  const b = cellVert[ci - du];
  const c = cellVert[ci - du - dv];
  const d = cellVert[ci - dv];
  if (a < 0 || b < 0 || c < 0 || d < 0) return;
  if (flip) out.push(a, b, c, d); else out.push(a, d, c, b);
}

/** Vertex adjacency (CSR) built from quad edges. */
export function buildAdjacency(nv, quads) {
  const deg = new Int32Array(nv);
  const nq = quads.length / 4;
  const seen = new Set();
  const ea = [], eb = [];
  for (let q = 0; q < nq; q++) {
    for (let s = 0; s < 4; s++) {
      let u = quads[q * 4 + s], v = quads[q * 4 + ((s + 1) & 3)];
      if (u === v) continue;
      if (u > v) { const t = u; u = v; v = t; }
      const key = u * nv + v;
      if (seen.has(key)) continue;
      seen.add(key);
      ea.push(u); eb.push(v);
      deg[u]++; deg[v]++;
    }
  }
  const start = new Int32Array(nv + 1);
  for (let i = 0; i < nv; i++) start[i + 1] = start[i] + deg[i];
  const cursor = start.slice(0, nv);
  const nb = new Int32Array(start[nv]);
  for (let e = 0; e < ea.length; e++) {
    nb[cursor[ea[e]]++] = eb[e];
    nb[cursor[eb[e]]++] = ea[e];
  }
  return { start, nb };
}

/**
 * Laplacian relax with per-iteration Newton reprojection onto the isosurface.
 * Total displacement from the dual-contour position is clamped so the mesh
 * can never fold through a neighbouring cell.
 */
export function relax(field, pos, adj, h, iterations = 3, lambda = 0.55) {
  const nv = pos.length / 3;
  const orig = pos.slice();
  const tmp = new Float64Array(pos.length);
  const gradH = h * 0.35;
  const cap = h * 0.85;
  const p = [0, 0, 0];

  for (let it = 0; it < iterations; it++) {
    for (let v = 0; v < nv; v++) {
      const s = adj.start[v], e = adj.start[v + 1];
      if (e === s) { tmp[v * 3] = pos[v * 3]; tmp[v * 3 + 1] = pos[v * 3 + 1]; tmp[v * 3 + 2] = pos[v * 3 + 2]; continue; }
      let ax = 0, ay = 0, az = 0;
      for (let t = s; t < e; t++) {
        const o = adj.nb[t] * 3;
        ax += pos[o]; ay += pos[o + 1]; az += pos[o + 2];
      }
      const inv = 1 / (e - s);
      tmp[v * 3] = pos[v * 3] + (ax * inv - pos[v * 3]) * lambda;
      tmp[v * 3 + 1] = pos[v * 3 + 1] + (ay * inv - pos[v * 3 + 1]) * lambda;
      tmp[v * 3 + 2] = pos[v * 3 + 2] + (az * inv - pos[v * 3 + 2]) * lambda;
    }
    for (let v = 0; v < nv; v++) {
      const o = v * 3;
      p[0] = tmp[o]; p[1] = tmp[o + 1]; p[2] = tmp[o + 2];
      field.project(p, gradH, 2, h * 0.9);
      // Leash to the original dual vertex.
      let dx = p[0] - orig[o], dy = p[1] - orig[o + 1], dz = p[2] - orig[o + 2];
      const l = Math.hypot(dx, dy, dz);
      if (l > cap) { const s2 = cap / l; dx *= s2; dy *= s2; dz *= s2; }
      pos[o] = orig[o] + dx; pos[o + 1] = orig[o + 1] + dy; pos[o + 2] = orig[o + 2] + dz;
    }
  }
  // Final snap so every vertex is exactly on the isosurface.
  for (let v = 0; v < nv; v++) {
    const o = v * 3;
    p[0] = pos[o]; p[1] = pos[o + 1]; p[2] = pos[o + 2];
    field.project(p, gradH, 3, h * 0.5);
    pos[o] = p[0]; pos[o + 1] = p[1]; pos[o + 2] = p[2];
  }
  return pos;
}

/** Analytic normals from the SDF gradient at the final vertex positions. */
export function analyticNormals(field, pos, h) {
  const nv = pos.length / 3;
  const nor = new Float32Array(pos.length);
  const out = [0, 0, 0];
  const gradH = h * 0.30;
  for (let v = 0; v < nv; v++) {
    const o = v * 3;
    field.normal(pos[o], pos[o + 1], pos[o + 2], gradH, out);
    nor[o] = out[0]; nor[o + 1] = out[1]; nor[o + 2] = out[2];
  }
  return nor;
}

/**
 * Quads -> triangles, split along the shorter diagonal, with the winding
 * verified against the analytic normals (and flipped wholesale if the dual
 * contour came out inside-out).
 */
export function triangulate(pos, nor, quads) {
  const nq = quads.length / 4;
  const idx = new Uint32Array(nq * 6);
  let w = 0;
  for (let q = 0; q < nq; q++) {
    const a = quads[q * 4], b = quads[q * 4 + 1], c = quads[q * 4 + 2], d = quads[q * 4 + 3];
    const d02 = sqDist(pos, a, c), d13 = sqDist(pos, b, d);
    if (d02 <= d13) {
      idx[w++] = a; idx[w++] = b; idx[w++] = c;
      idx[w++] = a; idx[w++] = c; idx[w++] = d;
    } else {
      idx[w++] = a; idx[w++] = b; idx[w++] = d;
      idx[w++] = b; idx[w++] = c; idx[w++] = d;
    }
  }

  // Global orientation check: sum geometric-vs-analytic normal agreement.
  let agree = 0;
  const stride = Math.max(1, Math.floor(idx.length / 3 / 600));
  for (let t = 0; t < idx.length / 3; t += stride) {
    const i0 = idx[t * 3] * 3, i1 = idx[t * 3 + 1] * 3, i2 = idx[t * 3 + 2] * 3;
    const ux = pos[i1] - pos[i0], uy = pos[i1 + 1] - pos[i0 + 1], uz = pos[i1 + 2] - pos[i0 + 2];
    const vx = pos[i2] - pos[i0], vy = pos[i2 + 1] - pos[i0 + 1], vz = pos[i2 + 2] - pos[i0 + 2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    agree += gx * nor[i0] + gy * nor[i0 + 1] + gz * nor[i0 + 2];
  }
  if (agree < 0) {
    for (let t = 0; t < idx.length; t += 3) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }
  }
  return idx;
}

function sqDist(pos, a, b) {
  const dx = pos[a * 3] - pos[b * 3];
  const dy = pos[a * 3 + 1] - pos[b * 3 + 1];
  const dz = pos[a * 3 + 2] - pos[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

/** Smooth a scalar/vector field over mesh adjacency. `dim` channels per vertex. */
export function smoothField(arr, dim, adj, iterations, lambda = 0.5, normalise = false) {
  const nv = arr.length / dim;
  let src = arr, dst = new Float32Array(arr.length);
  for (let it = 0; it < iterations; it++) {
    for (let v = 0; v < nv; v++) {
      const s = adj.start[v], e = adj.start[v + 1];
      const o = v * dim;
      if (e === s) { for (let c = 0; c < dim; c++) dst[o + c] = src[o + c]; continue; }
      const inv = 1 / (e - s);
      for (let c = 0; c < dim; c++) {
        let a = 0;
        for (let t = s; t < e; t++) a += src[adj.nb[t] * dim + c];
        dst[o + c] = src[o + c] + (a * inv - src[o + c]) * lambda;
      }
      if (normalise && dim === 3) {
        const l = Math.hypot(dst[o], dst[o + 1], dst[o + 2]);
        if (l > 1e-9) { dst[o] /= l; dst[o + 1] /= l; dst[o + 2] /= l; }
      }
    }
    const t = src; src = dst; dst = t;
  }
  if (src !== arr) arr.set(src);
  return arr;
}
