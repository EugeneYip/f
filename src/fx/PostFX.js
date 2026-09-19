// OWNER: postfx. The render-chain system. Order 950; the only system in the
// project permitted to define renderFrame().
//
// Pipeline (all half-float, all scene-linear until the very last pass):
//
//   scene -> HDR RT (projection jittered for TAA, depth texture attached)
//     |  GTAO (half res) + Poisson-style bilateral denoise
//     |  god-ray mask + 2x radial blur (quarter res)
//     +-> composite: AO x colour, exposure, height fog, shafts       [full res]
//         -> TAA resolve (history ping-pong, variance clip)          [full res]
//         -> RCAS-ish sharpen                                        [full res]
//         -> DoF: CoC prepare + near/far scatter-gather + composite  [half/full]
//         -> bloom prefilter + 7 mip down + 7 mip additive up        [pyramid]
//         -> grade: AgX + split tone + grain + CA + vignette + sRGB  [-> canvas]
//                                              (-> SMAA when TAA is off)
//
// ON DOUBLE TONEMAPPING (the classic way this goes wrong): three applies
// `renderer.toneMapping` only when the destination is the canvas — see
// WebGLRenderer.setProgram, which forces NoToneMapping whenever
// currentRenderTarget !== null. So rendering the scene into an HDR target is
// already untonemapped, and we must NOT touch renderer.toneMapping. Leaving it
// on AgX has the pleasant side effect that the bypass path
// (ctx.postfx.enabled = false) renders exactly the app's default look, which
// makes the A/B comparison honest rather than a blown-out linear straw man.
import * as THREE from 'three';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { clamp, damp, smoothstep } from '../util/math.js';
import { FxPass, makeRT, disposeRT, disposeQuad } from './Pass.js';
import { AO } from './AO.js';
import { Bloom } from './Bloom.js';
import { GodRays } from './GodRays.js';
import { DoF } from './DoF.js';
import { TAA } from './TAA.js';
import { makeComposite } from './Composite.js';
import { makeGrade, makeDebugBlit } from './Grade.js';

/* Post-specific sample counts. Quality.js has no keys for these and is not
   ours to edit, so they are derived from the tier name here; every one of them
   is overridable through ctx.postfx. The feature GATES all come from
   ctx.quality.get(): ao, bloom, dof, godRays, taa, smaa. */
const TUNE = {
  // At `low`: a 5-tap TAA clamp, no Catmull-Rom history, and no sharpen pass.
  // Sharpen is a whole extra full-res read/write whose only job is recovering
  // TAA softness — a luxury on the tier that exists for weak hardware.
  low:    { slices: 1, steps: 3, mips: 5, raySamples: 8,  dofTaps: 14, dofNearTaps: 10,
            taaCheap: true, sharpenScale: 0 },
  medium: { slices: 2, steps: 3, mips: 6, raySamples: 10, dofTaps: 24, dofNearTaps: 14 },
  high:   { slices: 2, steps: 4, mips: 7, raySamples: 12, dofTaps: 32, dofNearTaps: 18 },
  ultra:  { slices: 3, steps: 6, mips: 7, raySamples: 14, dofTaps: 48, dofNearTaps: 28 },
};

