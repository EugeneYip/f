// Small, allocation-free math helpers shared by every system.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, x) => (b === a ? 0 : (x - a) / (b - a));
export const remap = (x, a, b, c, d) => lerp(c, d, saturate(invLerp(a, b, x)));
export const mix = lerp;

export const smoothstep = (e0, e1, x) => {
  const t = saturate((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
};
export const smootherstep = (e0, e1, x) => {
  const t = saturate((x - e0) / (e1 - e0 || 1e-9));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** Framerate-independent exponential approach. `rate` = 1/e-folds per second. */
export const damp = (current, target, rate, dt) =>
  target + (current - target) * Math.exp(-rate * dt);

/** Wraps to [-PI, PI]. */
export const wrapPi = (a) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};

export const dampAngle = (current, target, rate, dt) =>
  current + wrapPi(target - current) * (1 - Math.exp(-rate * dt));

/**
 * Critically-stable implicit spring (Position-Based Dynamics style).
 * Returns the new value; mutates `state.v`.
 *   state: { v: number }
 *   omega: undamped angular frequency (rad/s) — stiffness
 *   zeta:  damping ratio (1 = critically damped)
 */
export function spring(value, target, state, omega, zeta, dt) {
  // Semi-implicit Euler, unconditionally stable for reasonable dt.
  const f = 1 + 2 * dt * zeta * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const det = 1 / (f + hhoo);
  const v = (state.v + hoo * (target - value)) * det;
  state.v = v;
  return (f * value + dt * v + hhoo * target) * det;
}

/** Deterministic 32-bit hash → [0,1). */
export function hash11(n) {
  n = (n ^ 61) ^ (n >>> 16);
  n = (n + (n << 3)) | 0;
  n ^= n >>> 4;
  n = Math.imul(n, 0x27d4eb2d);
  n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}

/** Mulberry32 — fast, seedable, good enough for content generation. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussian pair from a uniform source. */
export function gauss(rand, mean = 0, sd = 1) {
  const u = Math.max(1e-9, rand());
  const v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

// --- easing --------------------------------------------------------------
export const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
export const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
export const easeOutElastic = (t) => {
  const c = TAU / 3;
  return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c) + 1;
};
export const easeOutBack = (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);

/** Smooth 1D value noise over a hashed integer lattice — for organic drift. */
export function valueNoise1(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash11((i + seed * 7919) | 0);
  const b = hash11((i + 1 + seed * 7919) | 0);
  return lerp(a, b, u) * 2 - 1;
}

/** Fractal 1D noise, useful for gusts / idle wander. */
export function fbm1(x, octaves = 3, seed = 0) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    s += amp * valueNoise1(x * f, seed + i);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s / norm;
}
