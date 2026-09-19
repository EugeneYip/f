/**
 * IK — analytic limb solver with an exactness guarantee.
 * OWNER: animation agent.
 *
 * ## Why not a generic CCD/FABRIK
 *
 * REVIEW.md category E makes foot sliding an automatic ≤3, and `tools/audit.mjs`
 * enforces it numerically: a paw whose anchor is within 22 mm of the snow may
 * not move faster than 0.045 m/s horizontally — 0.375 mm per 1/120 s step.
 * An iterative solver leaves a residual that *varies* frame to frame, and that
 * residual is indistinguishable from sliding. So the solve here is closed form
 * and lands the contact anchor on its target to floating-point precision:
 *
 *   contactWorld = anklePos + Qw(ankle) · anchorLocal
 *
 * We choose `Qw(ankle)` (foot orientation) first, derive the required ankle
 * position `A = contactTarget − Qw·anchorLocal`, then place the chain so FK
 * reproduces `A` exactly. Because every bone keeps its rest translation and we
 * only ever write rotations that map a rest segment onto a vector of the
 * *same length*, forward kinematics is exact by construction:
 *
 *   childWorld = parentWorld + Qw(parent) · restLocal(child)
 *
 * ## The canid hindlimb bends the other way at the hock
 *
 * A dog's hind leg is a genuine Z: stifle forward, hock backward. Two-bone IK
 * cannot express that. This solves the 3-segment chain as two chained two-bone
 * solves sharing one plane, with the second bulge flipped:
 *
 *   1. hip → ankle over (L1, Leff)  places the knee/elbow on the +pole side
 *   2. knee → ankle over (L2, L3)   places the hock/carpus on the −pole side
 *
 * `Leff` is the knee→ankle chord of the lower two segments, i.e. a direct
 * handle on the hock angle. It is driven from limb extension (a real
 * digitigrade leg opens its hock as it straightens) and then clamped to
 * whatever keeps step 1 reachable — which is what makes step 2 exactly
 * reachable in turn, since step 1 guarantees |knee − ankle| == Leff.
 *
 * Which way is "cranial" is never hardcoded: it is measured off the rest pose,
 * so the elbow points back and the stifle points forward automatically.
 */
import * as THREE from 'three';
import { clamp } from '../util/math.js';

// twoBone scratch
const _d = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
// basisRotation scratch — never aliased with caller arguments
const _r1 = new THREE.Vector3();
const _r2 = new THREE.Vector3();
const _r3 = new THREE.Vector3();
const _s1 = new THREE.Vector3();
const _s2 = new THREE.Vector3();
const _s3 = new THREE.Vector3();
const _mA = new THREE.Matrix3();
const _mB = new THREE.Matrix3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();

/**
 * Place the intermediate joint of a two-bone chain.
 * `out` receives the joint. Returns true when the target was in reach.
 */
export function twoBone(H, T, L1, L2, poleDir, out) {
  _d.subVectors(T, H);
  const D = _d.length();
  if (D < 1e-7) _d.set(0, -1, 0);
  _u.copy(_d).normalize();

  // In-plane perpendicular, on the side the joint should bulge towards.
  _v.copy(poleDir);
  _v.addScaledVector(_u, -_v.dot(_u));
  if (_v.lengthSq() < 1e-12) {
    _v.set(_u.y, -_u.x, 0);
    if (_v.lengthSq() < 1e-12) _v.set(0, -_u.z, _u.y);
  }
  _v.normalize();

  const reach = L1 + L2;
  const Dc = clamp(D, Math.abs(L1 - L2) + 1e-6, reach - 1e-6);
  const a = (Dc * Dc + L1 * L1 - L2 * L2) / (2 * Dc);
  const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));

  out.copy(H).addScaledVector(_u, a).addScaledVector(_v, h);
  return D <= reach && D >= Math.abs(L1 - L2);
}

/**
 * World rotation carrying the rest basis (restSeg, restRef) onto the target
 * basis (seg, ref). `restRef`/`ref` only have to be a *consistent* reference
 * direction — they pin the roll, they do not choose the bend side.
 */
