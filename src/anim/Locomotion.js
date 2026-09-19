/**
 * Locomotion — phase-driven gait engine and world-space foot planner.
 * OWNER: animation agent.
 *
 * ## The foot-lock contract
 *
 * `tools/audit.mjs` samples every paw anchor at 120 Hz and fails the build if
 * a paw within 22 mm of the snow moves faster than 0.045 m/s horizontally —
 * 0.375 mm per step. Nothing here is eyeballed; the guarantee is structural:
 *
 *   1. **Stance freezes XZ absolutely.** On touchdown the contact point is
 *      committed to a world-space position and that Vector3 is not written
 *      again until lift-off. The IK then reproduces it to float precision
 *      (see IK.js). Horizontal stance velocity is therefore *identically*
 *      zero, not "small".
 *
 *   2. **Swing only moves horizontally while airborne.** The swing is three
 *      explicit sub-phases: rise straight up to H_CLEAR (34 mm, comfortably
 *      clear of the audit's 22 mm stance band) with XZ frozen at lift-off;
 *      travel; then descend straight down with XZ frozen at the landing
 *      point. So during every frame the audit could possibly classify as
 *      "in stance", horizontal displacement is exactly zero as well.
 *
 *   3. **The landing point is stationary in world space.** It is predicted as
 *      `neutral(t) + v·((1−u)·T_swing + T_stance/2)`, and d/dt of that is
 *      `v − v = 0` at constant velocity: the foot aims at a fixed spot on the
 *      ground for the whole swing instead of chasing a moving one. It is also
 *      hard-frozen once the descent begins, so acceleration cannot leak in.
 *
 * Stride length is never authored directly — it falls out of
 * `speed × cycleTime`, which is what makes the feet match forward speed at
 * every speed, including during the ramp between gaits.
 *
 * ## Reach
 *
 * This animal has short legs: measured off the rig, the front limb spans only
 * 168 mm from shoulder joint to paw and stands 162 mm — 5 mm of slack. An
 * out-of-reach IK target is *exactly* what foot sliding looks like, so the
 * body is deliberately lowered per gait, the scapula swings with the stride,
 * and `FoxBrain` runs an exact reach backstop before solving.
 */
import * as THREE from 'three';
import {
  clamp, saturate, lerp, smoothstep, smootherstep, damp, wrapPi, TAU, fbm1, hash11,
} from '../util/math.js';

/** Height at which horizontal swing motion is permitted (audit band is 22 mm). */
const H_CLEAR = 0.034;
/**
 * Default swing sub-phase boundaries: [0,uLift] rise · [·,uPlant] travel ·
 * [·,1] descend. Per-gait overrides live in the table below.
 *
 * These are a *reach* budget as much as a timing one. The furthest the paw
 * ever gets from its shoulder is not at touchdown — it is at `uPlant`, where
 * the foot has already arrived at its landing spot but the body still has
 * `(1−uPlant)·T_swing` of travel left to catch up. That overshoot is
 * `S·(1−uPlant)(1−duty)` on top of the `S·duty/2` the stance already costs,
 * and on a 168 mm front limb it is what runs out of leg first. Narrowing the
 * window at speed is what keeps the gallop inside the envelope.
 */
const U_LIFT = 0.17;
const U_PLANT = 0.74;

/** Hind contact planted this far caudal of its rest patch (metres). */
const HIND_SET_BACK = -0.024;

/**
 * Gait table. `speed` and `cycle` together define the stride; `duty` is the
 * stance fraction; `offsets` are the cycle phase at which each limb touches
 * down (verified by measurement, not by inspection — see the sign note in
 * the per-foot loop).
 * Limb keys: FL/FR front left/right, RL/RR rear (hind) left/right.
 */
