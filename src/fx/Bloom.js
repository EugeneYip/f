// OWNER: postfx. Progressive mip bloom (Sledgehammer/Call of Duty style).
//
// UnrealBloomPass runs five fixed-width separable Gaussians on five fixed mip
// levels; the widest kernel is still only ~9 taps, so to reach any real width
// it has to lift the strength, and the result is a flat grey veil. A
// downsample/upsample pyramid instead sums Gaussians at doubling radii, which
// integrates to the ~1/r falloff of real veiling glare: a tight bright core
// with a very wide, very faint skirt. That is the shape we want for snow
// specular and the backlit fur rim.
//
// Two details that keep it clean:
//  - Karis average in the prefilter. Snow sparkle is a field of single-pixel
//    HDR spikes; a plain box downsample turns each one into a flickering blob.
//  - Soft-knee threshold ABOVE diffuse white, so midtones contribute nothing.
import * as THREE from 'three';
import { FxPass, makeRT, disposeRT } from './Pass.js';

const PREFILTER_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2  uSrcTexel;
uniform float uThreshold;
uniform float uSoftKnee;
uniform float uClampMax;
varying vec2 vUv;

vec3 T(vec2 o) { return fxSafe(texture2D(tSrc, vUv + o * uSrcTexel).rgb); }

void main() {
  // 13-tap pattern, grouped into five 2x2 boxes.
  vec3 A = T(vec2(-2.0, -2.0)), B = T(vec2(0.0, -2.0)), C = T(vec2(2.0, -2.0));
  vec3 D = T(vec2(-1.0, -1.0)), E = T(vec2(1.0, -1.0));
  vec3 F = T(vec2(-2.0,  0.0)), G = T(vec2(0.0,  0.0)), H = T(vec2(2.0,  0.0));
  vec3 I = T(vec2(-1.0,  1.0)), J = T(vec2(1.0,  1.0));
  vec3 K = T(vec2(-2.0,  2.0)), L = T(vec2(0.0,  2.0)), M = T(vec2(2.0,  2.0));

  vec3 c0 = (A + B + G + F) * 0.25;
  vec3 c1 = (B + C + H + G) * 0.25;
  vec3 c2 = (F + G + L + K) * 0.25;
  vec3 c3 = (G + H + M + L) * 0.25;
  vec3 c4 = (D + E + J + I) * 0.25;

  // Karis: weight each box by 1/(1+luma) so one firefly cannot own the tile.
  float w0 = 1.0 / (1.0 + fxLum(c0));
  float w1 = 1.0 / (1.0 + fxLum(c1));
  float w2 = 1.0 / (1.0 + fxLum(c2));
  float w3 = 1.0 / (1.0 + fxLum(c3));
  float w4 = 1.0 / (1.0 + fxLum(c4));
  vec3 col = (c0 * w0 + c1 * w1 + c2 * w2 + c3 * w3 + c4 * w4 * 2.0)
           / (w0 + w1 + w2 + w3 + w4 * 2.0);

  // Soft-knee highpass in HDR.
  float br = fxMax3(col);
  float knee = uThreshold * uSoftKnee + 1e-5;
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-5);

  col *= contrib;
  col = min(col, vec3(uClampMax));          // no Inf into the pyramid
  gl_FragColor = vec4(col, 1.0);
}
`;

const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uSrcTexel;
varying vec2 vUv;
vec3 T(vec2 o) { return texture2D(tSrc, vUv + o * uSrcTexel).rgb; }
void main() {
  vec3 A = T(vec2(-2.0, -2.0)), B = T(vec2(0.0, -2.0)), C = T(vec2(2.0, -2.0));
  vec3 D = T(vec2(-1.0, -1.0)), E = T(vec2(1.0, -1.0));
  vec3 F = T(vec2(-2.0,  0.0)), G = T(vec2(0.0,  0.0)), H = T(vec2(2.0,  0.0));
  vec3 I = T(vec2(-1.0,  1.0)), J = T(vec2(1.0,  1.0));
  vec3 K = T(vec2(-2.0,  2.0)), L = T(vec2(0.0,  2.0)), M = T(vec2(2.0,  2.0));
  vec3 col = G * 0.125
           + (A + C + K + M) * 0.03125
           + (B + F + H + L) * 0.0625
           + (D + E + I + J) * 0.125;
  gl_FragColor = vec4(fxSafe(col), 1.0);
}
`;

