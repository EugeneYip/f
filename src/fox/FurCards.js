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

/* ----------------------------------------------------------------- clumps --
 * A card's LOCK: the nearest Worley site on a `CARD_SHAPE.clumpCell` lattice
 * in bind space. Cards sharing a site share a heading, a wind phase and half
 * their length draw, and lean their tips toward it — so several cards read as
 * one tuft with mass instead of as several separate hairs.
 *
 * Bind space, on the CPU, once at build time: the lock a hair belongs to is a
 * property of where it grows, not of the frame, so it must not be re-derived
 * per draw and must not move when the animal does.
 */

/** Deterministic integer hash -> [0,1). Not Math.random; not seeded state. */
function ihash(x, y, z, k) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)
        + Math.imul(z | 0, 1442695041) + Math.imul(k | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Exact Worley F1 over the 3x3x3 neighbourhood. Sites are unconstrained
 * within their cell, so 27 cells — not 8 — is what makes it exact; at 19k
 * cards that is half a million distance tests, once, at init.
 *
 * Writes [siteX, siteY, siteZ, siteRandom] into `out`.
 */
function clumpSite(px, py, pz, cell, out) {
  const cx = Math.floor(px / cell), cy = Math.floor(py / cell), cz = Math.floor(pz / cell);
  let best = Infinity;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      for (let k = -1; k <= 1; k++) {
        const gx = cx + i, gy = cy + j, gz = cz + k;
        const sx = (gx + ihash(gx, gy, gz, 1)) * cell;
        const sy = (gy + ihash(gx, gy, gz, 2)) * cell;
        const sz = (gz + ihash(gx, gy, gz, 3)) * cell;
        const dx = sx - px, dy = sy - py, dz = sz - pz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) {
          best = d;
          out[0] = sx; out[1] = sy; out[2] = sz; out[3] = ihash(gx, gy, gz, 7);
        }
      }
    }
  }
}

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
    // Longer coat gets more cards — but with a FLOOR.
    //
    // Without one this term starved exactly the regions that most need the
    // silhouette broken: the ear outline was getting 1/33 of the cheek's card
    // density and the skull 1/7, which is why the ruff, flank and tail broke
    // up beautifully while the head stayed a hard mesh curve. Short coat does
    // not mean "no cards" — it means SHORT cards, which is what a fine dense
    // fringe following a tapering ear actually is. Card length already scales
    // with coat thickness, so a floor here buys density without buying length.
    const l = (len[i0] + len[i1] + len[i2]) / 3;
    const lw = 0.30 + 0.70 * (Math.min(1, l / 0.030) ** 1.2);

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
  const aClump = new Float32Array(nVert * 4);
  const index = (nVert > 65535 ? new Uint32Array(nIndex) : new Uint16Array(nIndex));

  const nrm = new THREE.Vector3(), tg = new THREE.Vector3();
  const site = [0, 0, 0, 0];
  const cell = CARD_SHAPE.clumpCell;
  const lockIds = new Set();
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

    // Which lock this hair belongs to.
    clumpSite(px, py, pz, cell, site);
    lockIds.add(site[3]);

    // Per-card length spread, deliberately narrow.
    //
    // Perpendicular reach past the skin is uCardLength * lenMul * rise, and
    // the target band is 1.10-1.25x the local coat. A wide spread puts the
    // MEAN in band while the top third sits far outside it and reads as
    // separate spikes — that is what produced the dorsal crest. 1.20:1 keeps
    // the whole distribution inside the band.
    //
    // ONE of the two factors is the lock's, so a tuft is long or short as a
    // unit. Two independent draws per card give the same distribution and no
    // structure: at any distance where the individual hairs are not resolved
    // they average to a flat fringe, which is the "even spray" §5 forbids.
    const lenMul = CARD_SHAPE.lenMulMin + CARD_SHAPE.lenMulSpread * site[3] * rand();

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
        aClump[o * 4] = site[0]; aClump[o * 4 + 1] = site[1];
        aClump[o * 4 + 2] = site[2]; aClump[o * 4 + 3] = site[3];
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
  g.setAttribute('aClump', new THREE.BufferAttribute(aClump, 4));
  g.setIndex(new THREE.BufferAttribute(index, 1));

  // Cards extend well past the skin and then get skinned; give the culler room.
  g.computeBoundingSphere();
  g.boundingSphere.radius *= 1.9;
  g.computeBoundingBox();

  return {
    geometry: g, cards: w, vertices: nVert, triangles: nIndex / 3,
    // Cards per lock. Below ~2 there is nothing to gather and the clump term
    // is dead weight; the number is reported so that stays visible.
    locks: lockIds.size, cardsPerLock: +(w / Math.max(1, lockIds.size)).toFixed(2),
  };
}

/*
 * REGION_TABLE.b[3]. `earOuter` carries 2.60 and `earInner` 2.20, the two
 * highest weights on the animal, on the reasoning that the ear fringe is
 * silhouette-critical.
 *
 * MEASURED, AND IT IS WORTH KNOWING BEFORE ANYONE TUNES THIS AGAIN: at the
 * `profile` framing the near ear barely exists to be fringed. On the
 * bare-mesh coverage matte (coat length driven to zero, so this is geometry
 * alone), the per-column topmost covered row over the head reads
 *
 *   x  354 .. 426   y 378 -> 308     nose climbing to forehead
 *   x  430 .. 474   y 285 -> 263 -> 273   ONE smooth arc, peak at x~448
 *   x  478          y 292             a 19 px step
 *   x  482 onward   y 314 descending  the nape
 *
 * So the ear is a single 48 px-wide convex arc that merges CONTINUOUSLY into
 * the forehead on its rostral side and has exactly one discontinuity, the
 * 19 px step at its caudal margin. It rises ~51 px above the nape line on a
 * 383 px animal. What is missing is not height — it is the notch at the ear's
 * base and any defined tip: this is 4c's "semicircular paddle", not its
 * "rounded triangle", and it is fused to the skull.
 *
 * That is anatomy, not coat, and it is NOT the fur agent's to fix. The coat's
 * part in it is only this: a ~15 px fringe at that framing is a third of the
 * ear's 45 px rise above the forehead, and it fills the one step the outline
 * has. So the deeper the coat gets, the more completely the ear merges into
 * the head — which means raising these two weights cannot recover an ear that
 * has no notch in it, and lowering them cannot either. Route the shape.
 */
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
