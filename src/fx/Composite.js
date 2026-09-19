// OWNER: postfx. One full-res pass that folds together everything which must
// happen while the image is still jittered (so TAA can average its noise):
// AO application, exposure, height fog / aerial inscattering, god rays.
//
// Doing these as one pass rather than four saves three full-res read/write
// round trips of a half-float buffer, which at 1920x1200 is most of the cost.
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
  c += texture2D(tRays, vUv).rgb * uRayTint * (uRayStrength * shaft);
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
  }, defines);
}
