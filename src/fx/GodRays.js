// OWNER: postfx. Screen-space crepuscular rays.
//
// Built from the depth buffer plus the HDR scene, so there is no extra scene
// pass: sky pixels near the sun are the light source, everything with finite
// depth is an occluder. Two radial-blur passes at quarter resolution give an
// effective SAMPLES^2 march (coarse stride first, then a stride 1/N as wide,
// which fills the gaps the coarse pass left).
//
// Fade is driven entirely from CPU-side geometry (sun NDC position, sun
// elevation) and is smooth in both, so the shafts cannot pop as the sun
// leaves frame.
import * as THREE from 'three';
import { FxPass, makeRT, disposeRT } from './Pass.js';

const MASK_FRAG = /* glsl */ `
uniform sampler2D tHDR;
uniform sampler2D tDepth;
uniform vec2  uSunUV;
uniform vec2  uAspect;      // (w/h, 1) so the radial falloff stays circular
uniform float uThreshold;
uniform float uFalloff;
uniform float uSunDisc;
uniform vec3  uSunTint;
varying vec2 vUv;

void main() {
  float d = texture2D(tDepth, vUv).x;
  float sky = step(0.999998, d);

  vec3 c = fxSafe(texture2D(tHDR, vUv).rgb);
  // Only genuinely bright sky radiates shafts; a soft-knee keeps the mask from
  // switching on and off between neighbouring pixels as the camera drifts.
  float w = smoothstep(uThreshold, uThreshold * 3.0 + 1e-4, fxLum(c));

  vec2 dv = (vUv - uSunUV) * uAspect;
  float r = length(dv);

  vec3 m = c * (sky * w);
  // The solar disc and its aureole are the brightest thing in the sky and are
  // literally what the shafts are made of, so seed them explicitly rather than
  // hoping the sky pass clipped hard enough to trip the threshold.
  m += uSunTint * (uSunDisc * sky * (exp(-r * r * 2200.0) + 0.22 * exp(-r * r * 160.0)));

  gl_FragColor = vec4(m * exp(-r * uFalloff), 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2  uSunUV;
uniform float uDensity;
uniform float uDecay;
uniform float uStride;
uniform float uGain;
varying vec2 vUv;

void main() {
  vec2 step_ = (uSunUV - vUv) * (uDensity * uStride / float(GR_SAMPLES));
  // Dither the march start so the coarse pass does not band into visible rings.
  vec2 uv = vUv + step_ * fxIGN(gl_FragCoord.xy);
  vec3 acc = vec3(0.0);
  float illum = 1.0;
  float wsum = 0.0;
  for (int i = 0; i < GR_SAMPLES; i++) {
    acc += texture2D(tSrc, uv).rgb * illum;
    wsum += illum;
    illum *= uDecay;
    uv += step_;
  }
  /* Accumulate, do NOT average.
     Normalising by the weight sum made the output the MEAN sky brightness
     along the ray, which is almost the same everywhere — it threw away the
     very signal that makes shafts: how much bright sky the ray actually
     traverses before something occludes it. Measured, the averaged version
     contributed +1.4 sRGB levels near the sun, 70% of which came from the
     synthetic sun disc rather than the sky. Scaling by a FIXED 1/N keeps
     the tunable resolution-independent while letting an unoccluded ray
     accumulate more than a blocked one. */
  /* fxSafe, not decoration: blurGain is 4.0 and this pass runs TWICE, so the
     chain has a x16 gain on whatever the mask handed it. Bounding each stage
     keeps that multiplier from turning an out-of-spec emissive in the sky into
     a shaft that swamps the subject -- which is this pass's documented history.
  */
  gl_FragColor = vec4(fxSafe(acc * (uGain / float(GR_SAMPLES))), 1.0);
}
`;

export class GodRays {
  constructor(renderer, w, h, tune) {
    this.renderer = renderer;
    this.samples = tune.raySamples;
    this.rtA = makeRT(w, h, { name: 'rays0' });
    this.rtB = makeRT(w, h, { name: 'rays1' });

    this.mask = new FxPass('rayMask', MASK_FRAG, {
      tHDR: { value: null },
      tDepth: { value: null },
      uSunUV: { value: new THREE.Vector2(0.5, 0.5) },
      uAspect: { value: new THREE.Vector2(1, 1) },
      uThreshold: { value: 0.9 },
      uFalloff: { value: 1.6 },
      uSunDisc: { value: 0.6 },
      uSunTint: { value: new THREE.Color(1, 1, 1) },
    });

    this.blur = new FxPass('rayBlur', BLUR_FRAG, {
      tSrc: { value: null },
      uSunUV: { value: new THREE.Vector2(0.5, 0.5) },
      uDensity: { value: 0.65 },
      uDecay: { value: 0.93 },
      uStride: { value: 1 },
      uGain: { value: 1 },
    }, { GR_SAMPLES: this.samples });
  }

  get texture() { return this.rtA.texture; }

  setSize(w, h) { this.rtA.setSize(w, h); this.rtB.setSize(w, h); }

  render(hdr, depth, sunUV, aspect, tint, cfg) {
    const r = this.renderer;
    const m = this.mask.u;
    m.tHDR.value = hdr;
    m.tDepth.value = depth;
    m.uSunUV.value.copy(sunUV);
    m.uAspect.value.set(aspect, 1);
    m.uThreshold.value = cfg.threshold;
    m.uFalloff.value = cfg.maskFalloff;
    m.uSunDisc.value = cfg.sunDisc;
    m.uSunTint.value.copy(tint);
    this.mask.render(r, this.rtA);

    const b = this.blur.u;
    b.uSunUV.value.copy(sunUV);
    b.uDensity.value = cfg.density;
    b.uDecay.value = cfg.decay;

    b.uGain.value = cfg.blurGain;
    b.tSrc.value = this.rtA.texture;
    b.uStride.value = 1.0;
    this.blur.render(r, this.rtB);

    b.tSrc.value = this.rtB.texture;
    b.uStride.value = 1.0 / this.samples;
    this.blur.render(r, this.rtA);
  }

  /** Nothing to composite this frame: make sure no stale shafts linger. */
  clear() {
    const r = this.renderer;
    const prev = r.getClearColor(new THREE.Color());
    const prevA = r.getClearAlpha();
    r.setRenderTarget(this.rtA);
    r.setClearColor(0x000000, 1);
    r.clear(true, false, false);
    r.setClearColor(prev, prevA);
  }

  dispose() {
    disposeRT(this.rtA); disposeRT(this.rtB);
    this.mask.dispose(); this.blur.dispose();
  }
}
