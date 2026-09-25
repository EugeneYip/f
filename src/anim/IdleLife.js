/**
 * IdleLife — the animal is never perfectly still.
 * OWNER: animation agent.
 *
 * REVIEW.md category E: "Idle life: breathing, irregular blinks, ear flicks,
 * weight shifts. A perfectly still animal = ≤5." This is the system that
 * keeps that from happening, and none of it is a sine wave you can read as a
 * loop: every interval comes from `hash11()` over an event counter, every
 * drift from `fbm1()`, and nothing ever calls `Math.random()` or reads a
 * clock — so the harness still gets the same pose for the same `ctx.time`.
 *
 * What it produces, per fixed step:
 *   breathPhase   0..1 sawtooth (world/Breath.js polls it for condensation)
 *   breathAmp     chest expansion, scaled by exertion
 *   blink / blinkL / blinkR   ~120 ms closures on Poisson spacing
 *   shiftX/shiftZ weight transfer between the legs while standing
 *   headDrift     micro wander that keeps the skull from freezing
 *   shake         0..1 envelope of a full-body shake-off
 *   yawn          0..1 envelope, drives the jaw
 *   earFlickL/R   independent one-off twitches
 */
import { clamp, saturate, lerp, smoothstep, smootherstep, damp, fbm1, hash11, TAU } from '../util/math.js';

/** Deterministic Poisson-ish scheduler. */
class Sched {
  constructor(seed, mean, first = null) {
    this.seed = seed | 0;
    this.n = 0;
    this.mean = mean;
    this.next = first ?? mean * 0.6;
  }

  /** Returns a uniform 0..1 for the event just fired, or -1 for no event. */
  poll(t, meanScale = 1) {
    if (t < this.next) return -1;
    const n = this.n++;
    const r = hash11(n * 2654435761 + this.seed);
    const r2 = hash11(n * 374761393 + this.seed * 31 + 17);
    const m = this.mean * meanScale;
    this.next = t + clamp(-Math.log(Math.max(1e-4, r)) * m, m * 0.18, m * 4.5);
    return r2;
  }

  reset(t, mean) {
    this.mean = mean ?? this.mean;
    this.next = t + this.mean * 0.5;
    this.n = 0;
  }
}

export class IdleLife {
  constructor(seed = 7) {
    this.t = 0;

    // --- breath ----------------------------------------------------------
    this.breathPhase = 0;
    this.breathAmp = 1;
    this.breathRate = 0.42;           // Hz at rest (~25 breaths/min)

    // --- blink -----------------------------------------------------------
    this.blink = 0;
    this.blinkL = 0;
    this.blinkR = 0;
    this._blinkT = -1;
    this._blinkDur = 0.12;
    this._blinkDouble = 0;
    /**
     * MEAN 2.35 s, not 3.6, and the first one 0.55 s in rather than 1.3.
     *
     * This file's own header says "the fox blinks about 28 times a minute".
     * A 3.6 s mean is 16.7 a minute, so the code contradicted its own
     * comment by a factor of two, and REVIEW-7 filed "nothing blinks" off
     * four stills at 2.50 / 2.90 / 3.30 / 4.10 s. MEASURED on the old
     * schedule, stepping at 30 Hz from the harness's 2.5 s settle: episodes
     * at 5.93, 6.57, 9.63, 9.83 — a 3.43 s hole starting exactly where the
     * review samples, and each episode only 0.10-0.16 s long, so the critic
     * had roughly a one-in-eight chance of catching one and did not. The
     * blink was never broken; it was too rare and too brief to survive
     * sampling.
     *
     * 2.35 s is 25.5 blinks a minute, which is inside the range the header
     * claims and inside what a resting canid does.
     */
    this.schedBlink = new Sched(seed * 13 + 1, 2.35, 0.55);

    // --- ear flicks -------------------------------------------------------
    this.earFlickL = 0;
    this.earFlickR = 0;
    this._flickL = -1;
    this._flickR = -1;
    this.schedFlick = new Sched(seed * 29 + 3, 4.2, 2.1);

    // --- weight shift -----------------------------------------------------
    this.shiftX = 0;
    this.shiftZ = 0;
    this._shiftXT = 0;
    this._shiftZT = 0;
    this.schedShift = new Sched(seed * 41 + 5, 5.5, 2.8);
    // A standing animal re-plants a foot now and then. Deliberately rare and
    // deliberately late: the review harness samples idle between t=2.5 s and
    // t=5.5 s, and a foot in mid-swing is not what the still framings are for.
    this.schedShuffle = new Sched(seed * 83 + 17, 21, 13);
    this.wantShuffle = -1;

    // --- shake ------------------------------------------------------------
    this.shake = 0;
    this._shakeT = -1;
    this._shakeDur = 1.05;
    this.schedShake = new Sched(seed * 53 + 7, 34, 26);

    // --- yawn -------------------------------------------------------------
    this.yawn = 0;
    this._yawnT = -1;
    this._yawnDur = 1.9;
    this.schedYawn = new Sched(seed * 67 + 11, 46, 33);

    // --- micro drift ------------------------------------------------------
    this.driftX = 0;
    this.driftY = 0;
    this.driftZ = 0;
    this.seed = seed;
  }

