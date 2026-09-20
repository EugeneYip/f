import * as THREE from 'three';
import {
  DEG, clamp, saturate, lerp, damp, smoothstep, fbm1,
} from '../util/math.js';
import { applyAdaptiveFov } from '../core/App.js';
import { Cinematics } from './Cinematics.js';

/**
 * The camera operator.
 *
 * Everything lives in a small "rig space" — azimuth, elevation, distance and a
 * pan offset around a moving orbit centre — rather than in raw matrices, so
 * limits, framing rules and the cinematics module all speak the same language.
 *
 *   orbit centre = follow(subject) + lead(velocity) + pan
 *   camera pos   = centre + dist · spherical(az, el)
 *   aim point    = centre + screen-space vertical framing bias
 *
 * Three hard invariants:
 *
 *  1. `applyPose()` is the review harness's contract. It must place the camera
 *     *exactly* and then keep it there — the harness calls `settle(0.35)`
 *     (≈42 update ticks) AFTER the pose and only then screenshots. So a pose
 *     latches, and `update()` re-asserts the latched transform verbatim until
 *     the user touches something. No damping state, no noise, no wall clock
 *     can leak into a posed frame.
 *  2. Nothing here reads `performance.now()` / `Date.now()` / `Math.random()`.
 *     Handheld noise is `fbm1(ctx.time)`; idle timers run off `dt`.
 *  3. `_applyFov()` is the ONLY place in the project that assigns
 *     `camera.fov`, and it always routes through `applyAdaptiveFov()`. See the
 *     note on that method — this rig used to fight `App._applyRenderSize()`
 *     for control of the fov and won every frame, which is what cropped the
 *     animal off the side of a phone.
 */

const DIST_MIN = 0.35;          // bible §9: never closer than a macro on the eye
const DIST_MAX = 9.0;           // ...and never further than a wide of the field
const EL_MIN = -6 * DEG;        // a hair below eye level, never under the snow
const EL_MAX = 68 * DEG;        // stop short of a plan view
const FOV_LONG = 32;            // long lens at macro range
const FOV_WIDE = 46;            // still no wider than a 46° "normal"
const GROUND_CLEARANCE = 0.055; // metres the lens keeps above the snow
const PAN_SOFT = 0.45;          // pan freely inside this radius of the animal
const PAN_MAX = 0.90;           // rubber-band asymptote beyond it
const LEAD_TIME = 0.40;         // seconds of lead in the direction of travel
const LEAD_MAX = 0.55;

const ROT_GAIN = 1.35;          // radians of azimuth per radian of drag
const ROT_RATE = 7.5;           // damping rates, 1/e-folds per second
const DIST_RATE = 6.0;
const PAN_RATE = 6.0;
const CINE_RATE = 9.0;
const FOLLOW_RATE = 2.2;        // operator lag behind the animal
const MOMENTUM_DECAY = 2.6;     // 1/e every 0.38 s — settles in about 1.5 s
const FLICK_RATE = 14;          // how fast the throw estimate tracks the drag
const FLICK_GAIN = 0.75;        // a throw carries 75% of the drag speed
const FOV_RATE = 3.5;
const BIAS_RATE = 2.2;
const FOCUS_RATE = 9.0;

/** Rubber band: pushing past a limit costs progressively more and tops out. */
function rubber(x, lo, hi, soft) {
  if (x < lo) { const d = lo - x; return lo - soft * (d / (d + soft)); }
  if (x > hi) { const d = x - hi; return hi + soft * (d / (d + soft)); }
  return x;
}

export class CameraRig {
  name = 'cameraRig';
  order = 900;

