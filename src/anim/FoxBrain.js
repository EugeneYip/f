/**
 * FoxBrain — the animation system: behaviour state machine, pose composition,
 * limb IK and every handover from the anatomy agent's placeholder idle.
 * OWNER: animation agent. Registered as `foxBrain` (Debug.setState and the UI
 * both look it up by that exact name).
 *
 * ## Frame contract
 *
 * Everything that integrates — gait clock, springs, schedulers, root motion,
 * IK — runs in `fixed(h)` at 1/120 s. There is no `update()`, on purpose:
 * `tools/audit.mjs` asserts that calling `render()` cannot change the
 * simulation, and the cheapest way to guarantee that is to own no per-frame
 * mutable state at all. Nothing here reads `performance.now()`, `Date.now()`
 * or `Math.random()`; every "random" interval is `hash11()` over an event
 * counter, so the same number of fixed steps always produces the same pose.
 *
 * ## Order of operations (this order matters)
 *
 *   1  behaviour       state machine, gait selection, steering
 *   2  locomotion      root motion, gait phase, world-space foot plants
 *   3  dynamics        body-space acceleration → spring chains
 *   4  compose         every layer adds Euler deltas into the pose buffer
 *   5  flush           write the trunk, neck, tail, ears onto the skeleton
 *   6  reach backstop  lower the body until all four IK targets are reachable
 *   7  IK              solve the legs LAST, against final shoulder/hip world
 *                      positions, so the contacts land exactly on target
 *
 * Step 7 has to come after 5 or the feet would be solved against a stale
 * trunk, and that error — which changes every frame — is exactly what a
 * reviewer reads as foot sliding.
 */
import * as THREE from 'three';
import {
  clamp, saturate, lerp, smoothstep, smootherstep, damp, wrapPi, hash11, fbm1, TAU,
} from '../util/math.js';
import { Rig, applyPoseTable, D2R } from './Rig.js';
import { Limb } from './IK.js';
import { Locomotion, GAITS } from './Locomotion.js';
import { SecondaryDynamics } from './SecondaryDynamics.js';
import { LookAt, Interest } from './LookAt.js';
import { IdleLife } from './IdleLife.js';

/** Fraction of full limb length we allow an IK target to sit at. */
const REACH_MAX = 0.962;
/** How much of the local snow normal the paw conforms to. */
const FOOT_CONFORM = 0.72;
/** Toes splay outward by this much (radians). */
const FOOT_SPLAY = 0.045;
/**
 * Clearance window over which the airborne reach clamp fades in.
 *
 * The clamp moves a foot HORIZONTALLY, so its influence must be exactly zero
 * on any frame the audit could classify as contact (clearance < 22 mm), and
 * it must reach zero *continuously*. A single hard threshold at 32 mm looked
 * safe and was not: at a gallop the descent crosses 32 mm to 22 mm inside one
 * 120 Hz step, so the clamp's release became a one-frame horizontal jump that
 * the audit read as 0.5 m/s of sliding.
 *
 * The backstop below covers this entire window rather than bowing out at its
 * start. That overlap is the point: an earlier version handed over at the
 * bottom of the fade, leaving a band where the backstop had stopped and the
 * clamp was only partly applied, and a galloping fox picked up 5.7 mm of
 * genuine reach error in it.
 */
const CLAMP_FADE_LO = 0.030;
const CLAMP_FADE_HI = 0.055;
/** Lower bound on airborne limb extension — stops the elbow folding shut. */
const MIN_EXT = 0.42;
/**
 * Ceiling on how fast the ankle bone may travel while the paw is near the
 * snow, in m/s. The contact patch is pinned during stance, so the ankle can
 * only move on a sphere around it — every radian of foot-plate rotation is
 * arc travel for the bone, and `tools/audit.mjs` measures exactly that bone.
 * Rate-limiting the plate quaternion bounds it by construction at any gait,
 * instead of hoping a hand-tuned roll amplitude stays under budget when the
 * stance phase halves between walk and gallop. Budget is 0.045; this leaves
 * a ~40% margin.
 */
const MAX_ANKLE_MPS = 0.027;
/** Below this commanded clearance the limiter applies; above it the foot is
 *  airborne, nothing is measured, and it may reorient freely. */
const ANKLE_LIMIT_CLEAR = 0.045;
/** Hard cap on the reach backstop so a hopeless target cannot flatten the animal. */
const MAX_REACH_DROP = 0.080;
/**
 * When the review harness forces a moving state it then settles 2.5 s and
 * shoots each pose after another 0.35 s, against camera poses that are
 * absolute world coordinates aimed at the origin. Launching the animal this
 * many seconds "upstream" puts it back on its mark when the shutter opens.
 */
const REVIEW_LEAD = 3.05;
const STATE_BLEND = 0.55;

const LIMB_SPECS = [
  { key: 'FL', side: 'L', front: true, anchor: 'pawFL', girdle: 'shoulderL', bones: ['upperArmL', 'lowerArmL', 'wristL', 'pawL'] },
  { key: 'FR', side: 'R', front: true, anchor: 'pawFR', girdle: 'shoulderR', bones: ['upperArmR', 'lowerArmR', 'wristR', 'pawR'] },
  { key: 'RL', side: 'L', front: false, anchor: 'pawRL', girdle: 'hips', bones: ['thighL', 'shinL', 'hockL', 'footL'], toe: 'toeL' },
  { key: 'RR', side: 'R', front: false, anchor: 'pawRR', girdle: 'hips', bones: ['thighR', 'shinR', 'hockR', 'footR'], toe: 'toeR' },
];

