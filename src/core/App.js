import * as THREE from 'three';
import { Quality } from './Quality.js';
import { clamp } from '../util/math.js';

/**
 * The application shell.
 *
 * Everything else in this project is a *System*: a plain object (or class
 * instance) with any of these optional members —
 *
 *   name            string, unique
 *   order           number, lower runs first (default 0)
 *   async init(ctx) build geometry/materials, add to ctx.scene
 *   update(dt, ctx) called once per rendered frame with wall-clock delta
 *   fixed(h, ctx)   called 0..n times per frame with a FIXED step h (physics)
 *   prerender(ctx)  last chance before the draw (e.g. update render targets)
 *   resize(w,h,ctx)
 *   onQuality(e,ctx)
 *   dispose()
 *
 * Systems must not reach into each other directly; publish on `ctx` instead
 * (e.g. `ctx.fox`, `ctx.terrain`) and read defensively.
 */
/**
 * three clears the shadow map with whatever clear colour the app happens to
 * have set (WebGLShadowMap.render -> renderer.clear(), around line 169 of
 * src/renderers/webgl/WebGLShadowMap.js). Under VSM the map stores depth
 * moments, so a DARK clear colour means every texel that no caster wrote to
 * reads as an occluder sitting at the near plane, and the entire shadow
 * frustum comes out shadowed. Our clear colour is a dark blue, so we hit this
 * squarely.
 *
 * three exposes no hook for it, so wrap the shadow pass and force a white
 * clear (= nothing in front of anything) for its duration only. Callers see
 * no change: the previous clear colour and alpha are restored either way.
 */
function patchShadowClear(renderer) {
  const shadowMap = renderer.shadowMap;
  if (shadowMap.__clearPatched) return;
  const inner = shadowMap.render.bind(shadowMap);
  const prevColor = new THREE.Color();
  shadowMap.render = function (lights, scene, camera) {
    renderer.getClearColor(prevColor);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0xffffff, 1);
    try {
      inner(lights, scene, camera);
    } finally {
      renderer.setClearColor(prevColor, prevAlpha);
    }
  };
  shadowMap.__clearPatched = true;
}

/**
 * Fit an authored 16:10 composition to an arbitrary viewport aspect.
 *
 * three's PerspectiveCamera.fov is VERTICAL, so there are exactly two naive
 * answers below the reference aspect, and BOTH have shipped here and both are
 * wrong:
 *
 *   - Hold the VERTICAL field (change nothing). The horizontal field collapses
 *     with the viewport: at 390x844 a 40 degree vertical leaves ~19.5 degrees
 *     horizontally against ~60 on a 16:10 desktop. The subject keeps its
 *     height fraction and grows to ~138% of the frame WIDTH -- cropped out
 *     sideways. This is the bug the previous note describes.
 *   - Hold the HORIZONTAL field (what replaced it). The vertical field then
 *     grows by the full aspect ratio -- 40 degrees becomes 103 at 390x844, a
 *     ~16 mm ultra-wide -- and the subject shrinks by that same factor. The
 *     `hero` fox measured **13.9% of frame height at 390x844 against 48.3% at
 *     1920x1200**, a speck in an empty sky. REVIEW-5 blocker 13.
 *
 * Those two are "letterbox" and "crop", and the fit that works is the
 * GEOMETRIC MEAN of them:
 *
 *     tan(vFov/2) = tan(baseFov/2) * sqrt(REF_ASPECT / aspect)
 *
 * Three equivalent readings of the same formula, which is why it is the one
 * to pick:
 *
 *  1. It holds tan(hFov/2) * tan(vFov/2) constant -- the camera covers a
 *     constant AREA of the subject plane, so the subject keeps a constant
 *     fraction of the frame's area at every aspect. Area is the one scalar
 *     that answers "does this still read as the subject".
 *  2. It holds the DIAGONAL field, and therefore the 35 mm-equivalent focal
 *     length, constant to within 9% from 0.46 (portrait phone) to 2.16
 *     (landscape phone). ART_DIRECTION section 9 quotes lens choice in 35 mm
 *     equivalents, so this is the only one of the three fits that preserves
 *     the authored lens: `hero`'s 33 mm stays a 29 mm here, against 16 mm for
 *     hold-horizontal and 54 mm for hold-vertical.
 *  3. Subject height and width fractions move by sqrt(aspect ratio) each,
 *     instead of one of them taking the whole error.
 *
 * Above the reference aspect the authored vertical fov is used unchanged, so
 * 1280x800 and 1920x1200 -- which are exactly REF_ASPECT, and are where
 * audit.mjs and spec.mjs measure -- are bit-identical to before.
 */
