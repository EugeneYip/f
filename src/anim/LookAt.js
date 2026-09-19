/**
 * LookAt — head/neck/eye aim with per-joint weights and anatomical limits.
 * OWNER: animation agent.
 *
 * The point of interest is chosen by the brain; this turns it into a split of
 * yaw and pitch across neck01 / neck02 / head that respects how far a canid
 * can actually turn its head, and it gets there on a spring so the animal
 * never snaps. Eyes have no bones on this rig yet, so the residual (what the
 * neck could not deliver) is published as `gazeLocal` for the face agent to
 * put into the eyeballs.
 *
 * Bone axes (identity rest rotations): +Y yaws toward the animal's right,
 * +X pitches the muzzle down.
 */
import * as THREE from 'three';
import { clamp, damp, saturate, spring, smoothstep, fbm1, hash11, TAU } from '../util/math.js';

const YAW_MAX = 1.15;        // 66° total head turn — a fox, not an owl
const PITCH_UP = -0.62;
const PITCH_DOWN = 0.78;

// How the turn is shared. Sums to 1.
const W_NECK1 = 0.22;
const W_NECK2 = 0.30;
const W_HEAD = 0.48;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class LookAt {
  constructor(rig) {
    this.rig = rig;
    this.target = new THREE.Vector3(0, 0.30, 4);
    this.weight = 1;

    this.yaw = 0; this.yawS = { v: 0 };
    this.pitch = 0; this.pitchS = { v: 0 };
    this.roll = 0; this.rollS = { v: 0 };

    this.wantYaw = 0;
    this.wantPitch = 0;

    /** Residual the neck could not cover — for the eyes. */
    this.gazeYaw = 0;
    this.gazePitch = 0;

    this._neck = rig.bone('neck01');
  }

  /**
   * @param h     fixed step
   * @param bodyQ world orientation of the body (yaw)
   * @param sharp 0..1 — how eagerly the head snaps to the target
   */
  step(h, bodyQ, sharp = 0.5) {
    const neck = this._neck;
    let wy = 0, wp = 0;
    if (neck && this.weight > 0) {
      neck.updateWorldMatrix(true, false);
      _v.setFromMatrixPosition(neck.matrixWorld);
      _v.subVectors(this.target, _v);
      // Into body space.
      _q.copy(bodyQ).invert();
      _v.applyQuaternion(_q);
      const flat = Math.hypot(_v.x, _v.z);
      if (flat > 1e-4 || Math.abs(_v.y) > 1e-4) {
        wy = Math.atan2(_v.x, _v.z);
        wp = -Math.atan2(_v.y, Math.max(1e-4, flat));
      }
    }
    this.wantYaw = clamp(wy, -YAW_MAX * 1.8, YAW_MAX * 1.8);
    this.wantPitch = clamp(wp, PITCH_UP * 1.8, PITCH_DOWN * 1.8);

    const ty = clamp(this.wantYaw, -YAW_MAX, YAW_MAX) * this.weight;
    const tp = clamp(this.wantPitch, PITCH_UP, PITCH_DOWN) * this.weight;
    // Banking the head into a big turn is very canid and costs one line.
    const tr = clamp(-ty * 0.22, -0.20, 0.20);

    const om = 9 + 13 * saturate(sharp);
    const z = 0.92 - 0.18 * saturate(sharp);
    this.yaw = spring(this.yaw, ty, this.yawS, om, z, h);
    this.pitch = spring(this.pitch, tp, this.pitchS, om, z, h);
    this.roll = spring(this.roll, tr, this.rollS, om * 0.8, 0.95, h);

    this.gazeYaw = clamp(this.wantYaw - this.yaw, -0.55, 0.55);
    this.gazePitch = clamp(this.wantPitch - this.pitch, -0.42, 0.42);
  }

  apply(rig) {
    rig.add('neck01', this.pitch * W_NECK1, this.yaw * W_NECK1, this.roll * W_NECK1);
    rig.add('neck02', this.pitch * W_NECK2, this.yaw * W_NECK2, this.roll * W_NECK2);
    rig.add('head', this.pitch * W_HEAD, this.yaw * W_HEAD, this.roll * W_HEAD);
  }
}

/**
 * Chooses where the animal is looking. Deterministic: every interval and
 * every direction comes from `hash11` over an event counter, never from
 * Math.random() or the wall clock.
 */
export class Interest {
  constructor(seed = 91) {
    this.seed = seed | 0;
    this.n = 0;
    this.nextAt = 0.9;
    this.point = new THREE.Vector3(0, 0.28, 6);
    this.smoothed = new THREE.Vector3(0, 0.28, 6);
    this.out = new THREE.Vector3(0, 0.28, 6);
    this.hold = 0;
  }

  /**
   * @param t          sim seconds
   * @param origin     world position of the animal
   * @param yaw        heading
   * @param alertness  0..1 — raises the rate and narrows the scatter
   * @param camera     optional Object3D the fox occasionally clocks
   */
  step(h, t, origin, yaw, alertness, camera) {
    if (t >= this.nextAt) {
      const n = this.n++;
      const r1 = hash11(n * 2654435761 + this.seed);
      const r2 = hash11(n * 40503 + this.seed * 7 + 11);
      const r3 = hash11(n * 22695477 + this.seed * 13 + 101);
      const r4 = hash11(n * 1103515245 + this.seed * 3 + 7);

      // Poisson-ish: exponential intervals, shorter when alert.
      const mean = 3.4 - 1.9 * alertness;
      this.nextAt = t + clamp(-Math.log(Math.max(1e-4, r1)) * mean, 0.55, 11);

      const wide = 1.35 - 0.65 * alertness;
      const a = yaw + (r2 * 2 - 1) * wide;
      const dist = 1.2 + r3 * 16;
      let y = origin.y + 0.10 + (r4 - 0.35) * 0.9;

      if (camera && r4 > 0.74) {
        // Every so often it clocks the viewer — the single most alive thing
        // a still animal can do.
        this.point.copy(camera.position);
      } else {
        this.point.set(
          origin.x + Math.sin(a) * dist,
          y,
          origin.z + Math.cos(a) * dist,
        );
      }
    }
    // Saccade: fast to the new point, then a slow bounded drift while it
    // holds. The drift is an *offset*, not an integration, so the point of
    // interest can never wander off on its own.
    const k = 1 - Math.exp(-11 * h);
    this.smoothed.lerp(this.point, k);
    this.out.copy(this.smoothed);
    this.out.x += fbm1(t * 0.23, 3, this.seed) * 0.28;
    this.out.y += fbm1(t * 0.19 + 44, 3, this.seed + 5) * 0.11;
    this.out.z += fbm1(t * 0.17 + 91, 3, this.seed + 9) * 0.22;
    return this.out;
  }
}
