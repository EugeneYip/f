// OWNER: postfx. Final pass: bloom add, AgX tonemap, film look, sRGB encode.
// This is the only pass in the chain that writes display-referred values.
import * as THREE from 'three';
import { FxPass } from './Pass.js';
import { AGX, GRADE_LOOK } from '../shaders/grade.glsl.js';

const FRAG = AGX + GRADE_LOOK + /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tBloom;
uniform vec2  uTexel;
uniform float uExposure;
uniform vec3  uWhiteBalance;
uniform float uBloomStrength;
uniform float uChroma;
uniform float uVignette;
uniform float uShoulder;
uniform float uLookSlope;
uniform float uLookOffset;
uniform float uLookPower;
uniform float uLookSat;
uniform vec3  uShadowTint;
uniform float uShadowAmount;
uniform vec3  uHighlightTint;
uniform float uHighlightAmount;
uniform float uContrast;
uniform float uSaturation;
uniform float uHighlightDesat;
uniform vec3  uBlackLift;
uniform float uGrain;
uniform float uGrainSize;
uniform float uGrainSeed;
uniform float uDither;
varying vec2 vUv;

void main() {
  vec2 dv = vUv - 0.5;
  float r2 = dot(dv, dv) * 4.0;          // ~1.0 at the edge midpoints

  // --- chromatic aberration ------------------------------------------------
  // Real lenses are corrected across most of the field and give up in the far
  // corners, so the mask is r^6: literally nothing until the extreme edge.
  vec3 hdr;
  if (uChroma > 0.0) {
    vec2 off = dv * (pow(fxSat(r2), 3.0) * uChroma);
    hdr.r = texture2D(tSrc, vUv + off).r;
    hdr.g = texture2D(tSrc, vUv).g;
    hdr.b = texture2D(tSrc, vUv - off).b;
  } else {
    hdr = texture2D(tSrc, vUv).rgb;
  }
  hdr = fxSafe(hdr);

  hdr += fxSafe(texture2D(tBloom, vUv).rgb) * uBloomStrength;

  hdr *= uExposure;
  // White balance in scene-linear. The key is a 5-degree sun at #ffd2a1, so
  // without a cooling trim the white fur grades out salmon rather than the
  // bible's warm-white #fdfcfa.
  hdr *= uWhiteBalance;

  // Barely-there vignette, applied in scene-linear so it behaves like light
  // falloff rather than a painted-on dark ring. Bible: no heavy vignette.
  hdr *= 1.0 - uVignette * pow(fxSat(r2 * 0.72), 1.7);

  // --- tonemap -------------------------------------------------------------
  vec3 c = agxToneMap(hdr, uShoulder, uLookSlope, uLookOffset, uLookPower, uLookSat);

  // --- grade ---------------------------------------------------------------
  c = gradeHighlightDesat(c, uHighlightDesat);
  c = gradeSplitTone(c, uShadowTint, uShadowAmount, uHighlightTint, uHighlightAmount);
  c = gradeContrastSat(c, uContrast, uSaturation);

  /* Chromatic black floor, LAST. Bible SS2.3: shadows must never crush to 0.
     It has to come after the contrast stage — a contrast pivot at 0.5 sends
     near-black negative, which silently ate this lift the first time round.
     A tinted lift that pins white guarantees a floor and makes the darkest
     part of the frame blue rather than dead, which is also what a twilight
     zenith looks like through an atmosphere. */
  c = uBlackLift + c * (1.0 - uBlackLift);

  // --- display -------------------------------------------------------------
  c = fxLinearToSRGB(c);

  // Grain last, in display space, stronger in shadows: silver grain is most
  // visible where few grains were exposed, and it vanishes in the highlights.
  if (uGrain > 0.0) {
    float l = fxLum(c);
    float amp = uGrain * (0.28 + 0.72 * (1.0 - l) * (1.0 - l));
    c += gradeGrain(gl_FragCoord.xy, uGrainSize, uGrainSeed) * amp;
  }

  // Ordered dither at 1/255 kills the banding an 8-bit backbuffer would
  // otherwise show across the sky gradient.
  c += (fxIGN(gl_FragCoord.xy) - 0.5) * uDither;

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export function makeGrade() {
  return new FxPass('grade', FRAG, {
    tSrc: { value: null },
    tBloom: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uExposure: { value: 1 },
    uWhiteBalance: { value: new THREE.Vector3(1, 1, 1) },
    uBloomStrength: { value: 0.05 },
    uChroma: { value: 0.0016 },
    uVignette: { value: 0.11 },
    uShoulder: { value: 1 },
    uLookSlope: { value: 1 },
    uLookOffset: { value: 0 },
    uLookPower: { value: 1 },
    uLookSat: { value: 1 },
    uShadowTint: { value: new THREE.Vector3(-0.004, 0.004, 0.020) },
    uShadowAmount: { value: 1 },
    uHighlightTint: { value: new THREE.Vector3(0.016, 0.006, -0.010) },
    uHighlightAmount: { value: 1 },
    uContrast: { value: 1.02 },
    uSaturation: { value: 1.05 },
    uHighlightDesat: { value: 0.25 },
    uBlackLift: { value: new THREE.Vector3(0.006, 0.009, 0.020) },
    uGrain: { value: 0.016 },
    uGrainSize: { value: 1.9 },
    uGrainSeed: { value: 0 },
    uDither: { value: 1 / 255 },
  });
}

/** Blits a single texture for `ctx.postfx.debug` — not in the shipping path. */
export function makeDebugBlit() {
  return new FxPass('fxDebug', /* glsl */ `
    uniform sampler2D tSrc;
    uniform sampler2D tRef;
    uniform int uMode;   // 0 rgb, 1 red, 2 alpha, 3 signed CoC, 4 |src-ref|
    uniform float uScale;
    varying vec2 vUv;
    void main() {
      vec4 s = texture2D(tSrc, vUv);
      vec3 c = s.rgb * uScale;
      if (uMode == 1) c = vec3(s.r * uScale);
      else if (uMode == 2) c = vec3(s.a * uScale);
      else if (uMode == 3) c = vec3(max(s.a, 0.0), max(-s.a, 0.0), 0.0) * uScale;
      else if (uMode == 4) c = abs(s.rgb - texture2D(tRef, vUv).rgb) * uScale;
      gl_FragColor = vec4(fxLinearToSRGB(fxSafe(c)), 1.0);
    }
  `, {
    tSrc: { value: null },
    tRef: { value: null },
    uMode: { value: 0 },
    uScale: { value: 1 },
  });
}
