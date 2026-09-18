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
uniform mat4  uInvViewProjJ;   // current frame, WITH jitter
uniform mat4  uPrevViewProj;   // previous frame, WITHOUT jitter
uniform float uNear;
uniform float uFar;
uniform float uAlpha;          // weight of the current sample
uniform float uClampGamma;
uniform float uAntiGhost;      // 0 while the camera is static
uniform float uReset;
varying vec2 vUv;

void main() {
  vec3 curr = fxSafe(texture2D(tCurr, vUv).rgb);
  float d = texture2D(tDepth, vUv).x;
  float vz = fxViewZ(d, uNear, uFar);

  // --- neighbourhood statistics, in compressed YCoCg ----------------------
  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  vec3 cmin = vec3(1e9), cmax = vec3(-1e9);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 s = fxRGB2YCoCg(fxCompress(
        fxSafe(texture2D(tCurr, vUv + vec2(float(x), float(y)) * uTexel).rgb)));
      m1 += s; m2 += s * s;
      cmin = min(cmin, s); cmax = max(cmax, s);
    }
  }
  m1 /= 9.0; m2 /= 9.0;
  vec3 sigma = sqrt(max(m2 - m1 * m1, vec3(0.0)));
  // Variance clipping (Salvi): intersect the AABB of the 3x3 with a
  // gamma-sigma box around the mean. Tighter than min/max alone on smooth
  // gradients — which is most of this frame — so ghosts die faster, but it
  // still contains the full edge range, so a converging average is never
  // clipped away.
  vec3 lo = max(cmin, m1 - uClampGamma * sigma);
  vec3 hi = min(cmax, m1 + uClampGamma * sigma);

  // --- reprojection --------------------------------------------------------
  vec3 wp = fxWorldPos(vUv, d, uInvViewProjJ);
  vec4 pp = uPrevViewProj * vec4(wp, 1.0);
  vec2 prevUv = (pp.xy / pp.w) * 0.5 + 0.5;

  float valid = 1.0 - uReset;
  valid *= step(0.0, pp.w);
  valid *= step(0.0, prevUv.x) * step(prevUv.x, 1.0)
         * step(0.0, prevUv.y) * step(prevUv.y, 1.0);

  // Disocclusion test against the view distance stored in history alpha.
  float hz = texture2D(tHist, prevUv).a;
  valid *= 1.0 - smoothstep(0.02, 0.08, abs(hz - vz) / max(vz, 0.05));

  vec3 histRGB = fxHistoryCR(tHist, prevUv, uRes, uTexel);
  vec3 hist = clamp(fxRGB2YCoCg(fxCompress(fxSafe(histRGB))), lo, hi);
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
  constructor(renderer, w, h) {
    this.renderer = renderer;
    this.histA = makeRT(w, h, { name: 'taaHistA' });
    this.histB = makeRT(w, h, { name: 'taaHistB' });
    this.out = makeRT(w, h, { name: 'taaSharp' });

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
      uInvViewProjJ: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uNear: { value: 0.05 },
      uFar: { value: 900 },
      uAlpha: { value: 1 },
      uClampGamma: { value: 1.25 },
      uAntiGhost: { value: 0 },
      uReset: { value: 1 },
    });

    this.sharpen = new FxPass('sharpen', SHARPEN_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uAmount: { value: 0.35 },
    });
  }

  setSize(w, h) {
    this.histA.setSize(w, h);
    this.histB.setSize(w, h);
    this.out.setSize(w, h);
    this.resolve.u.uTexel.value.set(1 / w, 1 / h);
    this.resolve.u.uRes.value.set(w, h);
    this.sharpen.u.uTexel.value.set(1 / w, 1 / h);
    this.reset();
  }

  reset() { this.needsReset = true; this.n = 0; }

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
    const key = [e[12], e[13], e[14], e[0], e[4], e[8], e[2], e[6], e[10], camera.fov];
    const prev = this._camKey;
    let cut = false;
    let still = false;
    if (!prev) {
      cut = true;
    } else {
      const dx = e[12] - prev[0], dy = e[13] - prev[1], dz = e[14] - prev[2];
      const move = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // forward-axis agreement (matrixWorld col 2 is the camera's +Z = backward)
      const dot = key[6] * prev[6] + key[7] * prev[7] + key[8] * prev[8];
      cut = move > 0.25 || dot < 0.99 || key[9] !== prev[9];
      still = move === 0 && dot >= 1 - 1e-9 && key[9] === prev[9];
    }
    this._camKey = key;
    return { cut, still };
  }

  /** @param p {{ current, depth, invViewProjJ, near, far, static_, cfg }} */
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
    u.uInvViewProjJ.value.copy(p.invViewProjJ);
    u.uPrevViewProj.value.copy(this._prevViewProj);
    u.uNear.value = p.near;
    u.uFar.value = p.far;
    u.uAlpha.value = 1 / (this.n + 1);
    u.uClampGamma.value = p.cfg.clampGamma;
    u.uAntiGhost.value = p.static_ ? 0 : p.cfg.antiGhost;
    u.uReset.value = reset ? 1 : 0;

    this.resolve.render(r, this.histA);
    this.needsReset = false;

    // ping-pong
    const t = this.histA; this.histA = this.histB; this.histB = t;
    return this.histB.texture;     // the target we just wrote
  }

  applySharpen(texture, amount) {
    this.sharpen.u.tSrc.value = texture;
    this.sharpen.u.uAmount.value = amount;
    this.sharpen.render(this.renderer, this.out);
    return this.out.texture;
  }

  storePrevViewProj(m) { this._prevViewProj.copy(m); }

  dispose() {
    disposeRT(this.histA); disposeRT(this.histB); disposeRT(this.out);
    this.resolve.dispose(); this.sharpen.dispose();
  }
}