export function basisRotation(restSeg, restRef, seg, ref, outQ) {
  // rest frame: columns (perp, segment, perp×segment)
  _r1.copy(restSeg).normalize();
  _r2.copy(restRef).addScaledVector(_r1, -restRef.dot(_r1));
  if (_r2.lengthSq() < 1e-12) {
    _r2.set(_r1.y, -_r1.x, 0);
    if (_r2.lengthSq() < 1e-12) _r2.set(0, -_r1.z, _r1.y);
  }
  _r2.normalize();
  _r3.crossVectors(_r1, _r2);
  _mB.set(
    _r2.x, _r1.x, _r3.x,
    _r2.y, _r1.y, _r3.y,
    _r2.z, _r1.z, _r3.z,
  );

  // target frame, built exactly the same way
  _s1.copy(seg).normalize();
  _s2.copy(ref).addScaledVector(_s1, -ref.dot(_s1));
  if (_s2.lengthSq() < 1e-12) {
    _s2.set(_s1.y, -_s1.x, 0);
    if (_s2.lengthSq() < 1e-12) _s2.set(0, -_s1.z, _s1.y);
  }
  _s2.normalize();
  _s3.crossVectors(_s1, _s2);
  _mA.set(
    _s2.x, _s1.x, _s3.x,
    _s2.y, _s1.y, _s3.y,
    _s2.z, _s1.z, _s3.z,
  );

  // Q = target · restᵀ  (both frames share the same handedness, so proper)
  _mB.transpose();
  _mA.multiply(_mB);
  const e = _mA.elements;
  _m4.set(
    e[0], e[3], e[6], 0,
    e[1], e[4], e[7], 0,
    e[2], e[5], e[8], 0,
    0, 0, 0, 1,
  );
  return outQ.setFromRotationMatrix(_m4);
}

/**
 * One limb: three posed segments (hip→knee→hock→ankle) plus the foot plate.
 * Every rest measurement is taken off the live skeleton, so a change to the
 * anatomy agent's landmarks flows through without edits here.
 */
export class Limb {
  /**
   * @param rig        Rig
   * @param spec       { key, side, front, anchor, bones:[root,mid,low,ankle], girdle, toe }
   * @param anchorObj  the bone-parented contact Object3D (ctx.fox.anchors[...])
   */
  constructor(rig, spec, anchorObj) {
    this.key = spec.key;
    this.side = spec.side;
    this.front = !!spec.front;
    this.sideSign = spec.side === 'R' ? 1 : -1;
    this.girdle = spec.girdle;

    const [rn, mn, ln, an] = spec.bones;
    this.names = { root: rn, mid: mn, low: ln, ankle: an };
    this.iRoot = rig.i(rn);
    this.iMid = rig.i(mn);
    this.iLow = rig.i(ln);
    this.iAnkle = rig.i(an);
    this.bRoot = rig.list[this.iRoot];
    this.bMid = rig.list[this.iMid];
    this.bLow = rig.list[this.iLow];
    this.bAnkle = rig.list[this.iAnkle];
    this.bToe = spec.toe ? rig.bone(spec.toe) : null;

    // Rest segment vectors == the bones' own rest translations.
    this.seg1 = rig.restLocal[this.iMid].clone();
    this.seg2 = rig.restLocal[this.iLow].clone();
    this.seg3 = rig.restLocal[this.iAnkle].clone();
    this.L1 = this.seg1.length();
    this.L2 = this.seg2.length();
    this.L3 = this.seg3.length();
    this.Ltot = this.L1 + this.L2 + this.L3;

    const pRoot = rig.restRig[this.iRoot];
    const pMid = rig.restRig[this.iMid];
    const pAnkle = rig.restRig[this.iAnkle];
    this.restD = pAnkle.distanceTo(pRoot);

    // `restPole` points the way the first joint bulges — cranial for a stifle,
    // caudal for an elbow. Measured, so both come out right with no special case.
    const u = new THREE.Vector3().subVectors(pAnkle, pRoot).normalize();
    const w = new THREE.Vector3().subVectors(pMid, pRoot);
    w.addScaledVector(u, -w.dot(u));
    this.restPole = w.normalize();

    this.effMin = Math.abs(this.L2 - this.L3) + 1e-4;
    this.effMax = this.L2 + this.L3 - 1e-4;
    this.effRest = clamp(pAnkle.distanceTo(pMid), this.effMin, this.effMax);

    // Contact anchor, in the ankle bone's local frame.
    this.anchorObj = anchorObj;
    this.anchorLocal = anchorObj ? anchorObj.position.clone() : new THREE.Vector3(0, -0.0205, 0.012);
    /** Neutral footprint in rig space — where this paw sits when standing. */
    this.restContact = pAnkle.clone().add(this.anchorLocal);

    // Scratch
    this._K1 = new THREE.Vector3();
    this._K2 = new THREE.Vector3();
    this._H = new THREE.Vector3();
    this._pole = new THREE.Vector3();
    this._pole2 = new THREE.Vector3();
    this._seg = new THREE.Vector3();
    this._qw0 = new THREE.Quaternion();
    this._qw1 = new THREE.Quaternion();
    this._qw2 = new THREE.Quaternion();

    this.reachError = 0;
    this.extension = 1;
  }