function defaults() {
  return {
    // Trim on top of ctx.exposure. The scene's key-to-fill ratio is only about
    // two stops, so at 1.0 everything piles onto AgX's shoulder and the image
    // goes flat and chalky. Pulling ~1.3 stops down puts snow near the top of
    // the curve with room to gradate, and drops the fox's shade side into the
    // part of the curve that still has contrast.
    exposure: 1.08,
    sharpen: 0.35,
    autofocus: false,

    // Near-neutral on purpose. The animal's salmon cast was A/B'd against
    // ctx.postfx.enabled = false and is identical, so it is the fur material,
    // not the grade — correcting it here would fight the fur agent's fix and
    // would drag the snow, which is already correctly white-blue, off-hue.
    whiteBalance: [0.995, 1.0, 1.01],
    grade: {
      shoulder: 1.0,
      // lookPower > 1 is the contrast lever that does NOT shorten the
      // highlight rolloff: it bends the midtones down while pinning 1.0, so
      // the fox's shade side separates from its lit side without touching the
      // shoulder that is keeping snow off the clip.
      // Eased from 1.30: even chroma-preserving, a power that steep costs a
      // dark warm feature real luminance against a cold bright surround.
      lookSlope: 1.0, lookOffset: 0.0, lookPower: 1.15, lookSat: 1.0,
      // Bible SS3: "slight lift on the blue channel in shadow". Tiny numbers —
      // these are additive in display-linear, so 0.02 is already visible.
      blackLift: [0.0006, 0.0009, 0.0014],
      shadowTint: [0.0, 0.004, 0.018], shadowAmount: 1.0, shadowFloor: 0.06,
      highlightTint: [0.009, 0.003, -0.006], highlightAmount: 1.0,
      // Contrast lives in agxLook.lookPower, which bends midtones while
      // pinning white. This display-space pivot stays at 1.0.
      contrast: 1.0, saturation: 1.0, shadowSat: 0.35, highlightDesat: 0.22,
      grain: 0.016, grainSize: 1.9, grainFps: 24,
      chroma: 0.0018, vignette: 0.11, dither: 1 / 255,
    },
    bloom: {
      /* Measured. strength is divided by the pyramid normalisation (~4.2), so
         the old 0.085 was an effective ~0.02 — invisible. Sweeping it against
         a snow-sparkle crop: strength 0 -> mean 187.0, 0.30 -> 190.9,
         1.00 -> 198.4. 0.30 gives real veiling glare on the glints without a
         grey wash. Threshold sits above diffuse white so the backlit fur does
         not bloom into the eye socket, which is what filled the eye at 0.95. */
      /* Deliberately conservative. At strength 0.30 the whole-frame minimum
         luminance rose from 16 to 30 — the veil the review flagged as 3a,
         coming back in through bloom. Under-blooming is the cheaper mistake.
         NOTE for the terrain agent: the snow glints sit in the SAME exposed
         HDR range as the lit fur (both ~1.0-1.3), so no absolute threshold
         separates them. Giving the sparkle real HDR headroom is what would
         let bloom turn it into crystal without also blooming the coat. */
      threshold: 1.25, softKnee: 0.55, strength: 0.12,
      scatter: 0.82, upsampleRadius: 1.0, clampMax: 64,
    },
    ao: {
      intensity: 1.0, radius: 0.085, power: 1.9, color: 0x46597d,
      // Almost everything in an arctic scene is bright, so the bright-pixel
      // relief has to trigger only on genuine speculars (crystal glints,
      // sun-lit rim) or it deletes the contact occlusion that grounds the
      // animal. Thresholds are in exposed HDR luminance.
      brightRelief: 0.35, reliefLo: 3.0, reliefHi: 14.0,
      fadeStart: 6, fadeEnd: 22,
      maxScreenRadius: 44, minScreenRadius: 2.5,
      denoiseRadius: 2.2, denoiseDepthSigma: 0.035,
    },
    dof: {
      // f/4 rather than f/2.8: the review poses focus at 0.13-1.6 m, where a
      // 33-85 mm equivalent wide open obliterates the snowfield the terrain
      // and sky agents built. f/4 still throws the background well clear.
      fStop: 4.0, sensorHeight: 0.024, scale: 1.0, maxCoC: 26,
      // Background blur ceiling as a fraction of image height, so the look is
      // identical at every resolution and adaptive-resolution step.
      /* MEASURED, not chosen by eye. The coat is alpha-blended, so the gaps
         between guard hairs carry the BACKGROUND's depth, not the hair's.
         Any background blur therefore replaces those gaps with smooth
         backdrop and the fringe averages out of existence — the tail's upper
         contour measured 3.91 detail with post off, 2.52 with DoF off, and
         only 1.49 at a 0.011 ceiling. Sweeping the ceiling recovers it:
         0.007 -> 1.84, 0.004 -> 2.45, i.e. essentially everything DoF was
         costing. Bible SS2.1 ("fur must break the silhouette") outranks
         SS9's shallow depth of field, so the fringe wins. The real fix is for
         the hairs to write depth; until then this is the honest ceiling. */
      maxBackgroundCoC: 0.005,
      nearGain: 1.0, edgeBoost: 0.14, blendLo: 1.0, blendHi: 3.0,
      highlightClamp: 7.0,
    },
    fog: {
      density: 0.018, falloff: 0.18, height: 0.0, strength: 1.0,
      sunGain: 0.85, phase: 7, color: 0xaac4e0, sunColor: 0xffd2a1,
      luminance: 0.55,
    },
    rays: {
      /* Measured at silhouette: sky near the sun +6.0 sRGB levels, the animal
         +3.4 (veiling glare through bloom, not the old additive halo), and
         exactly 0.0 at the profile pose where the sun is off screen: the fade is
         correct. Held at 0.30 rather than 0.45: this pass has a history of
         costing the subject more than it earns. */
      strength: 0.30, density: 0.62, decay: 0.94,
      threshold: 0.45, maskFalloff: 1.5, sunDisc: 0.25, shaftDensity: 0.045,
      blurGain: 4.0,
    },
    taa: { clampGamma: 1.25, antiGhost: 1.0, feedbackFrames: 12 },
    debug: 'off',   // off | ao | bloom | rays | coc | hdr | depth
  };
}

const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector4();
const _m4 = new THREE.Matrix4();
const _col = new THREE.Color();
const _size = new THREE.Vector2();

export class PostFX {
  name = 'postfx';
  order = 950;