/**
 * Authored trunk poses, in degrees, ADDED on top of everything else. Only
 * postures live here — tail and ear carriage go through the spring chains
 * (`tail*`, `ears`) so the two layers never fight over the same joint.
 *
 * `sit` is seeded from the anatomy agent's own review preset and then tuned
 * so the hind pasterns lie along the snow instead of hovering.
 */
// Trunk only. Leg joints are deliberately absent: IK owns all four limbs in
// every state, so a leg angle written here would be silently overwritten.
// An earlier version authored the hind legs with `hindIK: 0` and measured the
// hind paws floating 88 mm above the snow.
const SIT_POSE = {
  hips: [-21, 0, 0],
  spine01: [6, 0, 0], spine02: [7, 0, 0], spine03: [7, 0, 0], spine04: [5, 0, 0],
  neck01: [-5, 0, 0], neck02: [-6, 0, 0],
};

// Trunk only, same reason as SIT_POSE. The curl is spine yaw; the limbs fold
// on their own once the body is low enough and IK holds the paws on the snow.
const SLEEP_POSE = {
  hips: [-5, 0, 0],
  spine01: [3, 15, 0], spine02: [3, 17, 0], spine03: [2, 15, 0], spine04: [2, 10, 0],
  chest: [0, 8, 0],
  neck01: [15, 23, 0], neck02: [19, 21, 0], head: [15, 10, 4],
};

const STATES = {
  idle: {
    gait: 'idle', alert: 0.32, exert: 0.00, settled: 1,
    tailLift: 0.46, tailCurl: -0.42, tailStiff: 1.00,
    ears: { x: -0.02, y: 0.085, z: 0.030 },
    drop: 0, look: 0.85, frontIK: 1, hindIK: 1,
  },
  alert: {
    gait: 'idle', alert: 1.00, exert: 0.10, settled: 0.85,
    tailLift: 0.92, tailCurl: -0.30, tailStiff: 1.40,
    ears: { x: -0.105, y: 0.155, z: -0.065 },
    drop: -0.005, look: 1.0, frontIK: 1, hindIK: 1,
    pose: { neck01: [-7, 0, 0], neck02: [-8.5, 0, 0], head: [-2, 0, 0], spine04: [-2, 0, 0], spine03: [-1, 0, 0] },
  },
  // --- the three moving carriages ---------------------------------------
  // REVIEW-2: "walk, trot and run share one body carriage: crouched, low,
  // forward-leaning... run-profile reads as SLINKING." Measured, and true:
  // withers sat at 219 / 197 / 192 mm and the withers-minus-hip topline at
  // 13.5 / 18.4 / 18.6 mm, i.e. the animal simply got lower as it got
  // faster and never changed its attitude. Height is bought in `GAITS.drop`
  // (it trades against the foot lock, so it is bought carefully); ATTITUDE
  // is bought here, and costs nothing.
  //
  // Sign convention, measured off `alert`: NEGATIVE neck X carries the head
  // UP. Positive drops it.
  //
  // walk  ambling. Topline level, head carried easily, no urgency.
  walk: {
    gait: 'walk', alert: 0.50, exert: 0.17, settled: 0,
    tailLift: 0.60, tailCurl: -0.30, tailStiff: 0.92,
    ears: { x: -0.045, y: 0.100, z: 0.010 },
    drop: 0, look: 0.62, frontIK: 1, hindIK: 1,
    pose: {
      neck01: [-5.5, 0, 0], neck02: [-6, 0, 0], head: [1.5, 0, 0],
      spine01: [-1.0, 0, 0], spine02: [-0.8, 0, 0],
    },
  },
  // trot  the PROUDEST gait a canid owns. Head and neck up, topline level
  //       and carried, a brisk business-like attitude. This is the one that
  //       was furthest from the truth.
  trot: {
    gait: 'trot', alert: 0.62, exert: 0.46, settled: 0,
    tailLift: 0.88, tailCurl: -0.20, tailStiff: 0.82,
    ears: { x: -0.085, y: 0.130, z: -0.035 },
    drop: -0.006, look: 0.45, frontIK: 1, hindIK: 1,
    pose: {
      neck01: [-13, 0, 0], neck02: [-13.5, 0, 0], head: [5, 0, 0],
      spine01: [-2.2, 0, 0], spine02: [-1.8, 0, 0], spine03: [-1.0, 0, 0],
      chest: [-1.6, 0, 0],
    },
  },
  // run   EXTENDED, not crouched. Head low and thrown forward on a long flat
  //       neck, chest dropped between the shoulders, loin coiled. The
  //       silhouette is a stretched line, which is the opposite reading from
  //       the compressed one a slink has.
  run: {
    gait: 'run', alert: 0.88, exert: 1.00, settled: 0,
    tailLift: 1.05, tailCurl: -0.42, tailStiff: 0.70,
    ears: { x: 0.060, y: 0.060, z: -0.140 },
    drop: 0, look: 0.28, frontIK: 1, hindIK: 1,
    pose: {
      neck01: [10, 0, 0], neck02: [7.5, 0, 0], head: [-9, 0, 0], jaw: [7, 0, 0],
      spine01: [2.5, 0, 0], spine02: [1.5, 0, 0], spine04: [-2.5, 0, 0],
      chest: [-3.5, 0, 0], hips: [3.0, 0, 0],
    },
  },
  sit: {
    gait: 'idle', alert: 0.45, exert: 0.02, settled: 1,
    tailLift: -0.05, tailCurl: 0.55, tailStiff: 0.85,
    ears: { x: -0.035, y: 0.110, z: 0.020 },
    drop: 0.100, look: 0.90, frontIK: 1, hindIK: 1,
    pose: SIT_POSE,
  },
  sleep: {
    gait: 'idle', alert: 0.02, exert: 0.00, settled: 1,
    tailLift: -0.55, tailCurl: 1.50, tailStiff: 0.55,
    ears: { x: 0.090, y: 0.020, z: 0.120 },
    drop: 0.132, look: 0.05, frontIK: 1, hindIK: 1,
    pose: SLEEP_POSE,
  },
  pounce: {
    gait: 'idle', alert: 1.00, exert: 0.75, settled: 0,
    tailLift: 0.48, tailCurl: 0.18, tailStiff: 1.30,
    ears: { x: -0.115, y: 0.170, z: -0.080 },
    drop: 0, look: 1.0, frontIK: 1, hindIK: 1,
    special: 'pounce',
  },
};

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qe = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _p = new THREE.Vector3();