// 9-tap tent, additively blended onto the coarser-but-larger level.
const UP_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2  uDstTexel;
uniform float uRadius;
uniform float uWeight;
varying vec2 vUv;
vec3 T(vec2 o) { return texture2D(tSrc, vUv + o * uDstTexel * uRadius).rgb; }
void main() {
  vec3 col = T(vec2(-1.0, -1.0)) * 1.0 + T(vec2(0.0, -1.0)) * 2.0 + T(vec2(1.0, -1.0)) * 1.0
           + T(vec2(-1.0,  0.0)) * 2.0 + T(vec2(0.0,  0.0)) * 4.0 + T(vec2(1.0,  0.0)) * 2.0
           + T(vec2(-1.0,  1.0)) * 1.0 + T(vec2(0.0,  1.0)) * 2.0 + T(vec2(1.0,  1.0)) * 1.0;
  gl_FragColor = vec4(fxSafe(col) * (uWeight / 16.0), 1.0);
}
`;

export class Bloom {
  constructor(renderer, w, h, tune) {
    this.renderer = renderer;
    this.maxMips = tune.mips;
    this.mips = [];
    this._alloc(w, h);

    this.prefilter = new FxPass('bloomPrefilter', PREFILTER_FRAG, {
      tSrc: { value: null },
      uSrcTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 1.1 },
      uSoftKnee: { value: 0.6 },
      uClampMax: { value: 64 },
    });
    this.down = new FxPass('bloomDown', DOWN_FRAG, {
      tSrc: { value: null },
      uSrcTexel: { value: new THREE.Vector2() },
    });
    this.up = new FxPass('bloomUp', UP_FRAG, {
      tSrc: { value: null },
      uDstTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.0 },
      uWeight: { value: 0.85 },
    }).setAdditive(true);
  }

  _alloc(w, h) {
    for (const m of this.mips) disposeRT(m);
    this.mips = [];
    let mw = Math.max(1, w >> 1);
    let mh = Math.max(1, h >> 1);
    for (let i = 0; i < this.maxMips; i++) {
      this.mips.push(makeRT(mw, mh, { name: `bloom${i}` }));
      if (mw <= 8 || mh <= 8) break;
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);
    }
  }

  get texture() { return this.mips[0].texture; }

  /** Total gain of the additive chain, so `strength` stays scale-independent. */
  get normalisation() {
    let s = 1, acc = 1;
    for (let i = 1; i < this.mips.length; i++) { s *= this._weight; acc += s; }
    return acc;
  }

  setSize(w, h) { this._alloc(w, h); }

  render(srcTexture, srcW, srcH, cfg) {
    const r = this.renderer;
    this._weight = cfg.scatter;

    this.prefilter.u.tSrc.value = srcTexture;
    this.prefilter.u.uSrcTexel.value.set(1 / srcW, 1 / srcH);
    this.prefilter.u.uThreshold.value = cfg.threshold;
    this.prefilter.u.uSoftKnee.value = cfg.softKnee;
    this.prefilter.u.uClampMax.value = cfg.clampMax;
    this.prefilter.render(r, this.mips[0]);

    for (let i = 1; i < this.mips.length; i++) {
      const src = this.mips[i - 1];
      this.down.u.tSrc.value = src.texture;
      this.down.u.uSrcTexel.value.set(1 / src.width, 1 / src.height);
      this.down.render(r, this.mips[i]);
    }

    this.up.u.uRadius.value = cfg.upsampleRadius;
    this.up.u.uWeight.value = cfg.scatter;
    for (let i = this.mips.length - 1; i > 0; i--) {
      const dst = this.mips[i - 1];
      this.up.u.tSrc.value = this.mips[i].texture;
      this.up.u.uDstTexel.value.set(1 / dst.width, 1 / dst.height);
      this.up.render(r, dst);
    }
  }

  dispose() {
    for (const m of this.mips) disposeRT(m);
    this.mips = [];
    this.prefilter.dispose(); this.down.dispose(); this.up.dispose();
  }
}
