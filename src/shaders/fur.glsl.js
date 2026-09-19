/**
 * Fur GLSL. OWNER: fur agent.
 *
 * One shading model, three geometry variants:
 *
 *   base   the fox's own skin mesh, opaque. The floor of the coat: dark cream
 *          undercoat, plus the dark wet nose/pads carried by the vertex colour.
 *   shell  concentric offset shells drawn INSTANCED — one draw call, N shells,
 *          `aShell` is the instance index. Alpha-cut by a cellular hair field
 *          evaluated in BIND space, so it can never swim when the animal
 *          deforms or the camera moves.
 *   card   hair-card tufts that break the mesh silhouette into strands.
 *
 * Everything that varies through the coat is a function of `t` — normalised
 * depth, 0 at the skin, 1 at the outermost shell / hair tip.
 *
 * Coordinate conventions, in order of importance:
 *   1. The hair PATTERN is evaluated at `vRoot`, the bind-space position of the
 *      hair's root. Bind space is rigid with respect to the skin, so a hair
 *      keeps its identity through any skeletal deformation. This is the single
 *      most important decision in the file.
 *   2. The hair SHAPE (normal rise + tangential lay) is built in bind space and
 *      then skinned, so the comb follows the body.
 *   3. Gravity and wind are applied AFTER skinning, in world space, because
 *      that is where they actually act.
 */
import { HASH, SIMPLEX3, IGN, UTIL } from './noise.glsl.js';

export const REGION_COUNT = 27;

/* ------------------------------------------------------------------ uniforms */

export const FUR_UNIFORMS = /* glsl */ `
// --- light (rewritten every frame from ctx.*) ------------------------------
uniform vec3  uSunDir;         // TOWARDS the sun, world space
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform vec3  uSkyColor;
uniform vec3  uGroundBounce;
uniform float uAmbient;
uniform float uAmbientSat;
uniform float uSunSat;
uniform float uTransSat;

// --- dynamics --------------------------------------------------------------
uniform float uTime;
uniform vec3  uWindDir;        // ctx.wind, unit — the same vector the snow uses
uniform float uWindSpeed;      // ctx.windSpeed * (1 + 1.4*gust), as SnowParticles
uniform float uWindGust;
uniform vec3  uGravity;        // world down

// --- coat shape ------------------------------------------------------------
uniform vec3  uEyeL;           // bind-space eyeball centres: the coat has to
uniform vec3  uEyeR;           // part around the eye or it buries the face
uniform vec2  uEyeFade;        // x inner radius (bald), y outer radius
uniform vec3  uNose;           // nose pad centre, bind space
uniform vec2  uNoseFade;       // the rhinarium is bare skin, not short fur
uniform float uShellCount;
uniform float uCoatScale;
uniform float uLay;
uniform float uDroop;
uniform float uWindBend;
uniform float uWaveFreq;
uniform float uWaveSpeed;

// --- hair field ------------------------------------------------------------
uniform float uClumpFreq;      // clumps per metre
uniform float uStrandFreq;     // strands per metre
uniform float uMicroFreq;
uniform float uClumpPull;
uniform float uStrandRoot;
uniform float uStrandTip;
uniform float uHairLenMin;
uniform float uDensity;
uniform float uFill;
uniform float uCoatVarFreq;

// --- shading ---------------------------------------------------------------
uniform vec3  uFurLit;
uniform vec3  uFurUnder;
uniform vec3  uShadowTint;
uniform vec3  uSpecTintA;
uniform vec3  uSpecTintB;
uniform vec3  uTransTint;
uniform float uSpecShiftA;
uniform float uSpecShiftB;
uniform float uSpecPowA;
uniform float uSpecPowB;
uniform float uSpecGainA;
uniform float uSpecGainB;
uniform float uSpecJitter;
uniform float uWrap;
uniform float uTrans;
uniform float uTransPow;
uniform float uAOInner;
uniform float uAOPow;
uniform float uAOBake;
uniform float uAOFloor;
uniform float uShellJitter;
uniform float uTuftAmt;
uniform float uClumpAO;
uniform float uAniso;
uniform float uStrandRound;
uniform float uStrandAniso;
uniform float uRim;

// --- stochastic / TAA ------------------------------------------------------
uniform float uStochastic;     // 0 = smooth alpha · 1 = IGN dithered cut-out
uniform float uFrameSeed;

// --- per-region tables -----------------------------------------------------
// A: x density   y length     z lay     w tipWhite
// B: x clumpScale  y freqScale  z aoScale  w cardWeight
uniform vec4 uRegionA[${REGION_COUNT}];
uniform vec4 uRegionB[${REGION_COUNT}];
`;

export const FUR_VARYINGS = /* glsl */ `
varying vec3 vRoot;   // BIND-space hair root — the stable noise domain
varying vec3 vWPos;
varying vec3 vNrm;    // world surface normal
varying vec3 vTan;    // world hair direction at this depth
varying vec4 vP0;     // x t · y baseTint · z bakedOcclusion · w density
varying vec4 vP1;     // x clumpScale · y freqScale · z tipWhite · w coatLen
varying vec3 vAxis;   // BIND-space hair axis — the lattice is stretched along it
`;

/* ------------------------------------------------------------ vertex helpers */

