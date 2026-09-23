// OWNER: postfx. Scatter-as-gather bokeh depth of field.
//
// BokehPass is a two-tap variable blur; it cannot produce a bokeh disc and it
// gets the foreground exactly backwards. The failure everyone recognises is a
// defocused foreground object with a razor-sharp edge, because a naive gather
// asks "how blurred am I?" instead of "whose circle of confusion reaches me?".
//
// So both fields are built by scatter-as-gather: a tap contributes when its
// OWN circle of confusion covers the pixel being shaded. Splitting the taps
// into a near layer (in front of focus) and a far layer (behind) by sign, then
// compositing near OVER the rest with its accumulated coverage as alpha, gives
// correct foreground bleed without the background smearing onto sharp subjects.
//
// The circle of confusion is the real thin-lens one, so the strength of the
// effect follows the framing for free: at `wide` (46 deg, focus 8.2 m) the
// background is ~1 px soft, at `portrait` ~25 px, at `macro_eye` it saturates.
import * as THREE from 'three';
import { FxPass, makeRT, disposeRT } from './Pass.js';

const PREPARE_FRAG = /* glsl */ `
uniform sampler2D tHDR;
uniform sampler2D tDepth;
uniform vec2  uSrcTexel;
uniform float uNear;
uniform float uFar;
uniform float uFocus;
uniform float uCoCScale;     // half-res px of CoC per unit of (z-F)/z
uniform float uMaxCoC;       // half-res px
uniform float uHighlightClamp;
varying vec2 vUv;

float cocAt(float z) {
  return clamp(uCoCScale * (z - uFocus) / max(z, 1e-3), -uMaxCoC, uMaxCoC);
}

void main() {
  vec2 o = uSrcTexel * 0.5;
  vec2 o0 = vec2(-o.x, -o.y), o1 = vec2(o.x, -o.y);
  vec2 o2 = vec2(-o.x,  o.y), o3 = vec2(o.x,  o.y);

  /* Colour and CoC must come from the SAME surface. Averaging a 2x2 colour box
     while taking CoC from one depth tap means a pixel straddling the
     silhouette gets the animal's bright colour paired with the background's
     CoC — it then scatters as a bright far-field source and paints a glowing
     halo around the whole subject. (That halo is what reads as the subject
     going "semi-transparent".)
     So: pick the sub-sample that is MOST out of focus — the blurred layers
     exist to represent out-of-focus content, and in-focus content is carried
     by the sharp path — then weight the colour toward sub-samples lying on
     that same surface. */
  float z0 = fxViewZ(texture2D(tDepth, vUv + o0).x, uNear, uFar);
  float z1 = fxViewZ(texture2D(tDepth, vUv + o1).x, uNear, uFar);
  float z2 = fxViewZ(texture2D(tDepth, vUv + o2).x, uNear, uFar);
  float z3 = fxViewZ(texture2D(tDepth, vUv + o3).x, uNear, uFar);
  float c0 = cocAt(z0), c1 = cocAt(z1), c2 = cocAt(z2), c3 = cocAt(z3);

  float coc = c0; float zRef = z0;
  if (abs(c1) > abs(coc)) { coc = c1; zRef = z1; }
  if (abs(c2) > abs(coc)) { coc = c2; zRef = z2; }
  if (abs(c3) > abs(coc)) { coc = c3; zRef = z3; }

  float k = 1.0 / max(zRef * 0.04, 1e-4);
  float w0 = exp(-abs(z0 - zRef) * k), w1 = exp(-abs(z1 - zRef) * k);
  float w2 = exp(-abs(z2 - zRef) * k), w3 = exp(-abs(z3 - zRef) * k);
  vec3 c = texture2D(tHDR, vUv + o0).rgb * w0
         + texture2D(tHDR, vUv + o1).rgb * w1
         + texture2D(tHDR, vUv + o2).rgb * w2
         + texture2D(tHDR, vUv + o3).rgb * w3;
  c /= max(w0 + w1 + w2 + w3, 1e-4);

  // Clamp the energy a single defocused point may scatter. This only feeds
  // the BLURRED layers — in-focus pixels take the sharp path untouched — so
  // snow sparkle still blooms into stars while a near flake stops turning
  // into an 80 px glowing disc that reads as lens dirt (bible SS3: no lens dirt).
  c = fxSafe(c);
  float m = fxMax3(c);
  if (m > uHighlightClamp) c *= uHighlightClamp / m;
  gl_FragColor = vec4(c, coc);
}
`;

