// OWNER: atmosphere agent.
//
// A single-scattering Rayleigh + Mie + ozone atmosphere, evaluated once into a
// pair of lookup tables and then sampled for free by the sky dome, the IBL
// dome, the aurora and the horizon haze.
//
// Why not three's `Sky` addon: Preetham is a *daytime* analytic fit. At 5 deg
// sun elevation it goes muddy brown at the horizon, has no ozone term (so no
// deep indigo zenith), no Belt of Venus, and no earth curvature (so no long
// anti-solar path). All four of those are the things that make a polar
// twilight legible.
//
// Everything below works in KILOMETRES with the origin at the earth's centre.
//
// One non-textbook detail worth calling out: `bandCompress`. Textbook RGB
// atmospheres evaluate extinction at three wavelengths and then exponentiate,
// which over-saturates badly at high airmass. Real RGB sensors integrate
// exp(-tau(lambda)) *across* a band, and the band average is dominated by its
// least-attenuated edge, so the effective optical depth saturates. Compressing
// tau logarithmically reproduces that, and it is the single change that stops
// a low sun from looking like a cartoon.

export const ATMO_PARS = /* glsl */ `
#ifndef PI
#define PI 3.141592653589793
#endif

const float Rg = 6371.0;          // ground radius (km)
const float Rt = 6471.0;          // top of atmosphere (km)
const float ATMO_H = 100.0;       // Rt - Rg
const float Hr = 8.0;             // Rayleigh scale height (km)
const float Hm = 1.2;             // Mie scale height (km)

const vec3  BETA_R  = vec3(5.802e-3, 13.558e-3, 33.100e-3);  // 1/km
// Clean polar aerosol. The textbook 3.996e-3 / 4.440e-3 pair is a
// mid-latitude continental value; used here it lays a grey Mie veil over the
// whole lower sky and the twilight goes khaki. Arctic air is exceptionally
// low in aerosol, and that is precisely why polar twilight is so saturated.
const float BETA_MS = 1.300e-3;
const float BETA_ME = 1.450e-3;
// Ozone, scaled 1.4x for a high-latitude autumn/winter column (real polar
// columns run 380-450 DU against a 300 DU global mean). The Chappuis band
// eats green hardest, which is exactly what turns the upper twilight sky
// indigo rather than plain blue. Nothing else in the model can do that.
const vec3  BETA_O  = vec3(0.910e-3, 2.6334e-3, 0.119e-3);
const float OZ_C = 25.0;
const float OZ_W = 15.0;

const float BAND_K = 0.805;       // RGB band-averaging compression (calibrated,
                                  // see Sky.js: lands the 5 deg sun on #ffd0a2)
const float VPOW   = 0.6;         // sky LUT elevation warp

vec2 raySphere(vec3 ro, vec3 rd, float R) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R * R;
  float d = b * b - c;
  if (d < 0.0) return vec2(1.0, -1.0);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}

vec3 atmoDensity(float h) {
  h = max(h, 0.0);
  return vec3(exp(-h / Hr), exp(-h / Hm), max(0.0, 1.0 - abs(h - OZ_C) / OZ_W));
}

vec3 atmoExtinction(float h) {
  vec3 d = atmoDensity(h);
  return BETA_R * d.x + vec3(BETA_ME) * d.y + BETA_O * d.z;
}

vec3 bandCompress(vec3 tau) { return log(1.0 + BAND_K * tau) / BAND_K; }

float phaseRayleigh(float mu) { return 0.0596831 * (1.0 + mu * mu); }

float phaseMieCS(float mu, float g) {
  float g2 = g * g;
  float d = max(1.0 + g2 - 2.0 * g * mu, 1e-4);
  return 0.1193662 * (1.0 - g2) * (1.0 + mu * mu) / ((2.0 + g2) * d * sqrt(d));
}

// --- transmittance LUT parameterisation (x = cos zenith, y = altitude) ------
vec2 transUv(float h, float mu) {
  return vec2(0.5 + 0.5 * sign(mu) * sqrt(abs(mu)), clamp(h / ATMO_H, 0.0, 1.0));
}
void transFromUv(vec2 uv, out float h, out float mu) {
  h = uv.y * ATMO_H;
  float s = uv.x * 2.0 - 1.0;
  mu = sign(s) * s * s;
}

// --- sky-view LUT parameterisation ------------------------------------------
// x = |azimuth relative to the sun| / PI   (the sky is symmetric about the
//     solar meridian, so half a texture buys double the resolution)
// y = elevation, warped so ~40% of the texels land in the first 15 degrees
//     above the horizon where all the interesting structure lives.
vec2 skyViewUv(vec3 dir, vec3 sunDir) {
  float elev = asin(clamp(dir.y, -1.0, 1.0));
  vec2 dh = vec2(dir.x, dir.z);
  vec2 sh = vec2(sunDir.x, sunDir.z);
  float lh = length(dh), ls = length(sh);
  float cosPhi = (lh > 1e-5 && ls > 1e-5) ? clamp(dot(dh, sh) / (lh * ls), -1.0, 1.0) : 1.0;
  float l = elev / (0.5 * PI);
  return vec2(acos(cosPhi) / PI, 0.5 + 0.5 * sign(l) * pow(abs(l), VPOW));
}
void skyViewFromUv(vec2 uv, float sunElev, out vec3 rd) {
  float s = uv.y * 2.0 - 1.0;
  float l = sign(s) * pow(abs(s), 1.0 / VPOW);
  float elev = l * 0.5 * PI;
  float phi = uv.x * PI;
  float ce = cos(elev);
  rd = vec3(sin(phi) * ce, sin(elev), cos(phi) * ce);
}
`;

