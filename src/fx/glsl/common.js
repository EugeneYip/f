// OWNER: postfx. Shared GLSL for the post chain.
//
// NOTE on GLSL version: three.js compiles every non-raw ShaderMaterial to
// `#version 300 es` and injects `#define varying in|out`, `#define texture2D
// texture` plus `layout(location=0) out highp vec4 pc_fragColor` /
// `#define gl_FragColor pc_fragColor`. So we author in the GLSL1 dialect
// (`varying`, `gl_FragColor`) yet still have every ES 3.00 builtin available
// (`textureLod`, integer maths, array constructors). That is the most robust
// option: no `glslVersion` juggling, no MRT-dependent code paths.
//
// Also note three declares `float luminance(vec3)` in every fragment prefix —
// never redefine it. Ours is `fxLum`.

/** Fullscreen-triangle vertex shader (pairs with addons' FullScreenQuad). */
export const FX_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const FX_COMMON = /* glsl */ `
#define FX_PI 3.14159265359
#define FX_HALF_PI 1.57079632679

float fxLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float fxMax3(vec3 c) { return max(c.x, max(c.y, c.z)); }
float fxMin3(vec3 c) { return min(c.x, min(c.y, c.z)); }
float fxSat(float x) { return clamp(x, 0.0, 1.0); }

/* THE HDR CEILING. Every emissive in this project must be bounded before it
   reaches the chain (the fox's own breath plume at ~20 linear and unclamped is
   what once obliterated the nose, after three agents had blamed the fur, bloom,
   the DoF gather and the depth attachment in turn). This is the chain's own
   backstop, so a future unbounded emissive degrades instead of detonating.

   MEASURED, not chosen by eye: the peak radiance actually present in the HDR
   scene target is 172 linear at 'hero' and under 130 at 'portrait',
   'silhouette', 'aurora' and 'wide', with nothing above 256 and no NaN or Inf
   anywhere. AgX's white point is 2^4.026 = 16.3 linear, so nothing above ~16
   survives the tonemap as anything but white; only bloom cares about the range
   above that, and it clamps its own pyramid at 64. 1024 is therefore 6x the
   worst real value and 60x the tonemapper's white: it can only ever bite on a
   value that is already a bug. */
#define FX_MAX_RADIANCE 1024.0

/* Clamp to [0, FX_MAX_RADIANCE], NaN-safe.
   ARGUMENT ORDER IS LOAD-BEARING. GLSL defines max(x, y) as "y if x < y, else
   x"; with x = 0.0 and y = NaN the comparison is false, so the bound must come
   FIRST for a NaN to collapse to 0 rather than propagate. (IEEE fmin/fmax,
   which is what ANGLE/Metal actually emit, return the non-NaN operand either
   way -- but the two orders are not equivalent on a spec-literal compiler, and
   the wrong one turns a NaN into a blazing 1024 instead of black.)
   Inf collapses to the ceiling. Without this the bloom prefilter's Karis
   weights, 1/(1+luma), all go to zero on an Inf region and the average becomes
   0/0 -- a NaN that the 13-tap kernel then spreads over the whole pyramid. */
vec3 fxSafe(vec3 c) { return min(vec3(FX_MAX_RADIANCE), max(vec3(0.0), c)); }

/** Window depth (0..1) -> positive view-space distance along -Z. */
float fxViewZ(float d, float near, float far) {
  float z = d * 2.0 - 1.0;
  return (2.0 * near * far) / (far + near - z * (far - near));
}

/** Window depth -> view-space position (right handed, -Z forward). */
vec3 fxViewPos(vec2 uv, float d, mat4 invProj) {
  vec4 p = invProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}

/** Window depth -> world-space position. */
vec3 fxWorldPos(vec2 uv, float d, mat4 invViewProj) {
  vec4 p = invViewProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}

// --- YCoCg: the right space for TAA neighbourhood clipping. Luma and the two
//     chroma axes decorrelate, so an AABB in YCoCg is a much tighter (less
//     ghost-prone) bound than one in RGB. ------------------------------------
vec3 fxRGB2YCoCg(vec3 c) {
  return vec3(
     0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
     0.50 * c.r             - 0.50 * c.b,
    -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
vec3 fxYCoCg2RGB(vec3 c) {
  return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}

// --- Reversible range compression. Blending HDR values directly lets a single
//     bright firefly dominate the average; compressing first is Karis' fix. ---
vec3 fxCompress(vec3 c)   { return c / (1.0 + fxLum(c)); }
/* The inverse is an AMPLIFIER: as luma approaches 1 the divisor approaches 0.
   The old 1e-4 floor meant a x10000 gain, so one compressed pixel that landed
   near luma 1 -- which is what an unbounded emissive compresses TO, since
   c/(1+lum) tends to a finite limit with lum tending to exactly 1 -- came back
   out of the TAA resolve as a 10^4 spike in an image whose real peak is 172.
   Floor the divisor at 1/FX_MAX_RADIANCE so the round trip can never manufacture
   a value the chain has already declared impossible, and fxSafe the result so
   a NaN cannot ride out either. Exact for every value below ~1000 linear, i.e.
   for everything this scene contains. */
vec3 fxUncompress(vec3 c) {
  return fxSafe(c / max(1.0 - fxLum(c), 1.0 / FX_MAX_RADIANCE));
}

/** Interleaved-gradient noise — matches src/shaders/noise.glsl.js. */
float fxIGN(vec2 px) {
  return fract(52.9829189 * fract(0.06711056 * px.x + 0.00583715 * px.y));
}

/* sRGB OETF. We always encode explicitly rather than leaning on three's
   linearToOutputTexel helper, which silently becomes the identity when a pass
   renders into a render target instead of the canvas. */
vec3 fxLinearToSRGB(vec3 c) {
  c = clamp(c, vec3(0.0), vec3(1.0));
  return mix(c * 12.92, pow(c, vec3(0.41666667)) * 1.055 - 0.055, step(0.0031308, c));
}
`;