const SKIN_FN = /* glsl */ `
/** Object-space skin matrix for the current vertex. */
mat4 furSkinMatrix(){
  #ifdef USE_SKINNING
    // Each influence is 4 texelFetches, and the shells re-run this once per
    // shell per vertex. Most vertices carry only two or three real weights.
    mat4 s = skinWeight.x * getBoneMatrix(skinIndex.x);
    if (skinWeight.y > 0.0) s += skinWeight.y * getBoneMatrix(skinIndex.y);
    if (skinWeight.z > 0.0) s += skinWeight.z * getBoneMatrix(skinIndex.z);
    if (skinWeight.w > 0.0) s += skinWeight.w * getBoneMatrix(skinIndex.w);
    return bindMatrixInverse * s * bindMatrix;
  #else
    return mat4(1.0);
  #endif
}
`;

const COATLEN_FN = /* glsl */ `
/**
 * Coat thickness at this vertex, in metres.
 *
 * furLength from the anatomy agent is COAT THICKNESS, not hair length, so it
 * maps straight onto the outermost shell's normal offset. The eye mask is the
 * one thing it does not know about: 24 mm of cheek ruff 15 mm from the cornea
 * swallows the whole face at macro range, and real canids are bald to the
 * lid margin.
 */
float furCoatLength(vec3 p, float lengthScale){
  float de = min(distance(p, uEyeL), distance(p, uEyeR));
  float eye = smoothstep(uEyeFade.x, uEyeFade.y, de);
  // The nose pad is bare wet skin. Region 0 already has zero density, but the
  // muzzle shells around it interpolate straight over the pad and bury it
  // under pale fur, which turns a black nose into a blue jellybean.
  float nose = smoothstep(uNoseFade.x, uNoseFade.y, distance(p, uNose));
  return furLength * uCoatScale * lengthScale * eye * nose;
}
`;

const DYNAMICS_FN = /* glsl */ `
/**
 * World-space displacement coefficient W: the hair's offset is t*t * W.
 * Quadratic in t is the small-deflection cantilever shape — a hair pinned at
 * the root and free at the tip. Gravity and wind both act here, after skinning,
 * and both are scaled by (1 - stiffness) through the bendable term.
 *
 * Gusts arrive as a travelling plane wave along the wind direction, with a
 * per-strand phase offset so the coat ripples instead of pulsing as one sheet.
 */
vec3 furDynamics(vec3 rootW, float bendable, float seed, float boost){
  vec3 W = uGravity * (uDroop * bendable * boost);
  float phase = dot(rootW, uWindDir) * uWaveFreq - uTime * uWaveSpeed + seed * 6.2831853;
  float gust  = 0.5 + 0.5 * sin(phase);
  float flick = sin(phase * 2.17 + seed * 11.0);
  float amt   = (uWindSpeed * 0.030 + uWindGust * 0.26 * gust) * uWindBend * bendable * boost;
  W += uWindDir * amt;
  W += vec3(0.0, 1.0, 0.0) * (amt * flick * 0.35);
  return W;
}
`;

/* ------------------------------------------------------------------- noise */

export const FUR_NOISE = HASH + SIMPLEX3 + IGN + UTIL + /* glsl */ `
/**
 * Exact cellular F1 over a 2x2x2 neighbourhood.
 *
 * Sites are confined to the middle half of their cell ([0.25,0.75]^3), which
 * makes the 8-cell search provably exact: for any query inside the block the
 * winning site is always one of those eight, so there are no seams. That makes
 * it ~3.4x cheaper than the shared 27-cell worley3, which the clump layer used
 * until the occlusion term was rewritten to need only F1. All three fur scales
 * (clump, strand, micro) run on this; the jitter range lost by confining the
 * sites is bought back by warping the lookup with the coat-variation noise.
 */
/**
 * Fade a noise octave out as its screen-space footprint approaches a pixel.
 *
 * px is the bind-space size of one pixel, freq the octave's cells per metre,
 * so px*freq is cells per pixel. Past ~1/3 cell per pixel the octave is being
 * point-sampled below Nyquist and must be dissolved into its mean instead of
 * kept, or it aliases and crawls. Bible 2.2 makes this a hard requirement at
 * every framing used in shots/.
 */
float octaveFade(float px, float freq){
  return 1.0 - smoothstep(0.13, 0.40, px * freq);
}

/** Smooth trilinear value noise. Used where a hashed lattice would show its
 *  cell boundaries as hard axis-aligned blocks. */
float vnoise3(vec3 p){
  vec3 i = floor(p), f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(hash13(i + vec3(0.0,0.0,0.0)), hash13(i + vec3(1.0,0.0,0.0)), f.x);
  float b2 = mix(hash13(i + vec3(0.0,1.0,0.0)), hash13(i + vec3(1.0,1.0,0.0)), f.x);
  float c = mix(hash13(i + vec3(0.0,0.0,1.0)), hash13(i + vec3(1.0,0.0,1.0)), f.x);
  float d = mix(hash13(i + vec3(0.0,1.0,1.0)), hash13(i + vec3(1.0,1.0,1.0)), f.x);
  return mix(mix(a, b2, f.y), mix(c, d, f.y), f.z);
}

/**
 * Stretch a lattice coordinate along the hair axis.
 *
 * A 3D Voronoi site is a BALL. Sliced by the shells it becomes a stack of
 * discs, and over a short coat — the 3 mm muzzle and forehead — those discs
 * pile up into a flat rounded scale instead of a hair, which is the "reptile
 * scale" pattern. Compressing the coordinate along the hair makes the cells
 * elongate along it, so a strand is a TUBE and successive shells cut the same
 * tube rather than different parts of a sphere.
 */
vec3 stretchAlong(vec3 q, vec3 axis, float aniso){
  float a = dot(q, axis);
  return q + axis * (a / max(aniso, 1e-3) - a);
}

float cell8(vec3 q, out vec3 site){
  vec3 ip = floor(q - 0.5);
  float best = 1e9;
  vec3 bs = ip;
  for (int k = 0; k < 2; k++)
  for (int j = 0; j < 2; j++)
  for (int i = 0; i < 2; i++){
    vec3 c = ip + vec3(float(i), float(j), float(k));
    vec3 s = c + 0.25 + 0.5 * hash33(c);
    vec3 d = s - q;
    float dd = dot(d, d);
    if (dd < best){ best = dd; bs = s; }
  }
  site = bs;
  return sqrt(best);
}
`;

