import * as THREE from 'three';

/**
 * The review harness contract.
 *
 * `tools/shoot.mjs` drives this from headless Chromium so that the critic
 * always looks at the SAME framings, with dynamics fully settled, frame after
 * frame. Do not change pose names without updating the review baseline.
 */
export const POSES = {
  // The money shot: 3/4 front, eye level, backlit from camera-left.
  hero:        { pos: [1.42, 0.30, 1.72], target: [0.02, 0.26, 0.04], fov: 40, focus: 2.25 },
  // Face. Tests eyes, nose, whisker pads, muzzle fur length gradient.
  portrait:    { pos: [0.60, 0.38, 0.86], target: [0.015, 0.315, 0.20], fov: 32, focus: 0.95 },
  // Extreme close on the eye. Tests iris parallax, caustic, lashes, lids.
  macro_eye:   { pos: [0.235, 0.355, 0.385], target: [0.045, 0.325, 0.215], fov: 20, focus: 0.29 },
  // Pure backlight profile. THE fur test — rim translucency and silhouette break-up.
  silhouette:  { pos: [-1.62, 0.26, 1.18], target: [0.0, 0.25, 0.0], fov: 42, focus: 2.05 },
  // Side elevation. Anatomy/proportion audit.
  profile:     { pos: [2.30, 0.29, 0.02], target: [0.0, 0.255, 0.02], fov: 36, focus: 2.3 },
  // Rear three-quarter. Tail volume and flow.
  tail:        { pos: [-1.22, 0.42, -1.48], target: [-0.05, 0.24, -0.16], fov: 40, focus: 1.95 },
  // Ground-level. Paw contact, snow compression, footprints.
  paws:        { pos: [0.95, 0.055, 1.12], target: [0.04, 0.085, 0.02], fov: 34, focus: 1.4 },
  // Environment composition, fox small in frame.
  wide:        { pos: [5.4, 1.35, 6.2], target: [0.1, 0.30, -0.4], fov: 46, focus: 8.2 },
  // Sky / aurora / atmosphere.
  aurora:      { pos: [3.1, 0.62, 3.6], target: [-0.6, 2.30, -2.2], fov: 62, focus: 14 },
  // Top-down-ish. Terrain shading and drift structure.
  terrain:     { pos: [2.6, 2.05, 2.9], target: [0.0, 0.14, 0.0], fov: 44, focus: 4.3 },
  // Back of the head / ruff & ear interior.
  nape:        { pos: [-0.52, 0.56, -0.70], target: [0.0, 0.30, 0.06], fov: 38, focus: 0.98 },
};

export class Debug {
  name = 'debug';
  order = 1000;

  constructor() {
    this._readyResolve = null;
    this.ready = new Promise((res) => { this._readyResolve = res; });
    this.deterministic = false;
  }

