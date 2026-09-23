// OWNER: postfx. Temporal anti-aliasing + RCAS-style sharpen.
//
// This scene is the worst case for aliasing: ~750k triangles of shell fur with
// stochastic alpha, discrete crystal sparkle on the snow, and thousands of
// sub-pixel snow particles. None of that is fixable spatially; it has to be
// integrated over time.
//
// CONVERGENCE CONTRACT. `tools/shoot.mjs` calls `FoxDebug.render()` 18 times
// with the camera and ctx.time frozen. So the accumulation weight is the
// incremental-mean 1/(n+1): with a static camera that is an exact box average
// of n+1 jittered samples (18x SSAA by the time the screenshot is taken), and
// because the Catmull-Rom history fetch is exact at zero reprojection offset,
// nothing softens along the way. When anything moves, n is capped so the
// weight floors at a normal TAA feedback of ~1/13.
//
// No velocity buffer: motion vectors would need a second scene pass with an
// override material, which cannot reproduce the fur shells' own vertex
// displacement and would cost more than the entire post budget. Instead we
// reproject through depth with the previous unjittered view-projection, which
// is exact for everything static (all of the terrain, sky and snow), and let
// variance clipping handle the animal.
//
// BOTH ENDS OF THAT REPROJECTION MUST BE UNJITTERED. For four rounds the
// current end was the jittered inverse, which put this frame's sub-pixel
// offset into the motion vector: prevUv - vUv measured exactly the Halton
// jitter, up to 0.47 px, at every depth and every pixel, so a frozen camera
// resampled its own history bilinearly on every accumulated frame instead of
// fetching it back unchanged. The contract above was simply false, and the
// coat's contour paid for it -- see the comment at the reprojection itself.
//
// VERIFIED, and the verification found the diagnosis INCOMPLETE. In-session
// A/B over cfg.taa.dejitterReproject, orders alternated on/off/on/off, one sim
// instant, 18 accumulated renders per arm, repeats bit-stable (arm-to-arm
// repeat moved 0.08-0.58% of the frame at max delta 4; on-vs-off moved 96.4%
// at macro_eye). Measured inside the coat band (matte-located, 18 px in from
// the contour, 99436 px at `profile`):
//
//                      OFF (as shipped for 4 rounds)   ON (fixed)
//   fine-detail rms          1.546                       5.769   (3.7x)
//   axis-aligned share       0.540                       0.479
//   vertical autocorr        +0.103 / -0.100 / -0.025    -0.164 / +0.002 / +0.020
//
// That middle row of autocorrelation IS the defect: a damped 4 px vertical
// ripple, i.e. the comb. It is gone. It converges too -- 18 / 60 / 180
// accumulated renders give rms 6.546 / 6.430 / 6.428, so what the fix restores
// is resolved detail and not unintegrated dither.
//
// BUT THE CHEVRONS AT `macro_eye` ARE NOT THIS PASS AND NEVER WERE. They are
// still there, sharper. Attributed in one session at one instant:
// hiding `ctx.fur.cardMesh` removes every right-angled bracket and leaves soft
// directional shell fur; hiding `ctx.fur.shellMesh` leaves the brackets as the
// ENTIRE image. The fur cards have a hard kink and their silhouettes are the
// staples. Do not spend another round on the resolve for that.
//
// The earlier "hiding post removes it" elimination was the AGENTS.md trap
// verbatim: post off also gates TAA off, the coat's stochastic alpha is then
// unresolved, and the whole crop becomes a noise field in which no shape of
// any kind is visible. `nopost` cannot answer a question about coat structure.
import * as THREE from 'three';
import { FxPass, makeRT, disposeRT } from './Pass.js';
import { FX_CATMULL_ROM } from './glsl/common.js';

/** Radical-inverse base b — the standard low-discrepancy jitter sequence. */
function halton(index, base) {
  let f = 1, r = 0, i = index;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}