/* Separable max of the NEAR circle of confusion.
   Without this the near gather has to search the full aperture at every
   pixel, so a handful of stray foreground taps get normalised into a
   plausible-looking colour and composited at a plausible-looking alpha —
   which paints a milky veil over the entire frame. Sizing the search radius
   to the near blur that is actually present makes the radius (and therefore
   the coverage) exactly zero wherever there is no foreground. */
const NEARMAX_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2  uStep;        // one tap step, in uv
uniform float uTaps;
varying vec2 vUv;
void main() {
  float m = 0.0;
  for (int i = -NEARMAX_TAPS; i <= NEARMAX_TAPS; i++) {
    vec4 s = texture2D(tSrc, vUv + uStep * float(i));
    // pass 1 reads the packed prepare buffer (alpha = signed CoC),
    // pass 2 reads this buffer back (red = dilated near CoC).
    m = max(m, NEARMAX_READ);
  }
  gl_FragColor = vec4(m, 0.0, 0.0, 1.0);
}
`;

const GATHER_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2  uTexel;
uniform float uMaxCoC;
uniform float uEdgeBoost;
uniform float uTapDensity;   // taps per square pixel of disc; huge = fixed
#ifdef DOF_NEAR
uniform sampler2D tNearMax;
#endif
varying vec2 vUv;

void main() {
  vec4 centre = texture2D(tSrc, vUv);
  float cocC = centre.a;

#ifdef DOF_NEAR
  // Foreground scatters OUTWARD onto sharp background, so the radius cannot
  // come from this pixel's own CoC — it comes from the dilated near CoC,
  // i.e. the largest foreground circle that can actually reach here.
  float R = texture2D(tNearMax, vUv).r;
  // Match the sub-pixel gate below: nothing here can scatter, so skip the loop.
  if (R < 1.0) { gl_FragColor = vec4(centre.rgb, 0.0); return; }
#else
  // The far layer only gathers within its own circle, which is what stops a
  // blurred background bleeding onto a sharp subject in front of it.
  float R = max(abs(cocC), 1.0);
#endif

  float rot = fxIGN(gl_FragCoord.xy) * 6.28318531;

  /* SAMPLE THE DISC YOU ACTUALLY HAVE.
     DOF_TAPS is a per-tier constant (32 far / 18 near at high) but R is not:
     the far layer's radius is capped by cfg.dof.maxBackgroundCoC, which is a
     FRACTION OF IMAGE HEIGHT, so at the gate's 1280x800 the far disc can never
     exceed 2.0 half-res px -- an area of 12.6 px sampled 32 times. Those extra
     19 taps cannot change a single pixel; they are 2.5x oversampling of a disc
     that is already fully covered. At the review's 2100x1350 the same ceiling
     is 3.375 px, area 35.8, and the full 32 are used, so this costs the review
     image nothing at all. One tap per square pixel of disc is the density; the
     floor of 6 keeps the spiral from degenerating on tiny discs. */
  float nf = clamp(ceil(uTapDensity * R * R), 6.0, float(DOF_TAPS));

  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  float cover = 0.0;

  for (int i = 0; i < DOF_TAPS; i++) {
    if (float(i) >= nf) break;
    float fi = (float(i) + 0.5) / nf;
    float rr = sqrt(fi);                            // uniform over the disc
    float a = float(i) * 2.39996323 + rot;          // golden-angle spiral
    vec2 o = vec2(cos(a), sin(a)) * rr * R;
    vec4 s = texture2D(tSrc, vUv + o * uTexel);

#ifdef DOF_NEAR
    if (s.a >= 0.0) continue;
    float reach = -s.a;
#else
    if (s.a < 0.0) continue;
    float reach = s.a;
#endif
    float dist = length(o);
    // Coverage of this pixel by the tap's circle of confusion, with a one
    // pixel soft edge...
    float w = fxSat(reach - dist + 1.0);
    // ...but that pad alone makes a tap whose circle is a FIFTH of a pixel
    // score full coverage at zero distance. At the profile pose the subject
    // sits at CoC -0.19 px: in focus, but fractionally near, so every
    // pixel of the animal qualified as its own near-field scatterer and got
    // averaged across the body. A circle smaller than a pixel is not blurred
    // at all, so it scatters nothing. The far layer never showed this because
    // its composite ramp already gates sub-pixel CoC; the near layer had no
    // equivalent gate.
    w *= smoothstep(0.5, 1.5, reach);
    cover += w;                       // un-boosted: this is the coverage term
    // Real lenses are not flat discs: spherical aberration piles a little
    // extra energy at the rim. A touch of it is what makes a highlight read
    // as bokeh rather than as a gaussian blob.
    w *= 1.0 + uEdgeBoost * smoothstep(0.55, 1.0, dist / max(reach, 1e-3));
    acc += s.rgb * w;
    wsum += w;
  }

#ifdef DOF_NEAR
  // Coverage = the fraction of the (correctly sized) disc that foreground
  // material actually occupies. Every tap can contribute at most 1.
  float alpha = fxSat(cover / nf);
  gl_FragColor = vec4(wsum > 1e-4 ? acc / wsum : centre.rgb, alpha);
#else
  acc += centre.rgb; wsum += 1.0;   // an in-focus pixel must remain itself
  gl_FragColor = vec4(acc / wsum, cocC);
#endif
}
`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tSharp;
uniform sampler2D tFar;
uniform sampler2D tNear;
uniform sampler2D tDepth;
uniform vec2  uHalfTexel;
uniform float uNear;
uniform float uFar;
uniform float uFocus;
uniform float uCoCScale;
uniform float uMaxCoC;
uniform float uNearGain;
uniform float uBlendLo;
uniform float uBlendHi;
varying vec2 vUv;