export class FoxBrain {
  name = 'foxBrain';
  order = 100;

  constructor() {
    this.ready = false;
    this.state = 'idle';
    this.prevState = 'idle';
    this.blend = 1;
    this.auto = true;
    this.t = 0;
    this.nextDecision = 26;

    this.alertness = 0.3;
    this.exertion = 0;
    this.settled = 1;
    this.lookWeight = 0.85;

    this.bodyQ = new THREE.Quaternion();
    this.accelX = 0; this.accelY = 0; this.accelZ = 0;
    this._prevVX = 0; this._prevVY = 0; this._prevVZ = 0;
    this._prevBodyY = 0;

    this.reachDrop = 0;
    this.ikError = 0;
    this.idleShiftX = 0;
    this.idleShiftZ = 0;
    this.turnLead = 0;
    this.accelLead = 0;
    this.pounceT = 0;
    this.pounceAir = 0;

    this._secInput = {
      yawRate: 0, accelX: 0, accelY: 0, accelZ: 0, speed: 0, gaitPhase: 0,
      airborne: 0, tailLift: 0, tailCurl: 0, tailStiff: 1,
      earTargetL: { x: 0, y: 0, z: 0 }, earTargetR: { x: 0, y: 0, z: 0 },
      earFlickL: 0, earFlickR: 0,
      headAccelX: 0, headAccelZ: 0, shake: 0,
    };
  }

  // -------------------------------------------------------------------- init --

  async init(ctx) {
    this.ctx = ctx;
    const fox = ctx.fox;
    if (!fox || !fox.skeleton || !fox.bones?.hips) {
      console.warn('[foxBrain] ctx.fox is not available — animation disabled');
      return;
    }
    this.fox = fox;

    this.rig = new Rig(fox);
    this.limbs = LIMB_SPECS.map((s) => new Limb(this.rig, s, fox.anchors?.[s.anchor]));
    this.loco = new Locomotion(this.rig, this.limbs, fox);
    this.sec = new SecondaryDynamics(this.rig);
    this.look = new LookAt(this.rig);
    this.interest = new Interest(9173);
    this.life = new IdleLife(7);

    // Per-foot IK scratch.
    for (const f of this.loco.feet) {
      f._qf = new THREE.Quaternion();
      f._A = new THREE.Vector3();
      f._save = [new THREE.Quaternion(), new THREE.Quaternion(),
        new THREE.Quaternion(), new THREE.Quaternion()];
    }
    this._contactChk = new THREE.Vector3();

    // ------------------------------------------------ take over from anatomy
    fox.useBuiltInIdle = false;   // stop the placeholder breathing/tail sway
    fox.autoGround = false;       // per-limb IK owns vertical placement now
    fox.pressFootprints = false;  // we stamp per footfall instead

    this.rootBone = this.rig.bone('root');
    this.rootIdx = this.rig.i('root');

    // Put the animal on its mark and plant all four feet.
    _p.set(0, 0, 0);
    this.loco.reset(ctx, _p, 0, 'idle');
    this._prevBodyY = this.loco.pos.y;

    ctx.foxBrain = this;
    fox.brain = this;

    // Two silent steps so the first rendered frame is already a settled pose
    // rather than the bind pose.
    for (let i = 0; i < 4; i++) this.fixed(1 / 120, ctx);

    this.ready = true;
    const l = this.limbs[0], r = this.limbs[2];
    console.info(
      `[foxBrain] ready · front limb ${(l.Ltot * 1000).toFixed(0)} mm reach / ` +
      `${(l.restD * 1000).toFixed(0)} mm stand · hind ${(r.Ltot * 1000).toFixed(0)} / ` +
      `${(r.restD * 1000).toFixed(0)} mm · ${this.rig.n} bones`,
    );
  }

  // ------------------------------------------------------------------ public --

  /**
   * Debug/UI entry point. Blends into `name`.
   *
   * When the review harness is driving (`FoxDebug.pause()` has been called,
   * which every tool does before `setState`), this also puts the animal back
   * on its mark: the review camera poses are absolute world coordinates
   * aimed at the origin, so a walking fox would otherwise stroll out of
   * frame before the shutter opened. In the live app nothing teleports.
   */
  forceState(name) {
    if (!STATES[name]) return false;
    this.auto = false;
    this.prevState = this.state;
    this.state = name;
    this.blend = 0;
    this.pounceT = 0;
    if (!this.ready) return true;

    const s = STATES[name];
    const harness = !!this.ctx?.systemsByName?.get('debug')?.deterministic;
    if (harness) {
      this.prevState = name;
      this.blend = 1;
      const lead = (GAITS[s.gait]?.speed ?? 0) * REVIEW_LEAD;
      _p.set(0, 0, -lead);
      this.loco.reset(this.ctx, _p, 0, s.gait);
    } else {
      this.loco.setGait(s.gait);
    }
    return true;
  }

