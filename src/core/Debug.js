import * as THREE from 'three';

/**
 * The review harness contract.
 *
 * `tools/shoot.mjs` drives this from headless Chromium so that the critic
 * always looks at the SAME framings, with dynamics fully settled, frame after
 * frame. Do not change pose names without updating the review baseline.
 */
export const POSES = {
  // Authored against MEASURED anatomy (tools/_probe.mjs), not guesswork:
  //   eyeR (0.027, 0.318, 0.222) · nose (0.001, 0.293, 0.274)
  //   earTip y 0.382 · withers y ~0.28 · pawF z 0.093 · pawR z -0.143
  //   tailTip (0.007, 0.055, -0.501) · bbox 0.777 L x 0.158 W x 0.383 H
  // Re-derive these if the anatomy changes; a pose that misses its subject
  // silently wastes an entire review round.

  // The money shot: 3/4 front, eye level, backlit from camera-left.
  // Target biased +x so the animal sits left of centre with space to look into.
  hero:        { pos: [0.904, 0.326, 0.854], target: [0.100, 0.205, 0.020], fov: 40, focus: 1.25 },

  // Head fills ~70% of frame height. Long-ish lens to stay flattering.
  portrait:    { pos: [0.364, 0.355, 0.610], target: [0.005, 0.310, 0.215], fov: 26, focus: 0.55 },

  // Extreme close on the RIGHT eye — iris parallax, corneal highlight, lids, lashes.
  macro_eye:   { pos: [0.105, 0.339, 0.324], target: [0.027, 0.318, 0.222], fov: 18, focus: 0.13 },

  // Camera looks almost straight into the sun with the fox between: the
  // definitive fur test for rim translucency and silhouette break-up.
  silhouette:  { pos: [0.720, 0.260, 1.420], target: [0.000, 0.210, 0.000], fov: 38, focus: 1.61 },

  // Side elevation on a long lens. Proportion and joint-placement audit.
  profile:     { pos: [1.900, 0.220, -0.020], target: [0.000, 0.200, -0.020], fov: 24, focus: 1.90 },

  // Rear three-quarter. Tail volume, flow and carriage.
  tail:        { pos: [-0.716, 0.496, -1.181], target: [0.000, 0.160, -0.300], fov: 38, focus: 1.15 },

  // Ground level at the front paws. Contact, compression, footprints.
  paws:        { pos: [0.620, 0.055, 0.660], target: [0.000, 0.055, 0.020], fov: 32, focus: 0.89 },

  // Environment composition, fox small in frame.
  wide:        { pos: [4.200, 1.050, 4.900], target: [0.150, 0.300, -0.300], fov: 44, focus: 6.40 },

  // Sky / aurora / atmosphere.
  aurora:      { pos: [2.600, 0.550, 3.000], target: [-0.500, 2.400, -2.000], fov: 60, focus: 12.0 },

  // Elevated. Terrain shading, sastrugi structure, aerial perspective.
  terrain:     { pos: [2.200, 1.700, 2.500], target: [0.000, 0.120, 0.000], fov: 42, focus: 3.70 },

  // Behind and above the head: ruff depth and ear interior.
  nape:        { pos: [-0.231, 0.562, -0.224], target: [0.000, 0.315, 0.160], fov: 34, focus: 0.55 },
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