/* -------------------------------------------------------------- hair field */

export const FUR_FIELD = /* glsl */ `
/**
 * The coat.
 *
 * Returns  .x alpha · .y radial position in the strand (0 axis, 1 edge)
 *          .z per-strand random · .w occlusion from the clump structure,
 * and writes the strand axis position (bind space) to the site out-param.
 *
 * px is the bind-space size of one screen pixel — the LOD signal. Scales
 * finer than a pixel are dissolved into their analytic mean coverage instead
 * of being point-sampled, which is what stops the coat crawling at distance.
 */
vec4 furHair(vec3 p, float t, float px, float densityScale, float clumpScale,
             float freqScale, float shellFill, float pathK, float detail, vec3 axis, out vec3 site)
{
  // Large-scale variation: real fur is not uniformly dense.
  float coatVar = snoise(p * uCoatVarFreq) * octaveFade(px, uCoatVarFreq);

  // ---- clumps ------------------------------------------------------------
  // The occlusion term needs only F1, so the 27-cell worley3 that used to
  // sit here bought nothing and cost ~200 ALU per fragment per shell — by
  // far the most expensive thing in the coat.
  float fc = uClumpFreq * clumpScale * (1.0 + 0.14 * coatVar);
  vec3  csiteC;
  vec2  cd = vec2(cell8(p * fc + coatVar * 0.35, csiteC), 0.0);
  vec3  csite = csiteC / fc;
  float cRand = hash13(csiteC * 1.913);

  // Hairs converge on their clump tip as they rise. This is what turns an even
  // carpet into tufts, and evenness is an instant tell.
  float pull = uClumpPull * (0.35 + 0.85 * cRand) * t * t;
  vec3  pPull = mix(p, csite, clamp(pull, 0.0, 0.95));

  // ---- strands -----------------------------------------------------------
  float fs = uStrandFreq * freqScale * (1.0 - 0.10 * coatVar);
  vec3  ssite;
  float ds = cell8(stretchAlong(pPull * fs, axis, uStrandAniso), ssite);
  site = ssite / fs;
  float sRand = hash13(ssite * 2.371);

  // Per-strand length. Without this every hair ends on the same shell and the
  // coat gets a hard outer boundary — the shrink-wrapped shag-carpet tell.
  float hairLen = uHairLenMin + (1.0 - uHairLenMin) *
                  clamp(mix(cRand, 0.25 + 0.75 * sRand * sRand, 0.58), 0.0, 1.0);
  float lenFade = 1.0 - smoothstep(hairLen - 0.30, hairLen + 0.04, t);

  // Strand cross-section, tapering to a point.
  float r  = mix(uStrandRoot, uStrandTip, t * t) * (0.62 + 0.72 * sRand);
  float aa = max(px * fs * 1.6, 0.012);
  float a  = 1.0 - smoothstep(r - aa, r + aa, ds);

  float sLod = octaveFade(px, fs) * detail;
  float mean = clamp(3.1416 * r * r * 1.15, 0.0, 1.0);
  a = mix(mean, a, sLod);

  // ---- micro strands: only where a pixel can resolve them -----------------
  float fm = uMicroFreq * freqScale;
  float mLod = octaveFade(px, fm) * detail;
  if (mLod > 0.004){
    vec3  msite;
    float dm  = cell8(stretchAlong(pPull * fm, axis, uStrandAniso) + vec3(11.3, 5.7, 2.9), msite);
    float maa = max(px * fm * 1.6, 0.02);
    float mr  = mix(0.34, 0.16, t) * (0.7 + 0.6 * hash13(msite * 3.1));
    float ma  = 1.0 - smoothstep(mr - maa, mr + maa, dm);
    a *= mix(1.0, mix(0.30, 1.0, ma), mLod);
  }

  // ---- undercoat fill -----------------------------------------------------
  // Near the skin the coat is dense felt, not separate hairs. Without this the
  // shells read as a stack of nets and you see straight through to the body.
  float fill = 1.0 - smoothstep(shellFill * 0.42, shellFill * 1.18, t);

  // ---- the tuft --------------------------------------------------------
  // Each clump is a CONE: wide enough at the root to cover the skin, narrowing
  // to a point at the tip, so the gaps between tufts open up as you climb
  // through the coat. This is the difference between fur and carpet, and it is
  // what breaks the shells' long parallel comb strokes into separate locks.
  float tuftR = mix(1.15, 0.34, t * t) * (0.72 + 0.56 * cRand);
  // Ragged the clump boundary. A clean Voronoi edge reads as a rounded
  // polygon — the "reptile scale" pattern over the short face coat — because
  // nothing at this scale breaks it up.
  float edgeN = vnoise3(p * fc * 5.3) - 0.5;
  float taa   = max(px * fc * 1.6, 0.045);
  float tuft  = 1.0 - smoothstep(tuftR - taa, tuftR + taa, cd.x + edgeN * 0.16);
  tuft = mix(1.0, tuft, smoothstep(0.0, 0.18, t) * uTuftAmt
                        * octaveFade(px, fc) * detail);

  a = a * tuft * lenFade;                                  // guard hair, tufted

  // Beer-Lambert path length, applied to the UNDERCOAT ONLY.
  //
  // The undercoat is a continuous medium: a ray crossing a shell's slab
  // obliquely travels further through it and must come out more opaque, which
  // is what stops the coat going translucent along the surface (the cast
  // shadow used to be legible straight through the ruff). Guard hairs are
  // discrete cylinders and get no such boost — applying it to them too seals
  // the outline into smooth felt and throws away the silhouette break-up,
  // which is the one thing that matters most here.
  float under = fill * uFill * (0.86 + 0.14 * cRand);
  under = 1.0 - pow(1.0 - clamp(under, 0.0, 1.0), pathK);

  a = max(a, under) * densityScale * uDensity;

  // Occlusion from the lock structure.
  //
  // This used to be a near-flat tint per Voronoi cell, which painted the flank
  // and shoulder with grey patches that read as a dirty, moulting coat — the
  // single worst artifact this shader had. It is now a gradient that is
  // weighted to vanish at the tips: only hair that genuinely has a lock
  // stacked above it gets darkened, so there is nothing left to tint the
  // visible outer coat cell by cell.
  float lockDepth = (1.0 - t) * (1.0 - t);
  float clumpAO = 1.0 - 0.40 * uClumpAO * lockDepth * smoothstep(0.58, 0.08, cd.x);

  return vec4(clamp(a, 0.0, 1.0), clamp(ds / max(r, 1e-4), 0.0, 1.0), sRand, clumpAO);
}
`;

