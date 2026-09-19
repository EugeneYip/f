/**
 * FurCards — hair-card tufts for the silhouette. OWNER: fur agent.
 *
 * Shell fur always leaves the mesh's own smooth outline at grazing angles, and
 * a hard silhouette edge is an automatic fail. Cards fix that: each one is a
 * short strip of quads rooted on the skin, carrying two to five procedural
 * hairs, that rotates about its own hair axis to face the camera. Because they
 * are geometry they poke past the outermost shell and break the outline into
 * strands against the sky.
 *
 * They are skinned exactly like the body — every card carries the skin indices
 * and weights of the surface vertex it sprouted from — so they deform with the
 * animal instead of shearing off it.
 *
 * Placement is area-weighted and biased by `cardWeight` from the region table,
 * so the budget lands on the zones that read on the outline: ruff, tail, ear
 * fringe, cheek, hock, belly, plus the dorsal line and croup, which are on the
 * silhouette in every side-on framing.
 */
import * as THREE from 'three';
import { rng } from '../util/math.js';
import { REGION_TABLE } from './FurMaterial.js';
import { CARD_SHAPE } from '../shaders/fur.glsl.js';

/** Segments along a card. 3 is enough for the tuft to curve under gravity. */
const SEGMENTS = 3;

/**
 * @param {THREE.BufferGeometry} src  the fox body geometry
 * @param {Float32Array} occlusion    per-vertex baked occlusion (0 open, 1 closed)
 * @param {number} count              number of cards to place
 * @param {number} seed
 */
