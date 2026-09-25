// OWNER: postfx. One full-res pass that folds together everything which must
// happen while the image is still jittered (so TAA can average its noise):
// AO application, exposure, height fog / aerial inscattering, god rays.
//
// Doing these as one pass rather than four saves three full-res read/write
// round trips of a half-float buffer, which at 1920x1200 is most of the cost.
//
// ------------------------------------------------------------------------
// uAOColor: THREE THINGS MEASURED ABOUT IT, SO NOBODY RE-DERIVES THEM.
//
// `c *= mix(uAOColor, vec3(1.0), k)` means uAOColor is the multiplier at FULL
// occlusion -- the colour an entirely closed pixel keeps. It ships at
// 0x46597d, linear (0.061, 0.102, 0.205): a saturated navy that removes 90%%
// of the light and multiplies blue 3.3x harder than red.
//
// 1. THE HUE IS BACKWARDS, AND FIXING IT IS A MEASURED NO-OP. Occlusion
//    attenuates INDIRECT light. Here the indirect is a blue sky and the
//    direct is a warm sun, so occluding it should make a surface LESS blue,
//    not more. But swapping 0x46597d for a grey of identical linear
//    luminance (0x595959) is worth 0.5 levels on the near snow at `profile`
//    and 0.4 points of coat B-R -- the modulation is luminance, not hue.
//    Arms in one session, TAA reset each, control identical to every digit:
//
//      profile     far-snow L   contact L   coat shade B-R
//      navy 46597d    145.38      174.37        60.89
//      grey 595959    144.86      174.27        60.37
//      pale b9c7d8    170.29      179.17        59.71
//      intensity 0    181.14      181.92        58.51
//
//    Only the PALE floor moves anything, and it does so by giving up the
//    contact darkening (+4.8 levels at profile, +1.2 at hero) that the
//    lighting agent earned deliberately. So: leave it alone. "Make the AO
//    neutral" is a correct-sounding change that buys nothing and costs
//    contact.
//
// 2. THIS MULTIPLY WAS SUPPLYING THE COAT'S SHADED COLOUR, and that is why
//    `the coat keeps its colour in shadow` began failing when a778006 took
//    the AO wash off the fur. Same box, same instant, portrait: shaded-coat
//    B-R 26.46 with the wash, 16.18 without (spec's own matte reads 23.0
//    then, 11.5 now, floor 18.6). REVIEW-5 measured +11.4 and it "did not
//    reproduce" -- it did not reproduce because a post-process paint was
//    covering it.
//
// 3. IT IS NOT RECOVERABLE FROM POST. Both grade levers are ADDITIVE on
//    shadows already (gradeContrastSat's s = sat + shadowSat*(1-l)^2 is a
//    boost, and shadowTint adds blue), so post cannot be what removed the
//    colour. More than doubling each of them buys a quarter of the gap:
//    shadowSat 0.35 -> 0.80 gives B-R 16.18 -> 18.89, shadowTint blue
//    0.018 -> 0.040 gives 17.77, against the 10.3 points the wash supplied.
//    Closing it from here would need a global shadow saturation near 2.0,
//    which drags the snow -- already B-R +51 -- into the ice-carving that
//    SS3 and this file's own comments spent rounds getting out of. The blue
//    belongs in the coat's SKY response, which is fur's, not here.
//
// Separately, and unrelated to the coat: at `profile` this pass takes 36
// levels out of the near foreground snow (far-snow L 181.14 -> 145.38, AO
// buffer 0.645). That is the pass working on an input that genuinely IS a
// surface at grazing incidence, so it is not the coat's defect -- but it is
// large, it reads as navy smearing at 1:1, and nobody has judged it.
// ------------------------------------------------------------------------
import * as THREE from 'three';
import { FxPass } from './Pass.js';

