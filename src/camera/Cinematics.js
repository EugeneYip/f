import * as THREE from 'three';
import { DEG, clamp, lerp, smootherstep, easeInOutCubic, wrapPi } from '../util/math.js';

/**
 * Attract mode.
 *
 * Leave the page alone for twelve seconds and an edit starts playing: five
 * authored shots on a timer, each easing in and out of stillness so the cut
 * between them lands on a held frame rather than mid-pan. The rig's own
 * damping smooths everything on top, and because cinematics writes to the
 * rig's *desired* state (not the camera), a single pointer-down hands control
 * back seamlessly — the operator just keeps damping toward wherever the user
 * points instead of wherever the shot wanted to go.
 *
 * All timing comes from `dt`. Nothing here reads a wall clock, so a paused app
 * is a frozen edit and the screenshot harness never sees a moving camera.
 */

const s5 = (u) => smootherstep(0, 1, u);
const lerpAngle = (a, b, t) => a + wrapPi(b - a) * t;

/**
 * az/el/dist/fov are [start, end] pairs. `bias` is the vertical framing shift
 * in frame-heights (+ aims up, dropping subject and horizon into the lower
 * third). `focus` null = rack to the head automatically.
 */
const SHOTS = [
  {
    // The establishing move: a long, slow arc through the rim light.
    name: 'orbit',
    dur: 26, ease: s5,
    az: [-20 * DEG, 44 * DEG],
    el: [3.5 * DEG, 10 * DEG],
    dist: [2.8, 2.15],
    fov: [41, 38],
    bias: 0.15,
    focus: null,
  },
  {
    // Push in on the face. Decelerating, so it settles on the eye.
    name: 'push',
    dur: 18, ease: easeInOutCubic,
    az: [31 * DEG, 20 * DEG],
    el: [7 * DEG, 4.5 * DEG],
    dist: [1.6, 0.62],
    fov: [35, 32],
    bias: -0.07,
    focus: null,
  },
  {
    // Low dolly, lens almost on the snow, the animal sliding across frame.
    name: 'dolly',
    dur: 19, ease: s5,
    az: [64 * DEG, 40 * DEG],
    el: [1.0 * DEG, 3.0 * DEG],
    dist: [3.0, 1.9],
    fov: [44, 41],
    pan: [[0.20, -0.03, 0.02], [-0.14, -0.03, -0.02]],
    bias: 0.12,
    focus: null,
  },
  {
    // Backlit rise and reveal: the snowfield opens up behind the silhouette.
    name: 'reveal',
    dur: 22, ease: s5,
    az: [-46 * DEG, -27 * DEG],
    el: [1.5 * DEG, 26 * DEG],
    dist: [2.1, 4.9],
    fov: [44, 46],
    bias: 0.17,
    focus: null,
  },
  {
    // Near-still profile. Barely any movement — just parallax and breathing.
    name: 'profile',
    dur: 15, ease: s5,
    az: [88 * DEG, 97 * DEG],
    el: [5.5 * DEG, 4.0 * DEG],
    dist: [1.42, 1.2],
    fov: [36, 35],
    bias: -0.03,
    focus: null,
  },
];

export class Cinematics {
  /** Seconds of no input before the edit starts playing. */
  static IDLE_DELAY = 12;
  /** Seconds to drift out of the user's framing into the first shot. */
  static ENTER = 4.5;
  /** Length of the dip-to-dark on a cut, in seconds. */
  static CUT = 0.42;

  constructor(rig) {
    this.rig = rig;
    this.shots = SHOTS;
    this.active = false;
    this.i = 0;
    this.t = 0;
    this.enter = 0;
    this.bias = null;
    this.focus = null;
    this.from = { az: 0, el: 0, dist: 2.3, fov: 40 };
    this.fromPan = new THREE.Vector3();
    this._pan = new THREE.Vector3();
  }

  get shot() { return this.shots[this.i % this.shots.length]; }

  /** The UI is the only thing I notify, and only if it exists. */
  _ui() { return this.rig.ctx?.systemsByName?.get('ui'); }

