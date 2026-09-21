/**
 * FoxSurface — turns the anatomy field into a skinned BufferGeometry plus the
 * per-vertex data the fur and animation agents consume.
 * OWNER: anatomy agent.
 *
 * Pipeline: SDF -> grid sample (tile-culled) -> Surface Nets -> adjacency ->
 * relax w/ Newton reprojection -> analytic normals -> triangulate -> fur
 * fields -> normal-based dorsal/ventral refinement -> field smoothing ->
 * region-constrained skin weights.
 *
 * Attributes written (all also exposed on `ctx.fox.attributes`):
 *   position      float3   metres, object space
 *   normal        float3   analytic SDF gradient at the final vertex
 *   furLength     float    metres of guard hair; 0.6 mm nose -> 62 mm tail
 *   furStiffness  float    0..1, high on back/tail guard hair
 *   furFlow       float3   unit hair direction, OBJECT space
 *   furTangent    float3   furFlow projected into the tangent plane, unit
 *   region        float    integer region id (see FoxAnatomy REGION)
 *   color         float3   TEMPORARY review tint (dark nose, pad leather).
 *                          The fur agent is free to ignore or drop it.
 *   skinIndex / skinWeight  4 influences, normalised
 */
import * as THREE from 'three';
import { smoothstep, saturate } from '../util/math.js';
import { buildField, REGION as R, FUR, TORSO_REGIONS, EAR_NORMAL, EAR_SPAN } from './FoxAnatomy.js';
import { Field } from './AnatField.js';
import {
  sampleGrid, surfaceNets, buildAdjacency, relax,
  analyticNormals, triangulate, smoothField,
} from './AnatMesher.js';

/**
 * Voxel edge length in metres, per quality tier.
 *
 * Sized directly rather than as "N cells along the longest axis": that made
 * the triangle count depend on the bounding box, so shortening the tail
 * silently pushed the mesh from 27k to 37k triangles. Cell size keeps the
 * budget stable while the anatomy is still being tuned.
 */