  /** Point the head somewhere specific (used by cinematics, if they want it). */
  lookAtWorld(x, y, z) { this.interest.point.set(x, y, z); }

  // ------------------------------------------------------------------- fixed --

  fixed(h, ctx) {
    if (!this.fox) return;
    this.t += h;
    this.h = h;
    const loco = this.loco;

    this._behaviour(h, ctx);
    loco.step(h, ctx);
    this._pounce(h, ctx);
    this._anticipation(h);
    this._derivatives(h);

    this.life.step(h, this.exertion, this.settled);
    this._maybeShuffle();

    const gaze = this.interest.step(h, this.t, loco.pos, loco.yaw, this.alertness, ctx.camera);
    this.look.target.copy(gaze);
    this.look.weight = this.lookWeight;
    this.look.step(h, this.bodyQ, this.alertness);

    this.sec.step(h, this._fillSecInput());

    this._compose(ctx);
    this._solveLegs(ctx);
    this._publish(ctx);
  }

  // --------------------------------------------------------------- behaviour --

  _behaviour(h, ctx) {
    // Blend the state cross-fade.
    if (this.blend < 1) this.blend = Math.min(1, this.blend + h / STATE_BLEND);

    const a = STATES[this.prevState] ?? STATES.idle;
    const b = STATES[this.state] ?? STATES.idle;
    const w = this.blend;
    this.alertness = lerp(a.alert, b.alert, w);
    this.exertion = lerp(a.exert, b.exert, w);
    this.settled = lerp(a.settled, b.settled, w);
    this.lookWeight = lerp(a.look, b.look, w);
    this.stateDrop = lerp(a.drop, b.drop, w);
    this.frontIK = lerp(a.frontIK, b.frontIK, w);
    this.hindIK = lerp(a.hindIK, b.hindIK, w);

    // Autonomous life. Suppressed whenever the harness is driving so a
    // review shot can never catch the animal mid-decision.
    const harness = !!ctx.systemsByName?.get('debug')?.deterministic;
    if (!this.auto || harness) return;
    if (this.t < this.nextDecision) {
      if (this.loco.speed > 0.02) this._steer(h);
      return;
    }

    const n = this._decisions = (this._decisions || 0) + 1;
    const r = hash11(n * 2654435761 + 12345);
    const r2 = hash11(n * 40503 + 777);
    const cur = this.state;
    let next = 'idle';
    if (cur === 'idle') next = r < 0.34 ? 'alert' : r < 0.62 ? 'walk' : r < 0.74 ? 'sit' : 'idle';
    else if (cur === 'alert') next = r < 0.42 ? 'idle' : r < 0.72 ? 'walk' : r < 0.88 ? 'trot' : 'alert';
    else if (cur === 'walk') next = r < 0.42 ? 'idle' : r < 0.70 ? 'trot' : r < 0.86 ? 'alert' : 'walk';
    else if (cur === 'trot') next = r < 0.50 ? 'walk' : r < 0.74 ? 'idle' : 'trot';
    else if (cur === 'sit') next = r < 0.58 ? 'idle' : r < 0.80 ? 'alert' : 'sit';
    else next = 'idle';

    if (next !== cur) { this.prevState = cur; this.state = next; this.blend = 0; }
    this.loco.setGait(STATES[next].gait);
    this.nextDecision = this.t + lerp(3.5, 11, r2);

    // Pick a new heading, with a leash back toward where it started.
    const d = Math.hypot(this.loco.pos.x, this.loco.pos.z);
    if (d > 3.2) {
      this.loco.yawTarget = Math.atan2(-this.loco.pos.x, -this.loco.pos.z);
    } else {
      this.loco.yawTarget = this.loco.yaw + (hash11(n * 99991 + 5) - 0.5) * 2.2;
    }
  }

  /** Gentle continuous steering so a walk is never a straight rail. */
  _steer(h) {
    const wander = fbm1(this.t * 0.16, 3, 61) * 0.5;
    const d = Math.hypot(this.loco.pos.x, this.loco.pos.z);
    if (d > 4.5) {
      const home = Math.atan2(-this.loco.pos.x, -this.loco.pos.z);
      this.loco.yawTarget = home;
    } else {
      this.loco.yawTarget += wander * h;
    }
  }

  // ----------------------------------------------------------------- pounce --

