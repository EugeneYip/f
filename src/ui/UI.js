import './ui.css';
import { clamp } from '../util/math.js';

/**
 * The interface.
 *
 * Design brief: a gallery wall label, not a dev tool. Hairlines, wide
 * letterspacing, one cool accent lifted from the snow-bounce colour, and
 * nothing on screen that isn't earning its place.
 *
 * Four structural decisions worth knowing about:
 *
 *  1. The loading screen is built in the *constructor*, not `init()`. Systems
 *     register before `App.init()` runs, but this system's `order` is 960 —
 *     `init()` would not be called until the scene was almost finished
 *     building, which is far too late to show a loader.
 *  2. The UI drives itself from its own loop, never from `update()`. The
 *     screenshot harness calls `app.stop()`, and the Space shortcut pauses the
 *     app, so anything depending on the system loop would freeze.
 *  3. That loop has TWO independent drivers — requestAnimationFrame AND a
 *     setTimeout chain — because rAF is not a clock. When the review harness
 *     drives frames synchronously inside one `page.evaluate`, or when a real
 *     device is busy with a slow first paint, rAF can go hundreds of
 *     milliseconds between callbacks or not fire at all. The loader used to
 *     depend on rAF *tick count* (`p += (target - p) * 0.11`, ~40 ticks to
 *     finish) and simply never dismissed. Everything time-varying here is now
 *     a function of ELAPSED TIME, so one tick after a two-second gap lands in
 *     exactly the same place as sixty ticks would have. Each driver re-arms
 *     only itself and only when its own handle is clear, so no call path can
 *     start a second concurrent chain.
 *  4. Timing here uses the rAF/`performance.now()` wall clock. That is
 *     forbidden by the engineering contract for *animation* — but none of it
 *     reaches the rendered image: it only drives DOM chrome that is hidden
 *     before any screenshot, plus the loader's fail-safe.
 */