  constructor() {
    // Desired (input/cinematics write here) and current (what we render).
    this.d = { az: 39.8 * DEG, el: 4.2 * DEG, dist: 2.3 };
    this.c = { az: 39.8 * DEG, el: 4.2 * DEG, dist: 2.3 };
    this.vAz = 0; this.vEl = 0;

    // Input accumulated since the last update(), converted to a velocity there
    // where a real `dt` is available. Deriving the throw from per-EVENT deltas
    // made the momentum depend on the pointer's report rate: the same physical
    // flick threw much further from a 125 Hz mouse than from a 1000 Hz one.
    this._flickAz = 0; this._flickEl = 0;

    this.panD = new THREE.Vector3();
    this.pan = new THREE.Vector3();

    // `fov` is the AUTHORED, vertical-at-16:10 fov. `fovEffective` is what the
    // camera is actually running after the aspect fit, and is what any
    // frame-height arithmetic (pan speed, framing bias) has to use.
    this.fovTarget = 40;
    this.fov = 40;
    this.fovEffective = 40;
    this._fovBase = -1;
    this._fovAspect = -1;
    this.biasTarget = 0;
    this.bias = 0;

    this.centre = new THREE.Vector3(0, 0.26, 0);
    this.follow = new THREE.Vector3(0, 0.26, 0);
    this.subjPrev = new THREE.Vector3(0, 0.26, 0);
    this.subjVel = new THREE.Vector3();
    this.headPoint = new THREE.Vector3(0, 0.31, 0.06);
    this.aim = new THREE.Vector3();

    this.idle = 0;
    this.posed = null;

    // Scratch — the update path must not allocate.
    this._v0 = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._noise = new THREE.Vector3();

    this._pointers = new Map();
    this._mode = null;            // 'orbit' | 'pan'
    this._pinch = 0;
    this._centroid = { x: 0, y: 0 };

    this.reducedMotion = false;
    try {
      const mq = matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = mq.matches;
      this._mq = mq;
      this._onMq = () => { this.reducedMotion = mq.matches; if (this.reducedMotion) this.cine?.stop(); };
      mq.addEventListener('change', this._onMq);
    } catch { /* no matchMedia: assume motion is fine */ }

    this.cine = new Cinematics(this);
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.cameraRig = this;
    ctx.camera.up.set(0, 1, 0);
    ctx.camera.near = 0.035;
    // Publish the authored fov before anything else can resize us.
    this._applyFov(ctx, this.fov);
    this._bind(ctx);
    this._trackSubject(ctx, 0, true);
    this._compose(ctx, 0);
  }

  // --------------------------------------------------------------- the lens --

  /**
   * The single place `camera.fov` is assigned, anywhere in the project.
   *
   * three's `PerspectiveCamera.fov` is VERTICAL, so setting only `aspect` lets
   * the HORIZONTAL field collapse as the viewport narrows: at 390×844 an
   * authored 40° vertical fov leaves ~19.5° horizontally against ~60° on a
   * 16:10 desktop, and the animal falls out of frame sideways. `App.js`
   * exports `applyAdaptiveFov()` to hold the horizontal field constant below a
   * 16:10 reference; this rig used to overwrite its result every frame with a
   * raw `cam.fov = …`, so the fix never survived a single update.
   *
   * We also publish `ctx.baseFov`. `App._applyRenderSize()` reads it on every
   * resize and falls back to `camera.fov` when it is absent — and `camera.fov`
   * is by then the ALREADY-ADAPTED value, so each resize re-adapted an adapted
   * number and the fov compounded (40° → 103° → 137° → the 140° clamp after
   * three resize events at phone width). Publishing the authored value keeps
   * that path idempotent.
   */
  _applyFov(ctx, baseFov) {
    const cam = ctx.camera;
    ctx.baseFov = baseFov;
    const aspect = cam.aspect || 1;
    if (baseFov !== this._fovBase || aspect !== this._fovAspect ||
        cam.fov !== this.fovEffective) {
      this._fovBase = baseFov;
      this._fovAspect = aspect;
      this.fovEffective = applyAdaptiveFov(cam, baseFov, aspect);
    }
    return this.fovEffective;
  }

  // ---------------------------------------------------------------- harness --