export const REF_ASPECT = 16 / 10;

/** Widest vertical field we will ever produce, however extreme the viewport. */
export const MAX_VFOV = 100;

export function applyAdaptiveFov(camera, baseFov, aspect) {
  const baseRad = baseFov * Math.PI / 180;
  if (aspect < REF_ASPECT) {
    const a = Math.max(aspect, 0.2);
    const t = Math.tan(baseRad / 2) * Math.sqrt(REF_ASPECT / a);
    camera.fov = 2 * Math.atan(t) * 180 / Math.PI;
  } else {
    camera.fov = baseFov;
  }
  camera.fov = Math.min(camera.fov, MAX_VFOV);
  camera.updateProjectionMatrix();
  return camera.fov;
}

export class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.systems = [];
    this.running = false;
    this.initErrors = [];

    // Populated by _prerenderSort(); pre-seeded so step() can never explode
    // if a system throws during init and boot ends early.
    this._updaters = [];
    this._fixers = [];
    this._prerenderers = [];
    this._renderer = null;

    this.FIXED_STEP = 1 / 120;
    this._accum = 0;
    this._last = 0;
    this._frameStart = 0;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 900);
    this.camera.position.set(1.6, 0.85, 2.3);

    this.renderer = this._makeRenderer(canvas);
    this.quality = new Quality(Quality.detect(this.renderer));

    /** Shared, mutable context handed to every system. */
    this.ctx = {
      app: this,
      THREE,
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      quality: this.quality,
      time: 0,          // simulated seconds since start
      dt: 0,            // last frame delta (seconds)
      frame: 0,
      size: new THREE.Vector2(1, 1),
      // Global art-direction state, authored once and read everywhere.
      sunDirection: new THREE.Vector3(-0.42, 0.115, -0.90).normalize(),
      sunColor: new THREE.Color(0xffd2a1),
      sunIntensity: 7.0,
      skyColor: new THREE.Color(0x8fb4e8),
      groundBounce: new THREE.Color(0xcfe2f7),
      wind: new THREE.Vector3(0.78, 0, -0.62).normalize(),
      windSpeed: 2.4,     // m/s base
      windGust: 0,        // 0..1, animated
      exposure: 1.0,
      focusDistance: 2.6,
      // Filled in by systems as they initialise.
      systemsByName: new Map(),
    };

    this.quality.onChange((e) => {
      for (const s of this.systems) s.onQuality?.(e, this.ctx);
      this._applyRenderSize();
    });

    this._onResize = () => this._applyRenderSize();
    window.addEventListener('resize', this._onResize, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this._onResize, { passive: true });
    }
    document.addEventListener('visibilitychange', () => {
      // Avoid a giant dt spike when the tab comes back.
      if (!document.hidden) this._last = performance.now();
    });
  }

  _makeRenderer(canvas) {
    const r = new THREE.WebGLRenderer({
      canvas,
      antialias: false,           // handled in post (TAA/SMAA)
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.AgXToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.VSMShadowMap;
    r.shadowMap.autoUpdate = true;
    r.setClearColor(0x0a1220, 1);
    r.info.autoReset = false;
    patchShadowClear(r);
    return r;
  }

  register(system) {
    if (!system.name) throw new Error('System needs a name');
    if (this.ctx.systemsByName.has(system.name)) {
      throw new Error(`Duplicate system: ${system.name}`);
    }
    this.systems.push(system);
    this.ctx.systemsByName.set(system.name, system);
    return system;
  }

  get(name) { return this.ctx.systemsByName.get(name); }

  async init(onProgress = () => {}) {
    this.systems.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    this._applyRenderSize();
    const n = this.systems.length;
    for (let i = 0; i < n; i++) {
      const s = this.systems[i];
      onProgress(i / n, s.name);
      try {
        await s.init?.(this.ctx);
      } catch (e) {
        // Isolate the failure: record it, drop the system, keep booting. With
        // several people landing systems at once, one broken module must not
        // take the whole page down.
        this.initErrors.push({ system: s.name, error: String(e?.stack ?? e) });
        console.error(`[App] system "${s.name}" failed to init — disabling it`, e);
        window.__FOX_ERRORS?.push(`init ${s.name}: ${e?.message ?? e}`);
        this.systems[i] = { name: s.name, order: s.order, _failed: true };
        this.ctx.systemsByName.set(s.name, this.systems[i]);
      }
      // Yield so the loading UI can paint and we never block > a frame or two.
      await new Promise((r) => requestAnimationFrame(() => r()));
    }
    this._prerenderSort();
    onProgress(1, 'ready');
    return this.initErrors;
  }

  _prerenderSort() {
    this._updaters = this.systems.filter((s) => s.update);
    this._fixers = this.systems.filter((s) => s.fixed);
    this._prerenderers = this.systems.filter((s) => s.prerender);
    const claimants = this.systems.filter((s) => s.renderFrame);
    if (claimants.length > 1) {
      console.error('[App] more than one system defines renderFrame — only ' +
        `"${claimants[0].name}" will run. Offenders: ${claimants.map((c) => c.name).join(', ')}`);
    }
    this._renderer = claimants[0] ?? null;
  }

  _applyRenderSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.get('maxDpr'));
    const scale = this.quality.renderScale;
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.ctx.size.set(w, h);
    this.renderer.setPixelRatio(dpr * scale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    applyAdaptiveFov(this.camera, this.ctx.baseFov ?? this.camera.fov, this.camera.aspect);
    const bw = Math.round(w * dpr * scale);
    const bh = Math.round(h * dpr * scale);
    this.ctx.bufferSize = { width: bw, height: bh };
    for (const s of this.systems) s.resize?.(w, h, this.ctx);
  }

  /** One deterministic simulation + render step. Used by the loop AND the
   *  offline screenshot harness, so both produce identical images. */
  step(dt) {
    const ctx = this.ctx;
    dt = clamp(dt, 0, 1 / 12);        // never simulate more than ~83 ms at once
    ctx.dt = dt;
    ctx.time += dt;
    ctx.frame++;

    // Fixed-step physics, capped so we can never enter a death spiral.
    this._accum += dt;
    let steps = 0;
    while (this._accum >= this.FIXED_STEP && steps < 8) {
      for (const s of this._fixers) s.fixed(this.FIXED_STEP, ctx);
      this._accum -= this.FIXED_STEP;
      steps++;
    }
    if (steps === 8) this._accum = 0;

    for (const s of this._updaters) s.update(dt, ctx);
    for (const s of this._prerenderers) s.prerender(ctx);
  }

  render() {
    this.renderer.info.reset();
    if (this._renderer) {
      try {
        this._renderer.renderFrame(this.ctx);
        return;
      } catch (e) {
        if (!this._renderFrameFailed) {
          this._renderFrameFailed = true;
          console.error(`[App] renderFrame from "${this._renderer.name}" threw; ` +
            'falling back to a direct scene render for the rest of the session', e);
          window.__FOX_ERRORS?.push(`renderFrame ${this._renderer.name}: ${e?.message ?? e}`);
        }
        this._renderer = null;
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  _loop = (now) => {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._loop);
    const dt = (now - this._last) / 1000;
    this._last = now;

    const frameMs = now - this._frameStart;
    this._frameStart = now;
    const prevScale = this.quality.renderScale;
    this.quality.tickAdaptive(frameMs, dt);
    if (this.quality.renderScale !== prevScale) this._applyRenderSize();

    this.step(dt);
    this.render();
  };

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    this._frameStart = this._last;
    this._raf = requestAnimationFrame(this._loop);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    for (const s of this.systems) s.dispose?.();
    this.renderer.dispose();
  }
}
