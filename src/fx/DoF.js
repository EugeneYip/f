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
varying vec2 vUv;

void main() {
  vec2 o = uSrcTexel * 0.5;
  vec3 c = texture2D(tHDR, vUv + vec2(-o.x, -o.y)).rgb
         + texture2D(tHDR, vUv + vec2( o.x, -o.y)).rgb
         + texture2D(tHDR, vUv + vec2(-o.x,  o.y)).rgb
         + texture2D(tHDR, vUv + vec2( o.x,  o.y)).rgb;
  c *= 0.25;

  float d = texture2D(tDepth, vUv).x;
  float z = fxViewZ(d, uNear, uFar);
  float coc = clamp(uCoCScale * (z - uFocus) / max(z, 1e-3), -uMaxCoC, uMaxCoC);
  gl_FragColor = vec4(fxSafe(c), coc);
}
`;

const GATHER_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2  uTexel;
uniform float uMaxCoC;
uniform float uEdgeBoost;
varying vec2 vUv;

void main() {
  vec4 centre = texture2D(tSrc, vUv);
  float cocC = centre.a;

#ifdef DOF_NEAR
  // The near layer must search the full aperture: foreground pixels scatter
  // OUTWARD onto background that is itself perfectly sharp, so the radius
  // cannot be keyed off this pixel.
  float R = max(uMaxCoC, 1.0);
#else
  // The far layer only gathers within its own circle, which is what stops a
  // blurred background bleeding onto a sharp subject in front of it.
  float R = max(abs(cocC), 1.0);
#endif

  float rot = fxIGN(gl_FragCoord.xy) * 6.28318531;

  vec3 acc = vec3(0.0);
  float wsum = 0.0;

  for (int i = 0; i < DOF_TAPS; i++) {
    float fi = (float(i) + 0.5) / float(DOF_TAPS);
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
    float w = fxSat(reach - dist + 1.0);
    // Real lenses are not flat discs: spherical aberration piles a little
    // extra energy at the rim. A touch of it is what makes a highlight read
    // as bokeh rather than as a gaussian blob.
    w *= 1.0 + uEdgeBoost * smoothstep(0.55, 1.0, dist / max(reach, 1e-3));
    acc += s.rgb * w;
    wsum += w;
  }

#ifdef DOF_NEAR
  float alpha = fxSat(wsum / (float(DOF_TAPS) * 0.42));
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

    this.rtPrep = makeRT(hw, hh, { name: 'dofPrep' });
    this.rtFar = makeRT(hw, hh, { name: 'dofFar' });
    this.rtNear = makeRT(hw, hh, { name: 'dofNear' });
    this.rtOut = makeRT(w, h, { name: 'dofOut' });

    this.prepare = new FxPass('dofPrepare', PREPARE_FRAG, {
      tHDR: { value: null }, tDepth: { value: null },
      uSrcTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uNear: { value: 0.05 }, uFar: { value: 900 },
      uFocus: { value: 2.5 }, uCoCScale: { value: 10 }, uMaxCoC: { value: 16 },
    });

    const gatherU = () => ({
      tSrc: { value: this.rtPrep.texture },
      uTexel: { value: new THREE.Vector2(1 / hw, 1 / hh) },
      uMaxCoC: { value: 16 },
      uEdgeBoost: { value: 0.16 },
    });
    this.far = new FxPass('dofFar', GATHER_FRAG, gatherU(), { DOF_TAPS: tune.dofTaps });
    this.near = new FxPass('dofNear', GATHER_FRAG, gatherU(),
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
    this.rtPrep.setSize(hw, hh);
    this.rtFar.setSize(hw, hh);
    this.rtNear.setSize(hw, hh);
    this.rtOut.setSize(w, h);
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
   * so the scale factor multiplying (z - F)/z is constant per frame.
   */
  static cocScale(fovDeg, focus, cfg, halfResHeight) {
    const sensorH = cfg.sensorHeight;                      // metres
    const f = (sensorH * 0.5) / Math.tan((fovDeg * Math.PI) / 360);
    const A = f / Math.max(cfg.fStop, 0.5);
    const denom = Math.max(focus - f, 1e-4);
    return (A * (f / denom) / sensorH) * halfResHeight * cfg.scale;
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
    this.prepare.render(r, this.rtPrep);

    for (const g of [this.far, this.near]) {
      g.u.uMaxCoC.value = maxCoC;
      g.u.uEdgeBoost.value = cfg.edgeBoost;
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
    this.prepare.dispose(); this.far.dispose();
    this.near.dispose(); this.composite.dispose();
  }
}