  /**
   * HARD CONTRACT (src/core/Debug.js → setPose). Place the camera exactly at
   * `pose.pos` looking exactly at `pose.target`, set fov and focus, and
   * suppress every source of drift from here on so the screenshot is
   * bit-identical run to run.
   */
  applyPose(pose, ctx = this.ctx) {
    const cam = ctx.camera;
    const tgt = this._v0.fromArray(pose.target);

    cam.up.set(0, 1, 0);
    cam.position.fromArray(pose.pos);
    cam.lookAt(tgt);

    // The pose's fov is authored against the 16:10 reference, so it is a BASE
    // fov like any other; the aspect fit is applied on top of it.
    const baseFov = pose.fov ?? this._fovBase ?? cam.fov;
    this._applyFov(ctx, baseFov);
    cam.updateMatrixWorld(true);

    const focus = pose.focus ?? cam.position.distanceTo(tgt);
    ctx.focusDistance = clamp(focus, 0.08, 60);

    // Latch. `update()` re-asserts this verbatim; nothing else may touch the
    // camera until a real input arrives. Store the BASE fov, not the adapted
    // one, or re-asserting at a different viewport size would adapt twice.
    this.posed = {
      pos: [pose.pos[0], pose.pos[1], pose.pos[2]],
      target: [pose.target[0], pose.target[1], pose.target[2]],
      fov: baseFov,
      focus: ctx.focusDistance,
    };

    // Keep interactive state in sync with the pose so that when the user does
    // take over, control resumes from this framing instead of snapping back.
    this._syncFromPose(pose, ctx);
    this.cine.stop(true);
    return true;
  }

  _syncFromPose(pose, ctx) {
    const off = this._v1.fromArray(pose.pos).sub(this._v0.fromArray(pose.target));
    const dist = Math.max(1e-4, off.length());
    this.d.dist = this.c.dist = clamp(dist, DIST_MIN, DIST_MAX);
    this.d.el = this.c.el = clamp(Math.asin(clamp(off.y / dist, -1, 1)), EL_MIN, EL_MAX);
    this.d.az = this.c.az = Math.atan2(off.x, off.z);
    this.vAz = this.vEl = 0;
    this._flickAz = this._flickEl = 0;
    this.fov = this.fovTarget = pose.fov ?? this.fov;
    this.bias = this.biasTarget = 0;

    // The pose's look-at becomes the pan offset from the animal.
    const subj = ctx.subjectPosition ?? this.follow;
    this.pan.copy(this._v0).sub(subj);
    this._softenPan(this.pan);
    this.panD.copy(this.pan);
    this.follow.copy(subj);
    this.centre.copy(this._v0);
  }

  /** Any real user input drops the latch and hands control back. */
  _wake(ctx = this.ctx) {
    this.idle = 0;
    if (this.posed) this.posed = null;
    if (this.cine.active) this.cine.stop();
  }

  // ------------------------------------------------------------------ input --