/** Requires ATMO_PARS. Full-path transmittance, for the transmittance LUT. */
export const ATMO_TRANSMITTANCE = /* glsl */ `
vec3 computeTransmittance(float h, float mu) {
  vec3 ro = vec3(0.0, Rg + h, 0.0);
  vec3 rd = vec3(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
  vec2 g = raySphere(ro, rd, Rg);
  if (g.y > 0.0 && g.x > -1e-3) return vec3(0.0);   // occluded by the earth
  float tMax = raySphere(ro, rd, Rt).y;
  const int N = 48;
  vec3 tau = vec3(0.0);
  for (int i = 0; i < N; i++) {
    float f0 = float(i) / float(N), f1 = float(i + 1) / float(N);
    float ta = tMax * f0 * f0, tb = tMax * f1 * f1;
    vec3 p = ro + rd * (0.5 * (ta + tb));
    tau += atmoExtinction(length(p) - Rg) * (tb - ta);
  }
  return exp(-bandCompress(tau));
}
`;

/** Requires ATMO_PARS. Samples a generated transmittance LUT. */
export const ATMO_SAMPLE_TRANS = /* glsl */ `
uniform sampler2D uTransLut;
uniform vec2 uTransTexel;
vec3 sampleTrans(float h, float mu) {
  vec2 uv = transUv(h, mu);
  uv = uv * (1.0 - uTransTexel) + 0.5 * uTransTexel;
  return texture2D(uTransLut, uv).rgb;
}
`;

/**
 * Requires ATMO_PARS + ATMO_SAMPLE_TRANS. In-scattering along a view ray,
 * including the lit ground below the horizon (so the IBL gets a real snow
 * bounce in its lower hemisphere instead of black).
 *
 * The multiple-scattering term is an approximation, not Hillaire's LUT: the
 * second-order field is treated as isotropic and lit by the transmittance at a
 * zenith-biased sun angle, because light that arrives here after a bounce came
 * from higher and less-attenuated air. It is cheap, smooth, and it is what
 * keeps the zenith a deep blue instead of black and puts the pink in the
 * anti-solar band.
 */
export const ATMO_SCATTER = /* glsl */ `
uniform vec3  uSunIrradiance;
uniform float uMsScale;
uniform float uMieG;
uniform vec3  uGroundAlbedo;
uniform vec3  uGroundAmbient;
uniform vec3  uBeltTint;
uniform float uBeltScale;

vec3 atmoScatter(vec3 ro, vec3 rd, vec3 sunDir, int N) {
  vec2 top = raySphere(ro, rd, Rt);
  if (top.y <= 0.0) return vec3(0.0);
  float t0 = max(top.x, 0.0);
  float t1 = top.y;

  vec2 gnd = raySphere(ro, rd, Rg);
  bool hitsGround = (gnd.y > 0.0 && gnd.x > -1e-3);
  if (hitsGround) t1 = max(gnd.x, 0.0);

  float mu = dot(rd, sunDir);
  float pR = phaseRayleigh(mu);
  float pM = phaseMieCS(mu, uMieG);

  vec3 L = vec3(0.0);
  vec3 T = vec3(1.0);
  float span = t1 - t0;

  for (int i = 0; i < N; i++) {
    // Quadratic step distribution: the density is exponential and the horizon
    // path is 1100 km long, so uniform stepping wastes every sample.
    float f0 = float(i) / float(N), f1 = float(i + 1) / float(N);
    float ta = t0 + span * f0 * f0;
    float tb = t0 + span * f1 * f1;
    float ds = tb - ta;
    if (ds <= 0.0) continue;

    vec3 p = ro + rd * (0.5 * (ta + tb));
    float r = length(p);
    float h = r - Rg;
    vec3 dens = atmoDensity(h);

    vec3 sR = BETA_R * dens.x;
    vec3 sM = vec3(BETA_MS * dens.y);
    vec3 ext = sR + vec3(BETA_ME * dens.y) + BETA_O * dens.z;

    float muS = dot(p / r, sunDir);
    vec3 Tsun = sampleTrans(h, muS);
    vec3 Tms  = sampleTrans(h, clamp(muS * 0.42 + 0.44, -1.0, 1.0));

    // Belt of Venus.
    //
    // The isotropic MS term above comes out spectrally NEUTRAL at the
    // anti-solar horizon, because Rayleigh's lambda^-4 bias almost exactly
    // cancels the reddening of the grazing sunlight feeding it. Real
    // backscatter there is dominated by light that has crossed the entire
    // illuminated limb and arrives far redder than a one-bounce estimate; the
    // band compression that keeps the direct solar beam from looking like a
    // cartoon also caps the ratio well below what pink needs. uBeltTint is
    // that grazing-limb colour computed with much weaker compression, added
    // back only where we are looking away from a low sun.
    // NOTE: multiplying the tint by sR cancels it -- Rayleigh's blue bias is
    // stronger than any plausible reddening. The belt carries its OWN
    // spectrum and only borrows Rayleigh's altitude profile and magnitude.
    float back = smoothstep(0.30, -0.55, mu);
    vec3 belt = uBeltTint * (BETA_R.r * dens.x * back * uBeltScale);

    vec3 S = ((sR * pR + sM * pM) * Tsun
           + (sR + sM) * Tms * uMsScale * 0.0795775
           + belt) * uSunIrradiance;

    vec3 segT = exp(-ext * ds);
    // Energy-conserving analytic integration of the segment (Hillaire 2020).
    L += T * (S - S * segT) / max(ext, vec3(1e-9));
    T *= segT;
  }

  if (hitsGround) {
    vec3 p = ro + rd * t1;
    vec3 n = p / length(p);
    float ndl = dot(n, sunDir);
    vec3 Tsun = sampleTrans(0.0, ndl);
    vec3 lit = uSunIrradiance * max(ndl, 0.0) * Tsun + uGroundAmbient;
    L += T * uGroundAlbedo * lit * 0.3183099;
  }
  return L;
}
`;