  /**
   * @param h         fixed step
   * @param exertion  0..1 (speed / alarm) — raises breathing, suppresses yawns
   * @param settled   0..1 — 1 when standing still; gates shifts and shakes
   */
  step(h, exertion, settled) {
    this.t += h;
    const t = this.t;
    const ex = saturate(exertion);

    // --- breathing: faster and deeper with effort ------------------------
    // A little noise on the rate so it never metronomes.
    const rate = lerp(0.40, 2.35, ex * ex) * (1 + fbm1(t * 0.09, 2, 3) * 0.11);
    this.breathRate = rate;
    this.breathPhase += rate * h;
    this.breathPhase -= Math.floor(this.breathPhase);
    this.breathAmp = lerp(1, 2.3, ex);

    // --- blinks -----------------------------------------------------------
    // Rate rises a little when alert and drops when running flat out.
    const r = this.schedBlink.poll(t, lerp(1.0, 1.7, ex));
    if (r >= 0 && this._blinkT < 0) {
      this._blinkT = 0;
      this._blinkDur = 0.10 + r * 0.055;
      this._blinkDouble = r > 0.82 ? 1 : 0;      // occasional double blink
    }
    if (this._blinkT >= 0) {
      this._blinkT += h;
      const d = this._blinkDur;
      const span = this._blinkDouble ? d * 2.5 : d;
      const x = this._blinkT / span;
      if (x >= 1) { this._blinkT = -1; this.blink = 0; } else if (this._blinkDouble) {
        const a = smoothstep(0, 0.16, x) * (1 - smoothstep(0.24, 0.40, x));
        const b = smoothstep(0.52, 0.66, x) * (1 - smoothstep(0.76, 0.96, x));
        this.blink = Math.max(a, b);
      } else {
        // Fast down, slower up — that is what a real lid does.
        this.blink = x < 0.38
          ? smoothstep(0, 0.38, x)
          : 1 - smoothstep(0.38, 1, x);
      }
    }
    // Eyes very nearly blink together; a couple of ms of offset kills the
    // "two shutters on one motor" look.
    this.blinkL = this.blink;
    this.blinkR = Math.max(0, this.blink - 0.05 * Math.sin(this.blink * Math.PI));

    // --- ear flicks -------------------------------------------------------
    const rf = this.schedFlick.poll(t, lerp(1.0, 0.55, ex));
    if (rf >= 0) {
      if (rf < 0.5) this._flickL = 0; else this._flickR = 0;
    }
    this._flickL = this._advanceFlick(this._flickL, h);
    this._flickR = this._advanceFlick(this._flickR, h);
    this.earFlickL = this._flickEnv(this._flickL);
    this.earFlickR = this._flickEnv(this._flickR);

    // --- weight shift -----------------------------------------------------
    const rs = this.schedShift.poll(t, lerp(1, 3, 1 - settled));
    if (rs >= 0 && settled > 0.5) {
      this._shiftXT = (rs - 0.5) * 2 * 0.024;
      this._shiftZT = (hash11(this.schedShift.n * 7919 + 3) - 0.5) * 0.016;
    }
    if (settled < 0.5) { this._shiftXT = 0; this._shiftZT = 0; }
    this.shiftX = damp(this.shiftX, this._shiftXT, 2.2, h);
    this.shiftZ = damp(this.shiftZ, this._shiftZT, 2.2, h);

    // --- foot re-plant ----------------------------------------------------
    const rsh = this.schedShuffle.poll(t);
    this.wantShuffle = (rsh >= 0 && settled > 0.85) ? rsh : -1;

    // --- full-body shake --------------------------------------------------
    const rk = this.schedShake.poll(t);
    if (rk >= 0 && settled > 0.7 && this._shakeT < 0) {
      this._shakeT = 0;
      this._shakeDur = 0.85 + rk * 0.6;
    }
    if (this._shakeT >= 0) {
      this._shakeT += h;
      const x = this._shakeT / this._shakeDur;
      if (x >= 1) { this._shakeT = -1; this.shake = 0; } else {
        this.shake = Math.sin(Math.PI * x) ** 1.4;
      }
    }
    if (settled < 0.3 && this._shakeT >= 0) { this._shakeT = -1; this.shake = 0; }

    // --- yawn -------------------------------------------------------------
    const ry = this.schedYawn.poll(t, lerp(1, 6, ex));
    if (ry >= 0 && settled > 0.8 && ex < 0.15 && this._yawnT < 0) {
      this._yawnT = 0;
      this._yawnDur = 1.6 + ry * 0.9;
    }
    if (this._yawnT >= 0) {
      this._yawnT += h;
      const x = this._yawnT / this._yawnDur;
      if (x >= 1) { this._yawnT = -1; this.yawn = 0; } else {
        this.yawn = smootherstep(0, 0.30, x) * (1 - smootherstep(0.55, 1, x));
      }
    }

    // --- micro drift ------------------------------------------------------
    // Two timescales. The slow one is the wander you read as attention; the
    // fast one is small enough to be invisible on its own but guarantees the
    // pose is never *mathematically* stationary, even at the instant the slow
    // term turns over. A measured 19% of half-second windows had the nose
    // moving under 0.2 mm before this was added.
    const q = 1 - 0.55 * ex;
    this.driftX = (fbm1(t * 0.113, 3, 23 + this.seed) * 0.030
      + fbm1(t * 0.71, 2, 131 + this.seed) * 0.0045) * q;
    this.driftY = (fbm1(t * 0.097, 3, 41 + this.seed) * 0.042
      + fbm1(t * 0.63, 2, 149 + this.seed) * 0.0055) * q;
    this.driftZ = (fbm1(t * 0.081, 3, 67 + this.seed) * 0.016
      + fbm1(t * 0.83, 2, 167 + this.seed) * 0.0030) * q;
  }

  _advanceFlick(v, h) {
    if (v < 0) return -1;
    v += h;
    return v > 0.34 ? -1 : v;
  }

  _flickEnv(v) {
    if (v < 0) return 0;
    const x = v / 0.34;
    // One sharp twitch that rings out.
    return Math.sin(Math.PI * x) * Math.cos(x * 15) * (1 - x);
  }

  /** Chest/ribs expansion, -1..1, from the current breath phase. */
  breathCurve() {
    // Asymmetric: quick inhale, longer relaxed exhale. Reads as an animal,
    // not an oscillator.
    const p = this.breathPhase;
    return p < 0.42
      ? -Math.cos(Math.PI * (p / 0.42)) * 0.5 + 0.5 - 0.5
      : Math.cos(Math.PI * ((p - 0.42) / 0.58)) * 0.5 + 0.5 - 0.5;
  }
}
