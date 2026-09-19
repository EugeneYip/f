/**
 * SecondaryDynamics — spring-damper chains for everything with mass.
 * OWNER: animation agent.
 *
 * ART_DIRECTION §2.4: "Anything with mass must lag: tail, ruff, ear tips,
 * belly fur, head." §8: "Critically damped enough not to wobble like jelly;
 * loose enough to read as mass."
 *
 * Every chain is the same idea: the base joint is driven by the body (angular
 * velocity, linear acceleration, gait sway, brain intent); each subsequent
 * joint chases the one above it through its own spring. Stiffness falls and
 * damping loosens toward the tip, so the lag accumulates and the amplitude
 * grows — a travelling wave, not a rigid bar and not a wobbling noodle.
 *
 * All of it runs in `fixed(h)` at 1/120 s with `spring()` from util/math.js,
 * which is an unconditionally stable semi-implicit integrator, so the result
 * is framerate-independent and bit-reproducible.
 *
 * Bone-axis conventions on this rig (identity rest rotations, so bone axes
 * ARE rig axes, measured off the landmarks):
 *   tail  +X lifts the tail, +Y swings it to the animal's left
 *   ear   +X tips fore/aft, +Y swivels, +Z cups laterally
 */
import { clamp, saturate, spring, lerp, smoothstep, fbm1, TAU } from '../util/math.js';

const TAIL_N = 9;
const EAR_N = 3;

function chain(n, fn) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = fn(i);
  return a;
}

export class SecondaryDynamics {
  constructor(rig) {
    this.rig = rig;

    this.tailNames = chain(TAIL_N, (i) => `tail${String(i + 1).padStart(2, '0')}`);
    this.earNames = {
      L: chain(EAR_N, (i) => `earL0${i + 1}`),
      R: chain(EAR_N, (i) => `earR0${i + 1}`),
    };

    // --- tail ------------------------------------------------------------
    this.tX = new Float64Array(TAIL_N);
    this.tY = new Float64Array(TAIL_N);
    this.tXs = chain(TAIL_N, () => ({ v: 0 }));
    this.tYs = chain(TAIL_N, () => ({ v: 0 }));
    // ART_DIRECTION §8b: follow-through must be FELT, not SEEN. Measured step
    // response of the previous tuning: the tip reached 50% at 1033 ms and the
    // chain took 2883 ms to settle, with 18% overshoot at the base — that is
    // not mass, that is rubber. Stiffer and at/above critical damping
    // throughout; §8b explicitly prefers slightly stiff to slightly loose.
    this.tOmega = chain(TAIL_N, (i) => lerp(42, 26, i / (TAIL_N - 1)));
    this.tZeta = chain(TAIL_N, (i) => lerp(1.10, 1.00, i / (TAIL_N - 1)));
    /**
     * `kLocal` is how much of each joint's target comes from its neighbour
     * rather than from the global drive, and it is the single most important
     * number in this file. At 1.0 the chain is a pure cascade and phase delay
     * compounds LINEARLY with joint count — nine joints then guarantee rubber
     * whatever the stiffness. Measured tip delay to 50%: 1033 ms at kLocal 1.0
     * versus 100 ms at 0.34. `transmit` > 1 additionally grew the amplitude
     * down the chain, which is the other half of "reads as rubber".
     */
    this.kLocal = 0.30;
    this.transmit = 1.0;

    // --- ears -------------------------------------------------------------
    this.ear = {};
    for (const s of ['L', 'R']) {
      this.ear[s] = {
        x: new Float64Array(EAR_N), y: new Float64Array(EAR_N), z: new Float64Array(EAR_N),
        xs: chain(EAR_N, () => ({ v: 0 })),
        ys: chain(EAR_N, () => ({ v: 0 })),
        zs: chain(EAR_N, () => ({ v: 0 })),
        // Small, light, stiff: an ear should be done in ~100 ms. The old
        // tuning measured 483 ms to settle with overshoot — rubber ears.
        omega: chain(EAR_N, (i) => lerp(62, 46, i / (EAR_N - 1))),
        zeta: chain(EAR_N, (i) => lerp(1.05, 1.00, i / (EAR_N - 1))),
      };
    }

    // --- neck / head ------------------------------------------------------
    this.neck = { x: 0, y: 0, z: 0, xs: { v: 0 }, ys: { v: 0 }, zs: { v: 0 } };
    this.head = { x: 0, y: 0, z: 0, xs: { v: 0 }, ys: { v: 0 }, zs: { v: 0 } };

    // --- ruff / belly follow-through --------------------------------------
    // No dedicated bones exist, so this rides on chest + spine04: a few
    // tenths of a degree of counter-motion is enough for the skinned ruff to
    // read as loose rather than welded to the ribcage.
    this.ruff = { x: 0, y: 0, xs: { v: 0 }, ys: { v: 0 } };
    this.belly = { x: 0, xs: { v: 0 } };

    this.t = 0;
    /** Published for the fur agent: how hard the coat is being thrown about. */
    this.agitation = 0;
  }