const RESOLVE_FRAG = FX_CATMULL_ROM + /* glsl */ `
uniform sampler2D tCurr;
uniform sampler2D tHist;
uniform sampler2D tDepth;
uniform vec2  uTexel;
uniform vec2  uRes;
uniform mat4  uInvViewProj;    // current frame, WITHOUT jitter
uniform mat4  uPrevViewProj;   // previous frame, WITHOUT jitter
uniform float uNear;
uniform float uFar;
uniform float uAlpha;          // weight of the current sample
uniform float uClampGamma;
uniform float uClamp;        // 0 disables clipping entirely
uniform float uLoosen;       // widen the box where the neighbourhood is detailed
uniform float uAntiGhost;      // 0 while the camera is static
uniform float uUseCR;          // 0 when reprojection is the identity
uniform float uDisocclude;     // 0 while the camera AND the sim are frozen
uniform float uReset;
varying vec2 vUv;

void main() {
  vec3 curr = fxSafe(texture2D(tCurr, vUv).rgb);
  float d = texture2D(tDepth, vUv).x;
  float vz = fxViewZ(d, uNear, uFar);

  // --- neighbourhood statistics, in compressed YCoCg ----------------------
  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  vec3 cmin = vec3(1e9), cmax = vec3(-1e9);
#ifdef TAA_CHEAP
  /* 5-tap cross instead of the full 3x3. The corners contribute least to the
     clipping box, and the low tier exists for weak hardware. */
  vec2 offs[5] = vec2[5](vec2(0.0), vec2(-1.0, 0.0), vec2(1.0, 0.0),
                         vec2(0.0, -1.0), vec2(0.0, 1.0));
  for (int i = 0; i < 5; i++) {
    vec3 s = fxRGB2YCoCg(fxCompress(fxSafe(texture2D(tCurr, vUv + offs[i] * uTexel).rgb)));
    m1 += s; m2 += s * s;
    cmin = min(cmin, s); cmax = max(cmax, s);
  }
  m1 /= 5.0; m2 /= 5.0;
#else
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 s = fxRGB2YCoCg(fxCompress(
        fxSafe(texture2D(tCurr, vUv + vec2(float(x), float(y)) * uTexel).rgb)));
      m1 += s; m2 += s * s;
      cmin = min(cmin, s); cmax = max(cmax, s);
    }
  }
  m1 /= 9.0; m2 /= 9.0;
#endif
  vec3 sigma = sqrt(max(m2 - m1 * m1, vec3(0.0)));
  // Variance clipping (Salvi): intersect the AABB of the 3x3 with a
  // gamma-sigma box around the mean. Tighter than min/max alone on smooth
  // gradients — which is most of this frame — so ghosts die faster, but it
  // still contains the full edge range, so a converging average is never
  // clipped away.
  /* Widen the box where the neighbourhood is ALREADY high-variance. A thin,
     high-contrast hair against bright sky makes history and current disagree
     in a high-frequency way, not a motion way — and an intersection of the
     3x3 min/max with a gamma-sigma box rejects exactly that, which is how the
     resolve was deleting the hairs the fur system draws. */
  float detail = smoothstep(0.015, 0.12, sigma.x);
  vec3 pad = sigma * (uLoosen * detail);
  vec3 lo = max(cmin - pad, m1 - uClampGamma * (1.0 + uLoosen * detail) * sigma);
  vec3 hi = min(cmax + pad, m1 + uClampGamma * (1.0 + uLoosen * detail) * sigma);

  // --- reprojection --------------------------------------------------------
  // BOTH matrices are jitter-free, so this is a pure motion vector. Feeding
  // the JITTERED inverse in here (which is what this pass used to do) makes
  // prevUv - vUv equal the current Halton offset everywhere on screen --
  // measured at up to 0.47 px, identical at every depth -- so the history was
  // resampled bilinearly by the jitter on every single frame. Each accumulated
  // sample then sat at a different cumulative displacement and a thin bright
  // hair integrated into an axis-aligned comb of echoes of itself: REVIEW-4
  // blocker 6, the "pixel lattice" on the coat's contour. Jitter is not
  // motion. See PostFX._chain for the matrix that is handed in.
  vec3 wp = fxWorldPos(vUv, d, uInvViewProj);
  vec4 pp = uPrevViewProj * vec4(wp, 1.0);
  vec2 prevUv = (pp.xy / pp.w) * 0.5 + 0.5;

  float valid = 1.0 - uReset;
  valid *= step(0.0, pp.w);
  valid *= step(0.0, prevUv.x) * step(prevUv.x, 1.0)
         * step(0.0, prevUv.y) * step(prevUv.y, 1.0);

  // Disocclusion test against the view distance stored in history alpha.
  //
  // GATED ON MOTION, for the same reason uClamp is. When the camera is still
  // AND the sim frame has not advanced, the only thing that differs between
  // history and current is the sub-pixel jitter -- so nothing can have been
  // disoccluded and every rejection this test makes is a false positive.
  //
  // It is not a harmless false positive either. It fires hardest exactly
  // where the depth ratio across one pixel is largest, which is the horizon:
  // jitter flips an edge texel between the snowfield at ~200 m and the sky at
  // the far plane, abs(hz - vz)/vz lands around 3.5, valid goes to 0, alpha
  // goes to 1 and history is thrown away. The pixel then shows ONE jittered
  // sample instead of eighteen, and the sky-to-snow transition arrives as a
  // 40-level cliff in a single pixel no matter how long the harness
  // accumulates -- measured at x=1800 in wide.png and reported as blocker 14.
  // Every other edge in frame resolves because its depth contrast is small
  // enough to stay inside the 0.02-0.08 window; the horizon is the one place
  // in an arctic scene where it is not.
  float hz = texture2D(tHist, prevUv).a;
  valid *= 1.0 - smoothstep(0.02, 0.08, abs(hz - vz) / max(vz, 0.05)) * uDisocclude;

  // Catmull-Rom is exact at zero offset, so when the camera has not moved a
  // single bilinear tap gives a bit-identical result for a fifth of the cost.
#ifdef TAA_CHEAP
  vec3 histRGB = texture2D(tHist, prevUv).rgb;   // no Catmull-Rom at low tier
#else
  vec3 histRGB = uUseCR > 0.5
    ? fxHistoryCR(tHist, prevUv, uRes, uTexel)
    : texture2D(tHist, prevUv).rgb;
#endif
  /* With a static camera and a static sim the ONLY difference between history
     and current is the sub-pixel jitter — there is no motion, no disocclusion
     and nothing to ghost, so clipping is provably unnecessary and actively
     destroys the sub-pixel samples this resolve exists to integrate. The
     convergence contract in the header demands those samples survive. */
  vec3 histY = fxRGB2YCoCg(fxCompress(fxSafe(histRGB)));
  vec3 hist = mix(histY, clamp(histY, lo, hi), uClamp);
  histRGB = fxUncompress(fxYCoCg2RGB(hist));

  float alpha = mix(1.0, uAlpha, valid);

  // Luminance-weighted feedback: where history and current disagree badly the
  // clip has probably only half-worked, so lean on the current frame. Gated
  // off entirely when the camera is static so it can never fight convergence.
  float lc = fxLum(curr), lh = fxLum(histRGB);
  float diff = abs(lc - lh) / max(max(lc, lh), 0.2);
  alpha = mix(alpha, min(1.0, alpha * 5.0),
              smoothstep(0.3, 1.0, diff) * uAntiGhost);

  vec3 outc = mix(histRGB, curr, clamp(alpha, 0.0, 1.0));
  gl_FragColor = vec4(fxSafe(outc), vz);
}
`;