// 4-tap tent on the half-res layers: hides the spiral dither for the price of
// three extra fetches, cheaper than a separate fill pass.
vec4 tent(sampler2D t, vec2 uv) {
  return 0.25 * (texture2D(t, uv + vec2(-0.5, -0.5) * uHalfTexel)
               + texture2D(t, uv + vec2( 0.5, -0.5) * uHalfTexel)
               + texture2D(t, uv + vec2(-0.5,  0.5) * uHalfTexel)
               + texture2D(t, uv + vec2( 0.5,  0.5) * uHalfTexel));
}

void main() {
  vec3 sharp = fxSafe(texture2D(tSharp, vUv).rgb);
  float d = texture2D(tDepth, vUv).x;
  float z = fxViewZ(d, uNear, uFar);
  float coc = clamp(uCoCScale * (z - uFocus) / max(z, 1e-3), -uMaxCoC, uMaxCoC);

  vec3 far = fxSafe(tent(tFar, vUv).rgb);
  vec4 near = tent(tNear, vUv);

  // The blurred layers live at half resolution, so below ~2 px of CoC the
  // sharp full-res image is strictly closer to the truth than the "correct"
  // blurred one. Ramping in over 1..3 px keeps the subject genuinely sharp
  // instead of paying a resolution tax for a blur nobody can see.
  float fb = smoothstep(uBlendLo, uBlendHi, coc);
  vec3 c = mix(sharp, far, fb);
  c = mix(c, fxSafe(near.rgb), fxSat(near.a * uNearGain));

  gl_FragColor = vec4(c, 1.0);
}
`;

export class DoF {
  constructor(renderer, w, h, tune) {
    this.renderer = renderer;
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);

    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    this.rtPrep = makeRT(hw, hh, { name: 'dofPrep' });
    this.rtFar = makeRT(hw, hh, { name: 'dofFar' });
    this.rtNear = makeRT(hw, hh, { name: 'dofNear' });
    // Quarter-res: a max filter is forgiving, and over-dilating slightly is
    // harmless (it only costs a few gather taps that then weight to zero).
    this.rtMaxA = makeRT(qw, qh, { name: 'dofNearMaxH', format: THREE.RedFormat });
    this.rtMaxB = makeRT(qw, qh, { name: 'dofNearMaxV', format: THREE.RedFormat });
    this.rtOut = makeRT(w, h, { name: 'dofOut' });

    this.prepare = new FxPass('dofPrepare', PREPARE_FRAG, {
      tHDR: { value: null }, tDepth: { value: null },
      uSrcTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uNear: { value: 0.05 }, uFar: { value: 900 },
      uFocus: { value: 2.5 }, uCoCScale: { value: 10 }, uMaxCoC: { value: 16 },
      uHighlightClamp: { value: 7 },
    });

    this.nearMaxH = new FxPass('dofNearMaxH', NEARMAX_FRAG, {
      tSrc: { value: this.rtPrep.texture },
      uStep: { value: new THREE.Vector2() },
      uTaps: { value: 1 },
    }, { NEARMAX_TAPS: 6, NEARMAX_READ: 'max(0.0, -s.a)' });

    this.nearMaxV = new FxPass('dofNearMaxV', NEARMAX_FRAG, {
      tSrc: { value: this.rtMaxA.texture },
      uStep: { value: new THREE.Vector2() },
      uTaps: { value: 1 },
    }, { NEARMAX_TAPS: 6, NEARMAX_READ: 's.r' });

    const gatherU = () => ({
      tSrc: { value: this.rtPrep.texture },
      uTexel: { value: new THREE.Vector2(1 / hw, 1 / hh) },
      uMaxCoC: { value: 16 },
      uEdgeBoost: { value: 0.16 },
      uTapDensity: { value: Math.PI },
    });
    this.far = new FxPass('dofFar', GATHER_FRAG, gatherU(), { DOF_TAPS: tune.dofTaps });
    const nearU = gatherU();
    nearU.tNearMax = { value: this.rtMaxB.texture };
    this.near = new FxPass('dofNear', GATHER_FRAG, nearU,
      { DOF_TAPS: tune.dofNearTaps, DOF_NEAR: '' });

    this.composite = new FxPass('dofComposite', COMPOSITE_FRAG, {
      tSharp: { value: null }, tFar: { value: this.rtFar.texture },
      tNear: { value: this.rtNear.texture }, tDepth: { value: null },
      uHalfTexel: { value: new THREE.Vector2(1 / hw, 1 / hh) },
      uNear: { value: 0.05 }, uFar: { value: 900 },
      uFocus: { value: 2.5 }, uCoCScale: { value: 10 }, uMaxCoC: { value: 16 },
      uNearGain: { value: 1.15 },
      uBlendLo: { value: 1.0 }, uBlendHi: { value: 3.0 },
    });
  }

  setSize(w, h) {
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    this.rtPrep.setSize(hw, hh);
    this.rtFar.setSize(hw, hh);
    this.rtNear.setSize(hw, hh);
    this.rtMaxA.setSize(qw, qh);
    this.rtMaxB.setSize(qw, qh);
    this.rtOut.setSize(w, h);
    this.nearMaxH.u.tSrc.value = this.rtPrep.texture;
    this.nearMaxV.u.tSrc.value = this.rtMaxA.texture;
    this.near.u.tNearMax.value = this.rtMaxB.texture;
    this.prepare.u.uSrcTexel.value.set(1 / w, 1 / h);
    for (const p of [this.far, this.near]) {
      p.u.uTexel.value.set(1 / hw, 1 / hh);
      p.u.tSrc.value = this.rtPrep.texture;
    }
    this.composite.u.uHalfTexel.value.set(1 / hw, 1 / hh);
    this.composite.u.tFar.value = this.rtFar.texture;
    this.composite.u.tNear.value = this.rtNear.texture;
  }

  /**
   * Thin-lens CoC in HALF-RES pixels:
   *   CoC_metres = (f/N) * (f / (F - f)) * |z - F| / z
   *   CoC_px     = CoC_metres / sensorHeight * imageHeightPx
   * so the factor multiplying (z - F)/z is constant per frame. Note that
   * (z - F)/z tends to 1 as z tends to infinity, which means this scale IS
   * the background blur radius — a genuinely useful thing to be able to cap.
   *
   * THE CAP. Left purely physical, a 52 mm at f/4 focused at 0.55 m (the
   * `portrait` pose) has a depth of field a few millimetres deep, and
   * `macro_eye` at 0.13 m is far worse: every pose closer than about a metre
   * saturates the entire frame and the shot becomes unreadable. That is not
   * a bug in the maths, it is what the lens does — which is exactly why a DP
   * stops down for a close-focus shot instead of shooting it wide open. So we
   * pick the aperture for the framing: raise N until the background blur sits
   * at maxBackgroundCoC (a fraction of image height, so it is resolution
   * independent). The CoC still follows the thin-lens curve; only the stop
   * moves, and only when the physical one would be unusable.
   */
  static cocScale(fovDeg, focus, cfg, halfResHeight) {
    const sensorH = cfg.sensorHeight;                      // metres
    const f = (sensorH * 0.5) / Math.tan((fovDeg * Math.PI) / 360);
    const A = f / Math.max(cfg.fStop, 0.5);
    const denom = Math.max(focus - f, 1e-4);
    const physical = (A * (f / denom) / sensorH) * halfResHeight * cfg.scale;
    const ceiling = cfg.maxBackgroundCoC * halfResHeight;
    return Math.min(physical, ceiling);
  }

  /** The stop we actually ended up at, for reporting. */
  static effectiveFStop(fovDeg, focus, cfg, halfResHeight) {
    const sensorH = cfg.sensorHeight;
    const f = (sensorH * 0.5) / Math.tan((fovDeg * Math.PI) / 360);
    const denom = Math.max(focus - f, 1e-4);
    const scale = DoF.cocScale(fovDeg, focus, cfg, halfResHeight);
    const A = (scale / cfg.scale / halfResHeight) * sensorH / (f / denom);
    return +(f / Math.max(A, 1e-6)).toFixed(2);
  }

  render(sharpTexture, hdrTexture, depth, params) {
    const r = this.renderer;
    const { cocScale, focus, near, far, cfg } = params;
    const maxCoC = cfg.maxCoC * 0.5;                        // full-res -> half-res

    const p = this.prepare.u;
    p.tHDR.value = hdrTexture;
    p.tDepth.value = depth;
    p.uNear.value = near; p.uFar.value = far;
    p.uFocus.value = focus;
    p.uCoCScale.value = cocScale;
    p.uMaxCoC.value = maxCoC;
    p.uHighlightClamp.value = cfg.highlightClamp;
    this.prepare.render(r, this.rtPrep);

    // Dilate the near CoC across the full aperture, in quarter-res steps.
    const qw = this.rtMaxA.width, qh = this.rtMaxA.height;
    const spanQ = Math.max(1, maxCoC * 0.5);          // half-res px -> quarter-res px
    const stepQ = spanQ / 6;
    this.nearMaxH.u.uStep.value.set(stepQ / qw, 0);
    this.nearMaxH.render(r, this.rtMaxA);
    this.nearMaxV.u.uStep.value.set(0, stepQ / qh);
    this.nearMaxV.render(r, this.rtMaxB);

    for (const g of [this.far, this.near]) {
      g.u.uMaxCoC.value = maxCoC;
      g.u.uEdgeBoost.value = cfg.edgeBoost;
      // cfg.tapDensity === 0 restores the fixed per-tier tap count, so the
      // saving stays A/B-able inside one page session. It is not a look knob.
      g.u.uTapDensity.value = cfg.tapDensity > 0 ? cfg.tapDensity : 1e9;
    }
    this.far.render(r, this.rtFar);
    this.near.render(r, this.rtNear);

    const c = this.composite.u;
    c.tSharp.value = sharpTexture;
    c.tDepth.value = depth;
    c.uNear.value = near; c.uFar.value = far;
    c.uFocus.value = focus;
    c.uCoCScale.value = cocScale;
    c.uMaxCoC.value = maxCoC;
    c.uNearGain.value = cfg.nearGain;
    c.uBlendLo.value = cfg.blendLo;
    c.uBlendHi.value = cfg.blendHi;
    this.composite.render(r, this.rtOut);
    return this.rtOut.texture;
  }

  dispose() {
    disposeRT(this.rtPrep); disposeRT(this.rtFar);
    disposeRT(this.rtNear); disposeRT(this.rtOut);
    disposeRT(this.rtMaxA); disposeRT(this.rtMaxB);
    this.prepare.dispose(); this.far.dispose(); this.near.dispose();
    this.nearMaxH.dispose(); this.nearMaxV.dispose();
    this.composite.dispose();
  }
}