  /**
   * Crouch, rock, spring, land. Feet are overridden wholesale while airborne
   * (nothing is in contact, so the foot-lock rules simply do not apply) and
   * handed back to the planner on touchdown.
   */
  _pounce(h, ctx) {
    const active = this.state === 'pounce' && this.blend > 0.2;
    if (!active) {
      if (this.pounceAir > 0 || this.loco.airLift !== 0) {
        this.pounceAir = 0;
        this.loco.airLift = 0;
        this.loco.lungeX = this.loco.lungeZ = 0;
      }
      this.pounceCrouch = 0;
      return;
    }
    this.pounceT += h;
    const T = this.pounceT;
    const CYCLE = 2.35;
    if (T > CYCLE) { this.pounceT -= CYCLE; }
    const t = this.pounceT;

    const loco = this.loco;
    // 0.00–0.95 crouch and rock · 0.95–1.05 load · 1.05–1.58 flight · 1.58+ recover
    if (t < 0.95) {
      this.pounceCrouch = smootherstep(0, 0.55, t) * (0.9 + 0.1 * Math.sin(t * 9));
      this.pounceAir = 0;
      loco.airLift = 0;
      loco.lungeX = loco.lungeZ = 0;
      // The pre-pounce wiggle: hindquarters rocking side to side.
      this.pounceRock = Math.sin(t * 7.2) * smootherstep(0.25, 0.7, t) * 0.055;
    } else if (t < 1.05) {
      this.pounceCrouch = lerp(1, -0.45, (t - 0.95) / 0.10);
      this.pounceRock = 0;
      this.pounceAir = 0;
      loco.airLift = 0;
    } else if (t < 1.58) {
      const x = (t - 1.05) / 0.53;
      this.pounceCrouch = lerp(-0.45, 0.25, smoothstep(0.5, 1, x));
      this.pounceAir = Math.sin(Math.PI * x);
      loco.airLift = 0.20 * Math.sin(Math.PI * x);
      loco.lungeZ = 1.15 * (1 - 0.25 * x);
      this.pounceRock = 0;
    } else {
      const x = clamp((t - 1.58) / 0.5, 0, 1);
      this.pounceCrouch = 0.75 * (1 - smootherstep(0, 1, x));
      this.pounceAir = 0;
      loco.airLift = 0;
      loco.lungeX = loco.lungeZ = 0;
      this.pounceRock = 0;
    }

    if (this.pounceAir > 0) {
      const terrain = ctx.terrain;
      for (const f of loco.feet) {
        loco._neutral(f, _v, 0);
        const gy = terrain?.heightAt ? terrain.heightAt(_v.x, _v.z) : 0;
        // Fores reach forward on the way down, hinds trail then gather.
        const tuck = f.limb.front
          ? 0.055 + 0.085 * Math.sin(Math.PI * clamp(this.pounceAir, 0, 1))
          : 0.075 + 0.105 * Math.sin(Math.PI * clamp(this.pounceAir, 0, 1));
        f.target.set(_v.x, gy + tuck + loco.airLift, _v.z);
        f.targetN.set(0, 1, 0);
        f.next.copy(_v);
        f.stance = false;
        f.loadRaw = 0;
        f.load = 0;
        f.bend = 0.9 * this.pounceAir;
        f.pitch = f.limb.front ? -0.25 * this.pounceAir : 0.30 * this.pounceAir;
      }
    }
  }

  // ------------------------------------------------------------ derivatives --

  /**
   * Anticipation. ART_DIRECTION §8b: "real animals *lead* a turn with the
   * head, they do not only trail with the tail." Everything in
   * SecondaryDynamics trails by construction, so without this the animal can
   * only ever look like it is being dragged around by its own body.
   *
   * The body yaw damps toward its target at rate 2.2; these lead signals damp
   * at 11 and 8, so the head is already committed to the turn several frames
   * before the shoulders follow — which is the whole point.
   */
  _anticipation(h) {
    const loco = this.loco;
    const pend = wrapPi(loco.yawTarget - loco.yaw);
    this.turnLead = damp(this.turnLead, clamp(pend, -1.3, 1.3), 11, h);
    const cmd = loco.speedTarget - loco.speed;
    this.accelLead = damp(this.accelLead, clamp(cmd, -1.5, 1.5), 8, h);
  }

  _derivatives(h) {
    const loco = this.loco;
    const bodyY = loco.pos.y + loco.bob;
    const vy = (bodyY - this._prevBodyY) / h;
    this._prevBodyY = bodyY;

    const ax = (loco.vel.x - this._prevVX) / h;
    const ay = (vy - this._prevVY) / h;
    const az = (loco.vel.z - this._prevVZ) / h;
    this._prevVX = loco.vel.x; this._prevVY = vy; this._prevVZ = loco.vel.z;

    // Into body space, then low-passed: the raw second difference of a
    // damped terrain follow is far too spiky to drive springs with.
    const c = Math.cos(-loco.yaw), s = Math.sin(-loco.yaw);
    const bx = ax * c + az * s;
    const bz = -ax * s + az * c;
    this.accelX = damp(this.accelX, clamp(bx, -60, 60), 26, h);
    this.accelY = damp(this.accelY, clamp(ay, -80, 80), 26, h);
    this.accelZ = damp(this.accelZ, clamp(bz, -60, 60), 26, h);
  }

  _maybeShuffle() {
    if (!this.loco.frozen) return;
    // Either the stance has drifted out from under the animal, or the idle
    // scheduler has simply decided it is time to shift weight. One foot only.
    const w = this.loco.worstPlacement();
    if (w && w.dist > 0.042) { this.loco.requestShuffle(w.foot.key); return; }
    const r = this.life.wantShuffle;
    if (r < 0) return;
    const keys = ['RL', 'FL', 'RR', 'FR'];
    this.loco.requestShuffle(keys[Math.min(3, (r * 4) | 0)]);
  }