/* ----------------------------------------------------------------- shading */

export const FUR_SHADE = /* glsl */ `
/** Kajiya-Kay lobe about a tangent shifted along the surface normal. */
float kkLobe(vec3 T, vec3 N, vec3 H, float shift, float power){
  vec3 t = normalize(T + N * shift);
  float dotTH = dot(t, H);
  float sinTH = sqrt(max(0.0, 1.0 - dotTH * dotTH));
  return pow(sinTH, power);
}

/**
 * The fur BRDF.
 *   N    shading normal, already bent to the per-strand cylinder
 *   T    hair direction, world
 *   V    towards the camera
 *   t    depth through the coat
 *   ao   combined occlusion
 *   rnd  per-strand random — breaks the specular into individual hairs
 */
vec3 furShade(vec3 N, vec3 T, vec3 V, float t, float ao, float rnd,
              float tipWhite, vec3 tintMul, bool cheap, float thinness)
{
  vec3  L = uSunDir;
  vec3  H = normalize(L + V);
  float ndl = dot(N, L);
  float ndv = abs(dot(N, V));

  // ---- albedo: cream undercoat -> warm-white tips ------------------------
  vec3 albedo = mix(uFurUnder, uFurLit, smoothstep(0.0, 0.34, t));
  albedo = mix(albedo, uFurLit, tipWhite * smoothstep(0.35, 1.0, t) * 0.55);
  albedo *= tintMul;

  // ---- wrapped diffuse: fur scatters, so the terminator is soft and wide --
  float wrapD = clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0);
  wrapD *= wrapD;
  float lit = clamp(wrapD * 1.9, 0.0, 1.0);

  // White fur in shade is BLUE, never grey (bible §3). Two mechanisms, both
  // needed: a hue shift on the albedo and a sky-coloured ambient.
  albedo *= mix(uShadowTint, vec3(1.0), lit);

  // Multiple scattering.
  //
  // Fur is a dense, high-albedo medium: a photon entering the coat bounces off
  // many hairs before it leaves, so what exits is an average over everything
  // that lit the coat, not a single-bounce copy of the sun's own colour. A
  // Lambert surface takes the sun's chromaticity at full strength; fur does
  // not, and treating it as if it did is what made a white animal render
  // salmon. The snow does not show this because at a 6.6 degree sun a flat
  // surface gets NdotL ~= 0.11 and is ambient dominated, whereas the fox's
  // flank faces that low sun almost square on and gets NdotL ~= 1.
  //
  // 1/PI keeps the fox at the same exposure as everything three lights with
  // the standard BRDF.
  vec3 sunScatter = mix(vec3(luma(uSunColor)), uSunColor, uSunSat);
  vec3 direct = sunScatter * uSunIntensity * wrapD * mix(ao, 1.0, 0.62) * RECIPROCAL_PI;

  // ---- ambient: cool sky above, snow bounce below -------------------------
  float up = N.y * 0.5 + 0.5;
  vec3 amb = mix(uGroundBounce, uSkyColor, up);
  amb = mix(vec3(luma(amb)), amb, uAmbientSat);
  vec3 ambient = amb * (uAmbient * RECIPROCAL_PI) * ao;

  vec3 col = albedo * (direct + ambient);

  // ---- anisotropic specular, two shifted lobes ---------------------------
  if (uAniso > 0.5 && !cheap){
    float j  = (rnd - 0.5) * uSpecJitter;
    float s1 = kkLobe(T, N, H, uSpecShiftA + j, uSpecPowA);
    float s2 = kkLobe(T, N, H, uSpecShiftB + j * 1.7, uSpecPowB);
    s2 *= 0.35 + 0.95 * rnd;   // the secondary lobe glints hair by hair
    float vis = clamp(ndl * 2.2 + 0.30, 0.0, 1.0) * mix(0.25, 1.0, t);
    col += uSunColor * uSunIntensity * vis * ao *
           (s1 * uSpecGainA * uSpecTintA + s2 * uSpecGainB * uSpecTintB);
  }

  // ---- forward scattering: this is the shot -------------------------------
  // Light that entered the far side of the coat and kept going. Peaks when the
  // camera looks into the sun, strongest in the thin outer coat and at grazing
  // angles — i.e. exactly along the rim.
  //
  // The weight that matters is THINNESS, not the grazing angle. A halo exists
  // where the coat is sparse enough that sky is visible between the hairs;
  // over the dense body there is an opaque animal behind the fur and nothing
  // can shine through it. Driving this off (1 - alpha) puts the glow exactly
  // on the fringe hairs and nowhere else — which is also why it reads as
  // individual lit hairs rather than as a warm haze over the whole coat.
  // Gating it on the grazing angle instead was what tinted the lit side peach.
  float fwd   = cheap ? 0.0 : pow(clamp(-dot(V, L), 0.0, 1.0), uTransPow);
  // Only the OUTERMOST coat can transmit: light that made it through exits
  // from the outer surface, and a buried inner shell has the whole coat above
  // it. A gentle ramp let ~7 shells each contribute a little and they summed
  // into a flat wash over the body.
  float thin  = pow(clamp(t, 0.0, 1.0), 3.5);
  float graze = pow(1.0 - ndv, 5.0);
  float shell = clamp(-ndl * 0.65 + 0.55, 0.0, 1.0);
  // Reference photographs (bible 4b): an arctic fox has NO warm cast, in any
  // light, including direct low sun — shaded fur goes blue-grey, never pink.
  // Light that has scattered through a deep white coat is heavily decorrelated
  // from the sun's own chromaticity, so the transmitted colour is desaturated
  // hard rather than carrying the sun's orange straight through.
  vec3 transLight = mix(vec3(luma(uSunColor)), uSunColor, uTransSat);
  col += transLight * uSunIntensity * uTransTint * albedo *
         (uTrans * RECIPROCAL_PI * fwd * thin * (1.45 * graze)
          * thinness * (0.30 + 0.95 * shell));
  // NOTE on the constant-free grazing weight: thinness alone cannot tell a
  // fringe hair over sky from an outer shell over dense coat — both have the
  // same low PER-SHELL alpha. With a 0.06 interior floor, every one of the
  // ~7 outer shells added transmission over the body and they accumulated:
  // measured +15.9/255 luma over the eroded body interior against +17.7 at
  // the fringe, i.e. a flat wash rather than a halo. The floor has to be
  // exactly zero and the falloff steep, so only genuinely grazing fragments
  // glow and the interior contributes nothing to integrate.

  // A cool sky rim keeps the shadow side alive on the silhouette.
  col += uSkyColor * albedo * (uRim * pow(1.0 - ndv, 2.6) * mix(0.2, 1.0, t) * ao);

  return col;
}
`;