export const CELL = { low: 0.0076, medium: 0.0067, high: 0.0060, ultra: 0.0056 };

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export async function buildFoxSurface(skeleton, {
  cell = CELL.high,
  relaxIters = 3,
  fieldSmooth = 3,
  flowSmooth = 5,
  onYield = null,
} = {}) {
  const t0 = now();
  const timings = {};
  const yieldNow = onYield || (() => Promise.resolve());

  // ------------------------------------------------------------------ field --
  const { field, eyes } = buildField();
  timings.field = now() - t0;
  await yieldNow();

  // ----------------------------------------------------------------- domain --
  const b = field.bounds;
  const span = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const h = cell;
  const pad = h * 2.0;
  const min = [b.min[0] - pad, b.min[1] - pad, b.min[2] - pad];
  const dims = [
    Math.ceil((span[0] + pad * 2) / h) + 1,
    Math.ceil((span[1] + pad * 2) / h) + 1,
    Math.ceil((span[2] + pad * 2) / h) + 1,
  ];

  let t = now();
  const { g, evals, culled } = sampleGrid(field, min, h, dims);
  timings.sample = now() - t;
  await yieldNow();

  t = now();
  const { pos, quads, nv } = surfaceNets(g, min, h, dims);
  timings.nets = now() - t;
  if (!nv) throw new Error('FoxSurface: empty isosurface');
  await yieldNow();

  t = now();
  const adj = buildAdjacency(nv, quads);
  timings.adjacency = now() - t;
  await yieldNow();

  t = now();
  relax(field, pos, adj, h, relaxIters);
  timings.relax = now() - t;
  await yieldNow();

  t = now();
  const normals = analyticNormals(field, pos, h);
  const index = triangulate(pos, normals, quads);
  timings.normals = now() - t;
  await yieldNow();

  // --------------------------------------------------------- per-vertex data --
  t = now();
  const furLength = new Float32Array(nv);
  const furStiffness = new Float32Array(nv);
  const furFlow = new Float32Array(nv * 3);
  const furTangent = new Float32Array(nv * 3);
  const regionArr = new Float32Array(nv);
  const colorArr = new Float32Array(nv * 3);
  const s = Field.newSample();
  // Blend falloff for the fur fields. 20 mm let the 28 mm cheek ruff and the
  // 45 mm neck bleed onto the muzzle and forehead, which must stay at 2-6 mm
  // per the bible. 12 mm keeps the gradients smooth without crossing a whole
  // anatomical zone.
  //
  // §4f tightened it again, to 8.5 mm. Once the skull coat went from 7.5 mm to
  // 22 mm, a 10.5 mm softmax smeared the skull/muzzle step across ~30 mm of a
  // 110 mm head — and that step IS the face: "the contrast between a deep
  // skull coat and a short muzzle coat is what makes the face read pointy".
  // Measured on the jaw line, the muzzle's 3.4 mm was still dragging the local
  // coat down to 14.8 mm where the cheek authors 38 mm. The log-space Laplacian
  // below still smooths the result over the mesh, so this does not produce a
  // visible coat-depth edge.
  const sigma = 0.0085;

  for (let v = 0; v < nv; v++) {
    const o = v * 3;
    const x = pos[o], y = pos[o + 1], z = pos[o + 2];
    field.sample(x, y, z, sigma, s);

    let reg = s.region;
    let len = s.furLength;
    let stiff = s.furStiffness;
    let fx = s.flow[0], fy = s.flow[1], fz = s.flow[2];
    const nx = normals[o], ny = normals[o + 1], nz = normals[o + 2];

    // --- dorsal / lateral / ventral refinement -----------------------------
    // One trunk primitive spans back, flank and belly, so the surface normal
    // is what separates them. Weights are smooth, so the fur length and flow
    // gradients that come out of this have no hard edges.
    if (TORSO_REGIONS.has(reg)) {
      const wBack = smoothstep(0.30, 0.70, ny);
      const wBelly = smoothstep(0.22, 0.62, -ny);
      const wSide = saturate(1 - wBack - wBelly);
      const sum = wBack + wBelly + wSide || 1;

      if (reg === R.flank || reg === R.back || reg === R.belly) {
        len = (wBack * FUR[R.back][0] + wSide * FUR[R.flank][0] + wBelly * FUR[R.belly][0]) / sum;
        stiff = (wBack * FUR[R.back][1] + wSide * FUR[R.flank][1] + wBelly * FUR[R.belly][1]) / sum;
        reg = wBack > wSide && wBack > wBelly ? R.back : wBelly > wSide ? R.belly : R.flank;
      } else if (reg === R.chest && wBelly > 0.55) {
        reg = R.belly;
        len = FUR[R.belly][0]; stiff = FUR[R.belly][1];
      } else if (reg === R.croup && wBack > 0.6) {
        reg = R.back;
      }
      // Guard hair sweeps down the flanks and under the belly.
      const down = 0.60 * wSide + 0.34 * wBelly;
      fy -= down;
      const l = Math.hypot(fx, fy, fz) || 1;
      fx /= l; fy /= l; fz /= l;
    }

    // --- ear interior ------------------------------------------------------
    // The concha is carved by a subtraction, and subtractions own no surface,
    // so `earInner` would never be assigned from primitives alone. Split the
    // pinna by which way the surface faces instead.
    if (reg === R.earOuter) {
      const sx = x >= 0 ? 1 : -1;
      const dot = nx * EAR_NORMAL[0] * sx + ny * EAR_NORMAL[1] + nz * EAR_NORMAL[2];
      const w = smoothstep(0.15, 0.58, dot);
      if (w > 0) {
        len = len + (FUR[R.earInner][0] - len) * w;
        stiff = stiff + (FUR[R.earInner][1] - stiff) * w;
        if (w > 0.5) reg = R.earInner;
      }
    }

    // --- pinna coat shortens toward the tip --------------------------------
    // A constant coat offset on a tapering cone collapses the taper: 1.95:1 of
    // skin became 1.57:1 furred, which is what read as a paddle (REVIEW-2
    // blocker 1). Real ear fur is long where the pinna meets the ruff and
    // short at the rim, which preserves the wedge.
    if (reg === R.earOuter || reg === R.earInner) {
      const t = saturate((y - EAR_SPAN.baseY) / (EAR_SPAN.tipY - EAR_SPAN.baseY));
      len *= 1.0 - 0.64 * t;
    }

    // --- throat ------------------------------------------------------------
    // Soft underfur below the jaw and down the front of the neck. Same story:
    // the throat primitive is almost entirely buried inside the ruff.
    if ((reg === R.ruff || reg === R.neck || reg === R.cheek) && z > 0.09 && ny < -0.30) {
      const w = smoothstep(0.30, 0.72, -ny);
      len = len + (FUR[R.throat][0] - len) * w;
      stiff = stiff + (FUR[R.throat][1] - stiff) * w;
      if (w > 0.5) reg = R.throat;
    }

    // --- leg coat thins toward the foot ------------------------------------
    // A single length per leg region filled in the hock notch, so the joint
    // that REVIEW blocker 6 asks for was geometrically present (42 mm of
    // caudal protrusion) but buried under coat. Real leg fur shortens sharply
    // below the elbow and stifle; tapering it by height exposes the hock
    // without contradicting §4b's "belly fur obscures the top of the leg",
    // which is about the leg TOP, not the joint.
    if (reg === R.legHindUpper || reg === R.hock ||
        reg === R.legFrontUpper || reg === R.legFrontLower) {
      len *= 0.55 + 0.45 * smoothstep(0.055, 0.150, y);
    }

    // Never let a hair point into the body.
    const dn = fx * nx + fy * ny + fz * nz;
    if (dn < 0.04) {
      fx += nx * (0.04 - dn); fy += ny * (0.04 - dn); fz += nz * (0.04 - dn);
      const l = Math.hypot(fx, fy, fz) || 1;
      fx /= l; fy /= l; fz /= l;
    }

    furLength[v] = len;
    furStiffness[v] = stiff;
    furFlow[o] = fx; furFlow[o + 1] = fy; furFlow[o + 2] = fz;
    regionArr[v] = reg;
    colorArr[o] = srgbToLinear(s.tint[0]);
    colorArr[o + 1] = srgbToLinear(s.tint[1]);
    colorArr[o + 2] = srgbToLinear(s.tint[2]);
  }
  timings.fields = now() - t;
  await yieldNow();

  // --------------------------------------------------- smooth the fur fields --
  t = now();
  // Smooth fur length in log space for the same reason it is blended there:
  // an arithmetic Laplacian lets the 58 mm tail and 48 mm flank leak into the
  // 3 mm muzzle far faster than the reverse.
  for (let v = 0; v < nv; v++) furLength[v] = Math.log(Math.max(furLength[v], 1e-5));
  smoothField(furLength, 1, adj, fieldSmooth, 0.55);
  for (let v = 0; v < nv; v++) furLength[v] = Math.exp(furLength[v]);
  smoothField(furStiffness, 1, adj, fieldSmooth, 0.55);
  smoothField(furFlow, 3, adj, flowSmooth, 0.50, true);

  // Re-orthogonalise after smoothing, then derive the tangent frame.
  for (let v = 0; v < nv; v++) {
    const o = v * 3;
    let fx = furFlow[o], fy = furFlow[o + 1], fz = furFlow[o + 2];
    let l = Math.hypot(fx, fy, fz);
    if (l < 0.25) {                       // cancellation: fall back to caudal
      fx = 0; fy = 0.05; fz = -1; l = Math.hypot(fx, fy, fz);
    }
    fx /= l; fy /= l; fz /= l;
    const nx = normals[o], ny = normals[o + 1], nz = normals[o + 2];
    const dn = fx * nx + fy * ny + fz * nz;
    if (dn < 0.03) {
      fx += nx * (0.03 - dn); fy += ny * (0.03 - dn); fz += nz * (0.03 - dn);
      const l2 = Math.hypot(fx, fy, fz) || 1;
      fx /= l2; fy /= l2; fz /= l2;
    }
    furFlow[o] = fx; furFlow[o + 1] = fy; furFlow[o + 2] = fz;

    const d2 = fx * nx + fy * ny + fz * nz;
    let tx = fx - nx * d2, ty = fy - ny * d2, tz = fz - nz * d2;
    const tl = Math.hypot(tx, ty, tz);
    if (tl > 1e-5) { tx /= tl; ty /= tl; tz /= tl; }
    else {                                 // hair straight out: pick any tangent
      tx = -nz; ty = 0; tz = nx;
      const q = Math.hypot(tx, ty, tz) || 1; tx /= q; ty /= q; tz /= q;
    }
    furTangent[o] = tx; furTangent[o + 1] = ty; furTangent[o + 2] = tz;
  }
  timings.smooth = now() - t;
  await yieldNow();

  // ---------------------------------------------------------------- weights --
  t = now();
  const { skinIndex, skinWeight } = skeleton.computeWeights(pos, regionArr, adj);
  timings.weights = now() - t;
  await yieldNow();

  // --------------------------------------------------------------- geometry --
  const position = new Float32Array(nv * 3);
  for (let i = 0; i < nv * 3; i++) position[i] = pos[i];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colorArr, 3));
  geometry.setAttribute('furLength', new THREE.BufferAttribute(furLength, 1));
  geometry.setAttribute('furStiffness', new THREE.BufferAttribute(furStiffness, 1));
  geometry.setAttribute('furFlow', new THREE.BufferAttribute(furFlow, 3));
  geometry.setAttribute('furTangent', new THREE.BufferAttribute(furTangent, 3));
  geometry.setAttribute('region', new THREE.BufferAttribute(regionArr, 1));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  // Skinning can push verts well outside the bind bounds; give the culler slack.
  geometry.boundingSphere.radius *= 1.75;

  const stats = {
    vertices: nv,
    triangles: index.length / 3,
    quads: quads.length / 4,
    gridDims: dims,
    cell: h,
    gridEvals: evals,
    gridCulled: culled,
    timings,
    totalMs: now() - t0,
    ...skeleton.weightStats,
  };

  return { geometry, field, eyes, positions: pos, regions: regionArr, adjacency: adj, stats };
}

/** UNORM sRGB -> linear, matching three's working colour space. */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export { R as REGION };
