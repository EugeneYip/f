import './ui.css';
import { clamp } from '../util/math.js';

/**
 * The interface.
 *
 * Design brief: a gallery wall label, not a dev tool. Hairlines, wide
 * letterspacing, one cool accent lifted from the snow-bounce colour, and
 * nothing on screen that isn't earning its place.
 *
 * Three structural decisions worth knowing about:
 *
 *  1. The loading screen is built in the *constructor*, not `init()`. Systems
 *     register before `App.init()` runs, but this system's `order` is 960 —
 *     `init()` would not be called until the scene was almost finished
 *     building, which is far too late to show a loader.
 *  2. The UI drives itself from its own rAF loop, never from `update()`. The
 *     screenshot harness calls `app.stop()`, and the Space shortcut pauses the
 *     app, so anything depending on the system loop would freeze. The loop
 *     shuts itself down when there is nothing left to animate, so the resting
 *     cost is exactly zero.
 *  3. Timing here uses the rAF timestamp. That is a wall clock, which the
 *     engineering contract forbids for *animation* — but none of it reaches
 *     the rendered image: it only drives DOM chrome that is gone before any
 *     screenshot, plus the loader's fail-safe timeout.
 */

const TIERS = [['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['ultra', 'Ultra']];
const STATES = ['idle', 'sit', 'walk', 'trot', 'run'];

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
  ['H', 'Hide interface'],
  ['C', 'Cinematic'],
  ['P', 'Performance'],
  ['1–4', 'Quality'],
  ['Space', 'Play / pause'],
  ['↑↓←→', 'Orbit'],
  ['+ −', 'Dolly'],
];

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
    this._closing = 0;
    this._p = 0;
    this._pTarget = 0;
    this._stepName = '';
    this._t0 = 0;
    this._raf = 0;
    this._lastPerf = 0;
    this._touched = false;
    this._reduced = false;
    try { this._reduced = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* ignore */ }

    // Never let a DOM problem take the scene down with it.
    try { this._buildShell(); } catch (e) { console.warn('[ui] shell failed', e); }
  }

  // ------------------------------------------------------------------ shell --

  _buildShell() {
    const host = document.getElementById('ui') || document.body;
    const root = this.root = h('div');
    root.id = 'vx';

    // --- loader ------------------------------------------------------------
    const loader = this.loader = h('div', 'vx-loader');
    loader.setAttribute('role', 'status');
    loader.setAttribute('aria-live', 'polite');
    loader.setAttribute('aria-label', 'Loading Vulpes');
    const lin = h('div', 'vx-loader-in');
    lin.appendChild(h('h1', 'vx-mark', 'Vulpes'));
    const track = h('div', 'vx-track');
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

    root.appendChild(this._buildPerf());
    root.appendChild(this._buildDock());

    this.paused = h('div', 'vx-paused', 'Paused');
    this.paused.setAttribute('aria-hidden', 'true');
    root.appendChild(this.paused);

    this.dip = h('div', 'vx-dip');
    this.dip.setAttribute('aria-hidden', 'true');
    root.appendChild(this.dip);

    host.appendChild(root);

    // Fail-safe: whatever else happens, the loader goes away. Two independent
    // guarantees (this timer and the rAF deadline) so a throttled rAF or a
    // hung init can never trap a visitor behind the title card.
    this._bail = setTimeout(() => this._dismiss(), 22000);
    this._loop();
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
    btn.setAttribute('aria-label', 'Open controls');
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
    try { this._buildPanel(ctx); } catch (e) { console.warn('[ui] panel failed', e); }
    this._bindKeys(ctx);

    this._offQuality = ctx.quality.onChange((e) => {
      if (e.type === 'tier' || e.type === 'override') this._syncQuality();
    });

    // First interaction dims the credit.
    const touch = () => {
      if (this._touched) return;
      this._touched = true;
      this.title?.classList.add('vx-dim');
    };
    this._touch = touch;
    for (const ev of ['pointerdown', 'wheel', 'keydown', 'touchstart']) {
      window.addEventListener(ev, touch, { passive: true, once: false });
    }
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
      panel.appendChild(sec);
    }

    // --- shortcuts ---------------------------------------------------------
    {
      const sec = h('div', 'vx-sec');
      const lab = h('div', 'vx-lab');
      lab.appendChild(h('span', null, 'Keys'));
      sec.appendChild(lab);
      const dl = h('dl', 'vx-keys');
      for (const [k, v] of KEYS) { dl.appendChild(h('dt', null, k)); dl.appendChild(h('dd', null, v)); }
      sec.appendChild(dl);
      sec.appendChild(h('p', 'vx-note', 'Drag to orbit · scroll to dolly · two fingers to pan'));
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
    this.toggleBtn.setAttribute('aria-label', open ? 'Close controls' : 'Open controls');
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
    if (this.perfBox) this.perfBox.hidden = !this._perf;
    if (this._perf) this._loop();
  }

  _bindKeys(ctx) {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // Let the browser activate a focused button instead of double-handling.
      if (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;

      switch (e.key) {
        case 'h': case 'H': this.setHidden(!this._hidden); break;
        case 'p': case 'P': this.setPerf(!this._perf); break;
        case 'c': case 'C':
          ctx.cameraRig?.toggleCinematic?.();
          this._syncCine();
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
    if (on) this._loop();
  }

  // ------------------------------------------------------------------- loop --

  /**
   * One self-scheduling rAF. It exits as soon as the loader is gone and the
   * perf readout is off, so the interface costs nothing at rest.
   */
  _loop = (now) => {
    this._raf = 0;
    // Called synchronously once to prime the loop; wait for a real timestamp.
    if (typeof now !== 'number') { this._raf = requestAnimationFrame(this._loop); return; }

    let again = false;
    if (!this._loaderGone) { this._tickLoader(now); again = true; }
    if (this._perf && now - this._lastPerf > 250) { this._lastPerf = now; this._tickPerf(); }
    if (this._perf) again = true;

    if (again) this._raf = requestAnimationFrame(this._loop);
  };

  _tickLoader(now) {
    if (!this._t0) this._t0 = now || 1;
    const secs = (now - this._t0) / 1000;
    const prog = window.__FOX_PROGRESS;
    const ready = window.__FOX_READY === true;

    // Monotonic: a progress bar never runs backwards.
    const p = typeof prog?.p === 'number' ? prog.p : 0;
    if (p > this._pTarget) this._pTarget = p;
    if (ready) this._pTarget = 1;
    this._p += (this._pTarget - this._p) * 0.11;
    if (this.bar) this.bar.style.transform = `scaleX(${this._p.toFixed(4)})`;

    const name = prog?.name ?? '';
    if (name !== this._stepName) {
      this._stepName = name;
      if (this.step) {
        this.step.textContent = STEP_LABEL[name]
          ?? name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
      }
    }

    // Dismiss once ready (after a beat, so it never just flashes), or on the
    // deadline regardless of what init is doing.
    if (!this._closing && ((ready && secs > 0.45) || secs > 16)) {
      this._closing = secs || 0.01;
      this._pTarget = 1;
    }
    if (this._closing && (this._p > 0.985 || secs - this._closing > 0.6)) this._dismiss();
  }

  _dismiss() {
    if (this._loaderGone) return;
    this._loaderGone = true;
    clearTimeout(this._bail);
    if (this.bar) this.bar.style.transform = 'scaleX(1)';
    this.loader?.classList.add('vx-gone');
    this.loader?.setAttribute('aria-hidden', 'true');
    setTimeout(() => { this.title?.classList.add('vx-in'); }, this._reduced ? 0 : 340);
    setTimeout(() => { this.loader?.remove(); this.loader = null; }, this._reduced ? 400 : 1900);
    this._syncPaused();
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
    clearTimeout(this._bail);
    this._offKeys?.();
    this._offQuality?.();
    if (this._touch) {
      for (const ev of ['pointerdown', 'wheel', 'keydown', 'touchstart']) {
        window.removeEventListener(ev, this._touch);
      }
    }
    this.root?.remove();
  }
}