  init(ctx) {
    this.ctx = ctx;
    const api = {
      poses: POSES,
      version: 1,

      ready: this.ready,

      /** Freeze the render loop; the harness drives frames by hand. */
      pause: () => { ctx.app.stop(); this.deterministic = true; },
      resume: () => { this.deterministic = false; ctx.app.start(); },

      /** Advance the simulation deterministically (no rAF, no wall clock). */
      settle: (seconds = 2.0, h = 1 / 120) => {
        const n = Math.max(1, Math.round(seconds / h));
        for (let i = 0; i < n; i++) ctx.app.step(h);
      },

      step: (h = 1 / 60) => ctx.app.step(h),
      render: () => ctx.app.render(),

      setPose: (p) => {
        const pose = typeof p === 'string' ? POSES[p] : p;
        if (!pose) throw new Error(`Unknown pose: ${p}`);
        const rig = ctx.systemsByName.get('cameraRig');
        if (rig?.applyPose) { rig.applyPose(pose, ctx); }
        else {
          ctx.camera.position.fromArray(pose.pos);
          ctx.camera.lookAt(new THREE.Vector3().fromArray(pose.target));
          if (pose.fov) { ctx.camera.fov = pose.fov; ctx.camera.updateProjectionMatrix(); }
        }
        if (pose.focus) ctx.focusDistance = pose.focus;
        ctx.camera.updateMatrixWorld(true);
        return true;
      },

      setState: (s) => ctx.systemsByName.get('foxBrain')?.forceState?.(s) ?? false,
      setQuality: (t) => { ctx.quality.setTier(t); return ctx.quality.tier; },
      setAdaptive: (v) => { ctx.quality.adaptive = !!v; },
      setWind: (speed, gust) => {
        if (speed != null) ctx.windSpeed = speed;
        if (gust != null) ctx.windGust = gust;
      },
      setSun: (elevDeg, aziDeg) => {
        const e = elevDeg * Math.PI / 180, a = aziDeg * Math.PI / 180;
        ctx.sunDirection.set(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)).normalize();
        ctx.sunDirty = true;
      },

      /** Numeric probes for tools/audit.mjs — see REVIEW.md category E/H. */
      probe: () => {
        const f = ctx.fox;
        const out = { t: +ctx.time.toFixed(4), paws: {}, ground: {}, root: null };
        if (!f) return out;
        f.root?.updateWorldMatrix?.(true, true);
        out.root = f.root ? f.root.position.toArray() : null;
        const v = new THREE.Vector3();
        for (const k of ['pawFL', 'pawFR', 'pawRL', 'pawRR']) {
          const a = f.anchors?.[k];
          if (!a) continue;
          a.updateWorldMatrix(true, false);
          out.paws[k] = v.setFromMatrixPosition(a.matrixWorld).toArray().map((n) => +n.toFixed(6));
          out.ground[k] = +(ctx.terrain?.heightAt?.(out.paws[k][0], out.paws[k][2]) ?? 0).toFixed(6);
        }
        out.state = ctx.systemsByName.get('foxBrain')?.state ?? null;
        out.speed = ctx.fox?.velocity?.length?.() ?? null;
        return out;
      },

      /** Hunt for NaN/Infinity leaking into transforms — one bad frame poisons
       *  the whole skeleton and the symptom (invisible mesh) is baffling. */
      scanNaN: () => {
        const bad = [];
        const fin = (o) => Number.isFinite(o);
        ctx.scene.traverse((o) => {
          const p = o.position, q = o.quaternion, s = o.scale;
          if (![p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z].every(fin)) {
            bad.push(`${o.type}:${o.name || '(unnamed)'}`);
          }
        });
        const sk = ctx.fox?.skeleton;
        if (sk) {
          for (let i = 0; i < sk.bones.length; i++) {
            const e = sk.boneMatrices?.[i * 16];
            if (e !== undefined && !fin(e)) bad.push(`bone:${sk.bones[i].name}`);
          }
        }
        return bad;
      },

      /** Every material in the scene, for a shading audit. */
      materials: () => {
        const seen = new Map();
        ctx.scene.traverse((o) => {
          for (const m of [].concat(o.material ?? [])) {
            if (m && !seen.has(m.uuid)) {
              seen.set(m.uuid, {
                name: m.name || m.type, type: m.type,
                transparent: !!m.transparent, blending: m.blending,
                depthWrite: !!m.depthWrite, side: m.side,
                toneMapped: m.toneMapped !== false,
              });
            }
          }
        });
        return [...seen.values()];
      },

      stats: () => {
        const i = ctx.renderer.info;
        return {
          fps: +ctx.quality.fps.toFixed(1),
          frameMs: +ctx.quality.avgFrameMs.toFixed(2),
          tier: ctx.quality.tier,
          renderScale: +ctx.quality.renderScale.toFixed(3),
          drawCalls: i.render.calls,
          triangles: i.render.triangles,
          programs: i.programs?.length ?? 0,
          textures: i.memory.textures,
          geometries: i.memory.geometries,
          buffer: ctx.bufferSize,
          frame: ctx.frame,
          time: +ctx.time.toFixed(3),
        };
      },

      /** Systems that failed to initialise, for a health check. */
      errors: () => (window.__FOX_ERRORS || []),
      systems: () => [...ctx.systemsByName.keys()],
      ctx: () => ctx,
    };

    window.FoxDebug = api;
    this._api = api;
    // NOTE: __FOX_READY is raised by src/main.js once App.init() has fully
    // resolved. Raising it here would let the review harness photograph a
    // half-booted scene whenever a later system throws.
    this._readyResolve?.(api);
  }
}