const FRAG = /* glsl */ `
uniform sampler2D tHDR;
uniform sampler2D tDepth;
uniform float uNear;
uniform float uFar;
uniform float uExposure;

#ifdef USE_AO
uniform sampler2D tAO;
uniform vec2  uAOTexel;
uniform float uAOIntensity;
uniform float uAOPower;
uniform float uAOBrightRelief;
uniform float uAOReliefLo;
uniform float uAOReliefHi;
uniform float uAOFadeStart;
uniform float uAOFadeEnd;
uniform vec3  uAOColor;
#endif

#ifdef USE_FOG
uniform mat4  uInvViewProj;
uniform vec3  uCamPos;
uniform vec3  uSunDir;
uniform vec3  uFogColor;
uniform vec3  uFogSunColor;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uFogHeight;
uniform float uFogStrength;
uniform float uFogSunGain;
uniform float uFogPhase;
#endif

#ifdef USE_RAYS
uniform sampler2D tRays;
uniform vec3  uRayTint;
uniform float uRayStrength;
uniform float uShaftDensity;
uniform vec2  uRayTexel;
#endif

varying vec2 vUv;

#ifdef USE_AO
/* Joint-bilateral upsample of the half-res AO. The G channel carries the
   view distance the AO was computed at; weighting by depth agreement is what
   stops occlusion leaking off the fox onto the snow behind it (the leak that
   reads as a dark halo). */
float aoUpsample(vec2 uv, float z) {
  const vec2 O[4] = vec2[4](vec2(-0.5, -0.5), vec2(0.5, -0.5),
                            vec2(-0.5,  0.5), vec2(0.5,  0.5));
  float sum = 0.0, wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 s = texture2D(tAO, uv + O[i] * uAOTexel).xy;
    float w = 1.0 / (1e-3 + 40.0 * abs(s.y - z) / max(z, 0.05));
    sum += s.x * w;
    wsum += w;
  }
  return wsum > 1e-5 ? sum / wsum : 1.0;
}
#endif

void main() {
  vec3 c = fxSafe(texture2D(tHDR, vUv).rgb);
  float d = texture2D(tDepth, vUv).x;
  bool sky = d >= 0.999998;
  float vz = fxViewZ(d, uNear, uFar);

#ifdef USE_AO
  if (!sky) {
    float ao = pow(clamp(aoUpsample(vUv, vz), 0.0, 1.0), uAOPower);
    float k = mix(1.0, ao, uAOIntensity);
    // Post AO multiplies everything, but occlusion physically modulates only
    // indirect light. Relieve it where the pixel is far above diffuse white —
    // those are sun-lit or specular, and darkening them reads as dirt.
    k = mix(k, 1.0, smoothstep(uAOReliefLo, uAOReliefHi, fxLum(c)) * uAOBrightRelief);
    // Distance fade: this is contact occlusion on a 0.55 m animal, not haze.
    k = mix(k, 1.0, smoothstep(uAOFadeStart, uAOFadeEnd, vz));
    // Tint instead of pure grey. White fur and snow in occlusion go BLUE
    // (bible SS3: fur base shadow #b9c7d8, snow shadow #6d8cb8).
    c *= mix(uAOColor, vec3(1.0), k);
  }
#endif

  c *= uExposure;

#ifdef USE_FOG
  if (!sky) {
    vec3 wp = fxWorldPos(vUv, d, uInvViewProj);
    vec3 toP = wp - uCamPos;
    float dist = length(toP);
    vec3 Vd = toP / max(dist, 1e-5);
    // Closed form of the exponential height-fog integral along the ray.
    float kf = uFogFalloff;
    float dy = wp.y - uCamPos.y;
    float baseline = exp(-kf * (uCamPos.y - uFogHeight));
    float integ = abs(kf * dy) > 1e-4
      ? baseline * (1.0 - exp(-kf * dy)) / (kf * dy)
      : baseline;
    float f = 1.0 - exp(-max(uFogDensity * integ * dist, 0.0));
    // Forward-scattering lobe: haze looking into the low sun goes warm.
    float ph = pow(fxSat(dot(Vd, uSunDir)), uFogPhase);
    vec3 insc = mix(uFogColor, uFogSunColor, fxSat(ph * uFogSunGain));
    c = mix(c, insc * uExposure, fxSat(f * uFogStrength));
  }
#endif

#ifdef USE_RAYS
  /* Crepuscular rays are light in-scattered along the path BETWEEN camera and
     surface, so the energy a pixel receives grows with its distance. Adding
     the full shaft to every pixel regardless of depth gave a 1.9 m animal the
     same in-scatter as the sky behind it, which reads as the subject going
     semi-transparent. Weighting by path transmittance is both the physical
     answer and the fix. */
  float shaft = sky ? 1.0 : (1.0 - exp(-vz * uShaftDensity));
  /* The ray buffer is quarter resolution; a single bilinear tap leaves a
     visible blocky column under the sun once the gain is high enough to
     matter. A 4-tap tent costs three fetches on a quarter-res target and
     removes it. */
  vec3 ray = 0.25 * (
      texture2D(tRays, vUv + vec2(-0.5, -0.5) * uRayTexel).rgb
    + texture2D(tRays, vUv + vec2( 0.5, -0.5) * uRayTexel).rgb
    + texture2D(tRays, vUv + vec2(-0.5,  0.5) * uRayTexel).rgb
    + texture2D(tRays, vUv + vec2( 0.5,  0.5) * uRayTexel).rgb);
  c += ray * uRayTint * (uRayStrength * shaft);
#endif

  gl_FragColor = vec4(fxSafe(c), 1.0);
}
`;

export function makeComposite(flags) {
  const defines = {};
  if (flags.ao) defines.USE_AO = '';
  if (flags.fog) defines.USE_FOG = '';
  if (flags.rays) defines.USE_RAYS = '';

  return new FxPass('composite', FRAG, {
    tHDR: { value: null },
    tDepth: { value: null },
    uNear: { value: 0.05 },
    uFar: { value: 900 },
    uExposure: { value: 1 },

    tAO: { value: null },
    uAOTexel: { value: new THREE.Vector2() },
    uAOIntensity: { value: 0.7 },
    uAOPower: { value: 1.4 },
    uAOBrightRelief: { value: 0.65 },
    uAOReliefLo: { value: 3 },
    uAOReliefHi: { value: 14 },
    uAOFadeStart: { value: 6 },
    uAOFadeEnd: { value: 22 },
    uAOColor: { value: new THREE.Color(0x5a7099) },

    uInvViewProj: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uFogColor: { value: new THREE.Color(0xaac4e0) },
    uFogSunColor: { value: new THREE.Color(0xffd2a1) },
    uFogDensity: { value: 0.02 },
    uFogFalloff: { value: 0.22 },
    uFogHeight: { value: 0 },
    uFogStrength: { value: 1 },
    uFogSunGain: { value: 0.8 },
    uFogPhase: { value: 6 },

    tRays: { value: null },
    uRayTint: { value: new THREE.Color(1, 1, 1) },
    uRayStrength: { value: 0 },
    uShaftDensity: { value: 0.045 },
    uRayTexel: { value: new THREE.Vector2() },
  }, defines);
}