/** 5-tap Catmull-Rom history fetch (Jimenez). Exact at zero offset, so a
 *  static camera still converges bit-for-bit; sharp under reprojection. */
export const FX_CATMULL_ROM = /* glsl */ `
vec3 fxHistoryCR(sampler2D tex, vec2 uv, vec2 res, vec2 texel) {
  vec2 position = uv * res;
  vec2 centerPosition = floor(position - 0.5) + 0.5;
  vec2 f = position - centerPosition;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  const float c = 0.5;
  vec2 w0 =        -c  * f3 +  2.0 * c        * f2 - c * f;
  vec2 w1 =  (2.0 - c) * f3 - (3.0 - c)       * f2          + 1.0;
  vec2 w2 = -(2.0 - c) * f3 + (3.0 - 2.0 * c) * f2 + c * f;
  vec2 w3 =         c  * f3 -              c  * f2;
  vec2 w12 = w1 + w2;
  vec2 tc12 = texel * (centerPosition + w2 / w12);
  vec2 tc0  = texel * (centerPosition - 1.0);
  vec2 tc3  = texel * (centerPosition + 2.0);
  float sw = 0.0;
  vec3 s = vec3(0.0);
  float w;
  w = w12.x * w0.y;  s += texture2D(tex, vec2(tc12.x, tc0.y )).rgb * w; sw += w;
  w = w0.x  * w12.y; s += texture2D(tex, vec2(tc0.x,  tc12.y)).rgb * w; sw += w;
  w = w12.x * w12.y; s += texture2D(tex, vec2(tc12.x, tc12.y)).rgb * w; sw += w;
  w = w3.x  * w12.y; s += texture2D(tex, vec2(tc3.x,  tc12.y)).rgb * w; sw += w;
  w = w12.x * w3.y;  s += texture2D(tex, vec2(tc12.x, tc3.y )).rgb * w; sw += w;
  return s / max(sw, 1e-5);
}
`;
