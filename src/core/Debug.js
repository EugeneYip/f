import * as THREE from 'three';
import { applyAdaptiveFov, REF_ASPECT } from './App.js';

/**
 * The review harness contract.
 *
 * `tools/shoot.mjs` drives this from headless Chromium so that the critic
 * always looks at the SAME framings, with dynamics fully settled, frame after
 * frame. Do not change pose names without updating the review baseline.
 */
/** The sun as it was before any pose overrode it; see setPose. */
let sunDefault = null;

export const POSES = {
  // Authored against MEASURED anatomy (not guesswork). Re-baselined after
  // §4f moved the bulk into the coat, §4g lengthened the rostrum to
  // stretch 1.60, and the eye socket became an anisotropic slot:
  //
  //   nose     (0.0000, 0.2406, 0.2761)   mouth  (0.0000, 0.2435, 0.2216)
  //   eyeR     (0.0289, 0.2784, 0.1984)   eyeL  (-0.0289, 0.2784, 0.1984)
  //   head     (0.0000, 0.2755, 0.1609)   jaw    (0.0000, 0.2578, 0.1856)
  //   earR tip (0.0572, 0.3419, 0.1656)   skull top y 0.3048 at z 0.1760 skin
  //   pawR fr  (0.0455, 0.0205, 0.0750)   footR hind (0.0450, 0.0205, -0.1290)
  //   tail tip (0.0000, 0.0370, -0.3740)  inter-pupil 57.7 mm
  //
  // Re-derive these if the anatomy changes; a pose that misses its subject
  // silently wastes an entire review round. The figures above replace a set
  // that had gone stale by 22.6 mm in z and 9.1 mm in y at the nose, and
  // claimed a 46 mm inter-pupil against a measured 57.7 -- and two separate
  // agents wasted measurements on the old numbers before anyone noticed.
  //
  // ANCHORED poses (`anchor:`) re-resolve against the live rig and survive
  // this; only ABSOLUTE poses carry these coordinates implicitly.

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
  wide:        { pos: [4.200, 1.050, 4.900], target: [0.150, 0.300, -0.300], fov: 44, focus: 6.40, focusHold: true },

  // Sky / aurora / atmosphere.
  // The pose named for the aurora has to be shot when an aurora can exist.
  //
  // The atmosphere agent established that an aurora and a +6.6 degree sun
  // cannot both be in frame and made the aurora fade with sun elevation,
  // which is right. This pose then kept the default sun, so REVIEW-5
  // measured its sky in 32 px boxes and found **0 of 1782 cells above +3
  // green excess, most-green cell -0.51, median -4.61** -- net magenta. The
  // aurora is fine; it was being photographed in daylight.
  //
  // -6 degrees is civil-to-nautical twilight, which is when aurorae are
  // actually seen, and is where spec.mjs already drops the sun to measure
  // this. Shot there, the DELIVERED png reads a 99th-percentile green excess
  // of 36.5 over the whole sky, with 24.3% of sky pixels above +3, against
  // 0.004% before. The `sun` key alone was not enough -- see setPose.
  aurora:      { pos: [2.600, 0.550, 3.000], target: [-0.500, 2.400, -2.000], fov: 60, focus: 12.0, focusHold: true, sun: [-6, 140] },

  // Elevated. Terrain shading, sastrugi structure, aerial perspective.
  terrain:     { pos: [2.200, 1.700, 2.500], target: [0.000, 0.120, 0.000], fov: 42, focus: 3.70, focusHold: true },

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
  frontal:     { anchor: 'head', dir: [0.020, 0.100, 1.000], dist: 0.55, fov: 30, local: true },

  // Low and close, looking up under the chin. Reproduces the framing where
  // the animal's INTERIOR became visible.
  chin:        { anchor: 'head', dir: [0.060, -0.300, 0.952], dist: 0.20, fov: 24, local: true },
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
  // Absolute poses are composed against the animal, not against the world
  // origin -- they only LOOK like world coordinates because the fox idles
  // there. In a moving state it does not: Locomotion integrates world
  // position, so after a 2.5 s settle at run speed the animal is ~5 m away
  // and every absolute pose frames empty snow. `run-paws` came back as a
  // bare snowfield for exactly this reason.
  //
  // Translating camera AND target by the same horizontal offset preserves
  // the composition exactly: the sun is directional, the sky is at infinity,
  // and the terrain is statistically uniform, so only the animal's position
  // in frame is restored.
  if (!pose.anchor) {
    const r = ctx.fox?.root?.position;
    if (!r || (Math.abs(r.x) < 1e-4 && Math.abs(r.z) < 1e-4)) return pose;
    return {
      ...pose,
      pos: [pose.pos[0] + r.x, pose.pos[1], pose.pos[2] + r.z],
      target: [pose.target[0] + r.x, pose.target[1], pose.target[2] + r.z],
    };
  }
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

  // `local: true` interprets `dir` in the ANCHOR'S OWN FRAME rather than in
  // world axes. A head framing authored as "straight in front of the face"
  // stops being that the moment anything yaws the head -- and the animation
  // agent's new per-gait carriage does exactly that, which silently turned
  // `frontal` and `chin` into three-quarter shots and stopped them
  // reproducing the screenshots they exist to reproduce. Anchored poses
  // already survive the skull MOVING; this makes them survive it TURNING.
  if (pose.local) {
    const a = fox?.anchors?.[pose.anchor] || fox?.bone?.(pose.anchor);
    if (a) {
      const q = new THREE.Quaternion();
      a.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3());
      dir.applyQuaternion(q).normalize();
    }
  }

  // On a narrow viewport, dolly back for the HALF of the aspect fit that the
  // lens did not absorb. Not the whole of it -- that was a double correction.
  //
  // This block used to pull back by the full REF_ASPECT/aspect (3.46x at
  // 390x844) on the argument that a dolly preserves the authored lens where
  // widening the fov does not. The argument is sound; the bug is that
  // `setPose` below ALSO calls applyAdaptiveFov, unconditionally, so both
  // corrections landed on every anchored pose and multiplied. `portrait`
  // measured a head at **12.9% of frame height at 390x844 against 95.3% at
  // 1920x1200** -- 3.46x from the dolly times 3.46x from the fov. A head
  // portrait in which the head is an eighth of the frame.
  //
  // applyAdaptiveFov now takes the geometric mean of the letterbox and crop
  // fits, so it absorbs sqrt(REF_ASPECT/aspect) of the ratio and leaves
  // exactly sqrt(REF_ASPECT/aspect) over. Taking that remainder as a dolly
  // holds the subject's WIDTH fraction at its authored 16:10 value, which is
  // what an anchored pose is really asking for: `portrait` is "the head fills
  // the frame", and on a frame 2.16x taller than it is wide the head can only
  // fill the width. Without this the same head projects to 138% of frame
  // width and loses both ears.
  //
  // Absolute poses get no dolly: their vantage point is authored against the
  // horizon and the sun, and moving the camera along the view axis would
  // change the composition rather than fit it.
  const aspect = ctx.camera.aspect || REF_ASPECT;
  let dist = pose.dist;
  if (pose.fov && aspect < REF_ASPECT) {
    dist = pose.dist * Math.sqrt(REF_ASPECT / Math.max(aspect, 0.2));
  }

  const pos = t.clone().addScaledVector(dir, dist);
  return { pos: pos.toArray(), target: t.toArray(), fov: pose.fov, focus: pose.focus ?? dist };
}

