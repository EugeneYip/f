/**
 * FoxSkeleton — canonical bone rig, automatic region-constrained skin weights,
 * bone-parented anchors and a few review pose presets.
 * OWNER: anatomy agent.
 *
 * ## Rest convention
 *
 * Every bone has an **identity rest rotation**; only its local translation is
 * set (parent-relative). So a bone's local axes are the world axes of the bind
 * pose, and "rotate the thigh about X" means exactly that in world terms with
 * no bone-roll bookkeeping. This makes procedural gait and IK straightforward
 * and it is why `setPose` presets below are plain Euler triples.
 *
 * ## Weighting
 *
 * Distance to the bone *segment* with a compact-support falloff, hard-masked
 * by anatomical region and by body side, then Laplacian-smoothed over mesh
 * adjacency (re-masked each iteration so the smoothing cannot re-introduce
 * bleeding), then truncated to 4 influences and renormalised.
 *
 * The two failure modes naive distance weighting always hits are (a) the two
 * hind legs stealing each other's vertices across the groin and (b) the ear
 * base welding itself to the skull. The region mask plus the side gate below
 * kill both.
 */
import * as THREE from 'three';
import { LANDMARKS, REGION as R, skullXf } from './FoxAnatomy.js';

/** [name, parent, tipLandmark|null] — declaration order IS the bone index order. */
const BONE_DEFS = [
  ['root', null, 'hips'],
  ['hips', 'root', 'spine01'],
  ['spine01', 'hips', 'spine02'],
  ['spine02', 'spine01', 'spine03'],
  ['spine03', 'spine02', 'spine04'],
  ['spine04', 'spine03', 'chest'],
  ['chest', 'spine04', 'neck01'],
  ['neck01', 'chest', 'neck02'],
  ['neck02', 'neck01', 'head'],
  ['head', 'neck02', '@muzzle'],
  ['jaw', 'head', '@chin'],

  ['earL01', 'head', 'earL02'],
  ['earL02', 'earL01', 'earL03'],
  ['earL03', 'earL02', 'earL_tip'],
  ['earR01', 'head', 'earR02'],
  ['earR02', 'earR01', 'earR03'],
  ['earR03', 'earR02', 'earR_tip'],

  ['tail01', 'hips', 'tail02'],
  ['tail02', 'tail01', 'tail03'],
  ['tail03', 'tail02', 'tail04'],
  ['tail04', 'tail03', 'tail05'],
  ['tail05', 'tail04', 'tail06'],
  ['tail06', 'tail05', 'tail07'],
  ['tail07', 'tail06', 'tail08'],
  ['tail08', 'tail07', 'tail09'],
  ['tail09', 'tail08', 'tail_tip'],
];
for (const s of ['L', 'R']) {
  BONE_DEFS.push(
    [`shoulder${s}`, 'chest', `upperArm${s}`],
    [`upperArm${s}`, `shoulder${s}`, `lowerArm${s}`],
    [`lowerArm${s}`, `upperArm${s}`, `wrist${s}`],
    [`wrist${s}`, `lowerArm${s}`, `paw${s}`],
    [`paw${s}`, `wrist${s}`, `paw${s}_tip`],
    [`thigh${s}`, 'hips', `shin${s}`],
    [`shin${s}`, `thigh${s}`, `hock${s}`],
    [`hock${s}`, `shin${s}`, `foot${s}`],
    [`foot${s}`, `hock${s}`, `toe${s}`],
    [`toe${s}`, `foot${s}`, `toe${s}_tip`],
  );
}

/** Extra segment endpoints that are not bone positions. */
const VIRTUAL_TIPS = {
  '@muzzle': skullXf([0, 0.3030, 0.2360]),
  '@chin': skullXf([0, 0.2900, 0.2440]),
};

/**
 * region -> the bones allowed to influence it.
 * `?` is expanded to both sides and then gated by the vertex's x sign, so a
 * left-side vertex can never pick up a right-side bone.
 */
