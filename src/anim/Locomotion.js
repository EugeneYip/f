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
  clamp, saturate, lerp, smoothstep, smootherstep, damp, spring, wrapPi, TAU, fbm1, hash11,
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
    press: 0.13, bob: 0.0, bobBeats: 2, sway: 0.0, swayBeat: 0, pitch: 0,
    scapula: 0, spineFlex: 0, yawSway: 0,
    flight: 0, impact: 0.0,
  },
  // Lateral-sequence walk: LH → LF → RH → RF, evenly spaced.
  //
  // MEASURED, and the reason the animal read as bulky: the commanded bob was
  // 5.5 mm peak-to-peak and the damper below delivered 46% of it, so a
  // walking fox's centre of mass rose and fell ONE MILLIMETRE per stride.
  // `audit.mjs` cannot see this — every one of its 98 assertions is about
  // where the FEET are, and the feet were always right. Mass that never
  // leaves the ground is exactly what "heavy and inert" looks like.
  walk: {
    speed: 0.70, cycle: 0.520, duty: 0.640,
    offsets: { RL: 0, FL: 0.25, RR: 0.5, FR: 0.75 },
    lift: 0.048, drop: 0.024, track: 0.97, sink: 0.018, uLift: 0.17, uPlant: 0.74,
    press: 0.17, bob: 0.0130, bobBeats: 2, sway: 0.0092, swayBeat: 0.0016, pitch: -0.2,
    vault: true,
    scapula: 11, spineFlex: 5.0, yawSway: 1.6,
    flight: 0, impact: 0.0055,
  },
  // Trot: diagonal pairs, brief suspension between them. A trot is the
  // PROUDEST gait a canid has — level topline, head up, brisk. It was the
  // second-lowest carriage here (withers 197 mm against 219 at a walk),
  // which is what made all three moving states read as one crouched slink.
  trot: {
    // Stance excursion is speed×cycle×duty = 236 mm (±118) and the forelimb
    // has sqrt(192² − 138²) = 134 mm of horizontal reach at this ride
    // height, so the 22 mm of body lift below is paid for out of duty and
    // speed rather than out of the foot lock.
    speed: 1.55, cycle: 0.400, duty: 0.380,
    offsets: { RL: 0, FR: 0, RR: 0.5, FL: 0.5 },
    lift: 0.062, drop: 0.024, track: 0.96, sink: 0.019, uLift: 0.12, uPlant: 0.88,
    press: 0.22, bob: 0.0255, bobBeats: 2, sway: 0.0050, swayBeat: 0.0042, pitch: 0.4,
    scapula: 15, spineFlex: 7.0, yawSway: 0.8,
    flight: 0.7, impact: 0.0115,
  },
  // Rotary gallop: LH → RH → RF → LF, with a gathered and an extended
  // suspension. The one canids actually use at speed.
  run: {
    // Retuned after the anatomy agent re-proportioned the forelimb (chain
    // 167.7 → 192.1 mm, standing extension 97% → 85%). Measured ceiling with
    // this planner is ~1.8 m/s: above it the reach backstop saturates its cap
    // and the forelimb starts missing targets, which is sliding. See the
    // note on `plantBias` for what was tried and rejected.
    //
    // `flight` is what lifts the cap. The limiting quantity is not speed, it
    // is STRIDE: reach runs out because `speed × cycle × duty` of stance
    // excursion has to fit inside a 192 mm forelimb. A genuine suspension
    // phase buys distance the legs never have to reach for — the body flies
    // it — so the same limb covers a longer stride at a higher speed.
    // Re-timed for a real extended suspension. Support windows at these
    // offsets are RL[0,.25] RR[.10,.35] FR[.42,.67] FL[.52,.77], leaving a
    // gathered gap of 0.07 and an EXTENDED gap of 0.23 — 78 ms with nothing
    // on the ground, against 34 ms before. Stance excursion is
    // speed×cycle×duty = 221 mm (±110), a hair over the ±101 mm the old
    // 2.0 m/s tune measured as its reach ceiling, and the lower duty is
    // what pays for the extra speed.
    speed: 2.60, cycle: 0.340, duty: 0.250,
    offsets: { RL: 0, RR: 0.10, FR: 0.42, FL: 0.52 },
    lift: 0.078, drop: 0.040, track: 0.76, sink: 0.021, uLift: 0.10, uPlant: 0.88,
    press: 0.30, bob: 0.030, bobBeats: 1, sway: 0.004, swayBeat: 0.0022, pitch: -3.4,
    scapula: 24, spineFlex: 15.0, yawSway: 0.5,
    flight: 1.0, impact: 0.0190,
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
    this.gBob = 0;
    this.gSway = 0;
    this.gSwayBeat = 0;
    this.gFlight = 0;
    this.gImpact = 0;

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
    this.bobS = { v: 0 };
    this.sway = 0;
    this.swayS = { v: 0 };
    /**
     * Ground reaction. Every footfall drives a velocity impulse into this
     * spring: the trunk compresses onto the loaded limb and rebounds. It is
     * the difference between a body that is *carried* over the legs and one
     * that is *thrown* between them, and nothing in the rig expressed it
     * before — `f.impact` existed but only ever reached the snow-press depth.
     */
    this.impactY = 0;
    this.impactYs = { v: 0 };
    this.impactRoll = 0;
    this.impactRollS = { v: 0 };
    /** Ballistic suspension lift (metres). Zero except mid-flight. */
    this.flight = 0;
    this.flightAmp = 0;
    this.inFlight = false;
    this.flightU = 0;
    /** Post-halt settle: a short fore/aft weight rock as the animal arrives. */
    this.settleT = -1;
    this.settle = 0;
    this.settlePitch = 0;
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
      this.gBob = g.bob ?? 0;
      this.gSway = g.sway ?? 0;
      this.gSwayBeat = g.swayBeat ?? 0;
      this.gFlight = g.flight ?? 0;
      this.gImpact = g.impact ?? 0;
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
    this.gBob = damp(this.gBob, g.bob ?? 0, r, h);
    this.gSway = damp(this.gSway, g.sway ?? 0, r, h);
    this.gSwayBeat = damp(this.gSwayBeat, g.swayBeat ?? 0, r, h);
    this.gFlight = damp(this.gFlight, g.flight ?? 0, r, h);
    this.gImpact = damp(this.gImpact, g.impact ?? 0, r, h);
    for (const f of this.feet) {
      f.offset = f.offset + wrapPi((f.offsetTarget - f.offset) * TAU) / TAU * (1 - Math.exp(-r * h));
      f.offset = f.offset - Math.floor(f.offset);
    }

    // --- speed / heading --------------------------------------------------
    // Asymmetric: an animal accelerates against its own inertia and stops
    // against the ground, which is far more authoritative. A single rate made
    // the halt a long coast with nothing to look at.
    const prevSpeed = this.speed;
    const accelRate = this.speedTarget > this.speed ? 2.6 : 5.2;
    this.speed = damp(this.speed, this.speedTarget, accelRate, h);
    if (this.speed < 1e-4) this.speed = 0;
    // Arrival: fire the settle exactly once, as the last stride is spent.
    if (prevSpeed > 0.10 && this.speed <= 0.10 && this.speedTarget < 1e-4) {
      this.settleT = 0;
      this.settleAmp = clamp(prevSpeed * 0.55, 0.15, 1);
    }
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
    // MEASURED DEFECT (nothing in audit.mjs samples a transition, so this had
    // never been seen): freezing on `speedTarget` alone stopped the feet
    // stepping 0.34 s after the halt command while the body coasted on until
    // 1.63 s. For 1.3 s the animal slid forward with all four paws pinned —
    // 146 mm of skid — and the reach backstop SATURATED at its 80 mm cap
    // trying to keep the legs attached, flattening the fox into a squat.
    // Keep the clock running until the animal has genuinely arrived.
    const wantMove = this.speedTarget > 1e-4 || this.speed > 0.022;
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
        // Kick the trunk spring. Front feet take more of the landing than
        // hinds, and the roll goes toward whichever side caught the weight.
        const kick = this.gImpact * (0.45 + 0.55 * saturate(this.speed / 1.8))
          * (f.limb.front ? 1.0 : 0.72);
        this._impulseY = (this._impulseY || 0) + kick * 70;
        this._impulseR = (this._impulseR || 0) + Math.sign(f.bodyX) * kick * 9;
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
        f.contactGround = damp(f.contactGround, gy, 16, h);
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
    this._flightWindow(h);
    // The paws go up with the body. Without this the trunk rises off a set of
    // targets pinned to the snow, the hip→ankle distance grows by the whole
    // arc, and the reach backstop immediately cancels the suspension it was
    // asked to produce. `flight` is zero at both ends of the window, so the
    // commanded touchdown profile is untouched.
    if (this.flight > 1e-5) for (const f of this.feet) if (!f.stance) f.target.y += this.flight;

    this._pressSnow(ctx);
    this._bodyMotion(h, ctx);
  }

  // ------------------------------------------------------------ suspension --

  /**
   * Ballistic suspension. While nothing is on the ground the centre of mass
   * has no choice about its trajectory, so this is derived, not authored:
   * measure the length of the zero-support window in seconds and use the only
   * arc that fits it, h = g·T²/8.
   *
   * That is deliberately a small number — 78 ms of flight is 7.5 mm of rise,
   * and an authored 50 mm "suspension" would be a 3.5 g parabola, i.e. a
   * twitch. The visible drama of a gallop is not the parabola; it is the
   * spine gathering and extending around it and the limbs cycling under a
   * body that is, briefly, unsupported. This term's job is to put the peak of
   * the centre of mass at the right INSTANT, and to be honest about its size.
   *
   * The window end is found analytically from the touchdown offsets rather
   * than by integrating, so `flight` is exactly zero at both ends: a foot
   * never lands against a body that is still rising.
   */
  _flightWindow(h) {
    const G = 9.81;
    const flying = this.airborne >= 0.999 && !this.frozen && this.gFlight > 1e-3;
    if (flying && !this.inFlight) {
      // Phase distance to the next touchdown, over all four limbs.
      let span = 1;
      for (const f of this.feet) {
        let d = f.offset - this.phase;
        d -= Math.floor(d);
        if (d > 1e-5 && d < span) span = d;
      }
      const T = span * Math.max(0.05, this.cycle);
      this.flightSpan = Math.max(1e-3, span);
      this.flightFrom = this.phase;
      this.flightAmp = Math.min(0.045, G * T * T / 8) * this.gFlight;
      this.inFlight = true;
    } else if (!flying) {
      this.inFlight = false;
      this.flightAmp = 0;
    }

    if (this.inFlight) {
      let d = this.phase - this.flightFrom;
      d -= Math.floor(d);
      this.flightU = clamp(d / this.flightSpan, 0, 1);
      this.flight = this.flightAmp * Math.sin(Math.PI * this.flightU);
    } else {
      // Never snap: a gait blend can drop out of flight mid-arc.
      this.flight = damp(this.flight, 0, 26, h);
      this.flightU = 0;
    }
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
   * Peak-to-peak range of the support signal over one cycle, for the live
   * duty and touchdown offsets. Sampled rather than derived so it stays right
   * mid-blend between two gaits, when the duty is a real number and the
   * offsets are all in motion.
   */
  _supportRange() {
    const d = this.frozen ? 1 : this.duty;
    let lo = 1, hi = 0;
    for (let i = 0; i < 48; i++) {
      const p = i / 48;
      let n = 0;
      for (const f of this.feet) {
        let x = p - f.offset;
        x -= Math.floor(x);
        if (x < d) n++;
      }
      const sup = n / this.feet.length;
      if (sup < lo) lo = sup;
      if (sup > hi) hi = sup;
    }
    return { mid: (lo + hi) * 0.5, half: Math.max(0.06, (hi - lo) * 0.5) };
  }

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

    // MEASURED: at a fixed rate of 9 (τ = 111 ms) a fox at 2.6 m/s carries its
    // body 290 mm of travel behind the ground it is standing on, which over
    // sastrugi is 28 mm of height error — the animal floats over a bump and
    // sinks into it a beat late. That is a literal, visible lag and it is
    // separate from the spring tuning. Scale the follow with speed: the
    // damper is only there to stop the body STEPPING when a foot plants on a
    // new height, and the faster the animal moves the less time it has to
    // spend not noticing the terrain.
    this.groundY = damp(this.groundY, (frontY + rearY) * 0.5, 9 + this.speed * 6.5, h);
    this.pos.y = this.groundY;

    // --- vertical bounce and lateral weight transfer ----------------------
    // Driven by how much of the animal is actually being held up, not by a
    // blind harmonic. A hand-phased sine put the withers at their HIGHEST
    // while a forefoot was planted, which on a 168 mm front limb pushed the
    // target out of reach and made the reach backstop yank the whole body
    // down 33 mm every stride. Support-driven, it is in phase by
    // construction, for every gait, including mid-blend between two.
    //
    // TWO MEASURED BUGS LIVED HERE, and between them they are most of why the
    // animal read as bulky rather than bouncy.
    //
    // 1. The raw support signal was normalised by `meanSupport`, which is not
    //    its range — so the delivered amplitude was an arbitrary fraction of
    //    the authored one (0.39× at a walk). `_supportRange` measures the
    //    actual swing of the signal for the live duty and offsets, so `g.bob`
    //    now means peak-to-peak millimetres and nothing else.
    // 2. `damp(..., 14, h)` is a first-order lag with τ = 71 ms sitting on a
    //    signal whose period is 200 ms at a trot. Measured attenuation was
    //    0.458 / 0.471 / 0.412 at walk / trot / run: over half the commanded
    //    bounce was being thrown away by the smoother, and what survived
    //    arrived ~40 ms late. That is the mechanism behind BOTH complaints at
    //    once — "not bouncy" is the lost amplitude and "noticeable lag" is
    //    the phase. A second-order spring at ω = 108 tracks a 5 Hz drive at
    //    ~0.95 with ~16 ms of lag, and its slight overshoot is the thing that
    //    reads as springy in the first place.
    const support = 1 - this.airborne;
    const sr = this._supportRange();
    const bobNorm = (support - sr.mid) / sr.half;
    // Walks VAULT (the centre of mass rises over a planted limb); trots and
    // gallops BOUNCE (it falls into stance and is thrown out of it). The old
    // code applied the bouncing sign to all three.
    const bobT = clamp((g.vault ? 1 : -1) * this.gBob * 0.5 * bobNorm * moving, -0.06, 0.06);
    this.bobCmd = bobT;                  // published so a probe can measure the spring's loss
    this.bob = clamp(spring(this.bob, bobT, this.bobS, 108, 0.86, h), -0.075, 0.075);

    // --- ground reaction --------------------------------------------------
    // Each footfall kicks the trunk spring. This is the only place in the rig
    // where a contact event does anything to the BODY; before it, `f.impact`
    // fed the snow-press depth and stopped there, so the animal absorbed
    // every landing perfectly and therefore looked weightless AND inert.
    const IMP_W = 44, IMP_Z = 0.52;
    if (this._impulseY) { this.impactYs.v -= this._impulseY; this._impulseY = 0; }
    if (this._impulseR) { this.impactRollS.v += this._impulseR; this._impulseR = 0; }
    this.impactY = clamp(spring(this.impactY, 0, this.impactYs, IMP_W, IMP_Z, h), -0.040, 0.016);
    this.impactRoll = clamp(spring(this.impactRoll, 0, this.impactRollS, 30, 0.58, h), -0.09, 0.09);

    // --- arrival settle ---------------------------------------------------
    // §8: a real animal does not simply stop — the mass it was carrying
    // forward has to be put down. One damped fore/aft rock, ~0.7 s.
    if (this.settleT >= 0) {
      this.settleT += h;
      const k = Math.exp(-5.4 * this.settleT) * (this.settleAmp ?? 0.5);
      this.settle = k * Math.sin(TAU * 2.1 * this.settleT);
      this.settlePitch = k * 0.055 * Math.cos(TAU * 2.1 * this.settleT - 0.5);
      if (this.settleT > 1.1) { this.settleT = -1; this.settle = 0; this.settlePitch = 0; }
    }

    // Sway toward the supported side: positive bodyX-weighted load. In a
    // SYMMETRIC gait the two sides cancel identically — measured sway at a
    // trot was 0.00 mm — so the load split carries the asymmetric part and a
    // stride-rate harmonic carries the symmetric one, exactly as `spineFlex`
    // already does for the sagittal plane.
    let swayT = 0;
    for (const f of this.feet) swayT += f.load * Math.sign(f.bodyX);
    swayT = swayT * this.gSway + Math.sin(TAU * this.phase) * this.gSwayBeat * moving;
    this.sway = spring(this.sway, swayT, this.swayS, 74, 0.90, h);

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

    // Whole-body attitude: terrain + a per-gait lean, plus the arrival rock.
    const pitchT = -terrainPitch * 0.8 + (g.pitch * Math.PI / 180) * moving
      - clamp(this.speed - this.speedTarget, -0.6, 0.6) * 0.06;
    this.bodyPitch = damp(this.bodyPitch, pitchT, 14, h) + this.settlePitch;
    // Bank into turns like an animal, not a vehicle: inside shoulder down.
    const rollT = terrainRoll * 0.85 + clamp(this.yawRate, -2.5, 2.5) * 0.085 * moving;
    this.bodyRoll = damp(this.bodyRoll, rollT, 14, h) + this.impactRoll;

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