  /**
   * @param h     fixed step
   * @param inp   {
   *   yawRate, accelX, accelY, accelZ, speed, gaitPhase, airborne,
   *   tailLift, tailCurl, tailStiff, earTargetL{y,x,z}, earTargetR{…},
   *   headAccelX, headAccelY, shake
   * }
   */
  step(h, inp) {
    this.t += h;
    const t = this.t;

    // ------------------------------------------------------------- tail --
    // Drive: the tail trails a turn, counterweights lateral acceleration,
    // floats on vertical acceleration, and always breathes a little.
    const life = fbm1(t * 0.63, 3, 17);
    const life2 = fbm1(t * 0.41 + 31, 3, 53);
    // Gait-driven tail sway. MEASURED: at 0.055 the nine joints articulated a
    // combined 0.6 deg at the base and the tail read as a rigid rod that the
    // pelvis happened to be carrying around. These are whole-tail radians.
    const spd = saturate(inp.speed / 0.5);
    const sway = Math.sin(TAU * inp.gaitPhase + 0.6) * 0.40 * spd;
    const swayV = Math.sin(TAU * inp.gaitPhase * 2 + 1.9) * 0.22 * spd;

    // IMPORTANT: these are *whole-tail* angles, in radians, not per-joint.
    // Nine joints each rotating by X accumulate to 9X at the tip, and with a
    // transmit of 1.055 the steady-state sum is ~11.4X — a measured tail tip
    // sat 85 mm above its rest height on a drive of 0.085. So carriage is
    // divided across the chain and only the *dynamic* part is propagated.
    const dynY = (clamp(inp.yawRate * 0.55, -0.85, 0.85)
      - clamp(inp.accelX * 0.050, -0.50, 0.50)
      + sway + life * 0.130 * (1 - 0.6 * saturate(inp.speed))) / TAIL_N;
    const dynX = (clamp(-inp.accelY * 0.022, -0.32, 0.32)
      + clamp(inp.accelZ * 0.034, -0.36, 0.36)
      + swayV
      + life2 * 0.090 * (1 - 0.6 * saturate(inp.speed))
      + inp.shake * 0.62 * Math.sin(t * 46)) / TAIL_N;

    const stiff = inp.tailStiff ?? 1;
    // See `kLocal` in the constructor — this is the bounded-delay blend.
    const K_LOCAL = this.kLocal;
    const transmit = this.transmit;
    // Carriage is front-loaded: a real tail lifts from the base and the tip
    // follows, rather than every vertebra hinging by the same amount.
    const CARRY = TAIL_N * 0.5 * (1.4 + 0.6);   // normaliser for the taper below
    let prevX = dynX, prevY = dynY;
    for (let i = 0; i < TAIL_N; i++) {
      const w = i / (TAIL_N - 1);
      const taper = (1.4 - 0.8 * w) * TAIL_N / CARRY;
      const biasX = (inp.tailLift + inp.tailCurl * (2 * w - 0.6)) * taper / TAIL_N;
      const tgtX = biasX + (i === 0 ? dynX
        : dynX * (1 - K_LOCAL) + prevX * transmit * K_LOCAL);
      const tgtY = (i === 0 ? dynY
        : dynY * (1 - K_LOCAL) + prevY * transmit * K_LOCAL);
      const om = this.tOmega[i] * stiff;
      this.tX[i] = clamp(spring(this.tX[i], tgtX, this.tXs[i], om, this.tZeta[i], h), -0.42, 0.42);
      this.tY[i] = clamp(spring(this.tY[i], tgtY, this.tYs[i], om, this.tZeta[i], h), -0.34, 0.34);
      prevX = this.tX[i] - biasX;      // propagate the dynamic part only
      prevY = this.tY[i];
    }

    // ------------------------------------------------------------- ears --
    for (const s of ['L', 'R']) {
      const e = this.ear[s];
      const tgt = s === 'L' ? inp.earTargetL : inp.earTargetR;
      const sgn = s === 'L' ? -1 : 1;
      const flick = inp[`earFlick${s}`] || 0;
      let px = tgt.x + clamp(-inp.headAccelZ * 0.010, -0.2, 0.2) + flick * 0.55;
      let py = tgt.y + clamp(inp.yawRate * 0.10, -0.18, 0.18);
      let pz = tgt.z + sgn * clamp(inp.accelX * 0.008, -0.12, 0.12)
        + sgn * inp.shake * 0.85 * Math.sin(t * 52 + (s === 'L' ? 0 : 1.7));
      const ex0 = px, ey0 = py, ez0 = pz;
      for (let i = 0; i < EAR_N; i++) {
        const k = i === 0 ? 1 : 0.55;
        const tx = i === 0 ? px : ex0 * k * 0.66 + px * 0.34;
        const ty = i === 0 ? py : ey0 * k * 0.66 + py * 0.34;
        const tz = i === 0 ? pz : ez0 * k * 0.66 + pz * 0.34;
        e.x[i] = clamp(spring(e.x[i], tx, e.xs[i], e.omega[i], e.zeta[i], h), -0.5, 0.5);
        e.y[i] = clamp(spring(e.y[i], ty, e.ys[i], e.omega[i], e.zeta[i], h), -0.5, 0.5);
        e.z[i] = clamp(spring(e.z[i], tz, e.zs[i], e.omega[i], e.zeta[i], h), -0.5, 0.5);
        px = e.x[i] * 0.85; py = e.y[i] * 0.85; pz = e.z[i] * 0.85;
      }
    }

    // -------------------------------------------------- neck / head lag --
    // The skull is the heaviest thing on the end of the longest lever, so it
    // lags the trunk. Negative sign: the head is left behind by acceleration.
    const nX = clamp(-inp.accelZ * 0.018, -0.16, 0.16) + inp.shake * 0.25 * Math.sin(t * 41 + 0.4);
    const nY = clamp(-inp.accelX * 0.016, -0.16, 0.16) - clamp(inp.yawRate * 0.055, -0.14, 0.14);
    const nZ = clamp(inp.accelX * 0.010, -0.10, 0.10) + inp.shake * 0.42 * Math.sin(t * 38);
    this.neck.x = spring(this.neck.x, nX, this.neck.xs, 34, 1.00, h);
    this.neck.y = spring(this.neck.y, nY, this.neck.ys, 34, 1.00, h);
    this.neck.z = spring(this.neck.z, nZ, this.neck.zs, 36, 1.02, h);
    this.head.x = spring(this.head.x, this.neck.x * 0.9, this.head.xs, 28, 1.00, h);
    this.head.y = spring(this.head.y, this.neck.y * 0.9, this.head.ys, 28, 1.00, h);
    this.head.z = spring(this.head.z, this.neck.z * 0.8, this.head.zs, 30, 1.02, h);

    // ------------------------------------------------ ruff / belly mass --
    this.ruff.x = spring(this.ruff.x, clamp(-inp.accelY * 0.0055, -0.07, 0.07)
      + inp.shake * 0.30 * Math.sin(t * 44 + 1.1), this.ruff.xs, 36, 1.00, h);
    this.ruff.y = spring(this.ruff.y, clamp(-inp.accelX * 0.0060, -0.07, 0.07),
      this.ruff.ys, 36, 1.00, h);
    this.belly.x = spring(this.belly.x, clamp(-inp.accelY * 0.0040, -0.05, 0.05),
      this.belly.xs, 28, 0.98, h);

    this.agitation = saturate(
      Math.abs(this.tY[TAIL_N - 1]) * 1.6 + Math.abs(this.tX[TAIL_N - 1]) * 1.2 + inp.shake,
    );
  }

  /** Add every chain's contribution to the pose accumulator. */
  apply(rig) {
    for (let i = 0; i < TAIL_N; i++) {
      rig.add(this.tailNames[i], this.tX[i], this.tY[i], 0);
    }
    for (const s of ['L', 'R']) {
      const e = this.ear[s];
      for (let i = 0; i < EAR_N; i++) {
        rig.add(this.earNames[s][i], e.x[i], e.y[i], e.z[i]);
      }
    }
    rig.add('neck01', this.neck.x * 0.55, this.neck.y * 0.55, this.neck.z * 0.5);
    rig.add('neck02', this.neck.x * 0.45, this.neck.y * 0.45, this.neck.z * 0.4);
    rig.add('head', this.head.x, this.head.y, this.head.z);
    rig.add('chest', this.ruff.x, this.ruff.y, 0);
    rig.add('spine04', this.ruff.x * 0.5, this.ruff.y * 0.45, 0);
    rig.add('spine02', this.belly.x, 0, 0);
  }
}