const TIERS = [['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['ultra', 'Ultra']];
const STATES = ['idle', 'sit', 'walk', 'trot', 'run'];

/** Timer-driver period. Fast enough to look smooth on its own if rAF dies. */
const TICK_MS = 32;
/** Fail-safe: the loader goes away even if the scene never reports ready. */
const BAIL_MS = 22000;
/**
 * Minimum time the loader is on screen, measured from when it APPEARS — not
 * from when readiness is first observed. Those are the same thing on a real
 * page, but not under the review harness: there, readiness is observed after a
 * multi-second synchronous `settle()` during which no timer and no rAF can
 * run, so a hold counted from first observation needed a SECOND tick 420 ms
 * later that the harness never gave it, and the loading screen was still
 * covering the frame when the screenshot was taken.
 */
const MIN_SHOW_MS = 650;
/** A tick gap longer than this means frames are not flowing at all. */
const STALLED_MS = 250;

/** System names → something a visitor can read. */
const STEP_LABEL = {
  environment: 'Lighting the field',
  sky: 'Building the sky',
  aurora: 'Hanging the aurora',
  terrain: 'Carving the snow',
  footprints: 'Pressing the snow',
  fox: 'Shaping the animal',
  foxAnim: 'Teaching it to walk',
  foxBrain: 'Waking it up',
  fur: 'Growing the winter coat',
  furCards: 'Combing the ruff',
  eyes: 'Setting the eyes',
  face: 'Setting the eyes',
  whiskers: 'Placing whiskers',
  snowParticles: 'Releasing the snow',
  breath: 'Warming its breath',
  cameraRig: 'Placing the camera',
  ui: 'Interface',
  postfx: 'Grading',
  debug: 'Review harness',
  ready: 'Ready',
};

const KEYS = [
  ['Drag', 'Orbit'],
  ['Scroll', 'Dolly'],
  ['↑↓←→', 'Orbit'],
  ['+ −', 'Dolly'],
  ['Home', 'Reset view'],
  ['C', 'Cinematic camera'],
  ['Space', 'Play / pause'],
  ['1–4', 'Quality'],
  ['P', 'Performance'],
  ['H', 'Hide interface'],
  ['?', 'Open controls'],
];

/** What a screen reader is told the canvas contains. */
const SCENE_LABEL =
  'An arctic fox in winter coat, standing on a wind-carved snowfield at polar ' +
  'twilight. A low sun behind it rims its fur with light; a faint aurora hangs ' +
  'overhead. Interactive: the view can be orbited.';

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export class UI {
  name = 'ui';
  order = 960;

  constructor() {
    this._perf = false;
    this._hidden = false;
    this._loaderGone = false;
    this._fading = false;
    this._fadeT0 = 0;
    this._p = 0;
    this._pTarget = 0;
    this._stepName = '';
    this._tPrev = 0;
    this._t0 = 0;
    this._gap = 0;
    this._raf = 0;
    this._timer = 0;
    this._lastPerf = 0;
    this._touched = false;
    this._reduced = false;
    this._timeouts = [];
    try { this._reduced = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* ignore */ }

    // Never let a DOM problem take the scene down with it.
    try { this._buildShell(); } catch (e) { console.warn('[ui] shell failed', e); }
  }

  _now() {
    try { return performance.now(); } catch { return Date.now(); }
  }

  /** setTimeout that is guaranteed to be cleaned up on dispose(). */
  _later(fn, ms) {
    const id = setTimeout(() => {
      this._timeouts = this._timeouts.filter((t) => t !== id);
      fn();
    }, ms);
    this._timeouts.push(id);
    return id;
  }

  // ------------------------------------------------------------------ shell --

  _buildShell() {
    const host = document.getElementById('ui') || document.body;
    const root = this.root = h('div');
    root.id = 'vx';

    // A heading that OUTLIVES the loader. The only <h1> used to live inside
    // the loading screen, which is removed from the DOM ~1 s after load, so
    // the finished document had no heading at all.
    root.appendChild(h('h1', 'vx-sr', 'Vulpes — an arctic fox'));

    // Keyboard help, for the canvas's aria-describedby. Visually hidden; the
    // same list is shown sighted in the controls panel.
    const help = h('div', 'vx-sr');
    help.id = 'vx-help';
    help.textContent =
      'Use the arrow keys to orbit the camera, plus and minus to move closer ' +
      'or further, Home to reset the view, and C to start the cinematic ' +
      'camera. Press question mark to open the controls panel.';
    root.appendChild(help);

    // --- loader ------------------------------------------------------------
    const loader = this.loader = h('div', 'vx-loader');
    loader.setAttribute('role', 'status');
    loader.setAttribute('aria-live', 'polite');
    const lin = h('div', 'vx-loader-in');
    // Decorative: the real heading is the persistent one above, and the
    // status region should announce the STEP, not the wordmark.
    const mark = h('div', 'vx-mark', 'Vulpes');
    mark.setAttribute('aria-hidden', 'true');
    lin.appendChild(mark);
    const track = h('div', 'vx-track');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', 'Loading progress');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', '0');
    this.track = track;
    this.bar = h('i');
    track.appendChild(this.bar);
    lin.appendChild(track);
    this.step = h('p', 'vx-step', '');
    lin.appendChild(this.step);
    loader.appendChild(lin);
    root.appendChild(loader);

    // --- title / credit ----------------------------------------------------
    const title = this.title = h('div', 'vx-title');
    title.appendChild(h('div', 'vx-rule'));
    const sp = h('div', 'vx-sp');
    sp.appendChild(h('em', null, 'Vulpes lagopus'));
    title.appendChild(sp);
    title.appendChild(h('div', 'vx-cap', 'Arctic fox — realtime'));
    root.appendChild(title);

    // --- first-run hint ----------------------------------------------------
    // The only affordance used to be one icon in a corner. Nothing said the
    // scene was interactive at all.
    // "Scroll to move closer" is meaningless on a phone, and the long form
    // wrapped to three ragged lines at 390 px.
    const touch = (navigator.maxTouchPoints || 0) > 0;
    let narrow = false;
    try { narrow = matchMedia('(max-width: 560px)').matches; } catch { /* ignore */ }
    this.hint = h('div', 'vx-hint',
      touch ? 'Drag to look · pinch to zoom'
            : narrow ? 'Drag to look · scroll to zoom'
                     : 'Drag to look · scroll to move closer');
    this.hint.setAttribute('aria-hidden', 'true');
    root.appendChild(this.hint);

    root.appendChild(this._buildPerf());
    root.appendChild(this._buildDock());

    this.paused = h('div', 'vx-paused', 'Paused');
    this.paused.setAttribute('aria-hidden', 'true');
    root.appendChild(this.paused);

    this.dip = h('div', 'vx-dip');
    this.dip.setAttribute('aria-hidden', 'true');
    root.appendChild(this.dip);

    // Keyboard focus indicator for the canvas. An outline on a viewport-sized
    // <canvas> is half off-screen, so the ring is drawn on this overlay.
    this.ring = h('div', 'vx-ring');
    this.ring.setAttribute('aria-hidden', 'true');
    root.appendChild(this.ring);

    host.appendChild(root);

    // Fail-safe: whatever else happens, the loader goes away. The normal path
    // is readiness-driven (see _tickLoader); this only catches a scene that
    // never reports ready at all.
    this._bail = this._later(() => this._dismiss('fail-safe'), BAIL_MS);
    this._schedule();
  }

  _buildPerf() {
    const perf = this.perfBox = h('div', 'vx-perf');
    perf.hidden = true;
    perf.setAttribute('aria-hidden', 'true');
    this._pf = {};
    for (const [key, label] of [['fps', 'fps'], ['ms', 'frame'], ['calls', 'draws'],
      ['tris', 'tris'], ['tier', 'tier']]) {
      perf.appendChild(h('b', null, label));
      const v = h('span', null, '—');
      this._pf[key] = v.firstChild ?? v.appendChild(document.createTextNode('—'));
      perf.appendChild(v);
    }
    return perf;
  }

  _buildDock() {
    const dock = h('div', 'vx-dock');

    // Toggle first in the DOM (so Tab reaches it before the panel) but last
    // visually — the dock is column-reverse.
    const btn = this.toggleBtn = h('button', 'vx-toggle');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'vx-panel');
    btn.setAttribute('aria-label', 'Open controls and keyboard shortcuts');
    btn.innerHTML =
      '<svg class="vx-i" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">' +
      '<path d="M1 5.5h16M1 12.5h16" stroke="currentColor" stroke-width="1" fill="none"/>' +
      '<circle cx="6" cy="5.5" r="2.1" fill="currentColor"/>' +
      '<circle cx="12" cy="12.5" r="2.1" fill="currentColor"/></svg>' +
      '<svg class="vx-x" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">' +
      '<path d="M4 4l10 10M14 4L4 14" stroke="currentColor" stroke-width="1" fill="none"/></svg>';
    btn.addEventListener('click', () => this._setPanel(!this._open));
    dock.appendChild(btn);

    const panel = this.panel = h('div', 'vx-panel');
    panel.id = 'vx-panel';
    panel.hidden = true;
    // An aria-label on a bare <div> is ignored by most screen readers; it
    // needs a role to hang off.
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'Controls');
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this._setPanel(false); this.toggleBtn.focus(); }
    });
    dock.appendChild(panel);
    return dock;
  }

  // ------------------------------------------------------------------- init --

  init(ctx) {
    this.ctx = ctx;
    ctx.ui = this;
    this.autoTier = ctx.quality.tier;
    try { this._describeCanvas(ctx); } catch (e) { console.warn('[ui] canvas a11y failed', e); }
    try { this._buildPanel(ctx); } catch (e) { console.warn('[ui] panel failed', e); }
    this._bindKeys(ctx);

    this._offQuality = ctx.quality.onChange((e) => {
      if (e.type === 'tier' || e.type === 'override') this._syncQuality();
    });

    // First interaction dims the credit and retires the hint.
    const touch = () => {
      if (this._touched) return;
      this._touched = true;
      this.title?.classList.add('vx-dim');
      this._hideHint();
    };
    this._touch = touch;
    for (const ev of ['pointerdown', 'wheel', 'keydown', 'touchstart']) {
      window.addEventListener(ev, touch, { passive: true, once: false });
    }
  }

  /**
   * WCAG 1.1.1: the canvas is the entire content of the page and had no
   * accessible name, role or text alternative — a screen-reader user got
   * nothing whatsoever. `index.html` belongs to the orchestrator, so the
   * attributes are applied here, to the renderer's own element.
   */
  _describeCanvas(ctx) {
    const cv = ctx.renderer?.domElement;
    if (!cv) return;
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', SCENE_LABEL);
    if (document.getElementById('vx-help')) cv.setAttribute('aria-describedby', 'vx-help');
    // Focusable, so a keyboard visitor can deliberately take the camera and
    // so the arrow keys have an owner. Also gives the canvas a focus ring.
    if (!cv.hasAttribute('tabindex')) cv.tabIndex = 0;
    // Fallback content: read by assistive tech that ignores the role/label.
    if (!cv.firstChild) cv.appendChild(document.createTextNode(SCENE_LABEL));

    // Show the ring for KEYBOARD focus only — a ring around the whole viewport
    // every time somebody clicks the scene would be intolerable.
    const onFocus = () => {
      let kb = true;
      try { kb = cv.matches(':focus-visible'); } catch { /* old browser: show it */ }
      this.root?.classList.toggle('vx-cvfocus', kb);
    };
    const onBlur = () => this.root?.classList.remove('vx-cvfocus');
    cv.addEventListener('focus', onFocus);
    cv.addEventListener('blur', onBlur);
    this._offCanvas = () => {
      cv.removeEventListener('focus', onFocus);
      cv.removeEventListener('blur', onBlur);
    };
    this._canvas = cv;
  }

  _buildPanel(ctx) {
    const panel = this.panel;
    if (!panel) return;

    // --- quality -----------------------------------------------------------
    {
      const sec = h('div', 'vx-sec');
      const lab = h('div', 'vx-lab');
      lab.appendChild(h('span', null, 'Quality'));
      lab.appendChild(h('var', null, `auto · ${this.autoTier}`));
      sec.appendChild(lab);
      const seg = h('div', 'vx-seg');
      this._tierBtns = {};
      for (const [key, label] of TIERS) {
        const b = h('button', null, label);
        b.type = 'button';
        b.setAttribute('aria-label', `Quality ${label}`);
        b.setAttribute('aria-pressed', String(ctx.quality.tier === key));
        b.addEventListener('click', () => { ctx.quality.setTier(key); this._syncQuality(); });
        this._tierBtns[key] = b;
        seg.appendChild(b);
      }
      sec.appendChild(seg);
      sec.appendChild(this._switch('Adaptive resolution', 'Adaptive', !!ctx.quality.adaptive,
        (on) => { ctx.quality.adaptive = on; }));
      panel.appendChild(sec);
    }

    // --- time of day (only if the sky system is there to hear it) ----------
    const sky = ctx.systemsByName.get('sky');
    if (sky && typeof sky.setElevation === 'function') {
      const d = ctx.sunDirection;
      const elev = Math.asin(clamp(d.y, -1, 1)) * 180 / Math.PI;
      this._azi = Math.atan2(d.x, d.z) * 180 / Math.PI;
      const { sec, input, out } = this._slider('Time of day', -4, 22, 0.2, elev, '°');
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        out.nodeValue = `${v.toFixed(1)}°`;
        try { sky.setElevation(v, this._azi); } catch { /* sky's problem */ }
      });
      panel.appendChild(sec);
    }

    // --- wind --------------------------------------------------------------
    {
      const { sec, input, out } = this._slider('Wind', 0, 12, 0.1, ctx.windSpeed ?? 2.4, ' m/s');
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        out.nodeValue = `${v.toFixed(1)} m/s`;
        ctx.windSpeed = v;
      });
      panel.appendChild(sec);
    }

    // --- behaviour ---------------------------------------------------------
    {
      const sec = this._behaviourSec = h('div', 'vx-sec');
      const lab = h('div', 'vx-lab');
      lab.appendChild(h('span', null, 'Behaviour'));
      sec.appendChild(lab);
      const seg = h('div', 'vx-seg vx-wrap');
      this._stateBtns = {};
      for (const s of STATES) {
        const b = h('button', null, s);
        b.type = 'button';
        b.setAttribute('aria-label', `Behaviour: ${s}`);
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', () => this._forceState(s));
        this._stateBtns[s] = b;
        seg.appendChild(b);
      }
      sec.appendChild(seg);
      panel.appendChild(sec);
      this._syncBrain();
    }

    // --- camera ------------------------------------------------------------
    {
      const sec = h('div', 'vx-sec');
      this._cineSw = this._switch('Cinematic camera', 'Cinematic',
        !!ctx.cameraRig?.cinematic, (on) => { ctx.cameraRig?.setCinematic?.(on); });
      sec.appendChild(this._cineSw);
      const reset = h('button', 'vx-sw vx-act');
      reset.type = 'button';
      reset.setAttribute('aria-label', 'Reset the view');
      reset.appendChild(h('span', null, 'Reset view'));
      reset.appendChild(h('em', null, 'Home'));
      reset.addEventListener('click', () => ctx.cameraRig?.reset?.());
      sec.appendChild(reset);
      panel.appendChild(sec);
    }

    // --- shortcuts ---------------------------------------------------------
    {
      const sec = h('div', 'vx-sec');
      const lab = h('div', 'vx-lab');
      lab.appendChild(h('span', null, 'Controls'));
      sec.appendChild(lab);
      const dl = h('dl', 'vx-keys');
      for (const [k, v] of KEYS) { dl.appendChild(h('dt', null, k)); dl.appendChild(h('dd', null, v)); }
      sec.appendChild(dl);
      sec.appendChild(h('p', 'vx-note', 'Two fingers to pan or pinch'));
      panel.appendChild(sec);
    }
  }

  _switch(aria, label, on, fn) {
    const b = h('button', 'vx-sw');
    b.type = 'button';
    b.setAttribute('aria-label', aria);
    b.setAttribute('aria-pressed', String(!!on));
    b.appendChild(h('span', null, label));
    b.appendChild(h('i'));
    b.addEventListener('click', () => {
      const next = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(next));
      fn(next);
    });
    return b;
  }

  _slider(label, min, max, stepv, value, unit) {
    const sec = h('div', 'vx-sec');
    const lab = h('div', 'vx-lab');
    lab.appendChild(h('span', null, label));
    const v = h('var');
    const out = v.appendChild(document.createTextNode(
      `${(+value).toFixed(1)}${unit}`));
    lab.appendChild(v);
    sec.appendChild(lab);
    const input = h('input');
    input.type = 'range';
    input.min = String(min); input.max = String(max);
    input.step = String(stepv); input.value = String(value);
    input.setAttribute('aria-label', label);
    sec.appendChild(input);
    return { sec, input, out };
  }

  // ---------------------------------------------------------------- actions --

  _setPanel(open) {
    this._open = !!open;
    if (!this.panel) return;
    this.panel.hidden = !open;
    this.toggleBtn.setAttribute('aria-expanded', String(!!open));
    this.toggleBtn.setAttribute('aria-label',
      open ? 'Close controls' : 'Open controls and keyboard shortcuts');
    if (open) {
      // Other systems may have arrived (or failed) since we built the panel.
      this._syncQuality();
      this._syncBrain();
      this._syncCine();
      if (!this._reduced) {
        this.panel.classList.remove('vx-anim');
        void this.panel.offsetWidth;
        this.panel.classList.add('vx-anim');
      }
    }
  }

  _hideHint() {
    if (!this.hint || this._hintGone) return;
    this._hintGone = true;
    this.hint.classList.remove('vx-in');
    this._later(() => { this.hint?.remove(); this.hint = null; }, 900);
  }

  _forceState(s) {
    const brain = this.ctx?.systemsByName.get('foxBrain');
    if (typeof brain?.forceState !== 'function') return;
    try { brain.forceState(s); } catch (e) { console.warn('[ui] forceState', e); }
    for (const k of STATES) this._stateBtns?.[k]?.setAttribute('aria-pressed', String(k === s));
  }

  _syncQuality() {
    const q = this.ctx?.quality;
    if (!q || !this._tierBtns) return;
    for (const [key] of TIERS) this._tierBtns[key]?.setAttribute('aria-pressed', String(q.tier === key));
  }

  _syncBrain() {
    const ok = typeof this.ctx?.systemsByName.get('foxBrain')?.forceState === 'function';
    for (const s of STATES) {
      const b = this._stateBtns?.[s];
      if (!b) continue;
      b.disabled = !ok;
      b.setAttribute('aria-disabled', String(!ok));
    }
  }

  _syncCine() {
    this._cineSw?.setAttribute('aria-pressed', String(!!this.ctx?.cameraRig?.cinematic));
  }

  /** Called by CameraRig/Cinematics when attract mode starts or stops. */
  onCinematic(on) {
    this._syncCine();
    // The credit comes back up when the piece starts playing itself again.
    if (this.title) this.title.classList.toggle('vx-dim', !on && this._touched);
  }

  /** Called by Cinematics on a cut: a short dissolve instead of a whip pan. */
  flashCut(seconds = 0.42) {
    const d = this.dip;
    if (!d || this._reduced) return;
    d.style.setProperty('--vx-cut', `${seconds}s`);
    d.classList.remove('vx-cut');
    void d.offsetWidth;
    d.classList.add('vx-cut');
  }

  setHidden(hidden) {
    this._hidden = !!hidden;
    this.root?.classList.toggle('vx-hidden', this._hidden);
    if (this._hidden) this._setPanel(false);
  }

  setPerf(on) {
    this._perf = !!on;
    if (this.perfBox) {
      this.perfBox.hidden = !this._perf;
      // `hidden` and `aria-hidden` were set independently, so the readout was
      // permanently invisible to assistive tech even when shown.
      this.perfBox.setAttribute('aria-hidden', String(!this._perf));
    }
    if (this._perf) { this._tickPerf(); this._schedule(); }
  }

  _bindKeys(ctx) {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      // Let the browser activate a focused button instead of double-handling.
      if (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;

      switch (e.key) {
        case 'h': case 'H': this.setHidden(!this._hidden); break;
        case 'p': case 'P': this.setPerf(!this._perf); break;
        case 'c': case 'C':
          ctx.cameraRig?.toggleCinematic?.();
          this._syncCine();
          break;
        case '?': case '/':
          if (e.key === '/' && !e.shiftKey) return;
          this._setPanel(true);
          this.toggleBtn?.focus();
          break;
        case '1': case '2': case '3': case '4':
          ctx.quality.setTier(TIERS[+e.key - 1][0]);
          this._syncQuality();
          break;
        case ' ':
          if (ctx.app.running) { ctx.app.stop(); this._userPaused = true; }
          else { ctx.app.start(); this._userPaused = false; }
          this._syncPaused();
          break;
        case 'Escape':
          if (this._open) { this._setPanel(false); this.toggleBtn?.focus(); }
          return;
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    this._offKeys = () => window.removeEventListener('keydown', onKey);
  }

  _syncPaused() {
    // Deliberately gated on _userPaused: the screenshot harness stops the app
    // too, and a "Paused" chip in every review frame would be a bug.
    const on = !!this._userPaused && this.ctx?.app?.running === false && this._loaderGone;
    this.paused?.classList.toggle('vx-in', on);
  }

  // ------------------------------------------------------------------- loop --

  /**
   * Arm both drivers. Each guards its own handle, so however many call sites
   * ask for a tick there is never more than one rAF chain and one timer chain.
   */
  _schedule() {
    if (this._raf === 0) {
      try { this._raf = requestAnimationFrame(this._onRaf) || 0; } catch { this._raf = 0; }
    }
    if (this._timer === 0) this._timer = setTimeout(this._onTimer, TICK_MS);
  }

  _onRaf = () => { this._raf = 0; this._tick(); };
  _onTimer = () => { this._timer = 0; this._tick(); };

  _tick() {
    const now = this._now();
    this._gap = this._tickPrev ? now - this._tickPrev : 0;
    this._tickPrev = now;
    let again = false;
    if (!this._loaderGone) { this._tickLoader(now); again = true; }
    if (this._fading) { this._tickFade(now); again = true; }
    if (this._perf) {
      if (now - this._lastPerf > 250) { this._lastPerf = now; this._tickPerf(); }
      again = true;
    }
    if (again) this._schedule();
    else { this._tPrev = 0; }
  }

  _tickLoader(now) {
    if (!this._tPrev) this._tPrev = now;
    if (!this._t0) this._t0 = now;
    // Elapsed time, not tick count — see the note at the top of the file.
    const dt = clamp((now - this._tPrev) / 1000, 0, 0.5);
    this._tPrev = now;

    const prog = window.__FOX_PROGRESS;
    const ready = window.__FOX_READY === true;

    // Monotonic: a progress bar never runs backwards.
    const p = typeof prog?.p === 'number' ? prog.p : 0;
    if (p > this._pTarget) this._pTarget = p;
    if (ready) this._pTarget = 1;
    this._p += (this._pTarget - this._p) * (1 - Math.exp(-6.5 * dt));
    if (this.bar) this.bar.style.transform = `scaleX(${this._p.toFixed(4)})`;
    this.track?.setAttribute('aria-valuenow', String(Math.round(this._p * 100)));

    const name = prog?.name ?? '';
    if (name !== this._stepName) {
      this._stepName = name;
      if (this.step) {
        this.step.textContent = STEP_LABEL[name]
          ?? name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
      }
    }

    // The NORMAL path: dismiss because the scene reported ready, as soon as the
    // loader has had its minimum airtime. ONE tick is enough — nothing here
    // waits for a second one. There is no longer a blind mid-flight deadline
    // that could drop a visitor into a half-built scene; the only other exit is
    // the fail-safe timer.
    if (!ready) return;
    if (now - this._t0 >= MIN_SHOW_MS) this._dismiss('ready');
  }

  _dismiss(reason = 'ready') {
    if (this._loaderGone) return;
    this._loaderGone = true;
    clearTimeout(this._bail);
    if (this.bar) this.bar.style.transform = 'scaleX(1)';
    this.track?.setAttribute('aria-valuenow', '100');
    if (reason !== 'ready') {
      console.warn(`[ui] loader dismissed by ${reason} — the scene never reported ready`);
    }
    if (this.loader) {
      this.loader.setAttribute('aria-hidden', 'true');
      this.loader.classList.add('vx-gone');
      this.loader.style.pointerEvents = 'none';
    }
    // Drive the fade NUMERICALLY rather than leaning on a CSS transition: a
    // transition only advances when the compositor produces frames, and under
    // the review harness (or a stalled first paint) it can sit at opacity 1
    // for its whole duration and photograph a black screen.
    this._fadeT0 = this._now();
    this._fading = true;
    this._schedule();
    this._syncPaused();
  }

  _tickFade(now) {
    const dur = this._reduced ? 220 : 900;
    let u = clamp((now - this._fadeT0) / dur, 0, 1);
    // If frames are not flowing there is nothing to animate FOR, and holding at
    // opacity 1 waiting for a smooth fade is how the loading screen ended up in
    // review screenshots. `u > 0` keeps the dismissing tick itself out of this:
    // a real page finishing a heavy init also has one long gap, and that one
    // should still get its fade.
    if (u > 0 && this._gap > STALLED_MS) u = 1;
    if (this.loader) this.loader.style.opacity = String(1 - u * u);
    if (u < 0.45) return;
    if (!this._titleIn) { this._titleIn = true; this.title?.classList.add('vx-in'); }
    if (u < 1) return;
    this._fading = false;
    this.loader?.remove();
    this.loader = null;
    if (!this._touched && !this._hintGone) {
      this.hint?.classList.add('vx-in');
      this._later(() => this._hideHint(), 7000);
    }
  }

  _tickPerf() {
    const ctx = this.ctx;
    if (!ctx || !this._pf) return;
    const info = ctx.renderer.info;
    const pf = this._pf;
    pf.fps.nodeValue = ctx.quality.fps.toFixed(0);
    pf.ms.nodeValue = `${ctx.quality.avgFrameMs.toFixed(1)}ms`;
    pf.calls.nodeValue = String(info.render.calls);
    const tris = info.render.triangles;
    pf.tris.nodeValue = tris > 9999 ? `${(tris / 1000).toFixed(0)}k` : String(tris);
    pf.tier.nodeValue = `${ctx.quality.tier}·${ctx.quality.renderScale.toFixed(2)}`;
  }

  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._timer) clearTimeout(this._timer);
    this._raf = this._timer = 0;
    clearTimeout(this._bail);
    for (const id of this._timeouts) clearTimeout(id);
    this._timeouts = [];
    this._offKeys?.();
    this._offQuality?.();
    this._offCanvas?.();
    if (this._touch) {
      for (const ev of ['pointerdown', 'wheel', 'keydown', 'touchstart']) {
        window.removeEventListener(ev, this._touch);
      }
    }
    for (const a of ['role', 'aria-label', 'aria-describedby', 'tabindex']) {
      this._canvas?.removeAttribute(a);
    }
    this.root?.remove();
  }
}