/* ------------------------------------------------------- shell / base pass */

export function furVertexShader(variant) {
  const isShell = variant === 'shell';
  return /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
${FUR_UNIFORMS}
${FUR_VARYINGS}
${HASH}
${SKIN_FN}

attribute float furLength;
attribute float furStiffness;
attribute vec3  furTangent;
attribute float region;
attribute float aFurAO;        // 0 = open, 1 = fully occluded (safe default 0)
${COATLEN_FN}
${DYNAMICS_FN}
${isShell ? 'attribute float aShell;' : ''}

void main(){
  #include <color_vertex>

  int  ri = int(clamp(region, 0.0, ${REGION_COUNT - 1}.0) + 0.5);
  vec4 ra = uRegionA[ri];
  vec4 rb = uRegionB[ri];

  float t = 0.0;
  ${isShell ? 't = (aShell + 1.0) / max(uShellCount, 1.0);' : ''}

  float L    = furCoatLength(position, ra.y);
  float soft = 1.0 - furStiffness;
  vec3  nb   = normalize(normal);
  vec3  tb   = furTangent;

  // --- the comb ------------------------------------------------------------
  // Rise along the normal preserves the coat's measured thickness; the
  // tangential term shears the shells so hairs LIE DOWN along furFlow instead
  // of standing off like a sea urchin. Soft fur lies flatter than guard hair.
  float lay  = uLay * ra.z * (0.30 + 1.05 * soft);
  vec3  offB = nb * (L * t) + tb * (L * lay * t * t);
  vec3  hdir = normalize(nb + tb * (2.0 * lay * t));

  // --- skin ----------------------------------------------------------------
  mat4 sk  = furSkinMatrix();
  mat3 sk3 = mat3(sk);
  vec3 posO  = (sk * vec4(position + offB, 1.0)).xyz;
  vec3 rootO = (sk * vec4(position, 1.0)).xyz;
  vec3 nO    = normalize(sk3 * nb);
  vec3 hO    = normalize(sk3 * hdir);

  mat3 m3 = mat3(modelMatrix);
  vec4 wp = modelMatrix * vec4(posO, 1.0);
  vec3 wn = normalize(m3 * nO);
  vec3 wh = normalize(m3 * hO);

  // --- gravity + wind, world space, after skinning -------------------------
  vec3 rootW = (modelMatrix * vec4(rootO, 1.0)).xyz;
  vec3 W = furDynamics(rootW, L * (0.25 + 0.95 * soft), hash13(position * 53.17), 1.0);
  wp.xyz += W * (t * t);

  vRoot = position;
  vAxis = hdir;
  vWPos = wp.xyz;
  vNrm  = wn;
  vTan  = normalize(wh * max(L, 1e-4) + 2.0 * t * W);
  vP0   = vec4(t, rb.z, aFurAO, ra.x);
  vP1   = vec4(rb.x, rb.y, ra.w, L);

  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;

  #ifdef USE_FOG
    vFogDepth = -mvPosition.z;
  #endif
}
`;
}

export function furFragmentShader(variant) {
  const isShell = variant === 'shell';
  return /* glsl */ `
precision highp float;
#include <common>
#include <fog_pars_fragment>
${FUR_UNIFORMS}
${FUR_VARYINGS}
${isShell ? FUR_NOISE + FUR_FIELD : HASH + UTIL}
${FUR_SHADE}
#ifdef USE_COLOR
  varying vec3 vColor;
#endif

void main(){
  float t   = vP0.x;
  vec3  V   = normalize(cameraPosition - vWPos);
  vec3  N   = normalize(vNrm);
  vec3  T   = normalize(vTan);
  float ao  = 1.0 - vP0.z * uAOBake;
  float rnd = 0.5;
  vec3  tint = vec3(1.0);
  float alpha = 1.0;

${isShell ? /* glsl */ `
  // Bind-space pixel footprint — the LOD signal for every noise scale.
  float px = max(length(fwidth(vRoot)), 1e-7);
  float shellFill = clamp(0.34 + 3.6 / max(uShellCount, 1.0), 0.34, 0.80);

  // Per-fragment shell-depth dither.
  //
  // A shell is a discrete slice of a continuous coat, so the alpha steps
  // between consecutive shells show up as concentric contour rings around the
  // animal — ruinous at 6 shells, where the rings are 7 mm apart. Jittering
  // the depth by up to half a shell spacing, from an OBJECT-space hash so it
  // is perfectly stable in motion, dissolves those steps into the hair noise
  // and lets the undercoat stay opaque at every tier.
  // Shell-depth dither, at hair scale.
  //
  // A per-fragment hash gives per-PIXEL grain; a hash of floor(p) gives hard
  // axis-aligned CUBES, which at macro range are ~40 px rectangles with
  // stair-stepped edges (these were the "texel grid" plates blamed on the
  // cards — they are shells). Smooth trilinear value noise has neither
  // problem, and it fades out once its own cells approach a pixel.
  float jf = 680.0;
  float tJ = clamp(t + (vnoise3(vRoot * jf) - 0.5) * uShellJitter
                       * octaveFade(px, jf) / max(uShellCount, 1.0), 0.0, 1.0);

  // Detail fade along the SHELL axis.
  //
  // Every shell samples the same object-space hair field; only its screen
  // position differs. When consecutive shells land within a pixel or two of
  // each other — which is exactly what 18 shells over a 3 mm face coat do —
  // they lay near-identical copies of one pattern at slightly different
  // offsets, and that beats into moire chevrons. Collapsing the field toward
  // its mean as the shell spacing approaches a pixel removes the interference
  // without changing the coat's thickness or its look at normal framings.
  float shellPx = (vP1.w / max(uShellCount, 1.0)) / px;
  float detail  = smoothstep(0.9, 3.2, shellPx);

  float pathK = clamp(1.0 / max(abs(dot(normalize(vNrm), V)), 0.16), 1.0, 6.0);

  // Shells this deep are solid felt and almost entirely hidden behind the coat
  // above them. Neither the strand/micro/clump field nor the specular and
  // transmission lobes can change what you see, so skip all of it.
  bool deep = tJ < shellFill * 0.40;

  vec3 site = vRoot;
  vec4 hair = vec4(1.0, 0.45, hash13(vRoot * 131.7), 1.0);
  if (!deep) hair = furHair(vRoot, tJ, px, vP0.w, vP1.x, vP1.y, shellFill, pathK, detail,
                              normalize(vAxis), site);
  alpha = hair.x;
  if (alpha < 0.004) discard;

  rnd = hair.z;
  ao *= hair.w;


  // Per-strand cylinder normal. Without this every hair in a tuft shades
  // identically and the macro shot turns to mush.
  float sLod = octaveFade(px, uStrandFreq * vP1.y) * detail * (deep ? 0.0 : 1.0);
  if (uStrandRound > 0.001 && sLod > 0.01){
    vec3 B = cross(T, V);
    float bl = length(B);
    if (bl > 1e-5){
      B /= bl;
      vec3 Vp = normalize(cross(B, T));
      vec3 toAxis = vRoot - site;
      float sgn = dot(toAxis, B) < 0.0 ? -1.0 : 1.0;
      float x = clamp(sgn * hair.y, -1.0, 1.0);
      vec3 Ncyl = normalize(B * x + Vp * sqrt(max(0.0, 1.0 - x * x)));
      N = normalize(mix(N, Ncyl, uStrandRound * sLod));
    }
  }

  // Depth-attenuated occlusion: the inside of the coat must be markedly darker
  // than the tips, or it reads as a flat decal instead of a deep coat.
  ao *= mix(uAOInner, 1.0, pow(tJ, uAOPow));
  ao *= mix(0.60, 1.0, 1.0 - hair.y * 0.5);
  ao = max(ao, uAOFloor);
` : /* glsl */ `
  // Base layer: skin under the coat — dark, occluded, faintly cool.
  ao = max(ao * mix(uAOInner, 1.0, 0.58), uAOFloor);
  #ifdef USE_COLOR
    // Pad leather and the nose come through the vertex colour. Under a dense
    // paw coat almost none of it should read, or the fox grows teddy-bear feet.
    tint = mix(vec3(1.0), vColor, vP0.y);
  #endif
`}

  vec3 col = furShade(N, T, V, t, ao, rnd, vP1.z, tint,
                      ${isShell ? 'deep' : 'false'}, ${isShell ? '1.0 - clamp(alpha, 0.0, 1.0)' : '0.0'});

${isShell ? /* glsl */ `
  // Stochastic cut-out. The threshold is hashed in OBJECT space, so it is
  // temporally stable with or without TAA; interleaved-gradient screen noise is
  // blended in only when a TAA resolve is actually running.
  if (uStochastic > 0.001){
    float d = mix(hash13(site * 91.7 + t * 3.1),
                  ign(gl_FragCoord.xy + uFrameSeed * 5.588238), uStochastic);
    if (alpha < d * 0.92) discard;
    alpha = min(1.0, alpha + 0.55 * uStochastic);
  }
` : ''}

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;
}

/* ------------------------------------------------------------- hair cards */

/**
 * Cards are cylindrical billboards: each tuft rotates about its own hair axis
 * to face the camera, so it always presents full width. Shells alone can never
 * remove the mesh's smooth outline — these are what turn that outline into
 * individual strands against the sky.
 */
export function cardVertexShader() {
  return /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
#include <fog_pars_vertex>
${FUR_UNIFORMS}
${FUR_VARYINGS}
${HASH}
${SKIN_FN}

uniform float uCardWidth;
uniform float uCardLength;
uniform float uCardJitter;

attribute float furLength;
attribute float furStiffness;
attribute vec3  furTangent;
attribute float region;
attribute float aFurAO;
attribute vec4  aCard;   // x v along card · y side -1/+1 · z rand · w lengthMul
${COATLEN_FN}
${DYNAMICS_FN}

varying vec3  vCard;     // x across 0..1 · y along 0..1 · z rand
varying float vEdge;     // silhouette weight

void main(){
  int  ri = int(clamp(region, 0.0, ${REGION_COUNT - 1}.0) + 0.5);
  vec4 ra = uRegionA[ri];
  vec4 rb = uRegionB[ri];

  float v    = aCard.x;
  float side = aCard.y;
  float rnd  = aCard.z;
  float soft = 1.0 - furStiffness;
  float L    = furCoatLength(position, ra.y) * uCardLength * aCard.w;

  vec3  nb   = normalize(normal);
  vec3  tb   = furTangent;

  // Fan each tuft off the flow direction. Without this every card on the
  // dorsal line sweeps back on exactly the same heading and the topline reads
  // as a combed mane rather than as separate locks.
  float ja = (rnd - 0.5) * uCardJitter;
  tb = normalize(tb * cos(ja) + cross(nb, tb) * sin(ja));

  // Cards fold over harder than the shells do — a tuft standing perpendicular
  // to the skin is a quill, not a hair. But the rise term is also what decides how
  // far a card reaches ALONG THE NORMAL, and if that lands short of the
  // outermost shell the cards are buried inside the coat and contribute
  // nothing to the outline. uCardLength is sized so the mean tip clears the
  // shells by ~25% and the longest by ~2x.
  float lay  = uLay * ra.z * (0.55 + 1.25 * soft) * (1.10 + 0.85 * hash11(rnd * 37.1));
  float rise = 0.95;
  vec3  offB = nb * (L * v * rise) + tb * (L * lay * v * (0.42 + 0.58 * v));
  vec3  hdir = normalize(nb * rise + tb * (lay * (0.42 + 1.16 * v)));

  mat4 sk  = furSkinMatrix();
  mat3 sk3 = mat3(sk);
  vec3 posO  = (sk * vec4(position + offB, 1.0)).xyz;
  vec3 rootO = (sk * vec4(position, 1.0)).xyz;
  vec3 nO    = normalize(sk3 * nb);
  vec3 hO    = normalize(sk3 * hdir);

  mat3 m3 = mat3(modelMatrix);
  vec4 wp = modelMatrix * vec4(posO, 1.0);
  vec3 wn = normalize(m3 * nO);
  vec3 wh = normalize(m3 * hO);

  vec3 rootW = (modelMatrix * vec4(rootO, 1.0)).xyz;
  vec3 W = furDynamics(rootW, L * (0.30 + 1.0 * soft), rnd, 0.85);
  wp.xyz += W * (v * v);
  vec3 hairW = normalize(wh * max(L, 1e-4) + 2.0 * v * W);

  vec3 toCam = normalize(cameraPosition - wp.xyz);
  vec3 B = cross(hairW, toCam);
  float bl = length(B);
  B = bl > 1e-5 ? B / bl : normalize(cross(hairW, vec3(0.0, 1.0, 0.0)));

  float w = uCardWidth * clamp(furLength * uCoatScale, 0.004, 0.06)
          * (0.55 + 0.9 * rnd) * pow(max(1.0 - v, 0.0), 0.5);
  wp.xyz += B * (side * w);

  vRoot = position;
  vAxis = hdir;
  vWPos = wp.xyz;
  vNrm  = wn;
  vTan  = hairW;
  vP0   = vec4(v, rb.z, aFurAO, ra.x);
  vP1   = vec4(rb.x, rb.y, ra.w, L);
  vCard = vec3(side * 0.5 + 0.5, v, rnd);
  vEdge = 1.0 - abs(dot(wn, toCam));

  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #ifdef USE_FOG
    vFogDepth = -mvPosition.z;
  #endif
}
`;
}

export function cardFragmentShader() {
  return /* glsl */ `
precision highp float;
#include <common>
#include <fog_pars_fragment>
${FUR_UNIFORMS}
${FUR_VARYINGS}
${HASH}
${UTIL}
${FUR_SHADE}

uniform float uCardInner;
uniform float uCardOpacity;

varying vec3  vCard;
varying float vEdge;

void main(){
  float v   = vCard.y;
  float rnd = vCard.z;

  // Several hairs per card, each with its own radius, length and phase.
  float n  = 2.0 + floor(rnd * 3.99);
  float s  = vCard.x * n + rnd * 7.31;
  float fi = floor(s);
  float fr = fract(s);
  float hr = hash11(fi * 1.7 + rnd * 31.0);

  float d   = abs(fr - 0.5) * 2.0;
  float rad = 0.20 + 0.40 * hr;
  float aa  = clamp(fwidth(s) * 1.6, 0.02, 1.2);
  float a   = 1.0 - smoothstep(rad - aa, rad + aa, d);

  // Per-hair length, so the card never ends on a straight edge.
  float hlen = 0.42 + 0.58 * hash11(fi * 3.3 + rnd * 11.0);
  float tipFade = 1.0 - smoothstep(hlen - 0.30, hlen, v);
  a *= tipFade;
  a *= smoothstep(0.0, 0.12, v);           // hide the root inside the shells

  // Sub-pixel cards dissolve to their mean instead of flickering.
  float lod = 1.0 - smoothstep(0.30, 0.85, fwidth(s));
  a = mix(clamp(rad * 0.70, 0.0, 1.0) * tipFade * smoothstep(0.0, 0.12, v), a, lod);

  // Strongest exactly where the surface turns away — the silhouette.
  float edge = mix(uCardInner, 1.0, pow(clamp(vEdge, 0.0, 1.0), 2.6));
  a *= edge * uCardOpacity * vP0.w;
  if (a < 0.004) discard;

  vec3 V = normalize(cameraPosition - vWPos);
  vec3 T = normalize(vTan);
  vec3 N = normalize(vNrm);

  vec3 B = cross(T, V);
  float bl = length(B);
  if (bl > 1e-5){
    B /= bl;
    vec3 Vp = normalize(cross(B, T));
    float x = clamp((fr - 0.5) * 2.0 / max(rad, 1e-3), -1.0, 1.0);
    vec3 Ncyl = normalize(B * x + Vp * sqrt(max(0.0, 1.0 - x * x)));
    // Only let the per-hair cylinder normal take over near the SILHOUETTE.
    // A card lying against the body that shades by its own tube normal is
    // lit quite differently from the shells right underneath it, and where
    // those cards overlap the mismatch pools into grey patches — the flank
    // went visibly mottled at sun 14,-30 while the shells alone stayed clean.
    // In the interior the card must shade like the coat it sits in.
    N = normalize(mix(N, Ncyl, (0.12 + 0.82 * clamp(vEdge, 0.0, 1.0)) * lod));
  }

  float ao = (1.0 - vP0.z * uAOBake) *
             mix(uAOInner + 0.3, 1.05, pow(clamp(v, 0.0, 1.0), uAOPow * 0.6));
  vec3 col = furShade(N, T, V, clamp(0.5 + 0.5 * v, 0.0, 1.0), ao, hr, vP1.z, vec3(1.0),
                      false, 1.0 - clamp(a, 0.0, 1.0) * 0.55);

  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;
}