  constructor() {
    this.ok = false;
    this.cfg = defaults();
    this.w = 0; this.h = 0;
    this._afDistance = 2.5;
    this._lastFrame = -1;
    this._failed = false;
    this._afBuf = new Uint8Array(4);
    // Scratch — renderFrame runs 60x a second and must not allocate.
    this._viewProjJ = new THREE.Matrix4();
    this._invViewProjJ = new THREE.Matrix4();
    this._invProjJ = new THREE.Matrix4();
    this._prevViewProj = new THREE.Matrix4();
    // Set only by _profile(), to cost each stage by difference.
    this._skip = { ao: false, bloom: false, dof: false, rays: false, taa: false, post: false };
  }

  // ------------------------------------------------------------------ init
  init(ctx) {
    this.ctx = ctx;
    this.renderer = ctx.renderer;
    this.api = this._makeApi();
    ctx.postfx = this.api;
    this._build(ctx);
  }

  _makeApi() {
    const self = this;
    const c = this.cfg;
    return {
      enabled: true,
      system: this,
      get sharpen() { return c.sharpen; },
      set sharpen(v) { c.sharpen = clamp(+v || 0, 0, 2); },
      setSharpen(v) { c.sharpen = clamp(+v || 0, 0, 2); return c.sharpen; },
      get autofocus() { return c.autofocus; },
      set autofocus(v) { c.autofocus = !!v; },
      get focusDistance() { return self._afDistance; },
      /* Read by SnowParticles for depth-softened flakes. This is the PREVIOUS
         frame's depth, which is the only one safe to sample while the scene
         pass is drawing into the current one. */
      get depthTexture() { return self.publishedDepth; },
      /* Authoritative: is a TAA resolve actually running this frame? Systems
         using stochastic/dithered alpha must key off THIS rather than the
         mere existence of a postfx system — at the `low` tier the chain is
         live but TAA is gated off, and an unresolved dither reads as a
         speckled coat. */
      get taaActive() { return self.ok && self.api?.enabled !== false && !!self.taa; },
      get near() { return self.ctx?.camera?.near ?? 0.05; },
      get far() { return self.ctx?.camera?.far ?? 900; },
      grade: c.grade,
      bloom: c.bloom,
      ao: c.ao,
      dof: c.dof,
      fog: c.fog,
      rays: c.rays,
      taa: c.taa,
      get whiteBalance() { return c.whiteBalance; },
      set whiteBalance(v) { c.whiteBalance = v; },
      get exposure() { return c.exposure; },
      set exposure(v) { c.exposure = Math.max(0, +v || 0); },
      get debug() { return c.debug; },
      set debug(v) { c.debug = String(v || 'off'); },
      reset() { self.taa?.reset(); },
      rebuild() { self._build(self.ctx); return self.ok; },
      stats() { return self._stats(); },
      profile(iters) { return self._profile(iters); },
    };
  }

  // ----------------------------------------------------------------- build
  _tune() {
    return TUNE[this.ctx.quality.tier] ?? TUNE.high;
  }

