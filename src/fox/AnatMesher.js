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

const TILE = 4;          // grid points per axis in the leaf cull tile
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
  let evals = 0, culled = 0;

  const fill = (x0, x1, y0, y1, z0, z1, v) => {
    for (let k = z0; k < z1; k++) {
      for (let j = y0; j < y1; j++) {
        let o = x0 + nx * (j + ny * k);
        for (let i = x0; i < x1; i++) g[o++] = v;
      }
    }
    culled += (x1 - x0) * (y1 - y0) * (z1 - z0);
  };

  const visit = (x0, x1, y0, y1, z0, z1, span) => {
    const cx = min[0] + (x0 + (x1 - x0 - 1) * 0.5) * h;
    const cy = min[1] + (y0 + (y1 - y0 - 1) * 0.5) * h;
    const cz = min[2] + (z0 + (z1 - z0 - 1) * 0.5) * h;
    const rad = 0.5 * h * SQRT3 * Math.max(x1 - x0, y1 - y0, z1 - z0);
    const dc = field.distance(cx, cy, cz);
    if (Math.abs(dc) > rad + 1e-6) {
      fill(x0, x1, y0, y1, z0, z1, dc > 0 ? dc - rad : dc + rad);
      return;
    }
    if (span > TILE) {
      const hs = span >> 1;
      for (let k = z0; k < z1; k += hs) {
        for (let j = y0; j < y1; j += hs) {
          for (let i = x0; i < x1; i += hs) {
            visit(i, Math.min(i + hs, x1), j, Math.min(j + hs, y1), k, Math.min(k + hs, z1), hs);
          }
        }
      }
      return;
    }
    for (let k = z0; k < z1; k++) {
      const pz = min[2] + k * h;
      for (let j = y0; j < y1; j++) {
        const py = min[1] + j * h;
        let o = x0 + nx * (j + ny * k);
        for (let i = x0; i < x1; i++) g[o++] = field.distance(min[0] + i * h, py, pz);
        evals += x1 - x0;
      }
    }
  };

  const ROOT = TILE * 8;
  for (let k = 0; k < nz; k += ROOT) {
    for (let j = 0; j < ny; j += ROOT) {
      for (let i = 0; i < nx; i += ROOT) {
        visit(i, Math.min(i + ROOT, nx), j, Math.min(j + ROOT, ny),
          k, Math.min(k + ROOT, nz), ROOT);
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
      field.project(p, gradH, 1, h * 0.9);
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
    field.project(p, gradH, 2, h * 0.5);
    pos[o] = p[0]; pos[o + 1] = p[1]; pos[o + 2] = p[2];
  }
  return pos;
}

/**
 * Analytic normals from the SDF gradient at the final vertex positions.
 *
 * `gradHArr` is an optional PER-VERTEX central-difference step. The refinement
 * pass below needs it: a 1.8 mm difference (0.30 x a 6 mm cell) is a large
 * smoothing kernel next to a 2 mm ear rim, and it would hand the refined
 * vertices the same averaged normal their coarse parents had — i.e. it would
 * throw away exactly the curvature the refinement went to get. Base vertices
 * keep `h * 0.30` so nothing outside the refined zone moves by a bit.
 */
export function analyticNormals(field, pos, h, gradHArr = null) {
  const nv = pos.length / 3;
  const nor = new Float32Array(pos.length);
  const out = [0, 0, 0];
  const gradH = h * 0.30;
  for (let v = 0; v < nv; v++) {
    const o = v * 3;
    field.normal(pos[o], pos[o + 1], pos[o + 2], gradHArr ? gradHArr[v] : gradH, out);
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

// ---------------------------------------------------------------------------
// Adaptive refinement
// ---------------------------------------------------------------------------
/**
 * CURVATURE-DRIVEN RED-GREEN REFINEMENT, with Newton reprojection.
 *
 * ## The defect this exists for
 *
 * The voxel is uniform and the curvature is not. A 6 mm cell on an 80 mm flank
 * is a ~4 degree step between neighbouring face normals and invisible; the same
 * cell on the 6.5 mm radius of the muzzle tip is a ~15 degree step, and a dozen
 * of those flat panels is the "faceted pale decagon" two reviewers filed around
 * the nose. Measured on the shipped mesh, within 30 mm of the muzzle tip:
 * median neighbour-normal step 13.3 deg, p90 29.1, max 38.2, against 1.7 / 4.9
 * / 25.1 on the flank. The thin pinna has the same problem and it is what the
 * ear rim stair-steps on.
 *
 * ## Why refine the MESH rather than the GRID
 *
 * Halving the cell everywhere fixes it — measured, a uniform 3 mm cell takes
 * the muzzle to median 6.7 / p90 14.0 — but it is 4x the triangles, and the fur
 * shells are an InstancedBufferGeometry SHARING this geometry's buffers, so
 * every skin triangle is drawn once per shell (18 at `high`) and again by the
 * coat's shadow caster. Skin triangles are the most expensive triangles on the
 * animal. They have to be spent where the curvature is.
 *
 * ## Why this is not just a flat subdivision
 *
 * Every new vertex is the edge MIDPOINT PROJECTED ONTO THE ISOSURFACE with the
 * same Newton step the mesher already uses. Splitting a chord and pushing the
 * midpoint out to the surface is what recovers the curvature between two
 * existing samples; a flat 1:4 split would produce four coplanar triangles and
 * change nothing at all. Normals come from the analytic gradient at a step
 * scaled to the NEW edge length (see `analyticNormals`).
 *
 * ## Crack-free-ness
 *
 * Red-green: an edge is split if either of its triangles is selected, then the
 * marking is CLOSED (any triangle holding exactly two marked edges gets its
 * third marked) until only 0-, 1- and 3-marked triangles remain. 3 -> four
 * children, 1 -> two children, 0 -> untouched. No T-junctions, so no hairline
 * seam can open in the skin — which matters more here than usual, because a
 * crack in the skin is a crack in all 18 fur shells and in the shadow caster.
 *
 * @param field   the SDF
 * @param pos     Float64Array, mutated only by being copied
 * @param nor     Float32Array of analytic normals (drives the selection)
 * @param index   Uint32Array triangle indices
 * @returns { pos, nor, index, gradH, nv, nvBase, added, perLevel }
 */
export function refineCurvature(field, pos, nor, index, opts = {}) {
  const {
    zone = null,              // (x, y, z) -> bool; null = everywhere
    edgeZone = null,          // (x, y, z) -> bool; zone dilated by a ring. See below.
    thresholdDeg = 12,
    levels = 2,
    minEdge = 0.0018,         // never split below this; bounds the cost
    baseGradH = 0.0018,
    gradFrac = 0.30,
    /**
     * Refuse to split an edge whose two endpoint normals disagree by more than
     * this. Such an edge is not a curved patch that more samples would resolve
     * — it spans a place where the two sides of a sheet have met, and the mesh
     * is already degenerate there. On this animal that is the apex of the
     * pinna, where the blade is thinner than one cell: the SHIPPED mesh
     * already carries 12 near-180 deg face pairs there, and subdividing them
     * merely produces 24. Declining costs nothing and buys back the triangles.
     */
    maxEdgeNormalDeg = 100,
  } = opts;

  const cosThr = Math.cos(thresholdDeg * Math.PI / 180);
  const cosMaxEdge = Math.cos(maxEdgeNormalDeg * Math.PI / 180);
  const KEY = 1 << 22;        // > any vertex count we will ever reach here

  // Growable vertex arrays.
  let nv = pos.length / 3;
  const P = Array.from(pos);
  const N = Array.from(nor);
  const GH = new Array(nv).fill(baseGradH);
  let idx = index;
  const perLevel = [];
  const p = [0, 0, 0];
  const nOut = [0, 0, 0];

  for (let level = 0; level < levels; level++) {
    const nt = idx.length / 3;

    // ---------------------------------------------------- select triangles --
    const sel = new Uint8Array(nt);
    let nSel = 0;
    for (let t = 0; t < nt; t++) {
      const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
      // Longest edge first: a triangle already at the floor is never selected,
      // so a crease of unbounded curvature cannot refine forever.
      let longest = 0;
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const d = Math.hypot(P[u * 3] - P[v * 3], P[u * 3 + 1] - P[v * 3 + 1], P[u * 3 + 2] - P[v * 3 + 2]);
        if (d > longest) longest = d;
      }
      if (longest < minEdge * 2) continue;

      // ALL THREE vertices, not the centroid: containment has to be provable.
      // A centroid test let a triangle straddling the boundary pull its outside
      // vertices in, and with the closure below that is how the patch escaped.
      if (zone && !(zone(P[a * 3], P[a * 3 + 1], P[a * 3 + 2])
        && zone(P[b * 3], P[b * 3 + 1], P[b * 3 + 2])
        && zone(P[c * 3], P[c * 3 + 1], P[c * 3 + 2]))) continue;

      // Spread of the ANALYTIC normals across the triangle. This is the
      // quantity the review complains about, one step removed: the face-normal
      // step between two neighbours is bounded by the vertex-normal spread
      // across the pair, and both scale as (edge / radius of curvature).
      let worst = 1;
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const d = N[u * 3] * N[v * 3] + N[u * 3 + 1] * N[v * 3 + 1] + N[u * 3 + 2] * N[v * 3 + 2];
        if (d < worst) worst = d;
      }
      if (worst < cosThr) { sel[t] = 1; nSel++; }
    }
    if (!nSel) { perLevel.push({ level, selected: 0, split: 0, added: 0 }); break; }

    // ------------------------------------------------------- mark and close --
    const marked = new Set();
    const ekey = (u, v) => (u < v ? u * KEY + v : v * KEY + u);

    /**
     * An edge may only be cut if it is short enough to be worth cutting, if it
     * is not a degenerate pinch (see maxEdgeNormalDeg), and if its midpoint is
     * inside the DILATED zone.
     *
     * That last clause is not belt-and-braces. Closure propagates: a triangle
     * outside the patch that ends up with two marked edges gets its third
     * marked, which can give ITS neighbour two, and so on. Left unbounded it
     * walked 32 mm past a 115 mm head zone and put a 145 degree fold in the
     * chest, four cells outside anything the selection had asked for.
     */
    const edgeOK = (u, v) => {
      const uo = u * 3, vo = v * 3;
      const ex = P[vo] - P[uo], ey = P[vo + 1] - P[uo + 1], ez = P[vo + 2] - P[uo + 2];
      if (ex * ex + ey * ey + ez * ez < minEdge * minEdge * 4) return false;
      const d = N[uo] * N[vo] + N[uo + 1] * N[vo + 1] + N[uo + 2] * N[vo + 2];
      if (d < cosMaxEdge) return false;
      if (edgeZone && !(edgeZone(P[uo], P[uo + 1], P[uo + 2]) && edgeZone(P[vo], P[vo + 1], P[vo + 2]))) return false;
      return true;
    };

    for (let t = 0; t < nt; t++) {
      if (!sel[t]) continue;
      const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
      if (edgeOK(a, b)) marked.add(ekey(a, b));
      if (edgeOK(b, c)) marked.add(ekey(b, c));
      if (edgeOK(c, a)) marked.add(ekey(c, a));
    }
    // Closure turns two-edge splits into clean 1:4 reds where it can. It is
    // now optional — the re-index below handles a two-edge triangle directly —
    // so it is capped, and it never overrides edgeOK.
    for (let sweep = 0; sweep < 3; sweep++) {
      let changed = 0;
      for (let t = 0; t < nt; t++) {
        const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
        const kab = ekey(a, b), kbc = ekey(b, c), kca = ekey(c, a);
        const m = (marked.has(kab) ? 1 : 0) + (marked.has(kbc) ? 1 : 0) + (marked.has(kca) ? 1 : 0);
        if (m !== 2) continue;
        if (!marked.has(kab)) { if (edgeOK(a, b)) { marked.add(kab); changed++; } }
        else if (!marked.has(kbc)) { if (edgeOK(b, c)) { marked.add(kbc); changed++; } }
        else if (edgeOK(c, a)) { marked.add(kca); changed++; }
      }
      if (!changed) break;
    }

    // ------------------------------------------------------- cut midpoints --
    const mid = new Map();
    let reverted = 0;
    for (const key of marked) {
      const u = Math.floor(key / KEY), v = key - u * KEY;
      const uo = u * 3, vo = v * 3;
      const ex = P[vo] - P[uo], ey = P[vo + 1] - P[uo + 1], ez = P[vo + 2] - P[uo + 2];
      const el = Math.hypot(ex, ey, ez);
      const mx = P[uo] + ex * 0.5, my = P[uo + 1] + ey * 0.5, mz = P[uo + 2] + ez * 0.5;
      const gh = Math.max(gradFrac * el * 0.5, 1.2e-4);

      p[0] = mx; p[1] = my; p[2] = mz;
      // A chord midpoint on a convex patch sits about el^2/8R inside the
      // surface, which is sub-millimetre here — so a projection that wants to
      // move further than a third of the edge has found a DIFFERENT sheet of
      // the surface (the far face of a 4 mm pinna, say) and must be refused.
      const d0 = field.distance(mx, my, mz);
      if (Math.abs(d0) < el * 0.45) field.project(p, gh, 3, el * 0.34);

      field.normal(p[0], p[1], p[2], gh, nOut);
      const du = nOut[0] * N[uo] + nOut[1] * N[uo + 1] + nOut[2] * N[uo + 2];
      const dv = nOut[0] * N[vo] + nOut[1] * N[vo + 1] + nOut[2] * N[vo + 2];
      if (du < 0 || dv < 0) {
        // Normal flipped against both parents: we crossed the medial axis.
        // Keep the flat midpoint and the averaged normal rather than fold.
        reverted++;
        p[0] = mx; p[1] = my; p[2] = mz;
        nOut[0] = N[uo] + N[vo]; nOut[1] = N[uo + 1] + N[vo + 1]; nOut[2] = N[uo + 2] + N[vo + 2];
        const l = Math.hypot(nOut[0], nOut[1], nOut[2]) || 1;
        nOut[0] /= l; nOut[1] /= l; nOut[2] /= l;
      }

      mid.set(key, nv);
      P.push(p[0], p[1], p[2]);
      N.push(nOut[0], nOut[1], nOut[2]);
      GH.push(gh);
      nv++;
    }

    // ---------------------------------------------------------- re-index ----
    const out = [];
    let red = 0, green2 = 0, green1 = 0;
    for (let t = 0; t < nt; t++) {
      const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
      const ab = mid.get(ekey(a, b)), bc = mid.get(ekey(b, c)), ca = mid.get(ekey(c, a));
      const m = (ab !== undefined ? 1 : 0) + (bc !== undefined ? 1 : 0) + (ca !== undefined ? 1 : 0);
      if (m === 0) { out.push(a, b, c); continue; }
      if (m === 3) {
        out.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
        red++;
        continue;
      }
      if (m === 2) {
        // Cut corner + the quad on the other side, split off the cut corner.
        green2++;
        if (ab === undefined) out.push(c, ca, bc, ca, a, b, ca, b, bc);
        else if (bc === undefined) out.push(a, ab, ca, ab, b, c, ab, c, ca);
        else out.push(b, bc, ab, bc, c, a, bc, a, ab);
        continue;
      }
      // One marked edge: bisect to the opposite corner.
      green1++;
      if (ab !== undefined) out.push(a, ab, c, ab, b, c);
      else if (bc !== undefined) out.push(b, bc, a, bc, c, a);
      else out.push(c, ca, b, ca, a, b);
    }
    perLevel.push({ level, selected: nSel, red, green2, green1, added: mid.size, reverted });
    idx = Uint32Array.from(out);
  }

  return {
    pos: Float64Array.from(P),
    nor: Float32Array.from(N),
    index: idx,
    gradH: Float64Array.from(GH),
    nv,
    nvBase: pos.length / 3,
    added: nv - pos.length / 3,
    perLevel,
  };
}

/**
 * Vertex adjacency (CSR) for a REFINED mesh, built so that the unrefined part
 * of the animal keeps EXACTLY the connectivity it had before.
 *
 * This is not fussiness. `smoothField` runs a Laplacian over this graph for
 * furLength, furStiffness and furFlow, and `computeWeights` reads it too — so
 * the graph is an input to the coat and to the skinning, not just a helper.
 * Simply rebuilding it from the triangles adds every quad DIAGONAL as a
 * neighbour, which changes the smoothing everywhere: measured against the
 * shipped mesher with the refinement switched OFF, 11134 of 12087 off-head
 * vertices moved their furLength (max 4.00 mm), all 12087 moved furFlow, and
 * all 12087 moved a skin weight. None of that is anything this change is for.
 *
 * So the edge set is: every QUAD edge that still exists in the refined mesh,
 * plus every refined-triangle edge that touches a vertex the refinement added.
 * Where nothing was refined that is the quad edge set, bit for bit.
 */
export function buildAdjacencyRefined(nv, quads, index, nvBase) {
  const nt = index.length / 3;
  const KEY = nv;
  const live = new Set();
  for (let t = 0; t < nt; t++) {
    for (let s = 0; s < 3; s++) {
      let u = index[t * 3 + s], v = index[t * 3 + ((s + 1) % 3)];
      if (u === v) continue;
      if (u > v) { const q = u; u = v; v = q; }
      live.add(u * KEY + v);
    }
  }

  const deg = new Int32Array(nv);
  const seen = new Set();
  const ea = [], eb = [];
  const add = (u0, v0) => {
    if (u0 === v0) return;
    const u = u0 < v0 ? u0 : v0, v = u0 < v0 ? v0 : u0;
    const key = u * KEY + v;
    if (seen.has(key)) return;
    seen.add(key);
    ea.push(u); eb.push(v);
    deg[u]++; deg[v]++;
  };
  // Quad edges that survived the refinement.
  const nq = quads.length / 4;
  for (let q = 0; q < nq; q++) {
    for (let s = 0; s < 4; s++) {
      let u = quads[q * 4 + s], v = quads[q * 4 + ((s + 1) & 3)];
      if (u === v) continue;
      if (u > v) { const t2 = u; u = v; v = t2; }
      if (live.has(u * KEY + v)) add(u, v);
    }
  }
  // Every edge the refinement introduced.
  for (let t = 0; t < nt; t++) {
    for (let s = 0; s < 3; s++) {
      const u = index[t * 3 + s], v = index[t * 3 + ((s + 1) % 3)];
      if (u >= nvBase || v >= nvBase) add(u, v);
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