/** Requires ATMO_PARS. Samples a generated sky-view LUT. */
export const SKY_SAMPLE = /* glsl */ `
uniform sampler2D uSkyLut;
uniform vec2 uSkyTexel;
vec3 sampleSky(vec3 dir, vec3 sunDir) {
  vec2 uv = skyViewUv(dir, sunDir);
  uv = uv * (1.0 - uSkyTexel) + 0.5 * uSkyTexel;
  return texture2D(uSkyLut, uv).rgb;
}

/**
 * Sky only, never the lit ground the LUT stores below the horizon.
 *
 * The LUT's lower hemisphere exists for the IBL, where the snow bounce has to
 * be real. Showing it in the *visible* sky puts a hard brown seam right under
 * the horizon line, because a scattering integral that terminates on a snow
 * albedo will never agree with whatever the lighting rig is actually doing to
 * the terrain. Terrain and the horizon band cover that region in every real
 * view; where they leave a sliver, continuing the horizon haze downward is
 * what aerial perspective would give anyway.
 */
vec3 sampleSkyAbove(vec3 dir, vec3 sunDir) {
  vec2 uv = skyViewUv(dir, sunDir);
  float below = smoothstep(0.5, 0.47, uv.y);
  uv.y = max(uv.y, 0.5);
  uv = uv * (1.0 - uSkyTexel) + 0.5 * uSkyTexel;
  return texture2D(uSkyLut, uv).rgb * (1.0 - 0.10 * below);
}
`;

/**
 * The solar disc. Kept out of the LUT on purpose: the disc is 0.53 deg across
 * and the LUT is 0.35 deg per texel, so bilinear filtering would smear it into
 * an oval. Drawn analytically instead, with real limb darkening and a
 * three-scale aureole so the edge never resolves into a hard circle.
 */
export const SUN_DISC = /* glsl */ `
float sunTheta(vec3 dir, vec3 sunDir) {
  // Chord form: numerically stable at theta -> 0, unlike acos(dot()).
  return 2.0 * asin(clamp(0.5 * length(dir - sunDir), 0.0, 1.0));
}
vec3 sunDiscAndAureole(float th, vec3 tint, float radius, float coreScale, float glowScale) {
  float x = th / radius;
  float xc = min(x, 1.0);
  float limb = sqrt(max(0.0, 1.0 - xc * xc));
  float ld = 0.30 + 0.70 * pow(limb, 0.52);
  float core = smoothstep(1.10, 0.90, x) * ld;
  float a1 = 0.40 / (1.0 + pow(th / (radius * 2.1), 2.5));
  float a2 = 0.15 * exp(-th / (radius * 9.5));
  float a3 = 0.052 * exp(-th / (radius * 46.0));
  return tint * (core * coreScale + (a1 + a2 + a3) * glowScale);
}
`;

/**
 * Multiplicative triangular-PDF dither. Banding in a big smooth sky is the
 * number one amateur tell, and it is created by the final 8-bit write, not by
 * the shader. We do not own the output pass, so the noise has to be relative
 * (a fixed fraction of the local value) to survive an unknown tonemap and land
 * at roughly one code value wherever it ends up.
 */
export const SKY_DITHER = /* glsl */ `
float triDither(vec2 px) {
  float a = fract(52.9829189 * fract(0.06711056 * px.x + 0.00583715 * px.y));
  float b = fract(52.9829189 * fract(0.06711056 * (px.x + 23.0) + 0.00583715 * (px.y + 47.0)));
  return a + b - 1.0;
}
`;
