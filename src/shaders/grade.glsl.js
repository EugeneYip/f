// OWNER: postfx. The final look. Art bible §3 is binding here:
//
//   "ACES/AgX-family tonemap, exposure ~1.0, slight lift on the blue channel
//    in shadow, highlight rolloff long and soft. No teal-orange crush. No
//    heavy vignette. No lens dirt."
//
// Scene-linear sRGB in, display-linear sRGB out; the sRGB OETF is applied
// once, explicitly, by the caller at the very end.

/** Full AgX: log2 encode -> inset matrix -> sigmoid -> look -> outset matrix. */
export const AGX = /* glsl */ `
// Troy Sobotka's AgX, Blender's parameterisation. The Rec.2020 detour is not
// decoration: running the sigmoid in a wider gamut is what stops a saturated
// bright channel from skewing hue as it rolls off, and it is the reason AgX
// holds a warm rim light against snow where Reinhard or filmic go pink.
const mat3 AGX_LINEAR_SRGB_TO_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164),
  vec3(0.3293, 0.9195, 0.0880),
  vec3(0.0433, 0.0113, 0.8956));
const mat3 AGX_REC2020_TO_LINEAR_SRGB = mat3(
  vec3( 1.6605, -0.1246, -0.0182),
  vec3(-0.5876,  1.1329, -0.1006),
  vec3(-0.0728, -0.0083,  1.1187));
const mat3 AGX_INSET = mat3(
  vec3(0.856627153315983,  0.137318972929847,  0.11189821299995),
  vec3(0.0951212405381588, 0.761241990602591,  0.0767994186031903),
  vec3(0.0482516061458583, 0.101439036467562,  0.811302368396859));
const mat3 AGX_OUTSET = mat3(
  vec3( 1.1271005818144368,  -0.1413297634984383,  -0.14132976349843826),
  vec3(-0.11060664309660323,  1.157823702216272,   -0.11060664309660294),
  vec3(-0.016493938717834573,-0.016493938717834257, 1.2519364065950405));

const float AGX_MIN_EV = -12.47393;
const float AGX_MAX_EV =   4.026069;

/* The AgX default contrast curve: a 6th-order fit of the reference sigmoid.
   Short toe, very long shoulder. That shoulder is precisely what keeps snow
   highlights gradated instead of clipping to a flat white plateau. */
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return  15.5    * x4 * x2
        - 40.14   * x4 * x
        + 31.96   * x4
        -  6.868  * x2 * x
        +  0.4298 * x2
        +  0.1191 * x
        -  0.00232;
}

/* Blender's "look" stage, applied in the sigmoid's display-encoded domain.
   slope = gain, offset = lift, power = contrast, sat = saturation. */
vec3 agxLook(vec3 c, float slope, float offset, float power, float sat) {
  c = max(c * slope + offset, vec3(0.0));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  /* Apply the contrast power to LUMINANCE and carry chroma with it, rather
     than powering each channel independently.
     A per-channel power collapses the absolute channel spread of a dark
     saturated feature while leaving a bright neutral one alone: at power 1.30
     the amber iris measured (74,59,34) before the grade and (51,39,28) after
     — 0.290^1.30 = 0.200, i.e. exactly 51/255 — with R-B falling 40 -> 23.
     Scaling all three channels by the same luminance ratio preserves
     chromaticity exactly, so contrast no longer costs the iris its colour. */
  float lp = pow(max(l, 1e-5), power);
  vec3 scaled = c * (lp / max(l, 1e-5));
  return vec3(lp) + sat * (scaled - vec3(lp));
}

/**
 * color     scene-linear sRGB radiance, already exposed
 * shoulder  >1 lengthens the highlight rolloff, pivoting on 0.18 mid grey
 * returns   display-LINEAR sRGB in [0,1]
 */
vec3 agxToneMap(vec3 color, float shoulder, float lookSlope, float lookOffset,
                float lookPower, float lookSat) {
  color = max(color, vec3(0.0));
  color = AGX_LINEAR_SRGB_TO_REC2020 * color;
  color = AGX_INSET * color;

  color = max(color, vec3(1e-10));
  color = log2(color);
  color = (color - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);

  // Pivot on mid grey so "shoulder" stretches the log range around 0.18
  // rather than sliding the whole exposure.
  const float pivot = (log2(0.18) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
  color = pivot + (color - pivot) / max(shoulder, 1e-3);

  color = clamp(color, 0.0, 1.0);
  color = agxContrast(color);
  color = agxLook(color, lookSlope, lookOffset, lookPower, lookSat);

  color = AGX_OUTSET * color;
  // AgX emits roughly 2.2-gamma display-encoded values; undo that so the
  // caller owns the single, final OETF. Skipping it is a double gamma.
  color = pow(max(color, vec3(0.0)), vec3(2.2));
  color = AGX_REC2020_TO_LINEAR_SRGB * color;
  return clamp(color, 0.0, 1.0);
}
`;

/** Split-toning, grain, vignette helpers. */
export const GRADE_LOOK = /* glsl */ `
/* Cool shadows / warm highlights, weighted by display luminance. Both weights
   fall to zero through the midtones, which is the difference between a subtle
   polar grade and the teal-orange crush the bible forbids. */
vec3 gradeSplitTone(vec3 c, vec3 shadowTint, float shadowAmt,
                    vec3 highTint, float highAmt, float shadowFloor) {
  float l = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  /* The shadow weight must fall back to ZERO at true black. Peaking it at
     l = 0 turns a "slight blue lift in the shadows" (bible SS3) into an
     absolute floor under every pixel in the frame, including the night sky —
     a scrim, which is exactly what it was doing. Rolling it off below
     shadowFloor keeps the lift where there is actually signal to tint. */
  float ws = pow(1.0 - l, 2.5) * smoothstep(0.0, shadowFloor, l);
  float wh = l * l;
  c += shadowTint * (ws * shadowAmt);
  c += highTint   * (wh * highAmt);
  return max(c, vec3(0.0));
}

/* Highlight desaturation. Every real emulsion and every sensor pipeline bleeds
   colour out of the brightest values, because at least one channel saturates
   first. Without it, a white animal under a #ffd2a1 sun grades out salmon
   rather than the bible's warm-white #fdfcfa. */
vec3 gradeHighlightDesat(vec3 c, float amount) {
  float l = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  return mix(c, vec3(l), amount * l * l * l);
}

vec3 gradeContrastSat(vec3 c, float contrast, float sat) {
  // Contrast about 0.5 in display-linear; gentle, AgX already carries the S.
  c = (c - 0.5) * contrast + 0.5;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = vec3(l) + (c - vec3(l)) * sat;
  return max(c, vec3(0.0));
}

float gradeHash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/* Grain on a lattice a couple of pixels wide. Real silver-halide grain has a
   spatial scale, and at 1.5x DPR a per-pixel hash just reads as sensor noise.
   Two octaves so the lattice does not show. */
float gradeGrain(vec2 px, float size, float seed) {
  vec2 q = px / max(size, 0.25);
  vec2 i = floor(q), f = fract(q);
  f = f * f * (3.0 - 2.0 * f);
  float a = gradeHash2(i + seed);
  float b = gradeHash2(i + vec2(1.0, 0.0) + seed);
  float c = gradeHash2(i + vec2(0.0, 1.0) + seed);
  float d = gradeHash2(i + vec2(1.0, 1.0) + seed);
  float n = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  float n2 = gradeHash2(floor(q * 2.17) + seed * 1.7);
  return mix(n, n2, 0.35) * 2.0 - 1.0;
}
`;