  /** Begin the edit from wherever the camera currently is. */
  start() {
    if (this.active || this.rig.reducedMotion) return false;
    const r = this.rig;
    this.active = true;
    this.i = 0;
    this.t = 0;
    this.enter = 0;
    this.from.az = r.c.az;
    this.from.el = r.c.el;
    this.from.dist = r.c.dist;
    this.from.fov = r.fov;
    this.fromPan.copy(r.pan);
    r.posed = null;
    this._ui()?.onCinematic?.(true);
    return true;
  }

  /**
   * Hand control back. The rig's current (smoothed) state becomes the user's
   * desired state, so there is no snap — the camera simply stops being driven.
   */
  stop(silent = false) {
    if (!this.active) return false;
    this.active = false;
    this.bias = null;
    this.focus = null;
    const r = this.rig;
    r.d.az = r.c.az;
    r.d.el = clamp(r.c.el, -6 * DEG, 68 * DEG);
    r.d.dist = clamp(r.c.dist, 0.35, 9);
    r.panD.copy(r.pan);
    r.vAz = r.vEl = 0;
    if (!silent) r.idle = 0;
    this._ui()?.onCinematic?.(false);
    return true;
  }

  /** Cut to the next shot: snap the rig so the damping can't smear the edit. */
  _cut() {
    this.i = (this.i + 1) % this.shots.length;
    this.t = 0;
    this.enter = Cinematics.ENTER; // past the entry blend from here on
    const r = this.rig;
    this._evalInto(r.d, 0);
    r.c.az = r.d.az; r.c.el = r.d.el; r.c.dist = r.d.dist;
    r.pan.copy(r.panD);
    r.fov = r.fovTarget;
    // Frame height must come from the EFFECTIVE fov, not the authored one:
    // on a narrow viewport the aspect fit widens the vertical field a long
    // way (35 deg -> ~95 deg at 390x844), and using the authored number here
    // while _compose() uses the effective one popped the framing on every cut.
    const fovH = r.fovEffective ?? r.fov;
    r.bias = r.biasTarget = (this.bias ?? 0) * 2 * r.c.dist * Math.tan(fovH * 0.5 * DEG);
    // Dip the overlay rather than whip-panning between framings. The UI owns
    // the only full-screen element I can legitimately fade.
    this._ui()?.flashCut?.(Cinematics.CUT);
  }

  /** Write shot `u` into a {az, el, dist} sink, plus fov/pan/bias/focus. */
  _evalInto(sink, u) {
    const s = this.shot;
    const e = s.ease(clamp(u, 0, 1));
    const r = this.rig;

    let az = lerp(s.az[0], s.az[1], e);
    let el = lerp(s.el[0], s.el[1], e);
    let dist = lerp(s.dist[0], s.dist[1], e);
    let fov = lerp(s.fov[0], s.fov[1], e);
    this._pan.set(0, 0, 0);
    if (s.pan) {
      this._pan.set(
        lerp(s.pan[0][0], s.pan[1][0], e),
        lerp(s.pan[0][1], s.pan[1][1], e),
        lerp(s.pan[0][2], s.pan[1][2], e),
      );
    }

    // Entry blend: drift out of the user's framing, never cut into shot one.
    const w = s5(clamp(this.enter / Cinematics.ENTER, 0, 1));
    if (w < 1) {
      az = lerpAngle(this.from.az, az, w);
      el = lerp(this.from.el, el, w);
      dist = lerp(this.from.dist, dist, w);
      fov = lerp(this.from.fov, fov, w);
      this._pan.lerpVectors(this.fromPan, this._pan, w);
    } else {
      // Keep azimuth on the same revolution as the live value so damping takes
      // the short way round after a cut.
      az = lerpAngle(r.c.az, az, 1);
    }

    sink.az = az;
    sink.el = el;
    sink.dist = dist;
    r.fovTarget = fov;
    r.panD.copy(this._pan);
    this.bias = s.bias;
    this.focus = s.focus ?? null;
  }

  update(dt, ctx) {
    if (!this.active) return;
    if (this.rig.reducedMotion) { this.stop(true); return; }
    this.t += dt;
    this.enter += dt;
    const s = this.shot;
    if (this.t >= s.dur) { this._cut(); return; }
    this._evalInto(this.rig.d, this.t / s.dur);
  }
}
