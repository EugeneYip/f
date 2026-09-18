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
import { LANDMARKS, REGION as R } from './FoxAnatomy.js';

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
  '@muzzle': [0, 0.3030, 0.2400],
  '@chin': [0, 0.2895, 0.2500],
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
  [R.ruff]: ['chest', 'neck01', 'neck02', 'spine04'],
  [R.chest]: ['chest', 'spine04', 'spine03', 'shoulder?', 'neck01'],
  [R.shoulder]: ['shoulder?', 'chest', 'spine04', 'upperArm?'],
  [R.back]: ['hips', 'spine01', 'spine02', 'spine03', 'spine04', 'chest'],
  [R.flank]: ['hips', 'spine01', 'spine02', 'spine03', 'spine04', 'chest'],
  [R.belly]: ['hips', 'spine01', 'spine02', 'spine03', 'spine04', 'chest'],
  [R.croup]: ['hips', 'spine01', 'tail01', 'thigh?'],
  [R.haunch]: ['hips', 'thigh?', 'spine01', 'shin?'],
  [R.legFrontUpper]: ['upperArm?', 'lowerArm?', 'shoulder?', 'chest'],
  [R.legFrontLower]: ['lowerArm?', 'wrist?', 'paw?', 'upperArm?'],
  [R.pawFront]: ['paw?', 'wrist?'],
  [R.legHindUpper]: ['thigh?', 'shin?', 'hips', 'hock?'],
  [R.hock]: ['hock?', 'shin?', 'foot?'],
  [R.pawHind]: ['foot?', 'toe?', 'hock?'],
  [R.tailBase]: ['tail01', 'tail02', 'tail03', 'hips'],
  [R.tailMid]: ['tail02', 'tail03', 'tail04', 'tail05', 'tail06', 'tail07', 'tail08'],
  [R.tailTip]: ['tail06', 'tail07', 'tail08', 'tail09'],
};

const SIDE_DEAD = 0.006;   // |x| below this: both sides permitted (midline)

// ---------------------------------------------------------------------------
// pose presets (deg). Approximate by design — they exist for review framings;
// the animation agent owns real posing.
// ---------------------------------------------------------------------------
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
      tail01: [18, 0, 0], tail02: [10, 0, 0], tail03: [6, 0, 0],
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
    for (const [reg, names] of Object.entries(REGION_BONES)) {
      const L = [], Rr = [], both = [];
      for (const nm of names) {
        if (nm.includes('?')) {
          L.push(this.index.get(nm.replace('?', 'L')));
          Rr.push(this.index.get(nm.replace('?', 'R')));
        } else both.push(this.index.get(nm));
      }
      this._allow[reg] = { L, R: Rr, both };
    }
    return this;
  }

  bone(name) { return this.bones[name]; }

  /** Squared distance from p to bone i's segment. */
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
    return { d: Math.sqrt(dx * dx + dy * dy + dz * dz), len: Math.sqrt(l2) };
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
  computeWeights(pos, region, adj, { smoothIters = 5, lambda = 0.45 } = {}) {
    const nv = pos.length / 3;
    const nb = this.boneList.length;
    /** sparse per-vertex weights: Map<boneIndex, weight> */
    const maps = new Array(nv);
    const cand = [];

    for (let v = 0; v < nv; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      this._candidates(region[v] | 0, x, cand);
      const m = new Map();
      let total = 0;
      for (const i of cand) {
        if (i === undefined) continue;
        const { d, len } = this._segDist(i, x, y, z);
        const Rb = len * 1.55 + 0.055;
        if (d >= Rb) continue;
        const t = 1 - d / Rb;
        const w = (t * t) / (d + 0.004);
        if (w <= 0) continue;
        m.set(i, w);
        total += w;
      }
      if (total <= 0) {
        // Should not happen; fall back to the nearest allowed bone.
        let best = -1, bd = Infinity;
        for (const i of cand) {
          if (i === undefined) continue;
          const { d } = this._segDist(i, x, y, z);
          if (d < bd) { bd = d; best = i; }
        }
        m.set(best < 0 ? this.index.get('hips') : best, 1);
        total = 1;
      }
      for (const [k, w] of m) m.set(k, w / total);
      maps[v] = m;
    }

    // --- smooth over adjacency, re-masking every iteration ------------------
    for (let it = 0; it < smoothIters; it++) {
      const next = new Array(nv);
      for (let v = 0; v < nv; v++) {
        const s = adj.start[v], e = adj.start[v + 1];
        const src = maps[v];
        if (e === s) { next[v] = src; continue; }
        const acc = new Map();
        for (const [k, w] of src) acc.set(k, w * (1 - lambda));
        const f = lambda / (e - s);
        for (let t = s; t < e; t++) {
          for (const [k, w] of maps[adj.nb[t]]) acc.set(k, (acc.get(k) ?? 0) + w * f);
        }
        // re-mask: smoothing must not leak a forbidden bone in
        this._candidates(region[v] | 0, pos[v * 3], cand);
        let total = 0;
        for (const [k] of acc) if (!cand.includes(k)) acc.delete(k);
        for (const [, w] of acc) total += w;
        if (total <= 1e-9) { next[v] = src; continue; }
        for (const [k, w] of acc) acc.set(k, w / total);
        next[v] = acc;
      }
      for (let v = 0; v < nv; v++) maps[v] = next[v];
    }

    // --- truncate to 4 and normalise ---------------------------------------
    const skinIndex = new Uint16Array(nv * 4);
    const skinWeight = new Float32Array(nv * 4);
    let maxInf = 0;
    for (let v = 0; v < nv; v++) {
      const entries = [...maps[v]].sort((a, b) => b[1] - a[1]);
      maxInf = Math.max(maxInf, entries.length);
      let sum = 0;
      const k = Math.min(4, entries.length);
      for (let i = 0; i < k; i++) sum += entries[i][1];
      if (sum <= 1e-9) { skinIndex[v * 4] = 1; skinWeight[v * 4] = 1; continue; }
      for (let i = 0; i < k; i++) {
        skinIndex[v * 4 + i] = entries[i][0];
        skinWeight[v * 4 + i] = entries[i][1] / sum;
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