const SHARPEN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2  uTexel;
uniform float uAmount;
varying vec2 vUv;

vec3 T(vec2 o) { return fxCompress(fxSafe(texture2D(tSrc, vUv + o * uTexel).rgb)); }

void main() {
  // RCAS-flavoured: a cross-shaped unsharp mask clamped to the 5-tap min/max,
  // which is what makes it ringing-free. Run in compressed (0..1) space
  // because the contrast-adaptive clamp is meaningless on raw HDR.
  vec3 e = T(vec2(0.0,  0.0));
  vec3 b = T(vec2(0.0, -1.0));
  vec3 dd = T(vec2(-1.0, 0.0));
  vec3 f = T(vec2(1.0,  0.0));
  vec3 h = T(vec2(0.0,  1.0));

  vec3 blur = (b + dd + f + h) * 0.25;
  vec3 sharp = e + (e - blur) * uAmount;
  vec3 mn = min(e, min(min(b, dd), min(f, h)));
  vec3 mx = max(e, max(max(b, dd), max(f, h)));
  sharp = clamp(sharp, mn, mx);

  gl_FragColor = vec4(fxSafe(fxUncompress(sharp)), 1.0);
}
`;

export class TAA {
  constructor(renderer, w, h, cheap = false) {
    this.renderer = renderer;
    this.histA = makeRT(w, h, { name: 'taaHistA' });
    this.histB = makeRT(w, h, { name: 'taaHistB' });
    // Allocated lazily by _ownOut(), and only if the caller ever sharpens
    // without handing us a spare buffer. PostFX always hands one over.
    this.out = null;

    this.jitter = [];
    for (let i = 1; i <= 16; i++) {
      this.jitter.push([halton(i, 2) - 0.5, halton(i, 3) - 0.5]);
    }
    this.index = 0;
    this.n = 0;          // accumulated sample count since the last reset
    this.needsReset = true;

    this._prevViewProj = new THREE.Matrix4();
    this._camKey = null;

    this.resolve = new FxPass('taaResolve', RESOLVE_FRAG, {
      tCurr: { value: null },
      tHist: { value: null },
      tDepth: { value: null },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uRes: { value: new THREE.Vector2(w, h) },
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uNear: { value: 0.05 },
      uFar: { value: 900 },
      uAlpha: { value: 1 },
      uClampGamma: { value: 1.25 },
      uClamp: { value: 1 },
      uLoosen: { value: 1.5 },
      uAntiGhost: { value: 0 },
      uUseCR: { value: 1 },
      uDisocclude: { value: 1 },
      uReset: { value: 1 },
    }, cheap ? { TAA_CHEAP: '' } : {});

    this.sharpen = new FxPass('sharpen', SHARPEN_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uAmount: { value: 0.35 },
    });
  }

  setSize(w, h) {
    this.histA.setSize(w, h);
    this.histB.setSize(w, h);
    this.out?.setSize(w, h);
    this.resolve.u.uTexel.value.set(1 / w, 1 / h);
    this.resolve.u.uRes.value.set(w, h);
    this.sharpen.u.uTexel.value.set(1 / w, 1 / h);
    this.reset();
  }

  /** A hard cut. Rewinds the jitter phase too, so two runs of the same pose
   *  draw the same Halton samples in the same order and review screenshots
   *  are bit-reproducible rather than merely visually equivalent. */
  reset() { this.needsReset = true; this.n = 0; this.index = 0; }

  /** Current sub-pixel offset in pixels, in [-0.5, 0.5]. */
  currentJitter() { return this.jitter[this.index % this.jitter.length]; }

  advance() { this.index++; }

  /**
   * Detects a camera cut. Gentle drift must NOT reset (reprojection handles
   * it); a pose change must, or the first frame of every review shot ghosts
   * the previous pose.
   */
  checkCut(camera) {
    const e = camera.matrixWorld.elements;
    // position, then the camera's own basis columns (col 2 is +Z = backward).
    const key = [e[12], e[13], e[14], e[8], e[9], e[10], e[0], e[1], e[2], camera.fov];
    const prev = this._camKey;
    let cut = false;
    let still = false;
    if (!prev) {
      cut = true;
    } else {
      // "Still" has to be an exact test, not a tolerance: it gates the
      // unbounded accumulation that gives the review harness its 18-sample
      // convergence, and a near-1 dot product of a unit vector with itself is
      // only accurate to ~1e-7, which no sane epsilon distinguishes from a
      // one-arcsecond drift.
      still = true;
      for (let i = 0; i < key.length; i++) {
        if (key[i] !== prev[i]) { still = false; break; }
      }
      const dx = e[12] - prev[0], dy = e[13] - prev[1], dz = e[14] - prev[2];
      const move = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const dot = key[3] * prev[3] + key[4] * prev[4] + key[5] * prev[5];
      // Generous thresholds: a cinematic drift must keep its history (that is
      // what reprojection is for); only a pose CUT may throw it away.
      cut = move > 0.25 || dot < 0.99 || key[9] !== prev[9];
    }
    this._camKey = key;
    return { cut, still };
  }

  /** @param p {{ current, depth, invViewProj, near, far, static_, cfg }} */
  render(p) {
    const r = this.renderer;
    const reset = this.needsReset;

    // Incremental mean while nothing moves -> exact multi-sample average.
    // Capped feedback once anything does -> classic stable TAA.
    if (reset) this.n = 0;
    else this.n = Math.min(this.n + 1, p.static_ ? 250 : p.cfg.feedbackFrames);

    const u = this.resolve.u;
    u.tCurr.value = p.current;
    u.tHist.value = this.histB.texture;
    u.tDepth.value = p.depth;
    if (!p.invViewProj) throw new Error('TAA.render: invViewProj is required');
    u.uInvViewProj.value.copy(p.invViewProj);
    u.uPrevViewProj.value.copy(this._prevViewProj);
    u.uNear.value = p.near;
    u.uFar.value = p.far;
    u.uAlpha.value = 1 / (this.n + 1);
    u.uClampGamma.value = p.cfg.clampGamma;
    u.uClamp.value = p.static_ ? 0 : 1;
    u.uLoosen.value = p.cfg.clampLoosen;
    u.uAntiGhost.value = p.static_ ? 0 : p.cfg.antiGhost;
    u.uUseCR.value = p.static_ ? 0 : 1;
    u.uDisocclude.value = p.static_ ? 0 : 1;
    u.uReset.value = reset ? 1 : 0;

    this.resolve.render(r, this.histA);
    this.needsReset = false;

    // ping-pong
    const t = this.histA; this.histA = this.histB; this.histB = t;
    return this.histB.texture;     // the target we just wrote
  }

  /**
   * @param target a full-res half-float RT the caller has finished with. The
   *   caller hands us the composite buffer, which TAA has already consumed —
   *   the third argument used to be passed and silently ignored, so this class
   *   allocated a fourth full-res half-float target nobody needed (40 MB at
   *   1400x900 with --dsf 2). Falls back to its own buffer if none is given.
   */
  applySharpen(texture, amount, target = null) {
    const dst = target ?? this._ownOut();
    this.sharpen.u.tSrc.value = texture;
    this.sharpen.u.uAmount.value = amount;
    this.sharpen.render(this.renderer, dst);
    return dst.texture;
  }

  _ownOut() {
    if (!this.out) this.out = makeRT(this.histA.width, this.histA.height, { name: 'taaSharp' });
    return this.out;
  }

  storePrevViewProj(m) { this._prevViewProj.copy(m); }

  dispose() {
    disposeRT(this.histA); disposeRT(this.histB); disposeRT(this.out);
    this.out = null;
    this.resolve.dispose(); this.sharpen.dispose();
  }
}