const REGION_BONES = {
  [R.nose]: ['head'],
  [R.muzzle]: ['head', 'jaw'],
  [R.jawLower]: ['jaw', 'head'],
  [R.cheek]: ['head', 'jaw', 'neck02'],
  [R.forehead]: ['head'],
  [R.skull]: ['head', 'neck02'],
  [R.earOuter]: ['ear?01', 'ear?02', 'ear?03', 'head'],
  [R.earInner]: ['ear?01', 'ear?02', 'ear?03', 'head'],
  [R.throat]: ['neck01', 'neck02', 'head', 'jaw', 'chest'],
  [R.neck]: ['neck01', 'neck02', 'head', 'chest'],
  [R.ruff]: ['chest', 'neck01', 'neck02', 'spine04', 'shoulder?~'],
  [R.chest]: ['chest', 'spine04', 'spine03', 'shoulder?', 'upperArm?~', 'neck01'],
  [R.shoulder]: ['shoulder?', 'chest', 'spine04', 'upperArm?'],
  [R.back]: ['hips', 'spine01', 'spine02', 'spine03', 'spine04', 'chest',
    'shoulder?~', 'thigh?~'],
  // flank and belly must be allowed a little limb influence. Forbidding it
  // outright put a hard weight discontinuity exactly at the region boundary
  // over the hip and shoulder — 0.91 limb on one side, 0.22 on the other,
  // 25 mm apart — which is what tore the hip open in walk and pushed limb
  // geometry through the flank in trot. The distance falloff keeps the
  // contribution negligible away from the limb root; the side gate still
  // prevents any left/right bleed.
  [R.flank]: ['hips', 'spine01', 'spine02', 'spine03', 'spine04', 'chest',
    'thigh?~', 'shoulder?~', 'lowerArm?~'],
  [R.belly]: ['hips', 'spine01', 'spine02', 'spine03', 'spine04', 'chest',
    'thigh?~', 'upperArm?~'],
  [R.croup]: ['hips', 'spine01', 'tail01', 'thigh?'],
  [R.haunch]: ['hips', 'thigh?', 'spine01', 'shin?'],
  [R.legFrontUpper]: ['upperArm?', 'lowerArm?', 'shoulder?', 'chest', 'spine04~'],
  [R.legFrontLower]: ['lowerArm?', 'wrist?', 'paw?', 'upperArm?', 'chest~'],
  [R.pawFront]: ['paw?', 'wrist?'],
  [R.legHindUpper]: ['thigh?', 'shin?', 'hips', 'hock?', 'spine01~'],
  [R.hock]: ['hock?', 'shin?', 'foot?'],
  [R.pawHind]: ['foot?', 'toe?', 'hock?'],
  [R.tailBase]: ['tail01', 'tail02', 'tail03', 'hips'],
  [R.tailMid]: ['tail02', 'tail03', 'tail04', 'tail05', 'tail06', 'tail07', 'tail08'],
  [R.tailTip]: ['tail06', 'tail07', 'tail08', 'tail09'],
};

const SIDE_DEAD = 0.006;   // |x| below this: both sides permitted (midline)

/**
 * A bone name suffixed `~` is a SOFT influence: permitted in that region, but
 * with a much smaller falloff radius. This exists so a limb can carry the skin
 * across its own joint without reaching halfway down the torso. Forbidding it
 * outright leaves a weight cliff at the region boundary (the hip tore open in
 * walk); allowing it at full radius lets the femur dominate the whole flank.
 */
const SOFT_RADIUS = 0.42;

// ---------------------------------------------------------------------------
// pose presets (deg). Approximate by design — they exist for review framings;
// the animation agent owns real posing.
// ---------------------------------------------------------------------------
/**
 * Review pose presets. Approximate by design — they exist for review framings
 * and for the face/fur agents to check silhouettes; the animation agent owns
 * real posing and IK.
 *
 * ART_DIRECTION §4b: **tail carriage is pose-dependent, not a fixed rest
 * value.** The bind pose carries it low and close to the ground (standing).
 * Sitting or lying curls it around the flank — `sit` below does that. A
 * running animal carries it straight out behind, which is the gait engine's
 * job, not a preset here.
 */
