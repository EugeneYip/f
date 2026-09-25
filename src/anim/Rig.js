/**
 * Rig — a thin, allocation-free pose buffer over the anatomy agent's skeleton.
 * OWNER: animation agent.
 *
 * The anatomy agent guarantees **identity rest rotations** on all 46 bones, so
 * a bone's local axes are the rig's axes and "rotate the thigh about X" means
 * exactly that. Everything here leans on that:
 *
 *   restLocal[i]  bone.position at rest (parent-relative) — never mutated
 *   restRig[i]    absolute position in rig space at rest  == FoxAnatomy LANDMARKS
 *
 * Posing is a two-phase accumulate/flush so that a dozen independent layers
 * (gait, spine, breathing, look-at, tail springs…) can each add their small
 * contribution without caring about ordering or quaternion composition:
 *
 *   rig.begin()                    clear the accumulator
 *   rig.add('neck01', x, y, z)     add Euler radians (repeatable, commutative)
 *   rig.mul('chest', sx, sy, sz)   multiply a bone's LOCAL scale
 *   rig.flush()                    write quaternions + positions onto the bones
 *
 * `mul` exists for one reason: a ribcage expands, and this rig has no other
 * way to say so. Rotations pitch the trunk and translations move it; neither
 * one can make the belly drop while the flank widens, which is what breathing
 * looks like from the side. MEASURED before it was added: a full breath cycle
 * moved the topline 3.39 mm, the belly 0.024 mm and the width 0.032 mm — i.e.
 * the two axes a viewer reads were doing literally nothing.
 *
 * Scale is multiplicative down the bone chain, so anything hung off a scaled
 * bone must be counter-scaled by its caller or it inflates too. `restScale`
 * is captured rather than assumed to be 1, so an anatomy-side rest scale
 * survives.
 *
 * The four legs bypass this: `IK.js` writes their local quaternions directly
 * after `flush()` + `updateMatrixWorld()`, because analytic IK needs the final
 * world position of the shoulder/hip before it can solve.
 */
import * as THREE from 'three';

const _e = new THREE.Euler(0, 0, 0, 'XYZ');

export class Rig {
  constructor(fox) {
    this.fox = fox;
    this.list = fox.skeleton?.bones ?? fox.boneList ?? [];
    this.n = this.list.length;

    this.index = new Map();
    for (let i = 0; i < this.n; i++) this.index.set(this.list[i].name, i);

    this.parentIdx = new Int16Array(this.n).fill(-1);
    this.restLocal = new Array(this.n);
    this.restRig = new Array(this.n);
    this.restScale = new Float64Array(this.n * 3).fill(1);

    // Captured with every rotation identity. `setPose('stand')` is the
    // anatomy agent's own "no rotations, rest translations" state, so this is
    // measured rather than assumed.
    fox.setPose?.('stand');

    for (let i = 0; i < this.n; i++) {
      const b = this.list[i];
      const p = b.parent && this.index.has(b.parent.name) ? this.index.get(b.parent.name) : -1;
      this.parentIdx[i] = p;
      this.restLocal[i] = b.position.clone();
      this.restScale[i * 3] = b.scale.x;
      this.restScale[i * 3 + 1] = b.scale.y;
      this.restScale[i * 3 + 2] = b.scale.z;
      this.restRig[i] = p >= 0
        ? this.restRig[p].clone().add(this.restLocal[i])
        : this.restLocal[i].clone();
    }

    // Pose accumulator.
    this.eul = new Float64Array(this.n * 3);
    this.scl = new Float64Array(this.n * 3).fill(1);
    this.pos = new Array(this.n);
    for (let i = 0; i < this.n; i++) this.pos[i] = new THREE.Vector3();

    this.rootIdx = this.index.get('root') ?? 0;
  }

  i(name) { return this.index.get(name); }
  bone(name) { return this.list[this.index.get(name)]; }
  rest(name) { return this.restRig[this.index.get(name)]; }

  /** Clear the accumulator back to the rest pose. */
  begin() {
    this.eul.fill(0);
    this.scl.fill(1);
    for (let i = 0; i < this.n; i++) this.pos[i].copy(this.restLocal[i]);
  }

  /** Add Euler radians to a bone. Safe to call many times from many layers. */
  add(name, rx, ry, rz) {
    const i = this.index.get(name);
    if (i === undefined) return;
    const o = i * 3;
    this.eul[o] += rx;
    this.eul[o + 1] += ry;
    this.eul[o + 2] += rz;
  }

  addIdx(i, rx, ry, rz) {
    if (i === undefined || i < 0) return;
    const o = i * 3;
    this.eul[o] += rx;
    this.eul[o + 1] += ry;
    this.eul[o + 2] += rz;
  }

  /** Read back what has accumulated so far (look-at clamps against this). */
  get(name, axis) {
    const i = this.index.get(name);
    return i === undefined ? 0 : this.eul[i * 3 + axis];
  }

  /**
   * Multiply a bone's LOCAL scale. Multiplicative like `add` is additive, so
   * independent layers compose without ordering.
   *
   * Remember that three.js composes scale down the hierarchy: scaling `chest`
   * scales `neck01`, `shoulderL` and `shoulderR` and everything below them.
   * Counter-scale the children you did not mean to inflate.
   */
  mul(name, sx, sy, sz) {
    const i = this.index.get(name);
    if (i === undefined) return;
    const o = i * 3;
    this.scl[o] *= sx;
    this.scl[o + 1] *= sy;
    this.scl[o + 2] *= sz;
  }

  /** Translate a bone away from its rest offset (root bob, hip slide). */
  offset(name, dx, dy, dz) {
    const i = this.index.get(name);
    if (i === undefined) return;
    this.pos[i].x += dx;
    this.pos[i].y += dy;
    this.pos[i].z += dz;
  }

  /** Commit the accumulator onto the skeleton. */
  flush() {
    for (let i = 0; i < this.n; i++) {
      const b = this.list[i];
      const o = i * 3;
      const x = this.eul[o], y = this.eul[o + 1], z = this.eul[o + 2];
      if (x === 0 && y === 0 && z === 0) b.quaternion.set(0, 0, 0, 1);
      else b.quaternion.setFromEuler(_e.set(x, y, z, 'XYZ'));
      b.position.copy(this.pos[i]);
      // Always written, never left sticky: a scale set on one frame and not
      // cleared on the next is the bug this shape of accumulator exists to
      // make impossible.
      b.scale.set(this.restScale[o] * this.scl[o],
        this.restScale[o + 1] * this.scl[o + 1],
        this.restScale[o + 2] * this.scl[o + 2]);
    }
  }
}

/** Degrees → radians helper for the authored pose tables. */
export const D2R = Math.PI / 180;

/**
 * Apply an authored pose table ({ boneName: [xDeg, yDeg, zDeg] }) at `w`.
 * Additive, so a state pose layers on top of the gait rather than replacing it.
 */
export function applyPoseTable(rig, table, w) {
  if (!table || w <= 0) return;
  for (const name in table) {
    if (name === 'root' || name === 'ikWeight' || name === 'height') continue;
    const r = table[name];
    rig.add(name, r[0] * D2R * w, r[1] * D2R * w, r[2] * D2R * w);
  }
}