/**
 * §9 says focus the EYE. Measure the distance to it rather than authoring one.
 *
 * Every absolute pose carried a hand-written `focus`, and hand-written numbers
 * go stale the moment the rig moves — which it has, repeatedly. The postfx
 * agent measured `tail` at 1.10 m against 1.4825 m to the near eye: **26%
 * short**, and it had been blamed on DoF for two reviews. It is not DoF. The
 * animal's circle of confusion at `tail` tops out near 1.05 half-res pixels
 * and the composite's 1→3 px ramp discards it entirely; the coat is identical
 * to four decimals with DoF on and off. The focus number was simply wrong.
 *
 * So resolve it from the rig. A pose may still override — `wide`, `aurora` and
 * `terrain` are landscape compositions where the subject is deliberately not
 * the focal plane — but the animal framings now track whatever the eye does.
 */
export function focusOnEye(pose, ctx, camPos) {
  if (pose.focusHold) return pose.focus;
  const a = ctx.fox?.anchors?.eyeR ?? ctx.fox?.anchors?.eyeL;
  if (!a) return pose.focus;
  a.updateWorldMatrix(true, false);
  const eye = new THREE.Vector3().setFromMatrixPosition(a.matrixWorld);
  return +camPos.distanceTo(eye).toFixed(4);
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
        // §9: focus the eye, measured, not authored. `focusHold` poses keep
        // their own number because they are landscape compositions where the
        // animal is deliberately not the focal plane.
        // A pose may request its own sun. Only `aurora` does, and it must.
        //
        // setSun only raises ctx.sunDirty; Environment consumes it inside the
        // SIMULATION tick, which is exactly what the shot tools have paused.
        // Without the zero-dt step below the flag sat unread and the aurora
        // pose was photographed under the default +6.6 sun -- 0.004% of sky
        // above +3 green, against 25.6% once the sun actually moved.
        // A pose that sets the sun must also UNSET it, or it leaks into every
        // pose shot after it. shoot.mjs sets the sun once before the loop and
        // walks POSES in declaration order, so `aurora`'s -6 degrees was
        // silently applying to `terrain`, `hero_long`, `nape`, `frontal` and
        // `chin` in every default run -- including the gate's own shots. The
        // aurora was visible in `frontal`. Caught by the framing agent, in a
        // bug I introduced when I gave the pose its sun.
        if (pose.sun) {
          if (!sunDefault) sunDefault = ctx.sunDirection.clone();
          api.setSun(pose.sun[0], pose.sun[1]);
          ctx.app.step(0);
        } else if (sunDefault) {
          ctx.sunDirection.copy(sunDefault);
          ctx.sunDirty = true;
          ctx.app.step(0);
        }
        const camNow = ctx.camera.getWorldPosition(new THREE.Vector3());
        const f = focusOnEye(pose, ctx, camNow);
        if (f) ctx.focusDistance = f;
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

      /**
       * Actually measure what a frame costs.
       *
       * `ctx.quality.avgFrameMs` is accumulated by the rAF loop -- and the
       * harness calls `pause()`, which stops that loop, before it measures
       * anything. So the number every review run has reported was whatever
       * the idle loading screen last averaged: 15.69 ms, the vsync interval,
       * IDENTICAL to two decimals across all 14 poses including one at 58
       * draw calls and one at 65. The per-tier `perf` block had the same
       * origin and reported ultra as FASTER than low, which is impossible.
       * §10's 16 ms budget has therefore never actually been verified.
       *
       * Timing `render()` calls alone measures only the CPU side, because GL
       * commands queue. A one-pixel `readPixels` after the batch forces the
       * driver to finish, so the elapsed time includes the GPU.
       *
       * `performance.now()` here is deliberate and is not the rule-6
       * violation it looks like: rule 6 forbids wall-clock in ANIMATION,
       * where it would break determinism. This advances no state.
       */
      measureFrameMs: (n = 60) => {
        const gl = ctx.renderer.getContext();
        const px = new Uint8Array(4);
        const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        for (let i = 0; i < 12; i++) ctx.app.render();   // warm caches + shaders
        sync();
        const t0 = performance.now();
        for (let i = 0; i < n; i++) ctx.app.render();
        sync();
        return +((performance.now() - t0) / n).toFixed(3);
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