export const POSE_PRESETS = {
  stand: { root: [0, 0, 0], rot: {} },

  alert: {
    root: [0, 0, 0],
    rot: {
      neck01: [-7, 0, 0], neck02: [-9, 0, 0], head: [-4, 0, 0],
      earL01: [-6, 10, 0], earR01: [-6, -10, 0],
      tail01: [-14, 0, 0], tail02: [-8, 0, 0], tail03: [-5, 0, 0],
      spine04: [-2, 0, 0],
    },
  },

  sit: {
    root: [0, -0.052, -0.022],
    rot: {
      hips: [-16, 0, 0],
      spine01: [4, 0, 0], spine02: [5, 0, 0], spine03: [5, 0, 0], spine04: [4, 0, 0],
      neck01: [-6, 0, 0], neck02: [-8, 0, 0], head: [-3, 0, 0],
      thighL: [-52, 0, 0], thighR: [-52, 0, 0],
      shinL: [74, 0, 0], shinR: [74, 0, 0],
      hockL: [-38, 0, 0], hockR: [-38, 0, 0],
      footL: [10, 0, 0], footR: [10, 0, 0],
      upperArmL: [6, 0, 0], upperArmR: [6, 0, 0],
      lowerArmL: [-8, 0, 0], lowerArmR: [-8, 0, 0],
      // Tail curls round the RIGHT flank rather than lifting: ~130 deg of
      // cumulative yaw down the chain, which sweeps the brush from behind the
      // hocks round to the side of the body.
      tail01: [12, 22, 0], tail02: [4, 18, 0], tail03: [2, 16, 0],
      tail04: [0, 15, 0], tail05: [0, 14, 0], tail06: [0, 13, 0],
      tail07: [0, 12, 0], tail08: [0, 11, 0], tail09: [0, 10, 0],
    },
  },

  /**
   * Curled — "very nearly a sphere" (§4b). Bone rotations only, no IK, so this
   * is an approximation: the spine and neck coil to one side, the limbs fold
   * under, and the tail wraps forward over the flank toward the muzzle.
   */
  curled: {
    root: [0, -0.108, -0.010],
    rot: {
      hips: [-26, 0, 0],
      spine01: [-13, 9, 0], spine02: [-13, 10, 0],
      spine03: [-12, 11, 0], spine04: [-11, 11, 0],
      chest: [-10, 10, 0],
      neck01: [-16, 16, 0], neck02: [-18, 18, 0], head: [-10, 20, 0],
      thighL: [-98, 0, 0], thighR: [-98, 0, 0],
      shinL: [118, 0, 0], shinR: [118, 0, 0],
      hockL: [-72, 0, 0], hockR: [-72, 0, 0],
      footL: [34, 0, 0], footR: [34, 0, 0],
      upperArmL: [64, 0, 0], upperArmR: [64, 0, 0],
      lowerArmL: [-104, 0, 0], lowerArmR: [-104, 0, 0],
      wristL: [44, 0, 0], wristR: [44, 0, 0],
      tail01: [8, 24, 0], tail02: [4, 22, 0], tail03: [2, 21, 0],
      tail04: [0, 20, 0], tail05: [0, 19, 0], tail06: [0, 18, 0],
      tail07: [0, 17, 0], tail08: [0, 16, 0], tail09: [0, 15, 0],
    },
  },
};

export class FoxSkeleton {
  constructor() {
    this.bones = {};
    this.boneList = [];
    this.order = [];
    this._segA = null;
    this._segB = null;
    this._restPos = [];
    this._poseQ = [];
    this.pose = 'stand';
  }