  _bind(ctx) {
    const el = ctx.renderer.domElement;
    this._el = el;

    // `releasePointerCapture` throws NotFoundError if the capture has already
    // gone (which is exactly the case inside `lostpointercapture`), and an
    // uncaught throw here would be a console error the review harness fails on.
    const release = (id) => { try { el.releasePointerCapture?.(id); } catch { /* already gone */ } };

    const onDown = (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
      try { el.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
      this._mode = (e.button === 2 || e.shiftKey) ? 'pan' : 'orbit';
      if (this._pointers.size === 2) { this._mode = 'pan'; this._pinch = this._gap(); this._mid(this._centroid); }
      this.vAz = this.vEl = 0;
      this._flickAz = this._flickEl = 0;
      this._wake(ctx);
    };

    const onMove = (e) => {
      const p = this._pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      this._wake(ctx);

      if (this._pointers.size >= 2) {
        // Pinch = dolly, centroid travel = pan.
        const gap = this._gap();
        if (this._pinch > 1 && gap > 1) this._dolly(Math.log(this._pinch / gap) * 1.35);
        this._pinch = gap;
        const prev = this._centroid.x, prevY = this._centroid.y;
        this._mid(this._centroid);
        this._panBy(this._centroid.x - prev, this._centroid.y - prevY, ctx);
        return;
      }
      if (this._mode === 'pan') this._panBy(dx, dy, ctx);
      else this._orbitBy(dx, dy, ctx);
    };

    const onUp = (e) => {
      this._pointers.delete(e.pointerId);
      release(e.pointerId);
      if (this._pointers.size < 2) this._pinch = 0;
      if (this._pointers.size === 1) {
        // A pinch that has lost a finger must not strand the survivor in pan
        // mode until every finger lifts. Re-baseline so there is no jump.
        this._mode = 'orbit';
        this._mid(this._centroid);
      } else if (this._pointers.size === 0) {
        this._mode = null;
      }
    };

    const onWheel = (e) => {
      e.preventDefault();
      // Normalise line/page deltas so a trackpad and a mouse wheel agree.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      this._dolly(clamp(e.deltaY * unit * 0.0016, -0.5, 0.5));
      this._wake(ctx);
    };

    const onContext = (e) => e.preventDefault();

    // Keyboard orbit — the only way a keyboard-only visitor can look around.
    const onKey = (e) => {
      // Never swallow a browser/OS shortcut (⌘←, Alt+→, Ctrl+…).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' ||
                t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // Focus inside the overlay belongs to the overlay: arrow keys there are
      // for moving between controls, not for flying the camera around behind
      // the panel the visitor is reading.
      if (t?.closest?.('#vx')) return;

      const step = e.shiftKey ? 3 : 1;
      let hit = true;
      switch (e.key) {
        case 'ArrowLeft':  this._orbitBy(-18 * step, 0, ctx, false); break;
        case 'ArrowRight': this._orbitBy(18 * step, 0, ctx, false); break;
        case 'ArrowUp':    this._orbitBy(0, -14 * step, ctx, false); break;
        case 'ArrowDown':  this._orbitBy(0, 14 * step, ctx, false); break;
        case '+': case '=': this._dolly(-0.12 * step); this._wake(ctx); break;
        case '-': case '_': this._dolly(0.12 * step); this._wake(ctx); break;
        case 'Home': this.reset(); break;
        default: hit = false;
      }
      if (hit) e.preventDefault();
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove, { passive: true });
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('lostpointercapture', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', onContext);
    window.addEventListener('keydown', onKey);

    this._unbind = () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('lostpointercapture', onUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onKey);
    };
  }

  /** Back to the authored opening framing. */
  reset() {
    this._wake();
    this.d.az = 39.8 * DEG;
    this.d.el = 4.2 * DEG;
    this.d.dist = 2.3;
    this.panD.set(0, 0, 0);
    this.vAz = this.vEl = 0;
    this._flickAz = this._flickEl = 0;
  }

  _gap() {
    const it = this._pointers.values();
    const a = it.next().value, b = it.next().value;
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  _mid(out) {
    let x = 0, y = 0, n = 0;
    for (const p of this._pointers.values()) { x += p.x; y += p.y; n++; }
    out.x = n ? x / n : 0; out.y = n ? y / n : 0;
  }

  /** Radians per pixel, tied to viewport height so it feels the same anywhere. */
  _radPerPx(ctx) { return Math.PI / Math.max(360, ctx.size?.y || 800); }

  /**
   * `momentum` is false for discrete input (keys): a key press is a step, not
   * a throw, and feeding it into the flick estimator would launch the camera
   * into a long glide on every tap of an arrow key.
   */
  _orbitBy(dx, dy, ctx, momentum = true) {
    this._wake(ctx);
    const k = this._radPerPx(ctx);
    // Resistance builds as the desired elevation leaves the legal band.
    const over = Math.max(0, this.d.el - EL_MAX) + Math.max(0, EL_MIN - this.d.el);
    const give = 1 - 0.75 * saturate(over / (14 * DEG));
    const dAz = -dx * k * ROT_GAIN;
    const dEl = dy * k * give;
    this.d.az += dAz;
    this.d.el = rubber(this.d.el + dEl, EL_MIN, EL_MAX, 9 * DEG);
    if (momentum) {
      this._flickAz += dAz;
      this._flickEl += dEl;
    } else {
      this._flickAz = this._flickEl = 0;
      this.vAz = this.vEl = 0;
    }
  }

  _dolly(amount) {
    // Release the latch first: stopping cinematics rewrites `d` from `c`, so
    // applying the delta before that would silently discard it.
    this._wake();
    // Multiplicative: the same flick moves you the same *fraction* of the way
    // in, at any range. Distance, never fov — perspective stays flattering.
    this.d.dist = rubber(this.d.dist * Math.exp(amount), DIST_MIN, DIST_MAX, 0.9);
  }

  _panBy(dx, dy, ctx) {
    this._wake(ctx);
    const h = Math.max(360, ctx.size?.y || 800);
    // The EFFECTIVE fov: on a phone the vertical field is far wider than the
    // authored one, and panning by the authored number would crawl.
    const perPx = (2 * this.c.dist * Math.tan(this.fovEffective * 0.5 * DEG)) / h;
    // 0.55: panning is deliberately less authoritative than orbiting — this is
    // a portrait of an animal, not a level editor.
    this.panD.addScaledVector(this._right, -dx * perPx * 0.55)
            .addScaledVector(this._up, dy * perPx * 0.55);
    this._softenPan(this.panD);
  }

  _softenPan(v) {
    const len = v.length();
    if (len > PAN_SOFT) v.multiplyScalar(rubber(len, 0, PAN_SOFT, PAN_MAX - PAN_SOFT) / len);
  }

  // -------------------------------------------------------------- cinematics --

  get cinematic() { return this.cine.active; }
  setCinematic(on) { if (on) this.cine.start(); else this.cine.stop(); return this.cine.active; }
  toggleCinematic() { return this.setCinematic(!this.cine.active); }

  // ------------------------------------------------------------------ update --

  update(dt, ctx) {
    // A latched pose owns the camera completely. Re-assert rather than trust
    // that nothing else moved it, so N settle ticks == 0 settle ticks.
    if (this.posed) {
      const p = this.posed, cam = ctx.camera;
      cam.up.set(0, 1, 0);
      cam.position.set(p.pos[0], p.pos[1], p.pos[2]);
      cam.lookAt(this._v0.set(p.target[0], p.target[1], p.target[2]));
      this._applyFov(ctx, p.fov);
      cam.updateMatrixWorld(true);
      ctx.focusDistance = p.focus;
      return;
    }

    dt = clamp(dt, 0, 1 / 12);
    this._trackSubject(ctx, dt, false);

    // --- attract mode ------------------------------------------------------
    const interacting = this._pointers.size > 0;
    if (interacting) this.idle = 0; else this.idle += dt;
    if (!this.reducedMotion && !this.cine.active && this.idle > Cinematics.IDLE_DELAY) {
      this.cine.start();
    }
    if (this.cine.active) this.cine.update(dt, ctx);

    // --- throw estimate ----------------------------------------------------
    // Convert the input accumulated during THIS frame into an angular rate.
    // Framerate- and pointer-rate-independent by construction: 8 coalesced
    // moves in one frame and 1 move in one frame give the same rad/s.
    if (dt > 1e-5) {
      if (interacting) {
        this.vAz = damp(this.vAz, (this._flickAz / dt) * FLICK_GAIN, FLICK_RATE, dt);
        this.vEl = damp(this.vEl, (this._flickEl / dt) * FLICK_GAIN, FLICK_RATE, dt);
      }
      this._flickAz = this._flickEl = 0;
    }

    // --- glide after release ----------------------------------------------
    if (!interacting && !this.cine.active) {
      this.d.az += this.vAz * dt;
      this.d.el = rubber(this.d.el + this.vEl * dt, EL_MIN, EL_MAX, 9 * DEG);
      const k = Math.exp(-MOMENTUM_DECAY * dt);
      this.vAz *= k; this.vEl *= k;
      if (Math.abs(this.vAz) < 1e-4) this.vAz = 0;
      if (Math.abs(this.vEl) < 1e-4) this.vEl = 0;
    }

    // --- ease the desired state back inside the legal band ----------------
    if (!this.cine.active) {
      this.d.el = damp(this.d.el, clamp(this.d.el, EL_MIN, EL_MAX), 4.5, dt);
      this.d.dist = damp(this.d.dist, clamp(this.d.dist, DIST_MIN, DIST_MAX), 4.5, dt);
      const len = this.panD.length();
      if (len > PAN_SOFT) this.panD.multiplyScalar(damp(len, PAN_SOFT, 1.1, dt) / len);
    }

    const cine = this.cine.active;
    this.c.az = damp(this.c.az, this.d.az, cine ? CINE_RATE : ROT_RATE, dt);
    this.c.el = damp(this.c.el, this.d.el, cine ? CINE_RATE : ROT_RATE, dt);
    this.c.dist = damp(this.c.dist, this.d.dist, cine ? CINE_RATE : DIST_RATE, dt);
    this.pan.lerp(this.panD, 1 - Math.exp(-(cine ? CINE_RATE : PAN_RATE) * dt));

    this._compose(ctx, dt);
  }

  /** Where is the animal, where is it going, and where is its head? */
  _trackSubject(ctx, dt, snap) {
    const subj = ctx.subjectPosition;
    const sp = subj ? this._v0.copy(subj) : this._v0.set(0, 0.26, 0);

    if (snap) {
      this.follow.copy(sp); this.subjPrev.copy(sp); this.subjVel.set(0, 0, 0);
    } else if (dt > 1e-5) {
      this._v1.copy(sp).sub(this.subjPrev).divideScalar(dt);
      this.subjVel.lerp(this._v1, 1 - Math.exp(-6 * dt));
      this.subjPrev.copy(sp);
      // Lag behind, then lead into the travel direction: an operator panning.
      const lead = this._v1.copy(this.subjVel).multiplyScalar(LEAD_TIME);
      if (lead.length() > LEAD_MAX) lead.setLength(LEAD_MAX);
      this.follow.lerp(sp.add(lead), 1 - Math.exp(-FOLLOW_RATE * dt));
    }

    // Head point drives focus and the close-range framing. The anatomy agent
    // owns these anchors and may not have built them yet.
    const a = ctx.fox?.anchors;
    const eyeL = a?.eyeL, eyeR = a?.eyeR, nose = a?.nose;
    let got = false;
    if (eyeL?.matrixWorld && eyeR?.matrixWorld) {
      eyeL.updateWorldMatrix?.(true, false); eyeR.updateWorldMatrix?.(true, false);
      this.headPoint.setFromMatrixPosition(eyeL.matrixWorld)
        .add(this._v1.setFromMatrixPosition(eyeR.matrixWorld)).multiplyScalar(0.5);
      got = true;
    } else {
      for (const o of [eyeL, nose, a?.head]) {
        if (o?.matrixWorld) {
          o.updateWorldMatrix?.(true, false);
          this.headPoint.setFromMatrixPosition(o.matrixWorld);
          got = true;
          break;
        }
      }
    }
    if (!got || !Number.isFinite(this.headPoint.x)) {
      const s = ctx.subjectPosition;
      this.headPoint.set(s ? s.x : 0, (s ? s.y : 0.26) + 0.05, s ? s.z : 0);
    }
  }

  /** Build the final camera transform from rig state. */
  _compose(ctx, dt) {
    const cam = ctx.camera;

    // Orbit centre: the body, drifting up to the head as we push in close.
    const closeness = 1 - smoothstep(0.55, 1.6, this.c.dist);
    this.centre.copy(this.follow).add(this.pan);
    this.centre.lerp(this._v0.copy(this.headPoint).add(this.pan), closeness * 0.85);

    // Elevation guard: keep the lens above the snow even at full extension.
    // Two passes — correcting the elevation moves the camera horizontally too,
    // so the first ground sample was taken at a point we are no longer over.
    let el = clamp(this.c.el, EL_MIN, EL_MAX);
    for (let i = 0; i < 2; i++) {
      const ce = Math.cos(el), se = Math.sin(el);
      const px = this.centre.x + this.c.dist * ce * Math.sin(this.c.az);
      const pz = this.centre.z + this.c.dist * ce * Math.cos(this.c.az);
      const ground = ctx.terrain?.heightAt ? (ctx.terrain.heightAt(px, pz) ?? 0) : 0;
      const minY = ground + GROUND_CLEARANCE;
      if (this.centre.y + this.c.dist * se >= minY) break;
      el = clamp(Math.asin(clamp((minY - this.centre.y) / Math.max(this.c.dist, 1e-3), -1, 1)),
                 EL_MIN, EL_MAX);
    }

    // Long-lens by default; widen only as we pull out.
    if (!this.cine.active) this.fovTarget = lerp(FOV_LONG, FOV_WIDE, smoothstep(0.6, 6.5, this.c.dist));
    this.fov = dt > 0 ? damp(this.fov, this.fovTarget, FOV_RATE, dt) : this.fovTarget;
    this._applyFov(ctx, this.fov);

    const c2 = Math.cos(el), s2 = Math.sin(el);
    cam.position.set(
      this.centre.x + this.c.dist * c2 * Math.sin(this.c.az),
      this.centre.y + this.c.dist * s2,
      this.centre.z + this.c.dist * c2 * Math.cos(this.c.az),
    );

    // --- framing (bible §9: rule of thirds, horizon never dead-centre) ----
    // A vertical shift of the aim point, authored in frame-heights: aiming up
    // drops both the subject and the horizon into the lower third; aiming down
    // lifts a close-up head onto the upper third. Authoring in frame-heights
    // is what makes this survive the aspect fit — the subject lands on the
    // same THIRD on a phone as on a desktop, only the field around it grows.
    this._fwd.copy(this.centre).sub(cam.position).normalize();
    this._right.set(this._fwd.z, 0, -this._fwd.x);
    if (this._right.lengthSq() < 1e-8) this._right.set(1, 0, 0);
    this._right.normalize();
    this._up.copy(this._right).cross(this._fwd).normalize();

    const frameH = 2 * this.c.dist * Math.tan(this.fovEffective * 0.5 * DEG);
    let s = lerp(0.145, -0.150, closeness);
    s *= lerp(1, 0.45, smoothstep(6 * DEG, 40 * DEG, el));
    this.biasTarget = (this.cine.active ? this.cine.bias ?? s : s) * frameH;
    this.bias = dt > 0 ? damp(this.bias, this.biasTarget, BIAS_RATE, dt) : this.biasTarget;

    this.aim.copy(this.centre).addScaledVector(this._up, this.bias);

    // --- handheld ----------------------------------------------------------
    // Never while posed (we returned early), never while the app is paused,
    // never under prefers-reduced-motion. fbm of ctx.time only.
    let rx = 0, ry = 0;
    if (this._alive(ctx)) {
      const t = ctx.time;
      const amp = 0.0015 * lerp(0.45, 1, saturate(this.c.dist / 3));
      this._noise.set(fbm1(t * 0.37, 3, 11), fbm1(t * 0.31 + 3.1, 3, 23), fbm1(t * 0.29 + 7.7, 3, 37));
      // Breathing: a slow, almost-subliminal vertical swell.
      const breath = Math.sin(t * 1.35) * 0.0008;
      cam.position.addScaledVector(this._noise, amp);
      cam.position.y += breath;
      rx = fbm1(t * 0.23 + 1.7, 2, 51) * 0.18 * DEG;
      ry = fbm1(t * 0.19 + 5.3, 2, 67) * 0.18 * DEG;
    }

    cam.up.set(0, 1, 0);
    cam.lookAt(this.aim);
    if (rx || ry) { cam.rotateX(rx); cam.rotateY(ry); }
    cam.updateMatrixWorld(true);

    // --- focus -------------------------------------------------------------
    const want = clamp(cam.position.distanceTo(this.headPoint), 0.08, 60);
    const target = this.cine.active && this.cine.focus ? this.cine.focus : want;
    const prev = Number.isFinite(ctx.focusDistance) ? ctx.focusDistance : target;
    ctx.focusDistance = dt > 0 ? damp(prev, target, FOCUS_RATE, dt) : target;
  }

  _alive(ctx) {
    return !this.reducedMotion && ctx.app?.running !== false && !this.posed;
  }

  resize(w, h, ctx) {
    if (this.posed) { this.applyPose(this.posed, ctx); return; }
    // Not posed: the aspect changed under us, so re-fit the authored fov. The
    // app may be paused (the harness drives frames by hand), in which case
    // update() will not run and this is the only chance to get it right.
    this._applyFov(ctx, this.fov);
  }

  dispose() {
    this._unbind?.();
    try { this._mq?.removeEventListener('change', this._onMq); } catch { /* ignore */ }
  }
}