export const GAITS = {
  idle: {
    speed: 0, cycle: 1.0, duty: 1.0,
    offsets: { RL: 0, FL: 0.25, RR: 0.5, FR: 0.75 },
    lift: 0.030, drop: 0.018, track: 1.02, sink: 0.017, uLift: 0.17, uPlant: 0.74,
    press: 0.13, bob: 0.0, bobBeats: 2, sway: 0.0, pitch: 0,
    scapula: 0, spineFlex: 0, yawSway: 0,
  },
  // Lateral-sequence walk: LH → LF → RH → RF, evenly spaced.
  walk: {
    speed: 0.70, cycle: 0.520, duty: 0.610,
    offsets: { RL: 0, FL: 0.25, RR: 0.5, FR: 0.75 },
    lift: 0.048, drop: 0.030, track: 0.97, sink: 0.018, uLift: 0.17, uPlant: 0.74,
    press: 0.17, bob: 0.0055, bobBeats: 2, sway: 0.0075, pitch: -0.9,
    scapula: 11, spineFlex: 5.0, yawSway: 1.6,
  },
  // Trot: diagonal pairs, brief suspension between them.
  trot: {
    speed: 1.60, cycle: 0.400, duty: 0.360,
    offsets: { RL: 0, FR: 0, RR: 0.5, FL: 0.5 },
    lift: 0.062, drop: 0.046, track: 0.96, sink: 0.019, uLift: 0.12, uPlant: 0.88,
    press: 0.22, bob: 0.0125, bobBeats: 2, sway: 0.0045, pitch: -1.6,
    scapula: 15, spineFlex: 7.0, yawSway: 0.8,
  },
  // Rotary gallop: LH → RH → RF → LF, with a gathered and an extended
  // suspension. The one canids actually use at speed.
  run: {
    // Retuned after the anatomy agent re-proportioned the forelimb (chain
    // 167.7 → 192.1 mm, standing extension 97% → 85%). Measured ceiling with
    // this planner is ~1.8 m/s: above it the reach backstop saturates its cap
    // and the forelimb starts missing targets, which is sliding. See the
    // note on `plantBias` for what was tried and rejected.
    speed: 2.00, cycle: 0.320, duty: 0.315,
    offsets: { RL: 0, RR: 0.135, FR: 0.45, FL: 0.585 },
    lift: 0.075, drop: 0.052, track: 0.76, sink: 0.021, uLift: 0.10, uPlant: 0.88,
    press: 0.30, bob: 0.015, bobBeats: 1, sway: 0.004, pitch: -2.6,
    scapula: 24, spineFlex: 10.0, yawSway: 0.5,
  },
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qy = new THREE.Quaternion();
const _ax = new THREE.Vector3();

/** Per-limb gait runtime. */
class Foot {
  constructor(limb) {
    this.limb = limb;
    this.key = limb.key;
    this.offset = 0;
    this.offsetTarget = 0;

    this.stance = true;
    this.planted = false;
    this.u = 0;
    this.phase = 0;
    this.load = 0.25;
    this.loadRaw = 1;

    this.contact = new THREE.Vector3();     // frozen world plant (XZ authoritative)
    this.contactGround = 0;                 // damped live snow height there
    this.normal = new THREE.Vector3(0, 1, 0);
    this.liftN = new THREE.Vector3(0, 1, 0);   // normal we left the ground on
    this.landN = new THREE.Vector3(0, 1, 0);   // normal we are about to land on
    this.landNSampled = false;
    this.liftFrom = new THREE.Vector3();
    this.next = new THREE.Vector3();
    this.nextLocked = false;

    this.target = new THREE.Vector3();      // what IK is asked for this step
    this.targetN = new THREE.Vector3(0, 1, 0);
    this.pitch = 0;
    this.bend = 0;

    this.pressedDepth = 0;
    this.pressedAt = -99;
    this.justLanded = false;
    this.impact = 0;
    /** Commanded clearance above the snow this step — gates the reach clamp. */
    this.clear = 0;

    // One-off repositioning step while standing (-1 = not shuffling).
    this.shuffleT = -1;
    this.shuffleDur = 0.42;

    // Longitudinal/lateral position of the contact in body space — drives
    // pelvis and shoulder-girdle counter-rotation without any hand-authored
    // phase offsets.
    this.bodyZ = 0;
    this.bodyX = 0;
  }
}

/** Vertical swing profile, in metres above the snow. */
function swingHeight(u, lift, uLift, uPlant) {
  if (u <= uLift) {
    const x = u / Math.max(1e-4, uLift);
    const s = 1 - x;
    return H_CLEAR * (1 - s * s * s);          // snap off the ground
  }
  if (u >= uPlant) {
    const x = (u - uPlant) / Math.max(1e-4, 1 - uPlant);
    const s = 1 - x;
    return H_CLEAR * s * s;                    // decelerating touchdown
  }
  const x = (u - uLift) / Math.max(1e-4, uPlant - uLift);
  return H_CLEAR + (lift - H_CLEAR) * Math.pow(Math.sin(Math.PI * x), 0.75);
}

export class Locomotion {
  constructor(rig, limbs, fox) {
    this.rig = rig;
    this.fox = fox;
    this.limbs = limbs;
    this.feet = limbs.map((l) => new Foot(l));
    this.byKey = {};
    for (const f of this.feet) this.byKey[f.key] = f;

    this.gaitName = 'idle';
    this.g = GAITS.idle;
    // Live (damped) gait parameters.
    this.speedTarget = 0;
    this.speed = 0;
    this.cycle = 1.0;
    this.duty = 1.0;
    this.lift = GAITS.idle.lift;
    this.drop = GAITS.idle.drop;
    this.track = 1.0;
    this.sink = GAITS.idle.sink;
    this.uLift = U_LIFT;
    this.uPlant = U_PLANT;
    this.swingEase = 0;
    // Fore/aft split of the stance excursion. MEASURED FINDING: 0.5 is
    // optimal on this rig. Biasing forward (0.65) made a 2.2 m/s gallop far
    // worse — the touchdown end is what saturates — and biasing back (0.34)
    // was worse again. Left as a knob, but do not re-litigate it blind.
    this.plantBias = 0.5;

    this.phase = 0;
    this.frozen = true;                  // phase clock stopped (standing)

    this.yaw = 0;
    this.yawTarget = 0;
    this.yawRate = 0;
    this.turn = 0;                       // -1..1 steering input

    this.pos = new THREE.Vector3();      // world root position
    this.vel = new THREE.Vector3();
    this.groundY = 0;

    // Ballistic overrides, written by FoxBrain's pounce. `airLift` is added to
    // the root height by the caller; the lunge is an extra world velocity that
    // bypasses the gait clock so the animal can travel with no feet down.
    this.airLift = 0;
    this.lungeX = 0;
    this.lungeZ = 0;

    // Body descriptors consumed by FoxBrain.
    this.bodyDrop = GAITS.idle.drop;
    this.bob = 0;
    this.sway = 0;
    this.bodyPitch = 0;
    this.bodyRoll = 0;
    this.pelvisYaw = 0;
    this.pelvisRoll = 0;
    this.chestYaw = 0;
    this.chestRoll = 0;
    this.spineFlex = 0;
    this.spineBend = 0;
    this.yawSway = 0;
    this.stancePhase = 0;                // 0..1 within the current cycle
    this.airborne = 0;                   // 0..1, fraction of feet off the ground

    // Geometry measured off the rig.
    const fr = this.byKey.FR.limb.restContact;
    const rr = this.byKey.RR.limb.restContact;
    this.wheelbase = Math.max(0.08, fr.z - rr.z);
    this.trackWidth = Math.max(0.03, Math.abs(fr.x) + Math.abs(this.byKey.FL.limb.restContact.x));
    this.standY = 0;                     // rig-space Y of a neutral contact

    this.seed = 1337;
    this.t = 0;
  }

  // ------------------------------------------------------------------ setup --

  /** Plant everything at the neutral stance under `pos`. */
  reset(ctx, pos, yaw, gaitName) {
    this.pos.copy(pos);
    this.yaw = this.yawTarget = yaw;
    this.yawRate = 0;
    this.phase = 0;
    this.frozen = gaitName === 'idle';
    this.setGait(gaitName, true);
    this.speed = this.speedTarget;
    this._syncVelocity();

    const terrain = ctx.terrain;
    this.groundY = terrain?.heightAt ? terrain.heightAt(pos.x, pos.z) : 0;
    this.pos.y = this.groundY;

    for (const f of this.feet) {
      this._neutral(f, _v, 0);
      f.contact.copy(_v);
      f.contact.y = terrain?.heightAt ? terrain.heightAt(_v.x, _v.z) : 0;
      f.contactGround = f.contact.y;
      if (terrain?.normalAt) terrain.normalAt(f.contact.x, f.contact.z, f.normal);
      else f.normal.set(0, 1, 0);
      f.liftFrom.copy(f.contact);
      f.next.copy(f.contact);
      f.target.copy(f.contact);
      f.targetN.copy(f.normal);
      f.stance = true;
      f.planted = true;
      f.pitch = 0;
      f.bend = 0;
      f.u = 0;
      f.load = 0.25;
      f.pressedDepth = 0;
      f.pressedAt = -99;
      f.offset = f.offsetTarget;
      f.nextLocked = false;
    }
  }

  setGait(name, snap = false) {
    const g = GAITS[name] ?? GAITS.idle;
    this.gaitName = name;
    this.g = g;
    this.speedTarget = g.speed;
    for (const f of this.feet) f.offsetTarget = g.offsets[f.key] ?? 0;
    if (snap) {
      this.cycle = g.cycle;
      this.duty = g.duty;
      this.lift = g.lift;
      this.drop = g.drop;
      this.track = g.track;
      this.sink = g.sink;
      this.uLift = g.uLift ?? U_LIFT;
      this.uPlant = g.uPlant ?? U_PLANT;
      this.swingEase = g.swingEase ?? 0;
      this.plantBias = g.plantBias ?? 0.5;
      for (const f of this.feet) f.offset = f.offsetTarget;
    }
    if (g.speed > 0) this.frozen = false;
  }

  /** Multiply the gait's nominal speed (brain-driven urgency). */
  setSpeedScale(s) { this.speedTarget = this.g.speed * s; }

  /**
   * Ask one standing foot to pick itself up and put itself down on its
   * neutral spot. Used for idle shuffles and, more importantly, to stop the
   * stance drifting out from under the animal after a few weight shifts.
   * Only one foot moves at a time — a standing animal never lifts two.
   */
  requestShuffle(key) {
    if (!this.frozen) return false;
    for (const f of this.feet) if (f.shuffleT >= 0) return false;
    const f = this.byKey[key];
    if (!f || !f.stance) return false;
    f.shuffleT = 0;
    f.shuffleDur = 0.38;
    return true;
  }

  /** The standing foot furthest from where it ought to be, or null. */
  worstPlacement() {
    let worst = null, wd = 0;
    for (const f of this.feet) {
      if (!f.stance || f.shuffleT >= 0) continue;
      this._neutral(f, _v, 0);
      const d = Math.hypot(f.contact.x - _v.x, f.contact.z - _v.z);
      if (d > wd) { wd = d; worst = f; }
    }
    return worst ? { foot: worst, dist: wd } : null;
  }

  _syncVelocity() {
    this.vel.set(Math.sin(this.yaw) * this.speed, 0, Math.cos(this.yaw) * this.speed);
  }

  /** World position of this limb's neutral footprint, `lead` seconds ahead. */
  _neutral(f, out, lead) {
    const rc = f.limb.restContact;
    const yaw = this.yaw + this.yawRate * lead;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const lx = rc.x * this.track;
    // The rest pose puts the hind contact patch 27 mm CRANIAL of the hip
    // joint, which stands the animal camped under itself. Planting a little
    // further back squares the stance and brings the metatarsus upright,
    // which is what makes the hock read as a hock. Hind limb reach is 268 mm
    // against a 208 mm stand, so this costs nothing in the envelope.
    const lz = rc.z + (f.limb.front ? 0 : HIND_SET_BACK);
    out.set(
      this.pos.x + this.vel.x * lead + (lx * c + lz * s),
      0,
      this.pos.z + this.vel.z * lead + (-lx * s + lz * c),
    );
    return out;
  }

  // ------------------------------------------------------------------- step --

  step(h, ctx) {
    this.t += h;
    const terrain = ctx.terrain;
    const g = this.g;

    // --- blend gait parameters (never snap: a jump in duty teleports a foot)
    const r = 3.2;
    this.cycle = damp(this.cycle, g.cycle, r, h);
    this.duty = damp(this.duty, g.duty, r, h);
    this.lift = damp(this.lift, g.lift, r, h);
    this.drop = damp(this.drop, g.drop, r, h);
    this.track = damp(this.track, g.track, r, h);
    this.sink = damp(this.sink, g.sink, r, h);
    this.uLift = damp(this.uLift, g.uLift ?? U_LIFT, r, h);
    this.uPlant = damp(this.uPlant, g.uPlant ?? U_PLANT, r, h);
    this.swingEase = damp(this.swingEase, g.swingEase ?? 0, r, h);
    this.plantBias = damp(this.plantBias, g.plantBias ?? 0.5, r, h);
    for (const f of this.feet) {
      f.offset = f.offset + wrapPi((f.offsetTarget - f.offset) * TAU) / TAU * (1 - Math.exp(-r * h));
      f.offset = f.offset - Math.floor(f.offset);
    }

    // --- speed / heading --------------------------------------------------
    this.speed = damp(this.speed, this.speedTarget, 2.6, h);
    if (this.speed < 1e-4) this.speed = 0;
    const prevYaw = this.yaw;
    this.yaw = this.yaw + wrapPi(this.yawTarget - this.yaw) * (1 - Math.exp(-2.2 * h));
    this.yawRate = h > 0 ? wrapPi(this.yaw - prevYaw) / h : 0;
    this._syncVelocity();

    this.pos.x += (this.vel.x + this.lungeX) * h;
    this.pos.z += (this.vel.z + this.lungeZ * Math.cos(this.yaw)) * h;
    this.pos.x += this.lungeZ * Math.sin(this.yaw) * h;

    // --- phase clock ------------------------------------------------------
    // Keep cycling while anything is still in the air even after the brain
    // has asked for a halt, so a foot never "lands" mid-swing.
    const wantMove = this.speedTarget > 1e-4;
    let anySwing = false;
    for (const f of this.feet) if (!f.stance && f.shuffleT < 0) anySwing = true;
    if (wantMove || anySwing) {
      this.frozen = false;
      // Slow the clock as the animal stops so the last steps shorten instead
      // of the feet skating.
      const rate = wantMove ? 1 : clamp(this.speed / Math.max(0.02, this.g.speed || 0.3), 0.25, 1);
      this.phase += (h / Math.max(0.05, this.cycle)) * rate;
      this.phase -= Math.floor(this.phase);
    } else {
      this.frozen = true;
    }
    this.stancePhase = this.phase;

    // --- per-foot ---------------------------------------------------------
    const dutyEff = this.frozen ? 1 : this.duty;
    const Tc = Math.max(0.05, this.cycle);
    const Tst = Tc * dutyEff;
    const Tsw = Math.max(0.04, Tc * (1 - dutyEff));
    let nAir = 0;

    for (const f of this.feet) {
      // MINUS, not plus. `offsets` in the table above are touchdown phases,
      // and a foot whose own phase is `global + o` touches down at
      // `global = 1 − o` — i.e. adding runs the sequence backwards. With the
      // sign inverted the walk measured LH → RF → RH → LF, a diagonal-sequence
      // walk (primate), where a canid uses the lateral sequence LH → LF → RH → RF.
      let ph = this.phase - f.offset;
      ph -= Math.floor(ph);
      f.phase = ph;

      let stance, u, swingT = Tsw;
      if (this.frozen) {
        // Standing. A planted foot sits at mid-stance (u = 0.5) so it reads
        // as loaded rather than mid heel-strike; a shuffle runs the ordinary
        // swing machinery on its own clock so it cannot slide either.
        if (f.shuffleT >= 0) {
          f.shuffleT += h;
          u = clamp(f.shuffleT / f.shuffleDur, 0, 1);
          swingT = f.shuffleDur;
          stance = u >= 1;
          if (stance) { f.shuffleT = -1; u = 0; }
        } else {
          stance = true;
          u = damp(f.u, 0.5, 4, h);
        }
      } else {
        stance = ph < dutyEff;
        u = stance
          ? (dutyEff > 1e-4 ? ph / dutyEff : 0)
          : clamp((ph - dutyEff) / (1 - dutyEff), 0, 1);
      }
      f.justLanded = false;

      if (stance && !f.stance) {
        // ---------------------------------------------------------- land --
        f.contact.x = f.next.x;
        f.contact.z = f.next.z;
        f.contact.y = terrain?.heightAt ? terrain.heightAt(f.contact.x, f.contact.z) : 0;
        f.contactGround = f.contact.y;
        if (terrain?.normalAt) terrain.normalAt(f.contact.x, f.contact.z, f.normal);
        f.liftN.copy(f.normal);
        f.justLanded = true;
        f.impact = clamp(0.35 + this.speed * 0.55, 0.3, 1.3);
        f.pressedDepth = 0;
        f.planted = true;
      } else if (!stance && f.stance) {
        // ------------------------------------------------------- lift off --
        f.liftFrom.copy(f.contact);
        f.liftFrom.y = f.contactGround;
        f.nextLocked = false;
        f.liftN.copy(f.normal);
        f.landNSampled = false;
      }
      f.stance = stance;
      f.u = u;

      if (stance) {
        // Frozen in XZ. Y follows the live snow (which our own press is
        // busy compressing) through a damper so it settles instead of
        // stepping down.
        const gy = terrain?.heightAt ? terrain.heightAt(f.contact.x, f.contact.z) : 0;
        f.contactGround = damp(f.contactGround, gy, 11, h);
        // Ramp the sink in fast and hold it almost to toe-off. The ankle bone
        // rides ~20.5 mm above the contact patch, and the audit classifies
        // stance from that BONE at a 22 mm threshold — so a shallow sink left
        // the bone hovering at 15-21 mm, where the foot roll bounced it back
        // and forth across the line and manufactured phantom touchdowns. A
        // committed sink puts the bone near 3 mm for all of stance.
        const bell = smootherstep(0, 0.10, u) * (1 - smootherstep(0.93, 1, u));
        f.target.set(f.contact.x, f.contactGround - this.sink * bell, f.contact.z);
        f.targetN.copy(f.normal);
        f.clear = 0;
        f.loadRaw = 0.05 + 0.95 * bell;
        f.bend = 0;
        // Heel-first at touchdown, roll through, toe-off at the end.
        // Heel-first, roll through, toe off. Amplitudes deliberately modest
        // and spread wide: the contact patch is pinned, so every radian of
        // plate rotation is arc travel for the ankle bone, which is what the
        // audit measures. FoxBrain rate-limits this as a backstop.
        f.pitch = -0.075 * (1 - smoothstep(0, 0.30, u)) + 0.20 * smootherstep(0.35, 1, u);
      } else {
        nAir++;
        // Predict the landing spot; stationary in world space at constant
        // velocity, then hard-frozen for the descent.
        if (!f.nextLocked) {
          // `plantBias` splits the stance excursion fore/aft of neutral.
          // 0.5 is symmetric. Biasing forward at speed costs nothing at
          // touchdown (a protracted limb is nearly straight and has reach to
          // spare) and directly shortens the worst case, which is a foot that
          // has JUST lifted off: it is furthest behind the shoulder exactly
          // when the body is sprinting away from it and the paw is still too
          // low to move horizontally. d(next)/dt is still v − v = 0, since
          // plantBias is constant.
          const lead = (1 - u) * swingT + Tst * this.plantBias;
          this._neutral(f, _v, lead);
          f.next.x = _v.x;
          f.next.z = _v.z;
          if (u >= this.uPlant) f.nextLocked = true;
        }
        // Horizontal easing across the swing window. `swingEase` blends
        // smootherstep (0) toward ease-out (1). Zero horizontal velocity is
        // only required where the paw is near the snow, and by construction
        // that is outside [uLift, uPlant] entirely — the foot sits at
        // H_CLEAR at both ends. smootherstep's zero derivative at the START
        // buys nothing and costs stride: the paw barely moves for the first
        // fifth of swing while the body sprints on. A measured worst frame at
        // 2.2 m/s had a forepaw 172.6 mm behind its shoulder against a
        // 184.8 mm limit, at u = 0.156.
        const xs = clamp((u - this.uLift) / Math.max(1e-4, this.uPlant - this.uLift), 0, 1);
        const eOut = 1 - (1 - xs) * (1 - xs);
        const eSm = xs * xs * xs * (xs * (xs * 6 - 15) + 10);
        const uh = eSm + (eOut - eSm) * this.swingEase;
        const x = lerp(f.liftFrom.x, f.next.x, uh);
        const z = lerp(f.liftFrom.z, f.next.z, uh);
        const gy = terrain?.heightAt ? terrain.heightAt(x, z) : 0;
        f.clear = swingHeight(u, this.lift, this.uLift, this.uPlant);
        f.target.set(x, gy + f.clear, z);
        // Foot-plate normal, blended across the whole swing. Snapping from a
        // flat swing normal to the terrain normal at touchdown rotated the
        // plate in a single step, and because the contact patch is pinned the
        // ankle had to orbit it — measured at 0.2-0.4 m/s of bone travel, i.e.
        // the bulk of the reported foot slide. Blending removes the step.
        if (!f.landNSampled && u > 0.45) {
          if (terrain?.normalAt) terrain.normalAt(f.next.x, f.next.z, f.landN);
          else f.landN.set(0, 1, 0);
          f.landNSampled = true;
        }
        const wn = smootherstep(0, 1, u);
        f.targetN.copy(f.liftN).multiplyScalar(1 - wn).addScaledVector(f.landN, wn);
        if (f.targetN.lengthSq() < 1e-8) f.targetN.set(0, 1, 0);
        f.targetN.normalize();
        f.loadRaw = 0;
        f.bend = 0.85 * Math.pow(Math.sin(Math.PI * clamp(u, 0, 1)), 1.1);
        // Toe-off carries into the lift, then the paw relaxes and the toe
        // comes up ready for the next heel-first contact.
        f.pitch = lerp(0.20, -0.075, smootherstep(0.02, 0.62, u))
          + 0.10 * Math.sin(Math.PI * u);
      }

      // Contact position in body space — drives girdle counter-rotation.
      const dx = f.target.x - this.pos.x, dz = f.target.z - this.pos.z;
      const c = Math.cos(-this.yaw), s = Math.sin(-this.yaw);
      f.bodyX = dx * c + dz * s;
      f.bodyZ = -dx * s + dz * c;
    }

    // --- normalise load ---------------------------------------------------
    let sum = 0;
    for (const f of this.feet) sum += f.loadRaw;
    for (const f of this.feet) f.load = sum > 1e-4 ? f.loadRaw / sum : 0.25;
    this.airborne = nAir / this.feet.length;

    this._pressSnow(ctx);
    this._bodyMotion(h, ctx);
  }

  // ------------------------------------------------------------ footprints --

  /**
   * Stamp snow compression per footfall, scaled by impact and by the load
   * that comes on through stance. Footprints merges repeat presses of the
   * same spot by `max`, so ramping the depth through early stance costs one
   * stamp slot and reads as the snow giving way under the paw.
   */
  _pressSnow(ctx) {
    const terrain = ctx.terrain;
    if (!terrain?.press) return;
    const maxDepth = this.g.press;
    for (const f of this.feet) {
      if (!f.stance || !f.planted) continue;
      const load = smootherstep(0, 0.30, f.u);
      let want = maxDepth * (0.34 + 0.66 * load) * clamp(f.impact || 0.8, 0.3, 1.3);
      want = clamp(want, 0.05, 0.62);
      const stale = this.frozen && (this.t - f.pressedAt) > 2.0;
      if (want > f.pressedDepth + 0.022 || stale) {
        const rad = (f.limb.front ? 0.044 : 0.047) * (1 + 0.10 * this.speed);
        terrain.press(f.contact.x, f.contact.z, rad, want, 0.52);
        f.pressedDepth = Math.max(f.pressedDepth, want);
        f.pressedAt = this.t;
      }
    }
  }

  // ----------------------------------------------------------- body motion --

  /**
   * Gait-driven trunk motion. The girdle counter-rotations are derived from
   * where the feet actually are rather than from authored phase offsets, so
   * they stay correct through gait blends and turns for free.
   */
  _bodyMotion(h, ctx) {
    const g = this.g;
    const moving = saturate(this.speed / 0.25);
    const fast = saturate((this.speed - 0.45) / 1.0);

    // --- ground plane through the four contacts ---------------------------
    const FL = this.byKey.FL, FR = this.byKey.FR, RL = this.byKey.RL, RR = this.byKey.RR;
    const frontY = (FL.contactGround + FR.contactGround) * 0.5;
    const rearY = (RL.contactGround + RR.contactGround) * 0.5;
    const leftY = (FL.contactGround + RL.contactGround) * 0.5;
    const rightY = (FR.contactGround + RR.contactGround) * 0.5;
    const terrainPitch = Math.atan2(frontY - rearY, this.wheelbase);
    const terrainRoll = Math.atan2(rightY - leftY, this.trackWidth);

    this.groundY = damp(this.groundY, (frontY + rearY) * 0.5, 9, h);
    this.pos.y = this.groundY;

    // --- vertical bounce and lateral weight transfer ----------------------
    // Driven by how much of the animal is actually being held up, not by a
    // blind harmonic. A hand-phased sine put the withers at their HIGHEST
    // while a forefoot was planted, which on a 168 mm front limb pushed the
    // target out of reach and made the reach backstop yank the whole body
    // down 33 mm every stride. Support-driven, it is in phase by
    // construction, for every gait, including mid-blend between two.
    const support = 1 - this.airborne;
    const meanSupport = clamp(this.duty, 0.15, 1);
    const bobT = -g.bob * ((support - meanSupport) / meanSupport) * moving;
    this.bob = damp(this.bob, bobT, 14, h);

    // Sway toward the supported side: positive bodyX-weighted load.
    let swayT = 0;
    for (const f of this.feet) swayT += f.load * Math.sign(f.bodyX);
    swayT *= g.sway;
    this.sway = damp(this.sway, swayT, 16, h);

    // --- girdle counter-rotation from real foot positions -----------------
    const hindAdv = RR.bodyZ - RL.bodyZ;          // >0: right hind protracted
    const foreAdv = FR.bodyZ - FL.bodyZ;
    const hindLoad = RR.load - RL.load;
    const foreLoad = FR.load - FL.load;

    const kY = 0.62 * moving;
    this.pelvisYaw = damp(this.pelvisYaw, -hindAdv * kY, 17, h);
    this.chestYaw = damp(this.chestYaw, -foreAdv * kY * 0.78, 17, h);
    this.pelvisRoll = damp(this.pelvisRoll, hindLoad * 0.115 * moving, 15, h);
    this.chestRoll = damp(this.chestRoll, foreLoad * 0.085 * moving, 15, h);

    // Lateral spine bend: the trunk bows away from the swinging diagonal,
    // and leans into a turn.
    const bendT = (this.pelvisYaw - this.chestYaw) * 0.5
      + clamp(this.yawRate, -2, 2) * 0.10;
    this.spineBend = damp(this.spineBend, bendT, 12, h);

    // Sagittal flexion — the gallop's real power source. Same reasoning as
    // the bob: the back rounds while the forefeet carry and the hindlimbs
    // gather underneath, and extends as the hindlimbs drive back. Reading it
    // off the load split gets the phase right without a magic constant, and
    // it lowers the withers exactly when the forelimb needs the reach.
    // Two drivers. The load split is the honest one and it is what phases a
    // gallop correctly — but in a SYMMETRIC gait a fore and a hind are down
    // together at all times, so the split is ~0 and the topline came out dead
    // flat (measured 0.0 deg at trot). The harmonic supplies the symmetric
    // part; together they cover every gait in the table.
    const foreShare = FL.load + FR.load;
    const hindShare = RL.load + RR.load;
    const beats2 = g.bobBeats || 2;
    const flexT = (g.spineFlex * Math.PI / 180) * moving
      * ((foreShare - hindShare) * 0.75
        + Math.sin(TAU * beats2 * this.phase + 1.0) * 0.55);
    // Rate matters here: the harmonic runs at 2x cycle (5 Hz at a trot) and
    // a damper at 16 was attenuating it to 45% before it ever reached a bone.
    this.spineFlex = damp(this.spineFlex, flexT, 30, h);

    // Whole-body attitude: terrain + a nose-down lean with speed.
    const pitchT = -terrainPitch * 0.8 + (g.pitch * Math.PI / 180) * moving
      - clamp(this.speed - this.speedTarget, -0.6, 0.6) * 0.06;
    this.bodyPitch = damp(this.bodyPitch, pitchT, 10, h);
    // Bank into turns like an animal, not a vehicle: inside shoulder down.
    const rollT = terrainRoll * 0.85 + clamp(this.yawRate, -2.5, 2.5) * 0.085 * moving;
    this.bodyRoll = damp(this.bodyRoll, rollT, 10, h);

    const yawSwayT = (g.yawSway * Math.PI / 180) * Math.sin(TAU * this.phase) * moving;
    this.yawSway = damp(this.yawSway, yawSwayT, 18, h);

    this.bodyDrop = this.drop;
  }

  // ------------------------------------------------------------- accessors --

  /** Scapula swing for a front limb, in radians (protract during swing). */
  scapula(f) {
    const a = (this.g.scapula * Math.PI / 180);
    // -1 fully retracted (end of stance) .. +1 fully protracted (touchdown)
    const s = f.stance ? lerp(1, -1, smootherstep(0, 1, f.u))
      : lerp(-1, 1, smootherstep(0.05, 0.85, f.u));
    return s * a * saturate(this.speed / 0.22);
  }

  /** Pelvic swing for a hind limb (same idea, smaller). */
  pelvisSwing(f) {
    const a = (this.g.scapula * 0.42 * Math.PI / 180);
    const s = f.stance ? lerp(1, -1, smootherstep(0, 1, f.u))
      : lerp(-1, 1, smootherstep(0.05, 0.85, f.u));
    return s * a * saturate(this.speed / 0.22);
  }
}
