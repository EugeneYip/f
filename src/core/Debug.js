import * as THREE from 'three';
import { applyAdaptiveFov, REF_ASPECT } from './App.js';

/**
 * The review harness contract.
 *
 * `tools/shoot.mjs` drives this from headless Chromium so that the critic
 * always looks at the SAME framings, with dynamics fully settled, frame after
 * frame. Do not change pose names without updating the review baseline.
 */
export const POSES = {
  // Authored against MEASURED anatomy (not guesswork). Current rig, after the
  // proportion rework that dropped the skull 34 mm and pulled it back 22 mm:
  //   eyeR (0.0288, 0.2809, 0.1999) · nose (0.0016, 0.2497, 0.2518)
  //   head bone (0, 0.2821, 0.1638) · skull top 0.322 skin / ~0.33 furred
  //   inter-pupil 46 mm · pawF z 0.093 · pawR z -0.143 · tail tip y 0.048
  // Re-derive these if the anatomy changes; a pose that misses its subject
  // silently wastes an entire review round.

  // The money shot: 3/4 front, eye level, backlit from camera-left.
  // Target biased +x so the animal sits left of centre with space to look into.
  hero:        { pos: [0.904, 0.316, 0.854], target: [0.100, 0.190, 0.020], fov: 40, focus: 1.25 },

  // Head fills ~70% of frame height. Long-ish lens to stay flattering.
  portrait:    { anchor: 'head', dir: [0.661, 0.072, 0.746], dist: 0.55, fov: 26 },

  // Extreme close on the RIGHT eye — iris parallax, corneal highlight, lids, lashes.
  macro_eye:   { anchor: 'eyeR', dir: [0.600, 0.161, 0.784], dist: 0.13, fov: 18 },

  // Camera looks almost straight into the sun with the fox between: the
  // definitive fur test for rim translucency and silhouette break-up.
  silhouette:  { pos: [0.720, 0.250, 1.420], target: [0.000, 0.195, 0.000], fov: 38, focus: 1.61 },

  // Side elevation on a long lens. Proportion and joint-placement audit.
  profile:     { pos: [1.900, 0.205, -0.020], target: [0.000, 0.190, -0.020], fov: 24, focus: 1.90 },

  // Rear three-quarter. Tail volume, flow and carriage.
  tail:        { pos: [-0.716, 0.466, -1.100], target: [0.000, 0.150, -0.250], fov: 38, focus: 1.10 },

  // Ground level at the front paws. Contact, compression, footprints.
  paws:        { pos: [0.620, 0.055, 0.660], target: [0.000, 0.055, 0.020], fov: 32, focus: 0.89 },

  // Environment composition, fox small in frame.
  wide:        { pos: [4.200, 1.050, 4.900], target: [0.150, 0.300, -0.300], fov: 44, focus: 6.40 },

  // Sky / aurora / atmosphere.
  aurora:      { pos: [2.600, 0.550, 3.000], target: [-0.500, 2.400, -2.000], fov: 60, focus: 12.0 },

  // Elevated. Terrain shading, sastrugi structure, aerial perspective.
  terrain:     { pos: [2.200, 1.700, 2.500], target: [0.000, 0.120, 0.000], fov: 42, focus: 3.70 },

  // Same framing as `hero`, shot on a long lens instead of a wide one.
  // `hero` at fov 40 from 1.17 m is a 33 mm equivalent — wide enough to
  // enlarge the muzzle and shrink the ears, which is exactly the kind of
  // distortion that skews a proportion read. §9 asks for 50–85 mm. This pose
  // holds subject size constant (camera pulled back to 2.47 m, fov 19.5) so
  // the ONLY variable is perspective compression.
  hero_long:   { pos: [1.803, 0.457, 1.787], target: [0.100, 0.190, 0.020], fov: 19.5, focus: 2.47 },

  // Behind and above the head: ruff depth and ear interior.
  nape:        { anchor: 'head', dir: [-0.419, 0.449, -0.789], dist: 0.55, fov: 34 },

  // Dead front-on, eye level. The user's own screenshots were taken here and
  // here is where the ear interiors and the skin/fur silhouette edge show.
  frontal:     { anchor: 'head', dir: [0.020, 0.100, 1.000], dist: 0.55, fov: 30 },

  // Low and close, looking up under the chin. Reproduces the framing where
  // the animal's INTERIOR became visible.
  chin:        { anchor: 'head', dir: [0.060, -0.300, 0.952], dist: 0.20, fov: 24 },
};

/**
 * Resolve an anchor-relative pose against the live rig.
 *
 * Head framings were breaking every time the anatomy changed: the skull has
 * moved three times now (down 34 mm, back 22 mm, down another 7 mm, scaled
 * 1.10 then 1.18), and each time `portrait` and `macro_eye` silently framed
 * empty space or the back of the neck. A pose that misses its subject wastes
 * a whole review round before anyone notices.
 *
 * So these poses are authored as a DIRECTION and a DISTANCE from a named
 * anchor, and resolve against wherever that anchor actually is. Body framings
 * stay absolute — they want a fixed relationship to the horizon and the sun,
 * not to the animal.
 */