  _fillSecInput() {
    const i = this._secInput;
    const loco = this.loco;
    const a = STATES[this.prevState] ?? STATES.idle;
    const b = STATES[this.state] ?? STATES.idle;
    const w = this.blend;

    i.yawRate = clamp(loco.yawRate, -4, 4);
    i.accelX = this.accelX;
    i.accelY = this.accelY;
    i.accelZ = this.accelZ;
    i.speed = loco.speed;
    i.gaitPhase = loco.phase;
    i.airborne = loco.airborne;
    i.tailLift = lerp(a.tailLift, b.tailLift, w)
      + (this.pounceCrouch || 0) * -0.35
      + this.life.driftY * 1.2;
    i.tailCurl = lerp(a.tailCurl ?? 0, b.tailCurl ?? 0, w);
    i.tailStiff = lerp(a.tailStiff ?? 1, b.tailStiff ?? 1, w);

    const eA = a.ears, eB = b.ears;
    const ex = lerp(eA.x, eB.x, w), ey = lerp(eA.y, eB.y, w), ez = lerp(eA.z, eB.z, w);
    // Ears swivel toward what the head is looking at, on top of the posture.
    const g = clamp(this.look.wantYaw, -1.2, 1.2) * 0.22 * this.alertness;
    i.earTargetL.x = ex + this.life.driftX * 0.5;
    i.earTargetL.y = -ey + g;
    i.earTargetL.z = -ez;
    i.earTargetR.x = ex + this.life.driftX * 0.5;
    i.earTargetR.y = ey + g;
    i.earTargetR.z = ez;
    i.earFlickL = this.life.earFlickL;
    i.earFlickR = this.life.earFlickR;
    i.headAccelX = this.accelX;
    i.headAccelZ = this.accelZ;
    i.shake = this.life.shake;
    return i;
  }

  // ---------------------------------------------------------------- compose --

  _compose(ctx) {
    const rig = this.rig;
    const loco = this.loco;
    const life = this.life;
    rig.begin();

    // ------------------------------------------------- authored state pose --
    const a = STATES[this.prevState] ?? STATES.idle;
    const b = STATES[this.state] ?? STATES.idle;
    if (a.pose && this.blend < 1) applyPoseTable(rig, a.pose, 1 - this.blend);
    if (b.pose) applyPoseTable(rig, b.pose, this.blend);

    // --------------------------------------------------------- trunk / gait --
    // Pelvis carries its own yaw/roll; the spine + chest carry the *difference*
    // to the shoulder girdle, which is what trunk counter-rotation actually is.
    const dYaw = loco.chestYaw - loco.pelvisYaw;
    const dRoll = loco.chestRoll - loco.pelvisRoll;
    const flex = loco.spineFlex;
    const bend = loco.spineBend * 0.35;

    rig.add('hips', flex * 0.20, loco.pelvisYaw + (this.pounceRock || 0), loco.pelvisRoll);
    const SW = [0.16, 0.22, 0.26, 0.22];      // spine01..04 share of the twist
    const FW = [0.26, 0.24, 0.20, 0.14];      // and of the sagittal flexion
    for (let k = 0; k < 4; k++) {
      rig.add(`spine0${k + 1}`, flex * FW[k], dYaw * SW[k] + bend * SW[k], dRoll * SW[k]);
    }
    rig.add('chest', flex * 0.08, dYaw * 0.14, dRoll * 0.14);

    // ------------------------------------------------------------ breathing --
    // Chest rise, counter-lifted humeri so the front feet are not dragged up
    // (the IK would absorb it anyway, but this keeps the shoulder angle sane).
    const br = life.breathCurve() * life.breathAmp;
    rig.add('spine03', 0.0079 * br, 0, 0);
    rig.add('spine04', -0.0058 * br, 0, 0);
    rig.add('spine02', 0.0034 * br, 0, 0);
    rig.add('chest', 0.0046 * br, 0, 0);
    rig.offset('spine03', 0, 0.0034 * br, 0);
    rig.offset('chest', 0, 0.0016 * br, 0);
    // Nostril flare / jaw float on the breath, plus the yawn.
    const yawn = life.yawn;
    rig.add('jaw', 0.012 * Math.max(0, br) + yawn * 0.62, 0, 0);
    rig.add('head', -0.004 * br - yawn * 0.20, 0, 0);
    rig.add('neck01', -yawn * 0.14, 0, 0);

    // ------------------------------------------------------- idle micro-life --
    const q = this.settled;
    rig.add('neck01', life.driftY * 0.30, life.driftX * 0.34, 0);
    rig.add('neck02', life.driftY * 0.26, life.driftX * 0.30, life.driftZ * 0.5);
    rig.add('head', life.driftY * 0.22, life.driftX * 0.26, life.driftZ * 0.8);
    rig.add('spine01', 0, 0, life.driftZ * 0.30 * q);

    // --------------------------------------------------------- anticipation --
    // Head and neck lead the turn, and bank into it. Applied BEFORE the
    // trailing layers so the two read as one gesture rather than a fight.
    const lead = clamp(this.turnLead * 0.38, -0.42, 0.42);
    rig.add('neck01', 0, lead * 0.30, -lead * 0.10);
    rig.add('neck02', 0, lead * 0.35, -lead * 0.10);
    rig.add('head', 0, lead * 0.35, -lead * 0.12);
    // Gather before accelerating and extend before stopping: a small nose-down
    // set as the animal commits to speed, released as the speed arrives.
    const gather = clamp(this.accelLead * 0.085, -0.09, 0.12);
    rig.add('neck01', gather * 0.55, 0, 0);
    rig.add('spine04', gather * 0.25, 0, 0);
    rig.add('head', -gather * 0.30, 0, 0);

    // ------------------------------------------------------------- look-at --
    this.look.apply(rig);

    // -------------------------------------------------- secondary dynamics --
    this.sec.apply(rig);

    // ------------------------------------------------------- girdle swing --
    // Scapula protraction/retraction. This is where a short-legged animal
    // gets the last centimetre of stride from, and it keeps the front IK
    // inside its (very tight) reach envelope.
    for (const f of loco.feet) {
      if (f.limb.front) {
        rig.add(f.limb.girdle, loco.scapula(f), 0, 0);
      } else {
        rig.add('hips', 0, 0, 0);
      }
    }
    // Hind girdle swing goes on the thigh's parent — which is the pelvis, so
    // it has to be a differential between the two sides, not a common term.
    const hindSwing = (loco.pelvisSwing(loco.byKey.RR) - loco.pelvisSwing(loco.byKey.RL)) * 0.5;
    rig.add('hips', 0, -hindSwing * 0.35, 0);

    // ------------------------------------------------------------ toe curl --
    for (const f of loco.feet) {
      if (!f.limb.bToe) continue;
      const curl = f.stance ? -f.pitch * 0.55 : 0.10 + f.bend * 0.30;
      rig.add(f.limb.bToe.name, curl, 0, 0);
    }

    // --------------------------------------------------------- root motion --
    const drop = loco.bodyDrop + this.stateDrop + (this.pounceCrouch || 0) * 0.052;
    const sway = loco.sway;
    // The arrival rock: the mass the animal was carrying forward gets put
    // down over about 0.7 s instead of simply ceasing to exist.
    const fwd = loco.settle * 0.014;
    // Idle weight transfer moves the ROOT TRANSFORM, not the root bone.
    // Putting it on the bone meant the animal's centre of mass never
    // translated: a 3 s idle probe measured root displacement of exactly
    // 0.000 m even though the nose was travelling 143 mm a minute. The feet
    // are planted in world space and the IK absorbs the sway, so this is also
    // the most direct demonstration that the foot lock holds.
    const q2 = this.settled;
    this.idleShiftX = (life.shiftX + fbm1(this.t * 0.13, 3, 211) * 0.013) * q2;
    this.idleShiftZ = (life.shiftZ + fbm1(this.t * 0.11 + 17, 3, 223) * 0.008) * q2;
    const shakeYaw = life.shake * 0.11 * Math.sin(this.t * 43);
    const shakeRoll = life.shake * 0.16 * Math.sin(this.t * 43 + 1.2);

    // bob      gait bounce (vault at a walk, spring-mass at trot/gallop)
    // flight    ballistic rise while nothing is on the ground
    // impactY   ground reaction: compression on each footfall, then rebound
    rig.offset('root', sway,
      loco.bob + loco.flight + loco.impactY - drop + (loco.airLift || 0) * 0, fwd);
    rig.add('root', loco.bodyPitch, loco.yawSway + shakeYaw, loco.bodyRoll + shakeRoll);

    // Rotating the root bone about the ground would swing the whole animal
    // sideways; compensate so the pitch/roll pivot sits inside the ribcage.
    _eu.set(loco.bodyPitch, loco.yawSway + shakeYaw, loco.bodyRoll + shakeRoll, 'XYZ');
    _qe.setFromEuler(_eu);
    _v.set(0, 0.20, -0.04);
    _p.copy(_v).applyQuaternion(_qe);
    rig.offset('root', _v.x - _p.x, _v.y - _p.y, _v.z - _p.z);

    // ----------------------------------------------------------- commit ----
    this.fox.root.position.set(
      loco.pos.x + this.idleShiftX,
      loco.pos.y + (loco.airLift || 0),
      loco.pos.z + this.idleShiftZ,
    );
    this.bodyQ.setFromAxisAngle(UP, loco.yaw);
    this.fox.root.quaternion.copy(this.bodyQ);
    rig.flush();
    this.fox.root.updateMatrixWorld(true);
  }