  /** Build the bone tree with identity rest rotations. */
  build() {
    const byName = new Map();
    for (const [name, parent, tip] of BONE_DEFS) {
      const b = new THREE.Bone();
      b.name = name;
      byName.set(name, { bone: b, parent, tip });
    }
    for (const [name, parent] of BONE_DEFS) {
      const rec = byName.get(name);
      const world = LANDMARKS[name];
      if (!world) throw new Error(`FoxSkeleton: no landmark for bone "${name}"`);
      if (parent) {
        const pw = LANDMARKS[parent];
        rec.bone.position.set(world[0] - pw[0], world[1] - pw[1], world[2] - pw[2]);
        byName.get(parent).bone.add(rec.bone);
      } else {
        rec.bone.position.set(world[0], world[1], world[2]);
      }
      this.bones[name] = rec.bone;
      this.boneList.push(rec.bone);
      this.order.push(name);
      this._restPos.push(rec.bone.position.clone());
      this._poseQ.push(new THREE.Quaternion());
    }
    this.rootBone = this.bones.root;
    this.rootBone.updateMatrixWorld(true);

    // world-space segments used by the weighting pass
    const n = this.boneList.length;
    this._segA = new Float64Array(n * 3);
    this._segB = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const [name, , tip] = BONE_DEFS[i];
      const a = LANDMARKS[name];
      const b = tip?.[0] === '@' ? VIRTUAL_TIPS[tip] : LANDMARKS[tip];
      if (!b) throw new Error(`FoxSkeleton: no tip "${tip}" for bone "${name}"`);
      this._segA[i * 3] = a[0]; this._segA[i * 3 + 1] = a[1]; this._segA[i * 3 + 2] = a[2];
      this._segB[i * 3] = b[0]; this._segB[i * 3 + 1] = b[1]; this._segB[i * 3 + 2] = b[2];
    }

    this.skeleton = new THREE.Skeleton(this.boneList);
    this.index = new Map(this.order.map((nm, i) => [nm, i]));