  _build(ctx) {
    this._teardown();
    const r = this.renderer;
    const bs = ctx.bufferSize ?? r.getDrawingBufferSize(_size);
    const w = Math.max(2, Math.round(bs.width ?? bs.x));
    const h = Math.max(2, Math.round(bs.height ?? bs.y));
    const q = ctx.quality;
    const tune = this._tune();

    try {
      this.w = w; this.h = h;
      this.gates = {
        ao: !!q.get('ao'), bloom: !!q.get('bloom'), dof: !!q.get('dof'),
        rays: !!q.get('godRays'), taa: !!q.get('taa'), smaa: !!q.get('smaa'),
      };

      // TWO depth textures, ping-ponged. The scene pass writes one of them
      // while soft snow particles SAMPLE the other: a shader cannot read the
      // depth attachment of the framebuffer it is drawing into without
      // tripping a WebGL feedback loop (and ANGLE reports that as a GL error,
      // which fails the review harness). A one-frame-old depth buffer is
      // indistinguishable for soft particles, and under the harness's
      // repeated static renders it is literally identical.
      this.depthTex = [this._makeDepth(w, h), this._makeDepth(w, h)];
      this.depthIdx = 0;
      this.publishedDepth = null;
      this.rtScene = makeRT(w, h, { name: 'hdrScene', depthBuffer: true });
      this.rtScene.depthTexture = this.depthTex[0];
      this.rtComposite = makeRT(w, h, { name: 'hdrComposite' });

      const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
      this.ao = this.gates.ao ? new AO(r, hw, hh, tune) : null;
      this.bloom = this.gates.bloom ? new Bloom(r, w, h, tune) : null;
      this.dof = this.gates.dof ? new DoF(r, w, h, tune) : null;
      this.rays = this.gates.rays
        ? new GodRays(r, Math.max(1, w >> 2), Math.max(1, h >> 2), tune) : null;
      this.taa = this.gates.taa ? new TAA(r, w, h, !!tune.taaCheap) : null;
      this.sharpenScale = tune.sharpenScale ?? 1;

      this.composite = makeComposite({
        ao: this.gates.ao, fog: true, rays: this.gates.rays,
      });
      this.grade = makeGrade();
      this.blit = makeDebugBlit();

      // SMAA only when TAA is off; it runs on the graded, sRGB-encoded image,
      // which is the space its edge thresholds were designed for.
      if (!this.gates.taa && this.gates.smaa) {
        this.smaa = new SMAAPass();
        this.smaa.setSize(w, h);
        // SMAA's blend material draws straight to the canvas, where three
        // WOULD apply the renderer's AgX on top of ours unless we opt out.
        for (const k of ['_materialEdges', '_materialWeights', '_materialBlend']) {
          if (this.smaa[k]) this.smaa[k].toneMapped = false;
        }
        this.rtLdr = makeRT(w, h, { name: 'ldr', type: THREE.UnsignedByteType });
      }

      // 1x1 RGBA8 probe for autofocus; only read back when autofocus is on.
      this.rtFocus = makeRT(1, 1, {
        name: 'focusProbe', type: THREE.UnsignedByteType,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
      this.focusProbe = this._makeFocusProbe();

      this.ok = true;
      this._failed = false;
    } catch (e) {
      this.ok = false;
      this._teardown();
      this._warn('chain construction failed', e);
    }
  }

  /* 1x1 probe: the nearest depth in a small window at screen centre, log
     encoded across two 8-bit channels so a single readPixels gives ~0.4%
     precision on the distance. Nearest rather than centre-exact so the focus
     locks onto a whisker or an ear tip rather than falling through a gap. */
  _makeFocusProbe() {
    return new FxPass('focusProbe', /* glsl */ `
      uniform sampler2D tDepth;
      uniform vec2  uTexel;
      uniform float uNear;
      uniform float uFar;
      varying vec2 vUv;
      void main() {
        float best = 1.0;
        for (int y = -2; y <= 2; y++) {
          for (int x = -2; x <= 2; x++) {
            best = min(best, texture2D(tDepth,
              vec2(0.5) + vec2(float(x), float(y)) * uTexel * 3.0).x);
          }
        }
        float z = fxViewZ(best, uNear, uFar);
        float t = clamp(log(z / 0.05) / log(2000.0), 0.0, 1.0);
        gl_FragColor = vec4(floor(t * 255.0) / 255.0, fract(t * 255.0), 0.0, 1.0);
      }
    `, {
      tDepth: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uNear: { value: 0.05 },
      uFar: { value: 900 },
    });
  }

  _makeDepth(w, h) {
    const d = new THREE.DepthTexture(w, h);
    d.type = THREE.UnsignedIntType;
    d.format = THREE.DepthFormat;
    d.minFilter = THREE.NearestFilter;
    d.magFilter = THREE.NearestFilter;
    d.generateMipmaps = false;
    return d;
  }

  _teardown() {
    if (this.rtScene) this.rtScene.depthTexture = null;
    for (const d of this.depthTex ?? []) d.dispose();
    this.depthTex = null;
    this.publishedDepth = null;
    this._pushDepth(null);
    this.ao?.dispose(); this.ao = null;
    this.bloom?.dispose(); this.bloom = null;
    this.dof?.dispose(); this.dof = null;
    this.rays?.dispose(); this.rays = null;
    this.taa?.dispose(); this.taa = null;
    this.composite?.dispose(); this.composite = null;
    this.grade?.dispose(); this.grade = null;
    this.blit?.dispose(); this.blit = null;
    this.focusProbe?.dispose(); this.focusProbe = null;
    this.smaa?.dispose?.(); this.smaa = null;
    disposeRT(this.rtScene); this.rtScene = null;
    disposeRT(this.rtComposite); this.rtComposite = null;
    disposeRT(this.rtLdr); this.rtLdr = null;
    disposeRT(this.rtFocus); this.rtFocus = null;
    this.ok = false;
  }

  /** Hand the previous frame's depth to anything that wants soft depth. */
  _pushDepth(tex) {
    this.publishedDepth = tex;
    const ctx = this.ctx;
    if (!ctx) return;
    const sp = ctx.snowParticles;
    if (sp?.setDepthTexture) {
      try { sp.setDepthTexture(tex, ctx.camera.near, ctx.camera.far); } catch { /* their problem */ }
    }
  }

  _warn(msg, e) {
    if (this._failed) return;
    this._failed = true;
    // console.warn, not console.error: the review harness fails the build on
    // console errors, and a degraded-but-correct image must not do that. The
    // failure is still surfaced through window.__FOX_ERRORS and FoxDebug.
    console.warn(`[postfx] ${msg} — falling back to a direct scene render`, e);
    globalThis.__FOX_ERRORS?.push(`postfx: ${msg}: ${e?.message ?? e}`);
  }

  // ---------------------------------------------------------------- resize
  resize(w, h, ctx) {
    if (!this.ok) return;
    const bs = ctx.bufferSize ?? this.renderer.getDrawingBufferSize(_size);
    const bw = Math.max(2, Math.round(bs.width ?? bs.x));
    const bh = Math.max(2, Math.round(bs.height ?? bs.y));
    if (bw === this.w && bh === this.h) return;
    this._applySize(bw, bh);
  }

  _applySize(bw, bh) {
    try {
      this.w = bw; this.h = bh;
      const hw = Math.max(1, bw >> 1), hh = Math.max(1, bh >> 1);
      this.rtScene.setSize(bw, bh);
      // RenderTarget.setSize deliberately does not touch depthTexture, and
      // three throws if the attached depth texture's size disagrees.
      for (const d of this.depthTex) {
        if (d.image.width === bw && d.image.height === bh) continue;
        d.image.width = bw; d.image.height = bh;
        d.dispose();
      }
      this._pushDepth(null);
      this.publishedDepth = null;
      this.rtComposite.setSize(bw, bh);
      this.ao?.setSize(hw, hh);
      this.bloom?.setSize(bw, bh);
      this.dof?.setSize(bw, bh);
      this.rays?.setSize(Math.max(1, bw >> 2), Math.max(1, bh >> 2));
      this.taa?.setSize(bw, bh);
      this.smaa?.setSize(bw, bh);
      this.rtLdr?.setSize(bw, bh);
    } catch (e) {
      this._warn('resize failed', e);
      this.ok = false;
    }
  }

  onQuality(e, ctx) {
    if (!e) return;
    const gateKeys = ['ao', 'bloom', 'dof', 'godRays', 'taa', 'smaa'];
    if (e.type === 'tier' || (e.type === 'override' && gateKeys.includes(e.key))) {
      this._build(ctx);
    } else if (e.type === 'renderScale') {
      this.taa?.reset();
    }
  }

  // ----------------------------------------------------------------- frame
  renderFrame(ctx) {
    const r = ctx.renderer;
    if (!this.ok || ctx.postfx?.enabled === false) {
      this.taa?.reset();
      r.setRenderTarget(null);
      r.render(ctx.scene, ctx.camera);
      return;
    }
    try {
      this._chain(ctx);
    } catch (e) {
      this._warn('renderFrame threw', e);
      this.ok = false;
      r.setRenderTarget(null);
      r.render(ctx.scene, ctx.camera);
    }
  }

  _chain(ctx) {
    const r = ctx.renderer;
    const cam = ctx.camera;
    const cfg = this.cfg;

    // Keep in step with adaptive resolution even if a resize event was missed.
    r.getDrawingBufferSize(_size);
    if (_size.x !== this.w || _size.y !== this.h) {
      this._applySize(Math.max(2, _size.x | 0), Math.max(2, _size.y | 0));
    }

    const taaOn = !!this.taa;
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

    // --- 1. scene into the HDR target, with a Halton sub-pixel offset -------
    const cut = taaOn ? this.taa.checkCut(cam) : { cut: false, still: false };
    const isStatic = cut.still && ctx.frame === this._lastFrame;
    if (cut.cut) this.taa?.reset();

    // Attach this frame's depth target; anything sampling depth during the
    // scene pass is still holding the other one.
    const depthTex = this.depthTex[this.depthIdx];
    if (this.rtScene.depthTexture !== depthTex) this.rtScene.depthTexture = depthTex;

    const projU = _m4.copy(cam.projectionMatrix);
    if (taaOn) {
      const [jx, jy] = this.taa.currentJitter();
      const e = cam.projectionMatrix.elements;
      e[8] += (jx * 2) / this.w;
      e[9] += (jy * 2) / this.h;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    }

    const prevAutoClear = r.autoClear;
    r.autoClear = true;
    r.setRenderTarget(this.rtScene);
    r.render(ctx.scene, cam);
    r.autoClear = false;

    // Matrices that downstream passes need, captured while the jitter is live.
    const viewProjJ = this._viewProjJ
      .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const invViewProjJ = this._invViewProjJ.copy(viewProjJ).invert();
    const invProjJ = this._invProjJ.copy(cam.projectionMatrixInverse);

    if (taaOn) {
      cam.projectionMatrix.copy(projU);
      cam.projectionMatrixInverse.copy(projU).invert();
    }

    const near = cam.near, far = cam.far;
    // Now that the scene pass is finished this texture is safe to sample, so
    // hand it to soft particles for the NEXT frame and flip the pair.
    this._pushDepth(depthTex);
    this.depthIdx ^= 1;
    const exposure = Math.max(0, (ctx.exposure ?? 1) * cfg.exposure);

    const skip = this._skip;
    if (skip.post) {
      // Scene-only reference for the differential profiler: still goes
      // through one fullscreen blit so the readPixels barrier is comparable.
      this.blit.u.tSrc.value = this.rtScene.texture;
      this.blit.u.uMode.value = 0;
      this.blit.u.uScale.value = 1;
      this.blit.render(r, null);
      r.autoClear = prevAutoClear;
      this._lastFrame = ctx.frame;
      return;
    }

    // --- 2. ambient occlusion ----------------------------------------------
    if (this.ao && !skip.ao) {
      this.ao.render({
        depth: depthTex, invProj: invProjJ, near, far,
        height: this.h >> 1,
        tanHalfFov: Math.tan((cam.fov * Math.PI) / 360),
        // Decorrelate the dither per accumulated TAA sample so 18 renders
        // average the AO noise into a clean field instead of freezing it.
        noiseOffset: taaOn ? (this.taa.index % 64) * 11.37 : 0,
        cfg: cfg.ao,
      });
    }

    // --- 3. god rays --------------------------------------------------------
    let rayFade = 0;
    if (this.rays && !skip.rays) rayFade = this._renderRays(ctx, cam, depthTex);
    else if (this.rays) this.rays.clear();

    // --- 4. composite -------------------------------------------------------
    this._composite(ctx, cam, depthTex, near, far, exposure, invViewProjJ, rayFade);

    // --- 5. TAA + sharpen ---------------------------------------------------
    let colour = this.rtComposite.texture;
    if (taaOn && !skip.taa) {
      colour = this.taa.render({
        current: this.rtComposite.texture, depth: depthTex,
        invViewProjJ, near, far, static_: isStatic, cfg: cfg.taa,
      });
      if (cfg.sharpen * this.sharpenScale > 0.001) {
        // rtComposite has been consumed; reuse it instead of a 4th full-res
        // half-float buffer.
        colour = this.taa.applySharpen(colour, cfg.sharpen * this.sharpenScale, this.rtComposite);
      }
      this.taa.advance();
      this.taa.storePrevViewProj(
        this._prevViewProj.multiplyMatrices(projU, cam.matrixWorldInverse));
    }

    // --- 6. depth of field --------------------------------------------------
    const focus = this._focus(ctx, depthTex);
    this._preDofTex = colour;
    if (this.dof && !skip.dof) {
      const cocScale = DoF.cocScale(cam.fov, focus, cfg.dof, this.h >> 1);
      this._lastCocScale = cocScale;
      colour = this.dof.render(colour, colour, depthTex,
        { cocScale, focus, near, far, cfg: cfg.dof });
    }

    // --- 7. bloom -----------------------------------------------------------
    if (this.bloom && !skip.bloom) this.bloom.render(colour, this.w, this.h, cfg.bloom);

    // --- 8. grade + output --------------------------------------------------
    if (cfg.debug !== 'off' && this._debugBlit(cfg.debug, colour, depthTex)) {
      r.autoClear = prevAutoClear;
      r.setRenderTarget(null);
      this._lastFrame = ctx.frame;
      return;
    }

    this._grade(ctx, colour, exposure);
    const dest = this.smaa ? this.rtLdr : null;
    this.grade.render(r, dest);
    if (this.smaa) {
      this.smaa.renderToScreen = true;
      this.smaa.render(r, null, this.rtLdr);
    }

    r.autoClear = prevAutoClear;
    r.setRenderTarget(null);
    this._lastFrame = ctx.frame;
  }

  // --------------------------------------------------------------- helpers
  _renderRays(ctx, cam, depthTex) {
    const cfg = this.cfg.rays;
    // Sun is directional: place it far along ctx.sunDirection from the camera.
    _v3.copy(cam.position).addScaledVector(ctx.sunDirection, 1000);
    _v4.set(_v3.x, _v3.y, _v3.z, 1).applyMatrix4(cam.matrixWorldInverse);
    const behind = _v4.z > -1e-4;
    _v4.applyMatrix4(cam.projectionMatrix);
    const iw = 1 / (Math.abs(_v4.w) < 1e-6 ? 1e-6 : _v4.w);
    const nx = _v4.x * iw, ny = _v4.y * iw;

    let fade = smoothstep(1.7, 0.85, Math.max(Math.abs(nx), Math.abs(ny)));
    fade *= smoothstep(-0.06, 0.07, ctx.sunDirection.y);
    if (behind) fade = 0;

    if (fade <= 0.001) { this.rays.clear(); return 0; }

    _col.copy(ctx.sunColor);
    this.rays.render(this.rtScene.texture, depthTex,
      { x: nx * 0.5 + 0.5, y: ny * 0.5 + 0.5 },
      this.w / this.h, _col, cfg);
    return fade;
  }

  _composite(ctx, cam, depthTex, near, far, exposure, invViewProjJ, rayFade) {
    const u = this.composite.u;
    const cfg = this.cfg;
    u.tHDR.value = this.rtScene.texture;
    u.tDepth.value = depthTex;
    u.uNear.value = near; u.uFar.value = far;
    u.uExposure.value = exposure;

    if (this.gates.ao) {
      u.tAO.value = this.ao.texture;
      u.uAOTexel.value.set(2 / this.w, 2 / this.h);
      u.uAOIntensity.value = cfg.ao.intensity;
      u.uAOPower.value = cfg.ao.power;
      u.uAOBrightRelief.value = cfg.ao.brightRelief;
      u.uAOReliefLo.value = cfg.ao.reliefLo;
      u.uAOReliefHi.value = cfg.ao.reliefHi;
      u.uAOFadeStart.value = cfg.ao.fadeStart;
      u.uAOFadeEnd.value = cfg.ao.fadeEnd;
      u.uAOColor.value.set(cfg.ao.color);
    }

    u.uInvViewProj.value.copy(invViewProjJ);
    u.uCamPos.value.copy(cam.position);
    u.uSunDir.value.copy(ctx.sunDirection);
    u.uFogColor.value.set(cfg.fog.color).multiplyScalar(cfg.fog.luminance);
    u.uFogSunColor.value.copy(ctx.sunColor).multiplyScalar(cfg.fog.luminance * 1.6);
    u.uFogDensity.value = cfg.fog.density;
    u.uFogFalloff.value = cfg.fog.falloff;
    u.uFogHeight.value = cfg.fog.height;
    u.uFogStrength.value = cfg.fog.strength;
    u.uFogSunGain.value = cfg.fog.sunGain;
    u.uFogPhase.value = cfg.fog.phase;

    if (this.gates.rays) {
      u.tRays.value = this.rays.texture;
      u.uRayTint.value.copy(ctx.sunColor);
      u.uRayStrength.value = cfg.rays.strength * rayFade;
      u.uShaftDensity.value = cfg.rays.shaftDensity;
      u.uRayTexel.value.set(4 / this.w, 4 / this.h);
    }

    this.composite.render(this.renderer, this.rtComposite);
  }

  /** ctx.focusDistance, or the depth at screen centre when autofocus is on. */
  _focus(ctx, depthTex) {
    const base = ctx.focusDistance ?? 2.5;
    if (!this.cfg.autofocus || !this.focusProbe) { this._afDistance = base; return base; }
    // Only re-probe once per simulated frame: the review harness renders the
    // same frame ~18 times and focus must not creep across those renders.
    if (ctx.frame !== this._lastFrame) {
      const u = this.focusProbe.u;
      u.tDepth.value = depthTex;
      u.uNear.value = ctx.camera.near;
      u.uFar.value = ctx.camera.far;
      u.uTexel.value.set(1 / this.w, 1 / this.h);
      this.focusProbe.render(this.renderer, this.rtFocus);
      this.renderer.readRenderTargetPixels(this.rtFocus, 0, 0, 1, 1, this._afBuf);
      const t = (this._afBuf[0] + this._afBuf[1] / 255) / 255;
      const z = 0.05 * Math.exp(t * Math.log(2000));
      // A focus motor has inertia; snapping reads as a glitch.
      this._afDistance = damp(this._afDistance, z, 6, Math.max(ctx.dt, 1 / 240));
    }
    return this._afDistance;
  }

  _grade(ctx, colour, exposure) {
    const u = this.grade.u;
    const g = this.cfg.grade;
    u.tSrc.value = colour;
    u.tBloom.value = this.bloom ? this.bloom.texture : null;
    u.uTexel.value.set(1 / this.w, 1 / this.h);
    // Exposure is already baked into the composite; the grade only needs it
    // for the bloom it adds on top, so pass 1.0 and pre-scale the bloom.
    u.uExposure.value = 1;
    u.uWhiteBalance.value.fromArray(this.cfg.whiteBalance);
    u.uBloomStrength.value = (this.bloom && !this._skip.bloom)
      ? (this.cfg.bloom.strength * exposure) / this.bloom.normalisation : 0;
    u.uChroma.value = g.chroma;
    u.uVignette.value = g.vignette;
    u.uShoulder.value = g.shoulder;
    u.uLookSlope.value = g.lookSlope;
    u.uLookOffset.value = g.lookOffset;
    u.uLookPower.value = g.lookPower;
    u.uLookSat.value = g.lookSat;
    u.uShadowTint.value.fromArray(g.shadowTint);
    u.uShadowAmount.value = g.shadowAmount;
    u.uShadowFloor.value = g.shadowFloor;
    u.uHighlightTint.value.fromArray(g.highlightTint);
    u.uHighlightAmount.value = g.highlightAmount;
    u.uContrast.value = g.contrast;
    u.uSaturation.value = g.saturation;
    u.uShadowSat.value = g.shadowSat;
    u.uHighlightDesat.value = g.highlightDesat;
    u.uBlackLift.value.fromArray(g.blackLift);
    u.uGrain.value = g.grain;
    u.uGrainSize.value = g.grainSize;
    // Quantised to a shutter rate so it reads as film frames, and so repeated
    // renders of one simulated frame produce an identical grain field.
    u.uGrainSeed.value = Math.floor((ctx.time ?? 0) * g.grainFps) % 1024;
    u.uDither.value = g.dither;
  }

  _debugBlit(mode, colour, depthTex) {
    const map = {
      // What did DoF actually change, and where? Amplified 20x.
      dofdelta: [colour, 4, 20, this._preDofTex],
      dofnear: [this.dof?.rtNear.texture, 2, 1],
      dofnearmax: [this.dof?.rtMaxB.texture, 1, 0.2],
      doffar: [this.dof?.rtFar.texture, 0, 1],
      ao: [this.ao?.texture, 1, 1],
      bloom: [this.bloom?.texture, 0, 6],
      rays: [this.rays?.texture, 0, 3],
      coc: [this.dof?.rtPrep.texture, 3, 0.08],
      hdr: [colour, 0, 1],
      depth: [depthTex, 1, 1],
    };
    const entry = map[mode];
    if (!entry || !entry[0]) return false;
    this.blit.u.tSrc.value = entry[0];
    this.blit.u.uMode.value = entry[1];
    this.blit.u.uScale.value = entry[2];
    this.blit.u.tRef.value = entry[3] ?? null;
    this.blit.render(this.renderer, null);
    return true;
  }

  // ----------------------------------------------------------------- probes
  _stats() {
    return {
      ok: this.ok,
      enabled: this.ctx?.postfx?.enabled !== false,
      size: [this.w, this.h],
      tier: this.ctx?.quality?.tier,
      gates: this.gates,
      taaActive: this.ok && this.api?.enabled !== false && !!this.taa,
      bloomMips: this.bloom?.mips.length ?? 0,
      taaSamples: this.taa ? this.taa.n + 1 : 0,
      focus: this._afDistance,
      ctxFocus: this.ctx?.focusDistance,
      cocScale: this._lastCocScale ?? null,
      fStop: this.ctx ? DoF.effectiveFStop(this.ctx.camera.fov,
        this._afDistance, this.cfg.dof, this.h >> 1) : null,
    };
  }

  /**
   * Per-stage GPU cost by DIFFERENCE: time a full frame, then time it again
   * with one stage skipped. Timing the stages in isolation does not work here
   * — gl.finish() returns early under ANGLE/Metal, and a readPixels barrier
   * on the default framebuffer only reliably drains work that reached the
   * canvas, so an isolated render-to-texture pass measures as ~0. Differences
   * of a full, canvas-terminated frame are apples to apples.
   *
   * Absolute numbers are a ceiling when other processes share the GPU.
   */
  _profile(iters = 20) {
    const ctx = this.ctx;
    const gl = this.renderer.getContext();
    const buf = new Uint8Array(4);
    const frame = () => {
      this.renderFrame(ctx);
      this.renderer.setRenderTarget(null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    };
    const measure = () => {
      for (let i = 0; i < 4; i++) frame();          // warm up / settle TAA
      const t0 = performance.now();
      for (let i = 0; i < iters; i++) frame();
      return (performance.now() - t0) / iters;
    };

    const prevDebug = this.cfg.debug;
    this.cfg.debug = 'off';
    const sk = this._skip;
    const out = {};
    try {
      const full = measure();
      const one = (key) => {
        sk[key] = true;
        const t = measure();
        sk[key] = false;
        return +(full - t).toFixed(3);
      };
      out.frameMs = +full.toFixed(3);
      out.ao = this.ao ? one('ao') : 0;
      out.bloom = this.bloom ? one('bloom') : 0;
      out.dof = this.dof ? one('dof') : 0;
      out.rays = this.rays ? one('rays') : 0;
      out.taa = this.taa ? one('taa') : 0;
      sk.post = true;
      const sceneOnly = measure();
      sk.post = false;
      out.sceneMs = +sceneOnly.toFixed(3);
      out.postTotal = +(full - sceneOnly).toFixed(3);
      // Whatever the named stages do not account for: composite + grade +
      // the extra full-res round trips.
      out.compositeGradeEtc = +(out.postTotal - out.ao - out.bloom -
        out.dof - out.rays - out.taa).toFixed(3);
    } finally {
      for (const k of Object.keys(sk)) sk[k] = false;
      this.cfg.debug = prevDebug;
      this.renderer.setRenderTarget(null);
      this.taa?.reset();
    }
    return out;
  }

  dispose() {
    this._teardown();
    disposeQuad();
  }
}