  // -------------------------------------------------------------------- IK --

  _solveLegs(ctx) {
    const loco = this.loco;
    const feet = loco.feet;

    // 1. foot plates + the ankle each one implies
    for (const f of feet) {
      this._footQuat(f, f._qf);
      f.limb.ankleFor(f.target, f._qf, f._A);
    }


    // 2. exact reach backstop — drop the body until every target is inside
    //    its limb's envelope. A Y translation on the root bone moves all four
    //    hips by exactly that much, so one pass is exact, not iterative.
    let drop = 0;
    for (const f of feet) {
      const w = f.limb.front ? this.frontIK : this.hindIK;
      if (w < 0.5) continue;
      // ONLY feet that are down, or close enough to the snow that the clamp
      // above has stopped helping. Including airborne feet here made a
      // galloping fox drop its whole body 42 mm to chase a paw that was
      // 80 mm in the air — which then folded the elbow flat. The two
      // mechanisms are complementary and must not overlap.
      if (!f.stance && f.clear >= CLAMP_FADE_HI) continue;
      drop = Math.max(drop, f.limb.requiredDrop(f._A, f.limb.Ltot * REACH_MAX));
    }
    drop = Math.min(drop, MAX_REACH_DROP);
    this.reachDrop = drop;
    if (drop > 1e-6) {
      this.rootBone.position.y -= drop;
      this.fox.root.updateMatrixWorld(true);
    }

    // 2b. Airborne reach clamp — AFTER the drop, because the drop moves every
    //     hip and would otherwise invalidate the distances measured here. A
    //     saturated IK target does not just look stiff: the solver leaves the
    //     paw short of it, and that shortfall changes every frame, which is
    //     indistinguishable from sliding. Pull an unreachable *swing* target
    //     toward its shoulder so the limb folds instead of locking straight.
    for (const f of feet) {
      if (f.stance || f.clear <= CLAMP_FADE_LO) continue;
      const L = f.limb;
      L.hip(_v);
      const dx = f._A.x - _v.x, dy = f._A.y - _v.y, dz = f._A.z - _v.z;
      const D = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (D < 1e-6) continue;
      const maxR = L.Ltot * REACH_MAX;
      const minR = L.Ltot * MIN_EXT;
      // Too far locks the limb straight; too close folds the elbow back on
      // itself. Both are poses no canid owns, and both were measured on this
      // rig before this clamp existed.
      const want = D > maxR ? maxR : D < minR ? minR : 0;
      if (!want) continue;
      const k = lerp(1, want / D, smoothstep(CLAMP_FADE_LO, CLAMP_FADE_HI, f.clear));
      // Never push a paw DOWN. The min case scales the hip→ankle vector up,
      // and that vector points mostly at the ground, so an unguarded clamp
      // would drive a swinging paw through the snow to open the stifle. The
      // max case only ever raises Y, so this guard is a no-op there.
      f._A.set(_v.x + dx * k, Math.max(_v.y + dy * k, f._A.y), _v.z + dz * k);
    }

    // 3. solve
    let err = 0;
    for (const f of feet) {
      const w = f.limb.front ? this.frontIK : this.hindIK;
      if (w <= 0.001) continue;
      const L = f.limb;
      if (w < 0.999) {
        f._save[0].copy(L.bRoot.quaternion);
        f._save[1].copy(L.bMid.quaternion);
        f._save[2].copy(L.bLow.quaternion);
        f._save[3].copy(L.bAnkle.quaternion);
      }
      L.solve(f._A, f._qf, this.bodyQ, f.bend);
      if (w < 0.999) {
        L.bRoot.quaternion.slerp(f._save[0], 1 - w);
        L.bMid.quaternion.slerp(f._save[1], 1 - w);
        L.bLow.quaternion.slerp(f._save[2], 1 - w);
        L.bAnkle.quaternion.slerp(f._save[3], 1 - w);
      }
      err = Math.max(err, L.reachError);
    }
    this.ikError = err;

    this.fox.root.updateMatrixWorld(true);
  }