    // Resolve region -> bone-index lists once (with `?` expanded per side).
    this._allow = {};
    this._soft = new Set();
    for (const [reg, raw] of Object.entries(REGION_BONES)) {
      const L = [], Rr = [], both = [];
      for (const entry of raw) {
        const soft = entry.endsWith('~');
        const nm = soft ? entry.slice(0, -1) : entry;
        const push = (n) => {
          const i = this.index.get(n);
          if (i === undefined) throw new Error(`FoxSkeleton: unknown bone "${n}"`);
          if (soft) this._soft.add(reg + ':' + i);
          return i;
        };
        if (nm.includes('?')) {
          L.push(push(nm.replace('?', 'L')));
          Rr.push(push(nm.replace('?', 'R')));
        } else both.push(push(nm));
      }
      this._allow[reg] = { L, R: Rr, both };
    }
    return this;
  }

  bone(name) { return this.bones[name]; }

  /**
   * Distance from p to bone i's segment. Writes `_segLen` as a side channel
   * rather than returning an object — this runs ~1M times during binding.
   */
  _segDist(i, x, y, z) {
    const A = this._segA, B = this._segB, o = i * 3;
    const ax = A[o], ay = A[o + 1], az = A[o + 2];
    const bx = B[o] - ax, by = B[o + 1] - ay, bz = B[o + 2] - az;
    const l2 = bx * bx + by * by + bz * bz;
    let t = 0;
    if (l2 > 1e-12) {
      t = ((x - ax) * bx + (y - ay) * by + (z - az) * bz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    const dx = x - (ax + bx * t), dy = y - (ay + by * t), dz = z - (az + bz * t);
    this._segLen = Math.sqrt(l2);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Bones this vertex is permitted to use. */
  _candidates(region, x, out) {
    const a = this._allow[region] ?? this._allow[R.flank];
    out.length = 0;
    for (const i of a.both) out.push(i);
    if (x <= SIDE_DEAD) for (const i of a.L) out.push(i);
    if (x >= -SIDE_DEAD) for (const i of a.R) out.push(i);
    return out;
  }

  /**
   * Compute skinIndex / skinWeight for the whole mesh.
   *
   * @param pos    Float64Array|Float32Array of bind positions
   * @param region Float32Array of region ids (one per vertex)
   * @param adj    {start, nb} CSR adjacency for the smoothing pass
   */
  computeWeights(pos, region, adj, { smoothIters = 6, lambda = 0.45 } = {}) {
    const nv = pos.length / 3;
    const nb = this.boneList.length;
    const SLOTS = 10;                       // per-vertex sparse capacity

    // Flat arrays rather than a Map per vertex: with ~14k vertices and 4
    // smoothing passes the Map version spent more time in GC than in maths.
    let idx = new Int16Array(nv * SLOTS).fill(-1);
    let wts = new Float32Array(nv * SLOTS);
    const cand = [];
    const allowed = new Uint8Array(nb);

    for (let v = 0; v < nv; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      const reg = region[v] | 0;
      this._candidates(reg, x, cand);
      let n = 0, total = 0;
      for (const i of cand) {
        if (i === undefined || n >= SLOTS) continue;
        const d = this._segDist(i, x, y, z);
        let Rb = this._segLen * 1.55 + 0.055;
        if (this._soft.has(reg + ':' + i)) Rb *= SOFT_RADIUS;
        if (d >= Rb) continue;
        const t = 1 - d / Rb;
        // The 4 mm floor made weights enormously peaked at the bone (w -> 250
        // as d -> 0), so a vertex within a few mm of the femur ended up ~100 %
        // bound to it and the handover to the torso happened over ~25 mm. That
        // is what tore the hip open in walk and drove limb geometry through the
        // flank in trot (REVIEW blocker 7). A 12 mm floor plus more smoothing
        // spreads the transition over ~70 mm without letting regions bleed —
        // the per-iteration re-mask still forbids that.
        const w = (t * t) / (d + 0.012);
        idx[v * SLOTS + n] = i;
        wts[v * SLOTS + n] = w;
        total += w; n++;
      }
      if (n === 0) {
        let best = -1, bd = Infinity;
        for (const i of cand) {
          if (i === undefined) continue;
          const d = this._segDist(i, x, y, z);
          if (d < bd) { bd = d; best = i; }
        }
        idx[v * SLOTS] = best < 0 ? this.index.get('hips') : best;
        wts[v * SLOTS] = 1; total = 1; n = 1;
      }
      for (let k = 0; k < n; k++) wts[v * SLOTS + k] /= total;
    }

    // --- smooth over adjacency, re-masking every iteration ------------------
    // Without the re-mask, four rounds of averaging quietly reintroduce
    // exactly the bleeding the region masks exist to prevent.
    const acc = new Float32Array(nb);
    const touched = new Int32Array(nb);
    let nIdx = new Int16Array(nv * SLOTS);
    let nWts = new Float32Array(nv * SLOTS);
    for (let it = 0; it < smoothIters; it++) {
      nIdx.fill(-1); nWts.fill(0);
      for (let v = 0; v < nv; v++) {
        const s0 = adj.start[v], e0 = adj.start[v + 1];
        let nt = 0;
        const add = (bi, w) => {
          if (w <= 0) return;
          if (acc[bi] === 0) touched[nt++] = bi;
          acc[bi] += w;
        };
        for (let k = 0; k < SLOTS; k++) {
          const bi = idx[v * SLOTS + k]; if (bi < 0) break;
          add(bi, wts[v * SLOTS + k] * (1 - lambda));
        }
        if (e0 > s0) {
          const f = lambda / (e0 - s0);
          for (let t = s0; t < e0; t++) {
            const u = adj.nb[t];
            for (let k = 0; k < SLOTS; k++) {
              const bi = idx[u * SLOTS + k]; if (bi < 0) break;
              add(bi, wts[u * SLOTS + k] * f);
            }
          }
        }
        this._candidates(region[v] | 0, pos[v * 3], cand);
        allowed.fill(0);
        for (const i of cand) if (i !== undefined) allowed[i] = 1;

        // keep the strongest permitted influences
        let count = 0, total = 0;
        for (let k = 0; k < nt; k++) {
          const bi = touched[k];
          if (!allowed[bi]) continue;
          const w = acc[bi];
          if (count < SLOTS) {
            nIdx[v * SLOTS + count] = bi; nWts[v * SLOTS + count] = w; count++; total += w;
          } else {
            let mn = 0;
            for (let q = 1; q < SLOTS; q++) if (nWts[v * SLOTS + q] < nWts[v * SLOTS + mn]) mn = q;
            if (w > nWts[v * SLOTS + mn]) {
              total += w - nWts[v * SLOTS + mn];
              nIdx[v * SLOTS + mn] = bi; nWts[v * SLOTS + mn] = w;
            }
          }
        }
        for (let k = 0; k < nt; k++) acc[touched[k]] = 0;
        if (count === 0 || total <= 1e-9) {
          for (let k = 0; k < SLOTS; k++) {
            nIdx[v * SLOTS + k] = idx[v * SLOTS + k];
            nWts[v * SLOTS + k] = wts[v * SLOTS + k];
          }
          continue;
        }
        for (let k = 0; k < count; k++) nWts[v * SLOTS + k] /= total;
      }
      const ti = idx; idx = nIdx; nIdx = ti;
      const tw = wts; wts = nWts; nWts = tw;
    }

    // --- truncate to 4 and normalise ---------------------------------------
    const skinIndex = new Uint16Array(nv * 4);
    const skinWeight = new Float32Array(nv * 4);
    let maxInf = 0;
    const order = new Int32Array(SLOTS);
    for (let v = 0; v < nv; v++) {
      let n = 0;
      for (let k = 0; k < SLOTS; k++) { if (idx[v * SLOTS + k] < 0) break; order[n++] = k; }
      maxInf = Math.max(maxInf, n);
      // partial selection sort for the top 4
      const top = Math.min(4, n);
      for (let a = 0; a < top; a++) {
        let best = a;
        for (let b = a + 1; b < n; b++) {
          if (wts[v * SLOTS + order[b]] > wts[v * SLOTS + order[best]]) best = b;
        }
        const t = order[a]; order[a] = order[best]; order[best] = t;
      }
      let sum = 0;
      for (let a = 0; a < top; a++) sum += wts[v * SLOTS + order[a]];
      if (sum <= 1e-9) { skinIndex[v * 4] = 1; skinWeight[v * 4] = 1; continue; }
      for (let a = 0; a < top; a++) {
        skinIndex[v * 4 + a] = idx[v * SLOTS + order[a]];
        skinWeight[v * 4 + a] = wts[v * SLOTS + order[a]] / sum;
      }
    }
    this.weightStats = { nv, bones: nb, maxInfluencesBeforeTruncation: maxInf };
    return { skinIndex, skinWeight };
  }

  // ------------------------------------------------------------------ poses --
  /** Apply a named preset (or a raw {root, rot} object). */
  setPose(name) {
    const p = typeof name === 'string' ? POSE_PRESETS[name] : name;
    if (!p) return false;
    if (typeof name === 'string') this.pose = name;
    const e = new THREE.Euler();
    for (let i = 0; i < this.boneList.length; i++) {
      const b = this.boneList[i];
      const r = p.rot?.[b.name];
      if (r) {
        e.set(r[0] * Math.PI / 180, r[1] * Math.PI / 180, r[2] * Math.PI / 180, 'XYZ');
        this._poseQ[i].setFromEuler(e);
      } else this._poseQ[i].identity();
      b.quaternion.copy(this._poseQ[i]);
      b.position.copy(this._restPos[i]);
      if (b.name === 'root' && p.root) {
        b.position.set(
          this._restPos[i].x + p.root[0],
          this._restPos[i].y + p.root[1],
          this._restPos[i].z + p.root[2],
        );
      }
    }
    return true;
  }

  /** Pose quaternion for bone index i — the base the idle layer adds onto. */
  poseQuaternion(i) { return this._poseQ[i]; }
  restPosition(i) { return this._restPos[i]; }
}