export function buildFurCards(src, occlusion, count, seed = 0xfa17) {
  const pos = src.getAttribute('position').array;
  const nor = src.getAttribute('normal').array;
  const tan = src.getAttribute('furTangent').array;
  const len = src.getAttribute('furLength').array;
  const stf = src.getAttribute('furStiffness').array;
  const reg = src.getAttribute('region').array;
  const si = src.getAttribute('skinIndex').array;
  const sw = src.getAttribute('skinWeight').array;
  const idx = src.getIndex().array;
  const nTri = idx.length / 3;

  // ---------------------------------------------------- triangle weights --
  const cdf = new Float64Array(nTri);
  let total = 0;
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), cr = new THREE.Vector3();
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  for (let t = 0; t < nTri; t++) {
    const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
    va.fromArray(pos, i0 * 3); vb.fromArray(pos, i1 * 3); vc.fromArray(pos, i2 * 3);
    ab.subVectors(vb, va); ac.subVectors(vc, va);
    const area = cr.crossVectors(ab, ac).length() * 0.5;

    // Region bias: the silhouette budget.
    const w0 = cardWeight(reg[i0]), w1 = cardWeight(reg[i1]), w2 = cardWeight(reg[i2]);
    // Longer coat gets more cards; short coat (muzzle, paws) gets almost none.
    const l = (len[i0] + len[i1] + len[i2]) / 3;
    const lw = Math.min(1, l / 0.030) ** 1.2;

    total += area * ((w0 + w1 + w2) / 3) * lw;
    cdf[t] = total;
  }
  if (total <= 0) return null;

  // ------------------------------------------------------------- sampling --
  const rand = rng(seed);
  const vPer = (SEGMENTS + 1) * 2;
  const nVert = count * vPer;
  const nIndex = count * SEGMENTS * 6;

  const aPos = new Float32Array(nVert * 3);
  const aNor = new Float32Array(nVert * 3);
  const aTan = new Float32Array(nVert * 3);
  const aLen = new Float32Array(nVert);
  const aStf = new Float32Array(nVert);
  const aReg = new Float32Array(nVert);
  const aAO = new Float32Array(nVert);
  const aSI = new Uint16Array(nVert * 4);
  const aSW = new Float32Array(nVert * 4);
  const aCard = new Float32Array(nVert * 4);
  const index = (nVert > 65535 ? new Uint32Array(nIndex) : new Uint16Array(nIndex));

  const nrm = new THREE.Vector3(), tg = new THREE.Vector3();
  let w = 0, wi = 0;

  for (let cI = 0; cI < count; cI++) {
    const t = pickTriangle(cdf, rand() * total);
    const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];

    // Uniform barycentric sample.
    let b1 = rand(), b2 = rand();
    if (b1 + b2 > 1) { b1 = 1 - b1; b2 = 1 - b2; }
    const b0 = 1 - b1 - b2;

    const px = pos[i0 * 3] * b0 + pos[i1 * 3] * b1 + pos[i2 * 3] * b2;
    const py = pos[i0 * 3 + 1] * b0 + pos[i1 * 3 + 1] * b1 + pos[i2 * 3 + 1] * b2;
    const pz = pos[i0 * 3 + 2] * b0 + pos[i1 * 3 + 2] * b1 + pos[i2 * 3 + 2] * b2;

    nrm.set(
      nor[i0 * 3] * b0 + nor[i1 * 3] * b1 + nor[i2 * 3] * b2,
      nor[i0 * 3 + 1] * b0 + nor[i1 * 3 + 1] * b1 + nor[i2 * 3 + 1] * b2,
      nor[i0 * 3 + 2] * b0 + nor[i1 * 3 + 2] * b1 + nor[i2 * 3 + 2] * b2,
    );
    if (nrm.lengthSq() < 1e-12) nrm.set(0, 1, 0); else nrm.normalize();

    tg.set(
      tan[i0 * 3] * b0 + tan[i1 * 3] * b1 + tan[i2 * 3] * b2,
      tan[i0 * 3 + 1] * b0 + tan[i1 * 3 + 1] * b1 + tan[i2 * 3 + 1] * b2,
      tan[i0 * 3 + 2] * b0 + tan[i1 * 3 + 2] * b1 + tan[i2 * 3 + 2] * b2,
    );
    // Re-orthogonalise against the interpolated normal.
    tg.addScaledVector(nrm, -tg.dot(nrm));
    if (tg.lengthSq() < 1e-10) tg.set(-nrm.z, 0, nrm.x);
    tg.normalize();

    const cLen = len[i0] * b0 + len[i1] * b1 + len[i2] * b2;
    const cStf = stf[i0] * b0 + stf[i1] * b1 + stf[i2] * b2;
    const cAO = occlusion
      ? occlusion[i0] * b0 + occlusion[i1] * b1 + occlusion[i2] * b2
      : 0;

    // Discrete data comes from the dominant corner — you cannot lerp a bone id.
    const dom = b0 >= b1 && b0 >= b2 ? i0 : (b1 >= b2 ? i1 : i2);
    const cReg = reg[dom];

    const cRand = rand();
    // Per-card length spread, deliberately narrow.
    //
    // Perpendicular reach past the skin is uCardLength * lenMul * rise, and
    // the target band is 1.10-1.25x the local coat. A wide spread puts the
    // MEAN in band while the top third sits far outside it and reads as
    // separate spikes — that is what produced the dorsal crest. 1.20:1 keeps
    // the whole distribution inside the band.
    const lenMul = CARD_SHAPE.lenMulMin + CARD_SHAPE.lenMulSpread * rand() * rand();

    const base = cI * vPer;
    for (let s = 0; s <= SEGMENTS; s++) {
      const v = s / SEGMENTS;
      for (let side = 0; side < 2; side++) {
        const o = base + s * 2 + side;
        aPos[o * 3] = px; aPos[o * 3 + 1] = py; aPos[o * 3 + 2] = pz;
        aNor[o * 3] = nrm.x; aNor[o * 3 + 1] = nrm.y; aNor[o * 3 + 2] = nrm.z;
        aTan[o * 3] = tg.x; aTan[o * 3 + 1] = tg.y; aTan[o * 3 + 2] = tg.z;
        aLen[o] = cLen; aStf[o] = cStf; aReg[o] = cReg; aAO[o] = cAO;
        for (let k = 0; k < 4; k++) {
          aSI[o * 4 + k] = si[dom * 4 + k];
          aSW[o * 4 + k] = sw[dom * 4 + k];
        }
        aCard[o * 4] = v;
        aCard[o * 4 + 1] = side === 0 ? -1 : 1;
        aCard[o * 4 + 2] = cRand;
        aCard[o * 4 + 3] = lenMul;
      }
    }
    for (let s = 0; s < SEGMENTS; s++) {
      const a = base + s * 2;
      index[wi++] = a; index[wi++] = a + 1; index[wi++] = a + 3;
      index[wi++] = a; index[wi++] = a + 3; index[wi++] = a + 2;
    }
    w++;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(aPos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(aNor, 3));
  g.setAttribute('furTangent', new THREE.BufferAttribute(aTan, 3));
  g.setAttribute('furLength', new THREE.BufferAttribute(aLen, 1));
  g.setAttribute('furStiffness', new THREE.BufferAttribute(aStf, 1));
  g.setAttribute('region', new THREE.BufferAttribute(aReg, 1));
  g.setAttribute('aFurAO', new THREE.BufferAttribute(aAO, 1));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(aSI, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(aSW, 4));
  g.setAttribute('aCard', new THREE.BufferAttribute(aCard, 4));
  g.setIndex(new THREE.BufferAttribute(index, 1));

  // Cards extend well past the skin and then get skinned; give the culler room.
  g.computeBoundingSphere();
  g.boundingSphere.radius *= 1.9;
  g.computeBoundingBox();

  return { geometry: g, cards: w, vertices: nVert, triangles: nIndex / 3 };
}

function cardWeight(regionId) {
  const r = REGION_TABLE[Math.round(regionId)];
  return r ? r.b[3] : 0.8;
}

/** Binary search into the cumulative area table. */
function pickTriangle(cdf, x) {
  let lo = 0, hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}
