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
import {
  buildField, REGION as R, FUR, NECK_CREST, TORSO_REGIONS, CRANIUM, EAR, EAR_NORMAL, EAR_SPAN,
  LANDMARKS, skullXf, rostral,
} from './FoxAnatomy.js';
import { Field } from './AnatField.js';
import {
  sampleGrid, surfaceNets, buildAdjacency, buildAdjacencyTri, relax,
  analyticNormals, triangulate, smoothField, refineCurvature,
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

/**
 * WHERE THE UNIFORM CELL IS TOO COARSE, AND WHY THE ANSWER IS A ZONE.
 *
 * The cell is uniform and the curvature is not. Measured on the shipped mesh,
 * neighbour-normal step between adjacent faces:
 *
 *   flank / back      median  1.7 deg   p90  4.9   — invisible, 80 mm radius
 *   muzzle tip <30mm  median 13.3 deg   p90 29.1   — the reviewers' "decagon"
 *   upper pinna       median  8.6 deg   p90 24.2   — the ear stair-step
 *
 * A uniform 3 mm cell fixes both (muzzle median 6.7 / p90 14.0) at 4x the
 * triangles, which we cannot spend: `buildShellGeometry` hands the fur an
 * InstancedBufferGeometry over THESE buffers, so a skin triangle is drawn once
 * per shell (18 at `high`) plus once more by the coat's shadow caster.
 *
 * Refining by curvature ALONE is also unaffordable — it selects 39 % of the
 * whole mesh at a 12 deg threshold, because the legs, hocks and paws are thin
 * tubes and are just as curved as the muzzle (hock 1238, pawFront 1041,
 * legFrontLower 1764 triangles). They are also under 9-20 mm of coat and are
 * not what any review pose is pointed at. So the zone is the HEAD, and the
 * leg/hock/paw curvature is recorded here for whoever gets the budget for it.
 *
 * ## The zone is three capsules, not a sphere
 *
 * A single ball around the head cannot separate the ear tips from the armpit:
 * measured off the runtime rig, the ear tip is 99.8 mm from the skull axis and
 * the axilla is 99.3 mm. The first version of this used one sphere and put 90
 * refined vertices and a 145 degree fold into the chest and belly, 30 mm
 * outside anything the selection had asked for.
 *
 * So the zone follows the anatomy: one capsule down the skull's own axis
 * (braincase centre -> the nose-pad point `Fox.js` marches its nose anchor
 * from, so a rostrum change moves both together) and one down each pinna
 * (ear base -> ear tip). Every endpoint is a live rig anchor, so a proportion
 * change carries the zone with it instead of leaving it behind. NOTE that
 * `LANDMARKS` is REWRITTEN at module load by `skullXf` — the literals in
 * FoxAnatomy are authored-space and are not what you get at runtime.
 */
const SKULL_ZONE_R = 0.050;     // covers muzzle tip 27.6 mm, skull top 31.2, neck02 34.0
const EAR_ZONE_R = 0.035;       // pinna base half-width is ~26 mm plus the blade

function headZone() {
  CRANIUM.refresh();
  return [
    { a: CRANIUM.braincase.c, b: skullXf(rostral([0, 0.2930, 0.2480])), r: SKULL_ZONE_R },
    { a: LANDMARKS.earR01, b: LANDMARKS.earR_tip, r: EAR_ZONE_R },
    { a: LANDMARKS.earL01, b: LANDMARKS.earL_tip, r: EAR_ZONE_R },
  ];
}

/** Squared distance from a point to a segment. */
function segDist2(x, y, z, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 > 1e-12 ? ((x - a[0]) * dx + (y - a[1]) * dy + (z - a[2]) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = x - (a[0] + dx * t), py = y - (a[1] + dy * t), pz = z - (a[2] + dz * t);
  return px * px + py * py + pz * pz;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export async function buildFoxSurface(skeleton, {
  cell = CELL.high,
  relaxIters = 3,
  fieldSmooth = 3,
  flowSmooth = 5,
  onYield = null,
  /**
   * Head refinement: `false` (positive control — the pre-refinement mesh, and
   * the base vertices are bit-identical either way), `true`, or a level count.
   */
  refine = true,
  /** Vertex-normal spread, in degrees, above which a triangle is split. */
  refineThresholdDeg = 12,
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
  const nets = surfaceNets(g, min, h, dims);
  const quads = nets.quads;
  let pos = nets.pos;
  let nv = nets.nv;
  timings.nets = now() - t;
  if (!nv) throw new Error('FoxSurface: empty isosurface');
  await yieldNow();

  t = now();
  let adj = buildAdjacency(nv, quads);
  timings.adjacency = now() - t;
  await yieldNow();

  t = now();
  relax(field, pos, adj, h, relaxIters);
  timings.relax = now() - t;
  await yieldNow();

  t = now();
  let normals = analyticNormals(field, pos, h);
  let index = triangulate(pos, normals, quads);
  timings.normals = now() - t;
  await yieldNow();

  // ------------------------------------------------------------- refinement --
  // See SKULL_ZONE_R above for why the zone exists and why it is the head.
  // Everything after this point — the fur fields, the log-space smoothing, the
  // skin weights — runs over the REFINED vertex set, so no downstream system
  // has to know this happened.
  t = now();
  const caps = headZone();
  const inZone = (x, y, z, grow) => {
    for (const c of caps) {
      const r = c.r + grow;
      if (segDist2(x, y, z, c.a, c.b) < r * r) return true;
    }
    return false;
  };
  const ref = refineCurvature(field, pos, normals, index, {
    zone: (x, y, z) => inZone(x, y, z, 0),
    // One cell of dilation: enough for the closure to make clean 1:4 splits at
    // the patch boundary, and provably not enough to reach anything else.
    edgeZone: (x, y, z) => inZone(x, y, z, h),
    // 12 deg of vertex-normal spread across one triangle. Swept 10/12/14/16/18
    // at two levels, reporting the p90 neighbour-normal step it actually
    // delivers at the muzzle tip and the upper pinna against the triangles it
    // costs:
    //
    //   thr   tris    nose p90   ear p90
    //    10   44366     9.23       8.77
    //    12   41782     9.28       9.19     <- here
    //    14   39668    10.02       9.54
    //    16   37440    10.93      10.18
    //    18   35570    12.51      10.96
    //
    // 12 is the loosest threshold that puts BOTH under 10 deg; 10 buys 0.05 deg
    // for another 2584 triangles, which is 46 000 more fur triangles for
    // nothing.
    thresholdDeg: refineThresholdDeg,
    levels: typeof refine === 'number' ? refine : (refine ? 2 : 0),
    // Floor on a splittable edge. One level takes the 5.6 mm muzzle edge to
    // 2.8 mm, which is the 2-3 mm the target asks for; a second level is only
    // wanted where the FIRST one did not get there, so the floor sits just
    // under a level-0 edge and the second level lands on the pinna rim and the
    // rhinarium and nowhere else.
    minEdge: 0.0013,
    baseGradH: h * 0.30,
  });
  pos = ref.pos;
  index = ref.index;
  nv = ref.nv;
  // Refined vertices get a central-difference step scaled to their own edge
  // length; base vertices keep h * 0.30 and their normals are bit-identical.
  normals = analyticNormals(field, pos, h, ref.gradH);
  adj = buildAdjacencyTri(nv, index);
  timings.refine = now() - t;
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
  const ep = { u: 0, w: 0, n: 0, side: 1 };     // scratch for EAR.project
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
      } else if ((reg === R.neck || reg === R.ruff) && !CRANIUM.contains(x, y, z)) {
        // The NECK CREST. 55a9475 measured that no per-region depth moves the
        // profile topline and named the prerequisite: "a dorsal region split".
        // This is it. The ruff's 58 mm is authored for the cheek-throat mane,
        // which is lateral and ventral; left on the dorsal midline it puts a
        // 17 mm coat STEP in front of the withers pointing the wrong way, and
        // that step is most of why the topline had no withers to find.
        // The cranium is excluded so the crown band stays at its own depth.
        //
        // The weight is NOT `wBack`. `wBack` opens at ny = 0.30, i.e. 72 deg
        // off vertical, which reaches most of the way down the sides of the
        // neck -- and measured at `paws`, where the camera is 55 mm off the
        // snow and the frame crops the back, that cost five sub-1.15-tv
        // contour scans on the LEFT edge (rows y 8-26, all new). A crest is
        // the midline strip, so this opens at ny = 0.62 and is only fully on
        // at ny = 0.93. The lateral ruff keeps its authored 58 mm, which is
        // what that number was written for.
        const wCrest = smoothstep(0.62, 0.93, ny);
        len = len + (NECK_CREST - len) * wCrest;
      }
      // Guard hair sweeps down the flanks and under the belly.
      const down = 0.44 * wSide + 0.30 * wBelly;
      fy -= down;
      const l = Math.hypot(fx, fy, fz) || 1;
      fx /= l; fy /= l; fz /= l;
    }

    // --- the cranium owns its own region ------------------------------------
    // Done BEFORE the ear block so a relabelled dome vertex cannot then be
    // read as pinna. See CRANIUM in FoxAnatomy for why `region` is wrong on
    // the top of the head and what downstream reads it.
    if ((reg === R.neck || reg === R.ruff) && CRANIUM.contains(x, y, z)) reg = R.skull;

    // --- ear: concha, rim and blade ----------------------------------------
    // The concha is carved by a subtraction, and subtractions own no surface,
    // so `earInner` would never be assigned from primitives alone.
    //
    // It used to be assigned by surface ORIENTATION — forward-facing is the
    // concha, edge-on is the rim. That was sound only while the bowl was a
    // flat plane, because then the one place on the pinna facing sideways WAS
    // the outer edge. Now that there is a real bowl, its side walls face
    // sideways too, and the orientation test would have handed them the rim's
    // x2.55 fringe: the heaviest coat on the head, growing inward, filling in
    // the concha the carve had just cut. So the concha is located by POSITION,
    // in the pinna's own frame, and the rim keeps the orientation test with
    // the bowl explicitly masked out of it.
    let earRim = 0;
    if (reg === R.earOuter) {
      EAR.project(x, y, z, ep);
      const bw = EAR.bowlHalfWidthAt(saturate(ep.u));
      const wIn =
        (1 - smoothstep(bw - 0.005, bw + 0.005, Math.abs(ep.w))) *  // inboard of the rim
        smoothstep(0.0, 0.008, ep.n) *                              // forward of the mid-plane
        (1 - smoothstep(EAR.bowlU1, EAR.bowlU1 + 0.18, ep.u));      // below the bowl's top
      if (wIn > 0) {
        len = len + (FUR[R.earInner][0] - len) * wIn;
        stiff = stiff + (FUR[R.earInner][1] - stiff) * wIn;
        if (wIn > 0.5) reg = R.earInner;
      }
      // The RIM is where the pinna goes edge-on: neither the outer face nor
      // the concha, but the band between them, and it is precisely the band
      // that draws the ear's outline. A per-region coat length cannot single
      // it out because it is not a region — it is an orientation. Left at the
      // pinna's average depth it renders as the hardest line on the animal
      // (user 2x crop: a stair-stepped blue-grey cutout). A real winter fox
      // carries a heavy fringe here, sweeping up the leading edge, and that
      // fringe is the thing that breaks the ear silhouette.
      const sx = x >= 0 ? 1 : -1;
      const dot = nx * EAR_NORMAL[0] * sx + ny * EAR_NORMAL[1] + nz * EAR_NORMAL[2];
      earRim = (1 - smoothstep(0.05, 0.55, Math.abs(dot))) * (1 - wIn);
    }

    // --- pinna coat shortens toward the tip --------------------------------
    // A constant coat offset on a tapering cone collapses the taper: 1.95:1 of
    // skin became 1.57:1 furred, which is what read as a paddle (REVIEW-2
    // blocker 1). Real ear fur is long where the pinna meets the ruff and
    // short at the rim, which preserves the wedge.
    if (reg === R.earOuter || reg === R.earInner) {
      const t = saturate((y - EAR_SPAN.baseY) / (EAR_SPAN.tipY - EAR_SPAN.baseY));
      // 0.64 left the apex with 5 mm of coat — measured on the built mesh, the
      // single highest skin vertex on the whole animal was a BALD ear tip, and
      // §4c asks for a soft rounded apex, which 5 mm cannot give. 0.46 keeps
      // ~8.4 mm there and the taper still does its job (the pinna's furred
      // base-to-tip ratio is what §4c's wedge is measured on).
      len *= 1.0 - EAR.tipTaper * t;
      // Rim fringe, applied AFTER the tip taper so the fringe tapers with the
      // pinna and the §4c wedge survives. Softer than the pinna face too: a
      // stiff fringe reads as bristle, and on the reference animal this hair
      // is long, fine and combed along the edge.
      if (earRim > 0) {
        // `fringeTip` tapers the fringe along the pinna — see EAR in
        // FoxAnatomy for the measurement that says why it is not constant.
        const g = EAR.fringe * (1 - (1 - EAR.fringeTip) * t);
        len *= 1 + g * earRim;
        stiff -= EAR.fringeSoften * earRim;
      }
    }

    // --- the coat shortens to the eyelid margin -----------------------------
    // The fur shader carves a bald disc around each eye whose RADIUS scales
    // with the LOCAL coat depth (uEyeFade = 9.8 mm + 0.85 per metre of coat).
    // That coefficient was tuned when the face carried 4-32 mm. §4f took the
    // face to 15-40 mm, which puts the disc at ~44 mm radius while the pupils
    // are only 58 mm apart — the two discs meet across the bridge of the nose
    // and shave the entire front of the face. That is §4f's own failure,
    // inverted, and arriving through a uniform the fur agent owns.
    // Capping the coat by distance to the eyeball shrinks the disc as well as
    // the coat (the shader reads the raw authored length), so the transition
    // tightens rather than spreading — and it is what the animal does: canids
    // are bald to the lid margin and the coat deepens away from the orbit.
    if (reg === R.forehead || reg === R.cheek || reg === R.skull ||
        reg === R.muzzle || reg === R.jawLower) {
      const dx1 = x - eyes.R.centre[0], dy1 = y - eyes.R.centre[1], dz1 = z - eyes.R.centre[2];
      const dx2 = x - eyes.L.centre[0], dy2 = y - eyes.L.centre[1], dz2 = z - eyes.L.centre[2];
      const dEye = Math.min(Math.hypot(dx1, dy1, dz1), Math.hypot(dx2, dy2, dz2));
      len = Math.min(len, 0.0035 + Math.max(0, dEye - 0.007));
    }

    // --- the muzzle's short coat must not leak back onto the jaw ------------
    // §4f.2 pins the muzzle at 3-4 mm, and the softmax that blends the fur
    // fields is isotropic, so the muzzle root drags the coat down across the
    // whole jaw line BEHIND it: measured 14.8 mm on the lateral jaw where the
    // cheek authors 40. That band is exactly where the user's 3x crop shows a
    // stair-stepped bare skin edge with ruff fur visible beyond it — the coat
    // simply is not there to cover the head's own silhouette against the body.
    // A floor that ramps up with distance behind the muzzle root removes the
    // leak while leaving the muzzle itself untouched, so the short-muzzle /
    // deep-skull contrast §4f asks for survives intact.
    if (reg === R.cheek || reg === R.jawLower || reg === R.muzzle) {
      const back = smoothstep(0.2140, 0.1920, z);
      const floor = FUR[R.jawLower][0] * (1 - back) + FUR[R.cheek][0] * back;
      len = Math.max(len, floor * back * 0.72);
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
      len *= 0.78 + 0.22 * smoothstep(0.055, 0.150, y);
    }

    // --- the SOLE is pad leather, not coat ---------------------------------
    //
    // `addPaw` already says "pad leather faces the ground" and tints it, and
    // §4f rule 3's list of places bare skin is allowed is "the rhinarium, the
    // eyes and the paw pads" -- so this facet is the one surface on the animal
    // that is *supposed* to be hairless. It was carrying the full 9.5 mm.
    //
    // Measured (`paws` coverage matte, coat split into shells and cards, four
    // arms in one page session at one sim instant), the coat hanging below the
    // drawn skin at the worst paw was 20.5 mm -- 2.2x the 9.5 mm the surface
    // authors, because cards reach ~1.2x the local coat and then droop. Every
    // millimetre of it is under the snow by construction, where it can only
    // read as the leg being amputated at the snow line, and it is the whole of
    // spec.mjs's `the drawn foot meets the drawn snow` overage.
    //
    // Masked on the NORMAL, not on height, so it takes the ground-facing facet
    // and nothing else: the paw's front, sides and top keep their 9.5 mm and
    // the outline at every framing is still hair. `ny < -0.45` is ~63 deg
    // below horizontal; at `paws` the camera sits 64 mm above the snow and
    // cannot see a surface that steep on a paw that is in the snow.
    //
    // 0.40x leaves 3.8 mm, which is §4f rule 2's own short-coat band, not
    // zero -- there is still interdigital hair, just not a skirt.
    if (reg === R.pawFront || reg === R.pawHind) {
      const down = smoothstep(-0.45, -0.88, ny);
      const low = smoothstep(0.030, 0.014, y);
      len *= 1 - 0.60 * down * low;
    }

    // Never let a hair point into the body.
    // Minimum rise off the skin. 0.04 is 2.3 degrees, i.e. flat, and a flat
    // hair cannot break a silhouette — see the trunk flowRadial note in
    // FoxAnatomy. 0.13 is ~7.5 degrees, still a combed coat, but every hair
    // now has a component pointing out of the surface.
    const dn = fx * nx + fy * ny + fz * nz;
    if (dn < 0.13) {
      fx += nx * (0.13 - dn); fy += ny * (0.13 - dn); fz += nz * (0.13 - dn);
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
    if (dn < 0.12) {
      fx += nx * (0.12 - dn); fy += ny * (0.12 - dn); fz += nz * (0.12 - dn);
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
    refineAdded: ref.added,
    refineLevels: ref.perLevel,
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