  /** World position of the limb root, from already-updated matrices. */
  hip(out) { return out.setFromMatrixPosition(this.bRoot.matrixWorld); }

  /**
   * Ankle position implied by a contact target and a foot orientation.
   * `Qf` is the ankle bone's desired world quaternion.
   */
  ankleFor(contact, Qf, out) {
    out.copy(this.anchorLocal).applyQuaternion(Qf);
    return out.subVectors(contact, out);
  }

  /**
   * How far the body must drop for this limb to reach `A`. Zero when it
   * already can. Exact: a Y translation on the root bone moves every
   * descendant by the same amount in world space (the fox root group is
   * translation + yaw only).
   */
  requiredDrop(A, maxReach) {
    this.hip(this._H);
    const dx = A.x - this._H.x, dz = A.z - this._H.z;
    const horiz = Math.sqrt(dx * dx + dz * dz);
    const vert = this._H.y - A.y;
    const d2 = maxReach * maxReach - horiz * horiz;
    // Horizontally out of reach: no body height fixes this, and returning the
    // full vertical would slam the animal flat trying. Report nothing and let
    // the swing clamp (or the gait tuning) deal with it.
    if (d2 <= 0) return 0;
    return Math.max(0, vert - Math.sqrt(d2));
  }

  /**
   * Solve and write local quaternions for root/mid/low/ankle.
   * @param A        world ankle position
   * @param Qf       desired world quaternion of the ankle (foot plate)
   * @param bodyQ    the body's world orientation (yaw); orients the bend plane
   * @param bendBias >0 closes the hock (gather/crouch), <0 opens it
   */
  solve(A, Qf, bodyQ, bendBias = 0) {
    this.hip(this._H);
    const H = this._H;
    const D = H.distanceTo(A);
    this.extension = D / Math.max(1e-5, this.Ltot);

    // --- how much of the bend lives in the hock/carpus --------------------
    const ext = clamp(D / Math.max(1e-5, this.restD), 0.45, 1.35);
    let eff = ext >= 1
      ? this.effRest + (ext - 1) * (this.effMax - this.effRest) * 2.1
      : this.effRest + (ext - 1) * (this.effRest - this.effMin) * 1.35;
    eff -= bendBias * (this.effRest - this.effMin) * 0.55;

    // Clamp so step 1 is exactly reachable; that makes step 2 exact too.
    const lo = Math.max(this.effMin, Math.abs(D - this.L1) + 1e-5);
    const hi = Math.min(this.effMax, D + this.L1 - 1e-5);
    eff = lo <= hi ? clamp(eff, lo, hi) : lo;

    // --- bend plane -------------------------------------------------------
    // The rest pole rotated into the body's current heading. Using the body
    // frame (not the parent bone) keeps the knee direction from swinging
    // around as the scapula or pelvis rotates through the gait.
    this._pole.copy(this.restPole).applyQuaternion(bodyQ);

    twoBone(H, A, this.L1, eff, this._pole, this._K1);
    // Opposite bulge for the hock/carpus — this is the canid Z-leg.
    this._pole2.copy(this._pole).multiplyScalar(-1);
    twoBone(this._K1, A, this.L2, this.L3, this._pole2, this._K2);

    this.reachError = Math.max(0, D - this.Ltot);

    // --- world rotations that reproduce the chain exactly -----------------
    this._seg.subVectors(this._K1, H);
    basisRotation(this.seg1, this.restPole, this._seg, this._pole, this._qw0);
    this._seg.subVectors(this._K2, this._K1);
    basisRotation(this.seg2, this.restPole, this._seg, this._pole, this._qw1);
    this._seg.subVectors(A, this._K2);
    basisRotation(this.seg3, this.restPole, this._seg, this._pole, this._qw2);

    // --- world → local ----------------------------------------------------
    _qp.setFromRotationMatrix(this.bRoot.parent.matrixWorld).invert();
    this.bRoot.quaternion.copy(_qp).multiply(this._qw0);
    this.bMid.quaternion.copy(_q.copy(this._qw0).invert()).multiply(this._qw1);
    this.bLow.quaternion.copy(_q.copy(this._qw1).invert()).multiply(this._qw2);
    this.bAnkle.quaternion.copy(_q.copy(this._qw2).invert()).multiply(Qf);
  }

  /** Where the contact anchor actually ended up — used by the self-check. */
  contactWorld(out) {
    this.bAnkle.updateWorldMatrix(true, false);
    return out.copy(this.anchorLocal).applyMatrix4(this.bAnkle.matrixWorld);
  }
}