function resolvePose(pose, ctx) {
  if (!pose.anchor) return pose;
  const fox = ctx.fox;
  const t = new THREE.Vector3();
  let found = false;

  if (fox) {
    const a = fox.anchors?.[pose.anchor];
    if (a) {
      a.updateWorldMatrix(true, false);
      t.setFromMatrixPosition(a.matrixWorld);
      found = true;
    } else if (fox.bone?.(pose.anchor)) {
      const b = fox.bone(pose.anchor);
      b.updateWorldMatrix(true, false);
      t.setFromMatrixPosition(b.matrixWorld);
      found = true;
    } else if (pose.anchor === 'head' && fox.anchors?.eyeL && fox.anchors?.eyeR) {
      // Midpoint of the eyes, nudged back into the skull.
      const l = new THREE.Vector3(), r = new THREE.Vector3();
      fox.anchors.eyeL.updateWorldMatrix(true, false);
      fox.anchors.eyeR.updateWorldMatrix(true, false);
      l.setFromMatrixPosition(fox.anchors.eyeL.matrixWorld);
      r.setFromMatrixPosition(fox.anchors.eyeR.matrixWorld);
      t.addVectors(l, r).multiplyScalar(0.5);
      found = true;
    }
  }
  if (!found) {
    console.warn(`[debug] pose anchor "${pose.anchor}" not found; using origin`);
    t.set(0, 0.28, 0.17);
  }
  if (pose.offset) t.add(new THREE.Vector3().fromArray(pose.offset));

  const dir = new THREE.Vector3().fromArray(pose.dir).normalize();

  // On a narrow viewport, DOLLY BACK rather than widen the lens.
  //
  // The interactive rig holds horizontal field constant by widening the
  // vertical fov, which is right for exploration -- but at 390x844 that means
  // a 103 degree vertical, roughly a 13 mm ultra-wide, and authored poses are
  // compositions with a deliberate lens character. Pulling back instead keeps
  // the authored fov (and therefore the perspective compression) while
  // covering the same horizontal extent of subject.
  const aspect = ctx.camera.aspect || (16 / 10);
  let dist = pose.dist;
  if (pose.fov && aspect < REF_ASPECT) {
    const halfV = (pose.fov * Math.PI / 180) / 2;
    const hRef = Math.atan(Math.tan(halfV) * REF_ASPECT);
    const hNow = Math.atan(Math.tan(halfV) * aspect);
    dist = pose.dist * (Math.tan(hRef) / Math.max(Math.tan(hNow), 1e-4));
  }

  const pos = t.clone().addScaledVector(dir, dist);
  return { pos: pos.toArray(), target: t.toArray(), fov: pose.fov, focus: pose.focus ?? dist };
}

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

      /**
       * Freeze the render loop; the harness drives frames by hand.
       *
       * Also ZEROES ctx.time. Between page load and the harness calling
       * pause(), a variable number of rAF frames run, so ctx.time after a
       * settle(2.5) was landing anywhere in 2.6144 .. 2.681 depending on
       * machine load. That ~70 ms spread does not move the fox's world pose
       * (identical to 4 decimals) but it is enough to swing a WHISKER across
       * a 12 px nose sample -- which produced a bimodal spec result, two
       * discrete states with byte-identical values, that three of us spent
       * rounds attributing to rendering. Found by the atmosphere agent with a
       * six-run controlled test after disabling its own systems entirely.
       *
       * With this, settle(2.5) lands on exactly 2.5 every run.
       */
      pause: () => {
        ctx.app.stop();
        this.deterministic = true;
        ctx.time = 0;
        ctx.frame = 0;
        ctx.app._accum = 0;
      },
      resume: () => { this.deterministic = false; ctx.app.start(); },

      /** Advance the simulation deterministically (no rAF, no wall clock). */
      settle: (seconds = 2.0, h = 1 / 120) => {
        const n = Math.max(1, Math.round(seconds / h));
        for (let i = 0; i < n; i++) ctx.app.step(h);
      },

      step: (h = 1 / 60) => ctx.app.step(h),
      render: () => ctx.app.render(),

      setPose: (p) => {
        let pose = typeof p === 'string' ? POSES[p] : p;
        if (!pose) throw new Error(`Unknown pose: ${p}`);
        pose = resolvePose(pose, ctx);
        const rig = ctx.systemsByName.get('cameraRig');
        if (rig?.applyPose) { rig.applyPose(pose, ctx); }
        else {
          ctx.camera.position.fromArray(pose.pos);
          ctx.camera.lookAt(new THREE.Vector3().fromArray(pose.target));
        }
        // Apply AFTER the rig, not instead of it. The rig sets the authored
        // vertical fov, which on a narrow viewport collapses the horizontal
        // field and crops the subject out of frame -- this reinstates the
        // intended horizontal field for whatever aspect we are actually at.
        if (pose.fov) {
          ctx.baseFov = pose.fov;
          applyAdaptiveFov(ctx.camera, pose.fov, ctx.camera.aspect);
        }
        if (pose.focus) ctx.focusDistance = pose.focus;
        ctx.camera.updateMatrixWorld(true);
        // A pose change is a hard cut. Drop temporal history so the shot
        // converges from scratch rather than dragging the previous framing's
        // accumulation across, which also makes repeat runs reproducible.
        ctx.postfx?.reset?.();
        return true;
      },

      setState: (s) => ctx.systemsByName.get('foxBrain')?.forceState?.(s) ?? false,
      setQuality: (t) => { ctx.quality.setTier(t); return ctx.quality.tier; },
      /**
       * Disabling adaptive resolution must also RESET the scale, not merely
       * freeze it. The app starts rendering at load, so by the time a harness
       * calls this, tickAdaptive has already pushed renderScale somewhere
       * between 0.6 and 1.0 depending on how loaded the machine happened to
       * be. Freezing it there makes every review screenshot render at a
       * machine-load-dependent resolution -- two runs with identical settings
       * come back at different buffer sizes and are not comparable.
       */
      setAdaptive: (v) => {
        ctx.quality.adaptive = !!v;
        if (!v) {
          ctx.quality.renderScale = 1;
          ctx.app._applyRenderSize();
        }
        return ctx.bufferSize;
      },

      setRenderScale: (s) => {
        ctx.quality.renderScale = Math.max(0.25, Math.min(1, s));
        ctx.app._applyRenderSize();
        return ctx.bufferSize;
      },
      setWind: (speed, gust) => {
        if (speed != null) ctx.windSpeed = speed;
        if (gust != null) ctx.windGust = gust;
      },
      setSun: (elevDeg, aziDeg) => {
        const e = elevDeg * Math.PI / 180, a = aziDeg * Math.PI / 180;
        ctx.sunDirection.set(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)).normalize();
        ctx.sunDirty = true;
      },

      /**
       * Numeric probes for tools/audit.mjs.
       *
       * CRITICAL: report the SKELETON BONE world position, not the anchor.
       * The anchors are IK targets — during stance their world x/z are pinned
       * by construction, identical to five decimal places frame after frame,
       * while the rendered bone drifts. Measuring the anchor therefore
       * reported foot slide of exactly 0.0000 m/s for every paw in every
       * state, which is not a passing grade, it is a broken instrument.
       * Found by the review critic; the bug had been silently validating the
       * gait engine for several rounds.
       */
      probe: () => {
        const f = ctx.fox;
        const out = { t: +ctx.time.toFixed(4), paws: {}, targets: {}, ground: {}, root: null };
        if (!f) return out;
        f.root?.updateWorldMatrix?.(true, true);
        out.root = f.root ? f.root.position.toArray().map((n) => +n.toFixed(6)) : null;
        const v = new THREE.Vector3();

        // Front feet ride `paw*`; hind feet ride `foot*` (the metatarsus ends
        // at the hock, so the hind ground contact is one bone further down).
        const BONES = { pawFL: 'pawL', pawFR: 'pawR', pawRL: 'footL', pawRR: 'footR' };
        for (const [key, boneName] of Object.entries(BONES)) {
          const b = f.bone?.(boneName);
          if (b) {
            b.updateWorldMatrix(true, false);
            out.paws[key] = v.setFromMatrixPosition(b.matrixWorld).toArray().map((n) => +n.toFixed(6));
            out.ground[key] = +(ctx.terrain?.heightAt?.(out.paws[key][0], out.paws[key][2]) ?? 0).toFixed(6);
          }
          // Keep the anchor too, so target-vs-bone divergence stays visible.
          const a = f.anchors?.[key];
          if (a) {
            a.updateWorldMatrix(true, false);
            out.targets[key] = v.setFromMatrixPosition(a.matrixWorld).toArray().map((n) => +n.toFixed(6));
          }
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

      /** Hide the DOM overlay for review shots. The critic is grading the
       *  render, not the chrome, and the loader's fade is driven by its own
       *  rAF which barely ticks while the harness drives frames synchronously
       *  inside a single evaluate block. */
      setUI: (visible) => {
        const el = document.getElementById('ui');
        if (el) el.style.display = visible ? '' : 'none';
        return !!el;
      },

      stats: () => {
        const i = ctx.renderer.info;
        // A system whose renderFrame throws is dropped permanently for the
        // session, but it still exists and still declares renderFrame -- so
        // "does a postfx system exist" is NOT the same question as "is post
        // actually running". Report both; the fur agent was misled by exactly
        // this and tuned against an unresolved dither.
        const claimants = ctx.app.systems.filter((s) => s.renderFrame);
        return {
          renderFrameClaimed: claimants.map((s) => s.name),
          renderFrameActive: ctx.app._renderer ? ctx.app._renderer.name : null,
          renderFrameDropped: claimants.length > 0 && !ctx.app._renderer,
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