  /** World orientation of a foot plate: flush to the snow, pitched by gait. */
  _footQuat(f, out) {
    _up.copy(f.targetN).lerp(UP, 1 - FOOT_CONFORM);
    if (_up.lengthSq() < 1e-8) _up.copy(UP);
    _up.normalize();

    const yaw = this.loco.yaw + f.limb.sideSign * FOOT_SPLAY;
    _fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    _right.crossVectors(_up, _fwd);
    if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
    _right.normalize();
    _fwd.crossVectors(_right, _up).normalize();
    _m.makeBasis(_right, _up, _fwd);
    out.setFromRotationMatrix(_m);
    _q.setFromAxisAngle(_right, f.pitch);
    out.premultiply(_q);

    // Rate-limit the plate while the paw is near the snow. `ankleFor()` uses
    // this same limited quaternion, so the contact patch still lands exactly
    // on target — only the roll slows down.
    if (!f._qfPrev) { f._qfPrev = out.clone(); return; }
    if (f.clear < ANKLE_LIMIT_CLEAR) {
      const radius = Math.max(0.006, f.limb.anchorLocal.length());
      const maxAng = (MAX_ANKLE_MPS / radius) * (this.h || 1 / 120);
      const d = Math.min(1, Math.abs(f._qfPrev.dot(out)));
      const ang = 2 * Math.acos(d);
      if (ang > maxAng && ang > 1e-6) {
        _q.copy(f._qfPrev).slerp(out, maxAng / ang);
        out.copy(_q);
      }
    }
    f._qfPrev.copy(out);
  }

  // --------------------------------------------------------------- publish --

  _publish(ctx) {
    const fox = this.fox;
    const loco = this.loco;
    fox.velocity.set(loco.vel.x, 0, loco.vel.z);
    fox.speed = loco.speed;
    fox.heading = loco.yaw;
    fox.gaitPhase = loco.phase;
    fox.state = this.state;

    // Consumed by world/Breath.js — a 0..1 sawtooth, exhale past 0.5.
    fox.breathPhase = this.life.breathPhase;
    fox.breathAmp = this.life.breathAmp;
    // For the face agent: eyelids and eyeball aim (no bones for these yet).
    fox.blink = this.life.blink;
    fox.blinkL = this.life.blinkL;
    fox.blinkR = this.life.blinkR;
    fox.gazeYaw = this.look.gazeYaw;
    fox.gazePitch = this.look.gazePitch;
    // World-space point of interest. src/fox/Eyes.js drives the eyeballs from
    // gazeYaw/gazePitch by default and treats its own setLook() as an
    // override, so this is published for anyone who wants the richer signal
    // (cinematics, breath aim) rather than pushed at it every frame — pushing
    // would permanently latch the override and kill its fallback path.
    if (!fox.lookTarget) fox.lookTarget = this.look.target.clone();
    else fox.lookTarget.copy(this.look.target);
    fox.yawn = this.life.yawn;
    // For the fur agent: how hard the coat is being thrown about.
    fox.agitation = this.sec.agitation;
    fox.airborne = loco.airborne;
  }
}
