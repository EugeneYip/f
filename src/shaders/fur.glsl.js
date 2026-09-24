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

/**
 * Card shape constants — the SINGLE source of truth.
 *
 * Perpendicular reach past the skin is
 *     uCardLength * lenMul * rise        (+ droop on the downward side)
 * as a multiple of the local coat thickness, and `reachBand` is the range it
 * must stay inside: below it the cards are buried inside the shells and the
 * silhouette goes smooth; above it they separate into visible spikes. We have
 * overshot this band in both directions, so these values are injected into the
 * shader from here AND read by ctx.fur.reachReport(), which means the guard
 * cannot drift away from what the shader actually does.
 */
export const CARD_SHAPE = {
  lenMulMin: 0.92,
  // lenMul = min + spread * rClump * rCard, both uniform in [0,1). It is a
  // PRODUCT of two uniforms, so E = 1/4 — not E[r^2] = 1/3, which is what the
  // reach arithmetic used to assume. One of the two factors is shared across a
  // clump, so a lock is long or short as a unit instead of every hair in it
  // drawing independently from the same distribution (which averages out to a
  // flat fringe at any distance where the hairs are not separately resolved).
  lenMulSpread: 0.18,
  lenMulMean: 0.92 + 0.18 * 0.25,
  rise: 0.95,           // fraction of card length spent along the normal
  droopBoost: 0.40,     // gravity multiplier for cards (guard hair is stiff)
  reachBand: [1.10, 1.25],

  /*
   * The most ABSOLUTE guard-hair stand-off any floor may add, in metres — the
   * ceiling on uCardFloor (see the card vertex shader).
   *
   * reachBand is a ratio and therefore cannot bound the millimetres that a
   * card stands over open sky; it grants 0.25 x the local coat, which is
   * 4.8 mm on the flank and 0.4 mm on the muzzle. uCardFloor exists to put a
   * floor under that second number, and it needs its own ceiling or it is an
   * unbounded knob with the same shape as every self-defeating one this
   * project has already shipped.
   *
   * 12 mm = 0.25 x the 48 mm flank coat, which is 4f's ONE sourced depth. So
   * the rule is: an absolute floor may add no more stand-off than the
   * proportional rule already grants the only coat depth we have a source
   * for. It is not a number chosen to admit the current value.
   */
  standFloorMax: 0.012,

  /*
   * Mean of the per-lock draw on that peak. The card vertex shader draws
   * sqrt(hash), whose mean is 2/3; a lock's share of the peak is then
   * uCardFloorLow + (1 - uCardFloorLow) * that. reachReport() reads this
   * constant rather than repeating the exponent, so the guard's idea of the
   * typical stand-off and the shader's cannot drift. If the exponent in the
   * shader changes, change this with it.
   *
   * The pairing that matters: peak x (low + (1 - low) * this) must come out
   * at the mean stand-off the coat had before the draw existed, or the
   * silhouette pays for the variation. 0.012 x (0.50 + 0.50 x 0.6667) = 10 mm.
   */
  floorDrawMean: 0.6667,

  /**
   * Clumping — bible §5, "fur must clump, not distribute evenly".
   *
   * Cards were placed independently and then FANNED APART by uCardJitter, so
   * nothing gathered: the coat was an even spray of separate hairs, which is
   * what "individually resolved" means. Each card now snaps to a Worley site
   * in bind space (CPU side, in FurCards) and every card sharing a site shares
   * its heading, its wind phase and half its length draw, and leans its tip
   * toward the site. That is a lock.
   *
   * 16 mm is a real arctic-fox lock and lands at 46 CSS px at `frontal` /
   * 57 px at `portrait` — big enough to read as mass, small enough that the
   * ruff carries several across its width.
   */
  clumpCell: 0.016,
};

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
// How far the UPWARD ambient is pulled off the zenith toward the pale band
// around the horizon. uSkyColor is the zenith swatch, and a surface does not
// see the zenith -- see the ambient block in furShade().
uniform float uSkyHorizon;
uniform float uSunSat;
uniform float uTransSat;

// --- dynamics --------------------------------------------------------------
uniform float uTime;
uniform vec3  uWindDir;        // ctx.wind, unit — the same vector the snow uses
uniform float uWindSpeed;      // ctx.windSpeed * (1 + 1.4*gust), as SnowParticles
uniform float uWindGust;
uniform vec3  uGravity;        // world down
// --- the animal's own motion, as opposed to the weather --------------------
// Published by animation on ctx.fox and, until now, read by nothing: the coat
// was bit-identical whether the fox was asleep or galloping.
uniform vec3  uCoatLag;        // WORLD-space coat inertia, metres at a 48 mm
                               // coat (FurSystem rotates it out of body space)
uniform float uCoatCompress;   // +1 crushed onto the body, negative = rebound
uniform float uCoatSquash;     // how much of that reaches the hair length
uniform float uAgitation;      // 0..1, how hard the coat is being thrown about
uniform float uCoatRuffle;     // agitation -> per-strand flick gain

// --- coat shape ------------------------------------------------------------
uniform vec3  uEyeL;           // bind-space eyeball centres: the coat has to
uniform vec3  uEyeR;           // part around the eye or it buries the face
// x bare radius · y where COVERAGE is restored · z where LENGTH is restored,
// all metres in the fissure's anisotropic metric -- see furSkinMask2
uniform vec3  uEyeFade;
uniform vec3  uEyeAxisL;       // bind-space optical axes: the fissure, and
uniform vec3  uEyeAxisR;       // therefore the slot, is built off these
uniform vec2  uEyeSlot;        // x along the fissure (<1 = further) · y across
uniform float uCardEyeGuard;   // 0..1, how hard a card is cut where it would
                               // sweep across the cornea. 0 restores the old
                               // root-only test, for A/B.
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
uniform float uPathKMax;       // cap on the oblique-path opacity boost
uniform float uShellDeep;      // shells below this share of shellFill take the cheap path
uniform float uFillTop;        // where the undercoat stops, x shellFill
uniform float uFillJitter;     // +/- fraction, per clump/strand
uniform float uCardTip;        // v past which a card stops being edge-gated
uniform float uCoatVarFreq;
uniform vec2  uStrandFade;     // strand octave's own LOD band, cells per pixel

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
uniform float uTransThin;      // exponent on (1 - alpha): 0 disables the term
uniform float uTransGraze;     // exponent on (1 - |N.V|)
uniform float uTransFloor;     // how far the grazing band bypasses the thinness gate
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
uniform float uMicroOn;
uniform float uFeltStrand;   // strand structure in the undercoat felt
uniform float uRim;

// --- inter-shell self-shadowing -------------------------------------------
// The coat casts a shadow on itself. See furSelfShadow().
uniform float uCoatSigma;      // extinction per metre of hair travelled
uniform float uCoatSigmaMin;   // floor on cos(N,L) -- caps the grazing path
uniform float uCoatSigmaSky;   // mean secant for the sky's own path
uniform float uCoatSigmaCard;  // card share of it (guard hair is sparser)
uniform float uCoatSigmaFloor; // multiple-scattering floor on the transmittance
uniform float uCoatLock;       // metres of coat a metre of lateral lock offset
                               // is worth, along the light. See furLockShadow.

// --- stochastic / TAA ------------------------------------------------------
uniform float uStochastic;     // 0 = smooth alpha · 1 = IGN dithered cut-out
uniform float uFrameSeed;

// --- per-region tables -----------------------------------------------------
// A: x density   y length     z lay     w tipWhite
// B: x clumpScale  y freqScale  z aoScale  w cardWeight
uniform vec4 uRegionA[${REGION_COUNT}];
uniform vec4 uRegionB[${REGION_COUNT}];
// C: x cardLengthScale — card length relative to the LOCAL coat.
//
// Cards normally scale with coat thickness, but on the head that couples two
// things that should be separate: 4b wants face fur a few millimetres deep,
// while 2.1 wants the outline broken everywhere. At the silhouette framing one
// pixel is ~2.6 mm, so a 4.7 mm ear fringe cannot ramp over more than two
// pixels no matter how dense it is — it has to be longer in WORLD units while
// the coat underneath stays short. Real ear rims and skull guard hairs are
// exactly that: long hairs standing out of short underfur.
uniform vec4 uRegionC[${REGION_COUNT}];
uniform float uCardFloorScale[${REGION_COUNT}];  // per-region x on uCardFloor
`;

export const FUR_VARYINGS = /* glsl */ `
varying vec3 vRoot;   // BIND-space hair root — the stable noise domain
varying vec3 vWPos;
varying vec3 vNrm;    // world surface normal
varying vec3 vTan;    // world hair direction at this depth
varying vec4 vP0;     // x t · y baseTint · z bakedOcclusion · w density
varying vec4 vP1;     // x clumpScale · y freqScale · z tipWhite · w coatLen
varying vec3 vAxis;   // BIND-space hair axis — the lattice is stretched along it
varying vec2 vShellMod;  // x: shell hair-length scale · y: transmission boost
varying vec3 vSunB;   // uSunDir carried into BIND space — see furLockShadow()
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
/**
 * Bare-skin mask: 0 on the rhinarium and the eyelid margin, 1 in full coat.
 *
 * Zeroing the coat LENGTH is not enough on its own — the shells then collapse
 * onto the skin and keep drawing at full alpha, so they still paint undercoat
 * cream over the nose pad. At distance that reads as (209,198,186) against a
 * (23,26,32) spec, which is very close to the undercoat colour #dcd3c6. The
 * mask has to gate coverage as well as offset.
 */
/**
 * Returns .x = LENGTH mask, .y = COVERAGE mask. They are not the same thing.
 *
 * Zeroing both over one disc is what produced a bald brow. The coat must get
 * SHORTER toward the lid margin, but it must not get THINNER at the same rate:
 * bible 4f rule 3 allows bare skin only on the rhinarium, the eyes and the paw
 * pads, and a single clearance radius shaved a disc ~45 mm across centred on
 * each eye -- which on a 90 mm head is the entire brow. So the coat goes bare
 * at the lid margin, recovers COVERAGE quickly past it, and recovers LENGTH
 * slowly: the surround is short fur, never skin.
 *
 * THE RADIUS MUST NOT SCALE WITH THE LOCAL COAT. It used to:
 *
 *     r = base + perMetre * localCoat        (capped)
 *
 * which is self-defeating by construction, because the clearance grows as fast
 * as the thing it is meant to clear. Authored at a 4 mm head coat it looked
 * harmless and measured clean -- the fur agent predicted the failure, anatomy
 * DISPROVED it by measurement, and both were right at the time. At 17-33 mm it
 * returned 23-37 mm of bald skin around an 8 mm eye and shaved the brow; at a
 * 40 mm face coat the two discs met across the bridge of the nose, 58.3 mm
 * apart, and shaved the whole face. A hard cap papered over it twice. The cap
 * was never the fix; the coat term was the bug, and it is gone.
 *
 * THE CLEARANCE IS A SLOT, NOT A DISC, and all three radii are metres
 * measured against the eyeball Eyes.js actually draws -- see eyeLidMargin()
 * in FurSystem. The previous form could not open the eye at all:
 *
 *   - COVERAGE cleared inside x*y*z = 3.5 mm and was fully restored by
 *     x*z = 7.8 mm, while the nearest skin to that centre is 8.6 mm and the
 *     lid margin 12.8 mm. Every skin vertex on the face was outside it, so
 *     the coverage mask was identically 1: it did nothing whatsoever.
 *   - LENGTH ramped from 6.8 mm to 15.0 mm, which puts 80% of full coat
 *     length ON the lid margin. Measured differentially, the coat ate 37.5%
 *     of the aperture at frontal and 42.4% at portrait, and hiding the
 *     cards recovered 0.2% of it: this mask, not the cards.
 *   - A disc big enough to clear the lid margin is also big enough to shave
 *     the brow, because the fissure is about twice as wide as it is tall.
 *     Anatomy carves the socket as a capsule along the fissure axis for the
 *     same reason ("a canid's palpebral fissure is a slot between the medial
 *     canthal ligament and the lateral raphe, not a hole"), so the parting
 *     has to be measured in the same anisotropic metric or the two disagree.
 *
 *   uEyeFade  x bare radius  y coverage restored  z length restored (metres)
 *   uEyeSlot  x scale ALONG the fissure (<1 reaches further)
 *             y scale ACROSS it (>1 keeps the brow and the cheek coated)
 */
/** Distance to one eye in the fissure's own anisotropic metric. */
float eyeSlotDist(vec3 p, vec3 c, vec3 axis){
  vec3  q = p - c;
  // The fissure runs horizontally, perpendicular to the optical axis: the
  // same construction Eyes.js uses to orient the socket capsule.
  vec3  tang = normalize(vec3(axis.z, 0.0, -axis.x));
  float a = dot(q, tang);                    // temporal <-> nasal
  vec3  r = q - tang * a;
  float x = dot(r, axis);                    // along the optical axis: there
  vec3  up = r - axis * x;                   // is no skin here, so it stays
  return length(vec3(a * uEyeSlot.x, length(up) * uEyeSlot.y, x));
}

vec2 furSkinMask2(vec3 p){
  float d = min(eyeSlotDist(p, uEyeL, uEyeAxisL),
                eyeSlotDist(p, uEyeR, uEyeAxisR));
  float eyeL = smoothstep(uEyeFade.x, max(uEyeFade.z, uEyeFade.x + 1e-4), d);
  float eyeD = smoothstep(uEyeFade.x, max(uEyeFade.y, uEyeFade.x + 1e-4), d);
  // The rhinarium is genuinely bare skin, so it gates both.
  float nose = smoothstep(uNoseFade.x, uNoseFade.y, distance(p, uNose));
  return vec2(eyeL * nose, eyeD * nose);
}

/**
 * Coat depth in metres, after the eye/nose parting AND the impact crush.
 *
 * Hair compression is the half of bible 4f's bounce that a bone rotation
 * physically cannot express: a skeleton can pitch the trunk, it cannot make
 * fur shorter. uCoatCompress reaches 0.20 at a gallop and dips negative on
 * the rebound by design, so this squashes on the landing and overshoots past
 * rest on the way back out.
 *
 * Both the shells and the cards multiply THIS, so the card tip's reach as a
 * multiple of the local coat -- the quantity CARD_SHAPE.reachBand guards and
 * the one that produced the urchin coat when it drifted -- is unchanged by
 * the crush. It scales the coat and the hair in it together.
 */
float furCoatLength(vec3 p, float lengthScale){
  float crush = clamp(1.0 - uCoatCompress * uCoatSquash, 0.62, 1.30);
  return furLength * uCoatScale * lengthScale * crush * furSkinMask2(p).x;
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

  // ---- the ANIMAL's motion, not the weather -----------------------------
  // Everything above this line comes from ctx.wind and ctx.windSpeed, which
  // is why the coat has been identical asleep and at a gallop. uCoatLag is
  // the body's acceleration with the sign reversed, sprung and published by
  // SecondaryDynamics: accelerate and the coat is left behind, which is what
  // bible 4f's "moves a beat behind the body" is.
  //
  // bendable carries the coat's own depth in metres, so dividing by the
  // 48 mm flank coat (4f, the one sourced depth we have) makes the lag land
  // at full strength on the deepest fur and nearly vanish on the 4 mm
  // muzzle. That is the right gradient: a ruff swings, a whisker pad does
  // not, and it falls out of the geometry instead of a per-region table.
  W += uCoatLag * (bendable * ${(1 / 0.048).toFixed(4)} * boost);

  // Agitation ruffles the coat out of phase with itself. It rides the
  // existing per-strand flick rather than adding a second oscillator, so an
  // agitated coat breaks up along the same axis a gust would break it up.
  W += vec3(0.0, 1.0, 0.0) *
       (bendable * boost * uAgitation * uCoatRuffle * flick);
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
             float freqScale, float shellFill, float pathK, float detail, vec3 axis,
             float hairLenScale, out vec3 site, out vec3 lockSite)
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
  lockSite = csite;             // for furLockShadow(); free, it is already here
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
  // Shell hairs stop early where hairLenScale < 1.
  //
  // On a thin coat the shells present a near-binary boundary only a few pixels
  // out from the mesh, and that step sits exactly on top of the cards' graded
  // fringe and flattens it: measured at the head, cards alone ramp over 4 px,
  // shells alone over 1, and together 2. Feathering the shells out early on
  // the head and legs lets the cards own the outline where the coat is too
  // shallow for shells to ramp on their own.
  float hairLen = uHairLenMin + (1.0 - uHairLenMin) *
                  clamp(mix(cRand, 0.25 + 0.75 * sRand * sRand, 0.58), 0.0, 1.0);
  hairLen *= hairLenScale;
  float lenFade = 1.0 - smoothstep(hairLen - 0.30, hairLen + 0.04, t);

  // Strand cross-section, tapering to a point.
  float r  = mix(uStrandRoot, uStrandTip, t * t) * (0.62 + 0.72 * sRand);
  float aa = max(px * fs * 1.6, 0.012);
  float a  = 1.0 - smoothstep(r - aa, r + aa, ds);

  // THE STRAND OCTAVE GETS ITS OWN BAND, for the same reason the micro one
  // does, and this is the waxy cheek.
  //
  // The shared octaveFade dissolves an octave between 0.13 and 0.40 cells per
  // pixel -- cells of 7.7 px down to 2.5 px. On the FACE the region freqScale
  // runs 1.3-1.6, so the strand cells are 0.58-0.72 mm, and at the portrait
  // framing one bind-space pixel is 0.25 mm: 0.38 cells per pixel, a 2.6 px
  // cell, and the shared band has already thrown 98% of the layer away. What
  // is left is the analytic mean coverage -- a smooth function of depth -- on
  // top of a clump octave whose own cells are 30 px and running at FULL
  // strength. Fine energy gone, coarse energy intact: that is the waxy,
  // blotchy cheek and nape exactly, and it is the failure mode spec.mjs's
  // fine/coarse ratio was built to name.
  //
  // 2.5 px is also simply too conservative a place to stop. Nyquist is 2 px
  // for a POINT-sampled signal, and nothing here is point-sampled: the
  // harness resolves 18 jittered TAA samples per pixel, which is what the
  // stochastic coat alpha already depends on.
  float sLod = (1.0 - smoothstep(uStrandFade.x, uStrandFade.y, px * fs)) * detail;
  float mean = clamp(3.1416 * r * r * 1.15, 0.0, 1.0);
  a = mix(mean, a, sLod);

  // ---- micro strands: only where a pixel can resolve them -----------------
  float fm = uMicroFreq * freqScale;
  // The micro layer is the cheapest thing to give up on weak hardware: it
  // only resolves at macro range and costs a full cell8 per fragment per
  // shell. Gated off on the tier that has already given up anisotropy.
  // The micro octave gets its own, more permissive band.
  //
  // The shared octaveFade cuts anything finer than ~2.5 px cells, which is
  // right for the clump and strand layers but means NO octave can ever produce
  // 1-2 px structure — so at 0.13 m the face had no resolvable strands by
  // construction, whatever the coat depth. A real guard hair is 0.05-0.08 mm,
  // which is ~2 px at that framing, so this octave is physically correct
  // rather than added detail; it is inert at every other framing because its
  // cells are far sub-pixel there, and TAA resolves it at macro.
  float mLod = (1.0 - smoothstep(0.26, 0.58, px * fm)) * detail * uMicroOn;
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
  // The undercoat fill, not the guard-hair length, is what makes the shells
  // read as opaque out to t ~ 0.55 — and it ignores hairLen entirely. On a
  // thin coat that is the binary step sitting on top of the cards' fringe, so
  // it has to be pulled in by the same per-region scale.
  // hairLenScale shortens the guard hairs so cards own the OUTLINE on thin
  // coat; it must not touch the undercoat fill, which is what covers the
  // SURFACE. Scaling the fill too removed the muzzle and brow coat entirely
  // and left pale porcelain skin at macro range.
  //
  // WHERE the undercoat stops is the coat's second silhouette, and it was a
  // smooth analytic one. a = max(a, under) means this term overwrites the
  // hair field wherever it is the larger of the two, and the Beer-Lambert
  // path factor below drives it to ~1 over the inner HALF of the coat at
  // grazing incidence — so the outline the eye actually read was the offset
  // surface where that sheet ended, not hair. Two changes: the envelope stops
  // well inside the guard hairs, and where it stops is jittered per clump and
  // per strand, so its boundary is ragged at tuft scale instead of being a
  // parallel copy of the mesh.
  float fillTop = shellFill * uFillTop *
                  (1.0 - uFillJitter + 2.0 * uFillJitter * mix(cRand, sRand, 0.42));
  float fill = 1.0 - smoothstep(fillTop * 0.38, fillTop, t);

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

  float aHair = a;                        // strand + micro, before the lock
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
  // Give the felt the lock structure too, at half strength. Without this the
  // undercoat is the one part of the coat with no hair in it at all, and
  // max(a, under) below hands it the outline wherever it is the larger term.
  under *= mix(1.0, tuft, 0.5);
  // ...and the STRANDS, shallower still.
  //
  // The lock alone is not enough. The felt had clump structure and no strand
  // structure at all, so wherever max(a, under) picked the felt the coat
  // rendered as a region of CONSTANT alpha bounded by the lock's Voronoi
  // edge: flat angular plates, the whole width of a 7.4 mm tuft, which at
  // macro_eye is ~325 px. That is the artefact the macro framing has been
  // showing -- it is neither the clump cells being wrong nor the 'deep' shell
  // early-out, it is the one layer in the coat with no hair in it winning the
  // max() over a third of the frame.
  //
  // Weaker than the lock term because the undercoat genuinely IS felt: its
  // fibres are finer, denser and more tangled than the guard hairs, so they
  // modulate it without cutting gaps in it. LOD-safe for free -- below the
  // strand layer's own resolution aHair is already its analytic mean, a
  // constant, so this term flattens to a constant scale at distance. The trap
  // that produced this artefact's ancestors -- a noise running at full
  // strength at a framing where its own cells are 40 px -- cannot happen to a
  // term that inherits its LOD from the layer it samples.
  //
  // MEASURED. A/B at macro_eye with uCardFloor identical in both arms, so the
  // felt is the only difference: shots/fur-p1/macro_eye.png (before) against
  // shots/fur-p3-nocardN/macro_eye.png (after). The plates' interiors go from
  // flat tone to fibre; their boundaries survive as a faint tonal step, which
  // is right -- a lock boundary is a real feature, it just is not a facet.
  // Both of tools/spec.mjs's macro checks were FAILING and now pass:
  //   fur reads as hair at macro: muzzle  fine 6.49 -> 7.25, share .70 -> .72
  //   macro reference carries hair detail brow fine 8.95 -> 9.80, .76 -> .77
  // and the profile contour holds at head 1.251 / body 1.427 / legs 1.635
  // against the 1.15 floor (the felt is slightly less opaque, so the body band
  // comes back from 1.769 -- still clear).
  //
  // AND THE FLOOR UNDER IT -- the 0.62 -- IS THE PETALS AT macro_eye, but
  // lowering it is a measured dead end. Do not spend another wave on it.
  //
  // ATTRIBUTION FIRST, because the handed-down diagnosis was wrong. The large
  // translucent striated petals at the macro framing were predicted to be
  // "the card's own silhouette". They are not: positive control in one page
  // session at macro_eye / 1400x900, interior fine detail over the eroded
  // coverage interior,
  //
  //     base              4.127      petals present
  //     cards hidden      4.248      petals UNCHANGED, in shape and position
  //     shells hidden     1.269      petals GONE
  //
  // and the renders agree with the numbers. The petals are the LOCK -- one
  // clump cell, 15-25 mm on the face, which is 115-190 px at that framing --
  // and what fills it is this felt term, because max(a, under) below hands
  // the felt every gap the guard hairs cut.
  //
  // So I gated the floor on sLod (correct by construction: aHair is already
  // mix(mean, a, sLod), so body range stays bit-identical) and swept it.
  // It went the WRONG WAY:
  //
  //     floor   macro_eye fine   portrait fine   profile fine
  //      0.62       4.127            4.513          1.145     shipped
  //      0.30       3.463            3.934          1.145
  //      0.10       3.310            3.652          1.145
  //      0.00       3.299            3.585          1.145
  //
  // profile was bit-identical in all four arms, so the gate works; the close
  // framings lost a fifth of their fine detail and the petals stayed, only
  // hazier. The reason is that every shell samples the SAME object-space
  // strand field, so the gaps line up through the whole coat: opening them
  // does not reveal a hair behind, it reveals the smooth skin at the bottom
  // of the stack. Reverted, and the knob with it.
  //
  // What that leaves as the live hypothesis for the petals: a lock's OUTLINE
  // is a smooth Voronoi edge ragged only by vnoise3 at 5.3x the clump
  // frequency (+/-0.08 of a cell, so +/-5-9 px against a 150 px petal). To
  // read as hair at macro it would have to be ragged at STRAND scale -- the
  // strand field is already computed right here in aHair.
  under *= mix(1.0, 0.62 + 0.38 * aHair, uFeltStrand);

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

export const FUR_LOCK = /* glsl */ `
/**
 * PER-LOCK SHADOWING: the half of a tuft facing away from the sun is behind
 * the tuft.
 *
 * furSelfShadow() above is a function of DEPTH, and depth alone cannot make
 * a coat look plush, because the layer the camera actually sees is at one
 * depth. What separates dense pile from an alpha wash at that one depth is
 * that the coat's outer surface is not smooth: it is a field of locks, each
 * a cone about 7.4 mm across, and each one is lit on the side facing the sun
 * and shaded on the side away from it. That per-tuft light-and-shade is the
 * whole visual signature of plush, and it is what a shell stack throws away.
 *
 * So: displace the optical depth by the hair's lateral offset from its own
 * lock's axis, resolved along the light.
 *
 *     above += gain * dot(p - lockSite, sunDir)     [bind space, lateral only]
 *
 * Three properties make this worth its ~10 ALU:
 *
 *  - It is ZERO MEAN over a lock. The dot product is as often positive as
 *    negative around the axis, so the coat gains contrast at tuft scale and
 *    loses no brightness. That matters here specifically: the depth term is
 *    already spending the coat's headroom against ART_DIRECTION 4b's
 *    coat-brighter-than-snow ratio, and this one spends none of it.
 *  - It is DIRECTIONAL. The pattern moves when the sun moves, which no
 *    amount of added noise does, and which is the only honest way to tell
 *    shadowing from texture.
 *  - The lattice is the one already driving the clumping, in bind space, so
 *    the shading is locked to the same tufts the alpha cuts and cannot swim
 *    against them under deformation.
 *
 * The lateral projection is not cosmetic: the raw offset to a lock site
 * carries a normal component of up to half a cell, and letting that into the
 * term would double-count the depth that furSelfShadow() already measures.
 * Only the component in the hair's own tangent plane is new information.
 */
float furLockShadow(vec3 p, vec3 lockSite, vec3 axis, vec3 sunB){
  vec3 d = p - lockSite;
  vec3 a = normalize(axis);
  d -= a * dot(d, a);
  return dot(d, normalize(sunB));
}
`;

export const FUR_SHADE = /* glsl */ `
/** Kajiya-Kay lobe about a tangent shifted along the surface normal. */
float kkLobe(vec3 T, vec3 N, vec3 H, float shift, float power){
  vec3 t = normalize(T + N * shift);
  float dotTH = dot(t, H);
  float sinTH = sqrt(max(0.0, 1.0 - dotTH * dotTH));
  return pow(sinTH, power);
}

/**
 * THE COAT SHADOWS ITSELF.
 *
 * Everything else in this file describes how much hair is at a point and
 * which way it points. Nothing described how much hair is BETWEEN that point
 * and the light -- so a hair 2 mm off the skin under 46 mm of pile received
 * the same sun as a hair standing on the outside of the ruff, and the only
 * thing separating them was a depth AO that is floored at uAOFloor and then
 * has 62% of its remainder handed back on the direct term. Measured through
 * that chain, the deepest shell in full sun receives 0.83 of the direct light
 * the tips receive. A coat whose interior is 83% as bright as its surface is
 * not a coat, it is an alpha wash, and that is the whole content of the
 * reviewer's "wide flat translucent blades": a card over sky is white on
 * blue, but a card over coat is the same colour as the coat behind it,
 * because neither of them is shadowed by anything.
 *
 * The model is Beer-Lambert through a slab, which is the standard cheap
 * stand-in for a deep opacity map and costs two exp() instead of a second
 * shadow pass over nineteen stochastic shells:
 *
 *     transmittance = exp(-sigma * pathLength)
 *
 * The "above" argument is the metres of hair lying between this fragment and the OUTER
 * surface of the coat, measured along the surface normal. It is metres, not
 * a fraction of the coat, and that distinction does the most important work
 * in the term: an 8 mm muzzle and a 47 mm flank both run t from 0 to 1, so a
 * normalised depth would bury the muzzle as deeply as the flank and turn the
 * short face coat -- the one region art direction 4f insists must stay
 * shallow -- into a dark smudge. Optical depth scales with the hair actually
 * travelled through, so the muzzle gets a sixth of the flank's.
 *
 * Two paths, because the two light sources are not the same shape:
 *
 *   .x SUN. One direction, so the path is above/cos(N,L) and gets longer the
 *      more the sun rakes across the surface. This is what gives the coat a
 *      light-dependent interior: at a 5 degree polar sun almost every
 *      surface on the animal is grazing, the path through the pile is three
 *      or four times its depth, and the inside of the coat goes properly
 *      dark while the tips stay lit. cos(N,L) is floored rather than
 *      clamped to zero: where the surface faces away from the sun the hair
 *      is behind the whole animal and the longest path is the right answer.
 *
 *   .y SKY. A hemisphere, so there is no single direction and the path is
 *      the mean secant over it -- a constant multiplier on the depth. This
 *      is the term that matters on the shaded cheek and the nape, where the
 *      sun contributes almost nothing and the ambient IS the light. Without
 *      it the change would be invisible at exactly the two framings the
 *      review names.
 */
vec2 furSelfShadow(float above, float cosL){
  float d = uCoatSigma * max(above, 0.0);
  vec2 tr = vec2(exp(-d / max(cosL, uCoatSigmaMin)), exp(-d * uCoatSigmaSky));
  // Remapped onto [floor, 1] rather than [0, 1]. Beer-Lambert through 47 mm
  // of pile really does go to zero, but our coat is a stack of stochastic
  // shells rather than a sealed medium, so wherever the dither lets the skin
  // show through a gap an exactly-zero interior renders as a black speck --
  // and art direction 2.3 forbids crushed shadows outright. The floor is a
  // multiple bounce term by another name: hair is high-albedo, so light that
  // gets in does not stop at the first strand.
  return uCoatSigmaFloor + (1.0 - uCoatSigmaFloor) * tr;
}

/**
 * The fur BRDF.
 *   N    shading normal, already bent to the per-strand cylinder
 *   T    hair direction, world
 *   V    towards the camera
 *   t    depth through the coat
 *   ao   combined occlusion
 *   rnd  per-strand random — breaks the specular into individual hairs
 *   sh   .x transmittance towards the sun · .y towards the sky dome
 */
vec3 furShade(vec3 N, vec3 T, vec3 V, float t, float ao, float rnd,
              float tipWhite, vec3 tintMul, bool cheap, float thinness, float transBoost,
              vec2 sh)
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
  // sh.x is a SHADOW, not an ambient occlusion, so it is not damped the way
  // the ao term is by mix(ao, 1.0, 0.62). That damping exists because an AO term is
  // a guess at how much of the whole environment a point can see and must
  // not be allowed to extinguish a light that demonstrably reaches it; a
  // transmittance along the actual light direction IS how much of that light
  // reaches it. Damping it would be the downstream cancellation that made
  // the existing depth AO measure flat.
  vec3 direct = sunScatter * uSunIntensity * wrapD * mix(ao, 1.0, 0.62) * sh.x * RECIPROCAL_PI;

  // ---- ambient: cool sky above, snow bounce below -------------------------
  //
  // A SURFACE DOES NOT SEE THE ZENITH. uSkyColor is bible 3's "cool zenith
  // fill", which on a polar sky is both the darkest and by far the bluest
  // part of the dome; the pale, much brighter band wrapped around a 6-degree
  // sun covers most of the cosine-weighted solid angle an upward-facing hair
  // actually integrates. Feeding the zenith swatch in as the WHOLE upward
  // irradiance is what made a white fox render as a blue-grey cloud --
  // measured differentially at the profile framing, the coat sat at r-b
  // = -50 against the snow's -14 and at 0.66x the luminance of the snow
  // it stands on, when bible 4b's own two swatch pairs put fur at
  // 1.03-1.44x its background.
  //
  // uSkyHorizon pulls the sky end of the mix toward uGroundBounce, which in
  // this scene IS that band: sunlit snow and the glow above it are the same
  // pale blue-white. No new colour enters the palette, and the term still
  // degrades correctly if the sky agent changes either swatch.
  vec3 skyDome = mix(uSkyColor, uGroundBounce, uSkyHorizon);
  float up = N.y * 0.5 + 0.5;
  vec3 amb = mix(uGroundBounce, skyDome, up);
  amb = mix(vec3(luma(amb)), amb, uAmbientSat);
  // sh.y goes here rather than into ao because ao is clamped from below
  // by uAOFloor (0.54) and the clamp is what has been holding the interior
  // flat. A floor is right for an AO heuristic and wrong for a measured
  // optical depth: 46 mm of pile really does stop almost all of the sky.
  vec3 ambient = amb * (uAmbient * RECIPROCAL_PI) * ao * sh.y;

  vec3 col = albedo * (direct + ambient);

  // ---- anisotropic specular, two shifted lobes ---------------------------
  if (uAniso > 0.5 && !cheap){
    float j  = (rnd - 0.5) * uSpecJitter;
    float s1 = kkLobe(T, N, H, uSpecShiftA + j, uSpecPowA);
    float s2 = kkLobe(T, N, H, uSpecShiftB + j * 1.7, uSpecPowB);
    s2 *= 0.35 + 0.95 * rnd;   // the secondary lobe glints hair by hair
    float vis = clamp(ndl * 2.2 + 0.30, 0.0, 1.0) * mix(0.25, 1.0, t);
    col += uSunColor * uSunIntensity * vis * ao * sh.x *
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
  float graze = pow(1.0 - ndv, uTransGraze);
  float shell = clamp(-ndl * 0.65 + 0.55, 0.0, 1.0);
  // Reference photographs (bible 4b): an arctic fox has NO warm cast, in any
  // light, including direct low sun — shaded fur goes blue-grey, never pink.
  // Light that has scattered through a deep white coat is heavily decorrelated
  // from the sun's own chromaticity, so the transmitted colour is desaturated
  // hard rather than carrying the sun's orange straight through.
  vec3 transLight = mix(vec3(luma(uSunColor)), uSunColor, uTransSat);
  col += transLight * uSunIntensity * uTransTint * albedo *
         (uTrans * transBoost * RECIPROCAL_PI * fwd * thin * (1.45 * graze)
          * mix(pow(thinness, uTransThin), 1.0, uTransFloor * graze)
          * (0.30 + 0.95 * shell));
  // NOTE on the constant-free grazing weight: thinness alone cannot tell a
  // fringe hair over sky from an outer shell over dense coat — both have the
  // same low PER-SHELL alpha. With a 0.06 interior floor, every one of the
  // ~7 outer shells added transmission over the body and they accumulated:
  // measured +15.9/255 luma over the eroded body interior against +17.7 at
  // the fringe, i.e. a flat wash rather than a halo. The floor has to be
  // exactly zero and the falloff steep, so only genuinely grazing fragments
  // glow and the interior contributes nothing to integrate.

  // A cool sky rim keeps the shadow side alive on the silhouette. Same dome
  // colour as the ambient: a grazing fragment sees the sky it reflects over
  // a wide lobe, not the zenith alone.
  // The rim is sky light too, so it takes the sky path. The transmission
  // lobe above does NOT: it is already the light that came through the coat,
  // and attenuating it by the coat again would count the same extinction
  // twice and put the halo out.
  col += skyDome * albedo * (uRim * pow(1.0 - ndv, 2.6) * mix(0.2, 1.0, t) * ao * sh.y);

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
  vShellMod = vec2(uRegionC[ri].z > 0.0 ? uRegionC[ri].z : 1.0,
                   uRegionC[ri].w > 0.0 ? uRegionC[ri].w : 1.0);
  // The sun, carried back into BIND space, for furLockShadow().
  //
  // A vector is transformed by the INVERSE of the matrix that moves points,
  // and for a rotation the inverse is the transpose -- which is what
  // v * M spells in GLSL. Skinning matrices are blends of rigid transforms
  // and are rigid to within the blend's small scale error, so this is exact
  // to the same tolerance the skinned NORMALS in this shader already assume
  // (they use sk3 directly, not its inverse transpose). Doing it per vertex
  // costs one mat3 multiply where a fragment-side inverse would cost ~30
  // ALU per fragment per shell.
  vSunB = uSunDir * (m3 * sk3);
  vWPos = wp.xyz;
  vNrm  = wn;
  vTan  = normalize(wh * max(L, 1e-4) + 2.0 * t * W);
  vP0   = vec4(t, rb.z, aFurAO, ra.x * furSkinMask2(position).y);
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
${FUR_LOCK}
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
  //
  // MINOR axis of the screen-space Jacobian, not its length. fwidth() measures
  // the footprint ALONG THE SURFACE, which diverges at grazing incidence: at
  // the silhouette one pixel covers centimetres of skin, so every octaveFade()
  // in the hair field returned 0 and a = mix(mean, a, sLod) replaced the
  // strands with their analytic mean coverage — pi*r*r — a smooth function of
  // depth alone. The clump tuft term collapsed to 1.0 for the same reason.
  // The shells' outline was therefore an offset surface with no hair in it:
  // measured on a coat-alpha coverage pass, the shells alone rendered the
  // silhouette as a graded smear (the user's "milky translucent sheet with
  // hair streaks"), while the cards alone rendered individual hairs.
  //
  // The hair field is a VOLUME, so the filter width that matters is the
  // pixel's own size, not the surface's foreshortening of it. The minor axis
  // is that size: identical face-on, and it no longer blows up edge-on.
  vec3  ddx = dFdx(vRoot), ddy = dFdy(vRoot);
  float px = max(min(length(ddx), length(ddy)), 1e-7);
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
  // Band-pass the dither by its ON-SCREEN cell size.
  //
  // octaveFade alone only kills an octave as it goes sub-pixel, which had the
  // gating exactly backwards here: at the macro framing the dither cells are
  // ~38 px and it ran at FULL strength (the pale angular patches over the
  // muzzle), while at profile the cells are ~2 px and it was faded fully OFF,
  // which is precisely where it earns its keep breaking shell contours. It is
  // only useful while its cells are roughly 1.5-8 px.
  float jf = 680.0;
  float jScale = px * jf;
  float ditherW = smoothstep(0.09, 0.16, jScale) * (1.0 - smoothstep(0.55, 0.95, jScale));
  float tJ = clamp(t + (vnoise3(vRoot * jf) - 0.5) * uShellJitter
                       * ditherW / max(uShellCount, 1.0), 0.0, 1.0);

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

  float pathK = clamp(1.0 / max(abs(dot(normalize(vNrm), V)), 0.16), 1.0, uPathKMax);

  // Shells this deep are solid felt and almost entirely hidden behind the coat
  // above them. Neither the strand/micro/clump field nor the specular and
  // transmission lobes can change what you see, so skip all of it.
  bool deep = tJ < shellFill * uShellDeep;

  vec3 site = vRoot;
  // Seeded to vRoot so the 'deep' cheap path, which never calls furHair,
  // produces a zero lateral offset and therefore no lock term rather than
  // reading an undefined vec3. Those shells are solid felt under the whole
  // coat; there is nothing for a tuft highlight to sit on.
  vec3 lockSite = vRoot;
  // The cheap path still has to honour the COVERAGE mask. furHair applies
  // vP0.w (region density x the eye/nose coverage mask) as its last step, and
  // this branch skipped it entirely -- so the innermost shells drew at alpha
  // 1.0 over the rhinarium and inside the eye clearance, which is exactly the
  // failure the mask was added to stop ("zeroing the coat LENGTH is not enough
  // on its own": the shells collapse onto the skin and keep drawing). Visible
  // at macro_eye as a cuff of opaque undercoat lapping over the iris.
  vec4 hair = vec4(clamp(vP0.w * uDensity, 0.0, 1.0), 0.45, hash13(vRoot * 131.7), 1.0);
  if (!deep) hair = furHair(vRoot, tJ, px, vP0.w, vP1.x, vP1.y, shellFill, pathK, detail,
                              normalize(vAxis), vShellMod.x, site, lockSite);
  alpha = hair.x;
  if (alpha < 0.004) discard;

  rnd = hair.z;
  ao *= hair.w;


  // Per-strand cylinder normal. Without this every hair in a tuft shades
  // identically and the macro shot turns to mush.
  // Same band as the strand layer in furHair -- the cylinder normal is that
  // layer's shading and must not outlive the coverage it shades.
  float sLod = (1.0 - smoothstep(uStrandFade.x, uStrandFade.y, px * uStrandFreq * vP1.y))
               * detail * (deep ? 0.0 : 1.0);
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

  // Coat lying between this shell and the outside, in METRES: the local coat
  // depth times the fraction of it still above us. tJ, not t, so the hair-
  // scale shell dither carries into the shadow -- that jitter is already a
  // stable object-space noise at 680 cycles/m (1.5 mm, hair scale), and
  // riding the optical depth on it is what makes the term read as individual
  // hairs shadowing each other rather than as a smooth vignette through the
  // stack. It was previously only modulating an AO that the floor had
  // flattened, so it cost ALU and showed nothing.
  float above = vP1.w * (1.0 - tJ)
              + uCoatLock * furLockShadow(vRoot, lockSite, vAxis, vSunB);
  vec2 sh = furSelfShadow(above, dot(normalize(vNrm), uSunDir));
` : /* glsl */ `
  // Base layer: skin under the coat — dark, occluded, faintly cool.
  ao = max(ao * mix(uAOInner, 1.0, 0.58), uAOFloor);
  // The skin has the WHOLE coat above it, so the above argument is the full local depth.
  // On the flank that is 47 mm and the skin goes nearly black, which is
  // correct and invisible (the coat above it is opaque); on the rhinarium the
  // coat is 1.6 mm and the term is almost exactly 1, which is why this is
  // safe to apply to the base pass at all. A NORMALISED depth here would have
  // blacked out the nose and the pads.
  vec2 sh = furSelfShadow(vP1.w, dot(normalize(vNrm), uSunDir));
  #ifdef USE_COLOR
    // Pad leather and the nose come through the vertex colour. Under a dense
    // paw coat almost none of it should read, or the fox grows teddy-bear feet.
    tint = mix(vec3(1.0), vColor, vP0.y);
  #endif
`}

  vec3 col = furShade(N, T, V, t, ao, rnd, vP1.z, tint,
                      ${isShell ? 'deep' : 'false'}, ${isShell ? '1.0 - clamp(alpha, 0.0, 1.0)' : '0.0'},
                      vShellMod.y, sh);

${isShell ? /* glsl */ `
  // Stochastic cut-out. The threshold is hashed in OBJECT space, so it is
  // temporally stable with or without TAA; interleaved-gradient screen noise is
  // blended in only when a TAA resolve is actually running.
  if (uStochastic > 0.001){
    // BOTH terms must vary per accumulated sample. The object-space hash is
    // what keeps the dither stable when nothing is resolving it, but while TAA
    // is accumulating a term that never changes contributes no new coverage
    // estimate — the resolve just re-averages the same pattern and converges
    // on the mesh edge. Offsetting both by the sample index turns N samples
    // into N independent estimates of the same partial coverage.
    float d = mix(hash13(site * 91.7 + t * 3.1 + uFrameSeed * 7.77),
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
${FUR_LOCK}

uniform float uCardWidth;
uniform float uCardLength;
uniform float uCardFloor;   // PEAK guard-hair stand-off past the coat, metres
uniform float uCardFloorLow; // what the shortest lock gets, as a fraction of it
uniform float uCardJitter;
uniform float uCardClump;
uniform float uCardCurve;   // 0 = the straight-ish original shape, 1 = hooked
uniform float uCardDroop;   // extra gravity for GUARD HAIR only
uniform float uCardDroopSym; // 1 = sag may not change perpendicular reach
uniform float uCardInteriorLen;  // card length multiplier AWAY from the outline
uniform vec2  uCardEdgeLen;      // vEdge band the multiplier ramps out over
uniform float uCardIntMix[${REGION_COUNT}];  // per-region share of it, 0 = exempt

attribute float furLength;
attribute float furStiffness;
attribute vec3  furTangent;
attribute float region;
attribute float aFurAO;
attribute vec4  aCard;   // x v along card · y side -1/+1 · z rand · w lengthMul
attribute vec4  aClump;  // xyz bind-space lock site · w lock random
${COATLEN_FN}
${DYNAMICS_FN}

varying vec4  vCard;     // x across 0..1 · y along 0..1 · z rand · w innerFloor
varying float vEdge;     // silhouette weight

void main(){
  int  ri = int(clamp(region, 0.0, ${REGION_COUNT - 1}.0) + 0.5);
  vec4 ra = uRegionA[ri];
  vec4 rb = uRegionB[ri];

  float v    = aCard.x;
  float side = aCard.y;
  float rnd  = aCard.z;
  float lrnd = aClump.w;            // shared by every card in this lock
  float soft = 1.0 - furStiffness;
  vec4  rc   = uRegionC[ri];

  // --- the guard-hair stand-off -------------------------------------------
  //
  // Card length used to be strictly PROPORTIONAL to the local coat, so the
  // amount a card tip stands past the outermost shell was ~10% of the coat
  // depth -- and on a 4 mm muzzle coat that is 0.4 mm, which at the profile
  // framing is a third of a pixel. Measured on the true coverage matte: with
  // the shells hidden the cards alone break the profile contour on all three
  // bands (head/body/legs p10 1.249 / 2.049 / 1.402 against a 1.15 floor);
  // with the shells back, the same cards are buried and the contour collapses
  // to 1.000 / 1.073 / 1.000. A proportional reach scales the fringe to
  // nothing exactly where the coat is shallowest, which is exactly where the
  // mesh edge is showing through.
  //
  // So the reach RATIO is kept for deep coat -- that is where the 1.10-1.25
  // band was validated and where the urchin lives -- and becomes an ABSOLUTE
  // stand-off in metres wherever the ratio cannot deliver one. That is also
  // the animal: a fox's guard hairs over the muzzle, brow and cannon are not
  // proportionally shorter than the ones over its flank, they stand out of a
  // much shallower undercoat.
  //
  // The stand-off tops the card up only when the proportional reach it already has
  // -- reachBand[0] - 1 of the coat, read from the band itself so the two
  // cannot drift -- falls short of uCardFloor. Where the coat is deep enough
  // that it does not, stand is exactly 0 and nothing changes.
  //
  // It is gated on furSkinMask2().x, the same LENGTH mask the coat uses, so a
  // floor cannot regrow hair on the rhinarium or across the eye parting.
  //
  // uCardFloor is the PEAK stand-off, not a constant one, and that correction
  // is the whole of "the hairs are uniform frizzy needles". The cap it lives
  // under -- standFloorMax, 0.25 x the 48 mm flank coat -- is reachBand's
  // CEILING, i.e. what the proportional rule grants its LONGEST card; the mean
  // card is granted reachBand's middle, about 0.17. A constant floor therefore
  // handed every lock in the coat the allowance meant for the longest one, so
  // every card tip cleared the shells by the same few millimetres and the coat
  // resolved as a halo of equal-length needles. Attributed in one page session
  // at the profile framing: hiding the cards leaves a smooth blob with a
  // granular rim and no needles at all; setting uCardFloor to 0 removes them
  // too and leaves a dense fuzz. The needles are card tips, and their
  // uniformity is this term's.
  //
  // Each LOCK can draw its own share of that peak, and at uCardFloorLow 1.0 --
  // the shipping value -- it draws all of it, so this is the constant floor.
  // THE DRAW IS OFF ON MEASURED EVIDENCE, NOT BY OVERSIGHT: three settings of
  // it, including one whose mean stand-off was identical to the constant's,
  // each cost silhouette checks in tools/spec.mjs, and two of the three did it
  // by tripping spec's blindness control and DELETING checks rather than
  // failing them. The numbers are in FUR_DEFAULTS next to cardFloorLow. Read
  // them before turning this on.
  //
  // Per LOCK, not per card: lrnd is aClump.w, shared by every card on a Worley
  // site, so a lock is long or short as a unit. Drawing this per card would
  // make neighbouring hairs disagree, which is the anti-clump that
  // CARD_SHAPE.clumpCell exists to undo.
  float coat  = furCoatLength(position, ra.y);
  float fw    = sqrt(hash11(lrnd * 61.7 + 4.3));   // mean 2/3, weighted long
  // PER-REGION, because an absolute floor applied globally is what makes the
  // hair the same length everywhere. See CARD_FLOOR_SCALE in FurMaterial.
  float stand = max(0.0, uCardFloor * uCardFloorScale[ri]
                         * (uCardFloorLow + (1.0 - uCardFloorLow) * fw)
                         * furSkinMask2(position).x
                         - coat * ${(CARD_SHAPE.reachBand[0] - 1).toFixed(3)});
  float L    = (coat + stand) * rc.x * uCardLength * aCard.w;

  vec3  nb   = normalize(normal);
  vec3  tb   = furTangent;

  /* ------------------------------------------------- INTERIOR vs OUTLINE --
   *
   * The review's headline look defect -- "long combed hair, not a dense pile,
   * ON THE INTERIOR of the body" -- and the outline requirement that every
   * previous attempt to shorten a card ran into are the SAME knob only
   * because card length was a single number for both. They are not the same
   * place in the image.
   *
   * For a smooth closed surface the silhouette is exactly where N.V = 0, so
   * vEdge (1 - |dot(N, V)|) is 1 on the contour and 0 on a flank facing the
   * camera. 250d67e measured that and read it as a defect ("uCardTipEdge is a
   * no-op on a body seen side-on"); it is also the clean discriminator this
   * needs. Cards that can put hair over sky are the high-vEdge ones -- on a
   * cylinder of radius R a card at angle phi from the front is rooted
   * R(1-cos phi) inside the outline and reaches L cos phi out of it, so it
   * only reaches the contour while cos phi > R/(R+L), which for the body's
   * 150 px radius against a 30 px card is vEdge > ~0.44. Below that a card
   * cannot be on the outline at any framing, and its whole length is drawn
   * over coat.
   *
   * So the length multiplier ramps OUT over uCardEdgeLen and is 1.0 by the
   * time a card can reach the contour. Silhouette reach is untouched by
   * construction, which is also why reachReport()'s band still bounds the
   * right quantity -- see the interiorLen note there.
   *
   * It is evaluated at the card's ROOT, not per vertex: a card must not bend
   * along its own length because its tip leans toward the outline.
   */
  mat4 sk  = furSkinMatrix();
  mat3 sk3 = mat3(sk);
  mat3 m3  = mat3(modelMatrix);
  vec3 rootO  = (sk * vec4(position, 1.0)).xyz;
  vec3 rootW  = (modelMatrix * vec4(rootO, 1.0)).xyz;
  vec3 wn     = normalize(m3 * normalize(sk3 * nb));
  float edgeRoot = 1.0 - abs(dot(wn, normalize(cameraPosition - rootW)));
  float ew    = smoothstep(uCardEdgeLen.x, uCardEdgeLen.y, edgeRoot);
  // Per region, because one global number for this is the mechanism behind
  // "length and direction are identical on the shoulder, flank, haunch, cheek
  // and muzzle". A mix above 1 extrapolates -- that is deliberate, it is how
  // the muzzle gets a SHORTER interior coat than the skull -- so it is
  // floored. 0 exempts a region entirely; flat plates need that, because on a
  // plate seen face-on vEdge is low over the RIM as well as the middle.
  float iLen  = max(0.12, mix(1.0, uCardInteriorLen, uCardIntMix[ri]));
  L *= mix(iLen, 1.0, ew);

  // Fan each LOCK off the flow direction. Without this every card on the
  // dorsal line sweeps back on exactly the same heading and the topline reads
  // as a combed mane rather than as separate locks.
  //
  // The angle is the LOCK's, not the card's. Per-card it was an anti-clump:
  // neighbouring hairs pointed up to uCardJitter radians apart, which is
  // exactly how you make a coat read as separate needles rather than as
  // tufts. Same spread between locks, none inside one.
  float ja = (lrnd - 0.5) * uCardJitter;
  tb = normalize(tb * cos(ja) + cross(nb, tb) * sin(ja));

  // Cards fold over harder than the shells do — a tuft standing perpendicular
  // to the skin is a quill, not a hair. But the rise term is also what decides how
  // far a card reaches ALONG THE NORMAL, and if that lands short of the
  // outermost shell the cards are buried inside the coat and contribute
  // nothing to the outline. uCardLength is sized so the mean tip clears the
  // shells by ~25% and the longest by ~2x.
  float lay  = uLay * ra.z * (0.55 + 1.25 * soft) * (1.10 + 0.85 * hash11(lrnd * 37.1));
  float rise = ${CARD_SHAPE.rise};
  /*
   * THE HAIR'S OWN SHAPE, and the one property of it that matters here is
   * that BOTH terms are 1.0 at v = 1, so uCardCurve moves the tip by zero.
   * See FUR_DEFAULTS.cardCurve: the silhouette metrics are 10th percentiles
   * of the outermost coverage, so a shape that holds the tip cannot lower
   * one, and that is the whole reason the curvature goes here and not into
   * more lay (which shortens perpendicular reach) or into a length draw
   * (which f88f36e measured costing 0.16 of body p10).
   *
   * vn front-loads the climb out of the skin; vt delays the comb-over into
   * the outer third. A hair that leaves the skin steeply and then hooks is
   * what a guard hair does and what a radial needle does not.
   */
  float vn = mix(v, pow(max(v, 1e-4), 0.70), uCardCurve);
  float vt = mix(v * (0.42 + 0.58 * v), v * v * (1.32 - 0.32 * v), uCardCurve);
  vec3  offB = nb * (L * vn * rise) + tb * (L * lay * vt);
  // How much pile is still above this point on the card, in metres. The
  // card's own perpendicular climb is L*vn*rise; the coat's outer surface is
  // at the local coat depth. A tip that has cleared the shells gets 0 and is fully lit,
  // which is the whole shape of a guard hair: dark where it leaves the
  // undercoat, bright where it stands out of it.
  // The shading tangent is the derivative of that curve, not the chord, or
  // the Kajiya-Kay lobe travels along a hair the geometry is not drawing.
  float dn = mix(1.0, 0.70 * pow(max(v, 0.08), -0.30), uCardCurve);
  float dt = mix(0.42 + 1.16 * v, 2.64 * v - 0.96 * v * v, uCardCurve);
  vec3  hdir = normalize(nb * (rise * dn) + tb * (lay * dt));

  // --- the lock ------------------------------------------------------------
  // Lean the tip toward the lock's own site. This is what gives a tuft MASS:
  // the several cards sharing a site stop being parallel neighbours and become
  // one gathered bundle with a waist and a tip, which is what an arctic fox's
  // winter coat separates into.
  //
  // Only the LATERAL component is used. The site is a point in space near the
  // surface, so the raw offset carries a normal component of up to half a cell
  // — following it would drive tips into the skin on one side and lift them
  // off it on the other, and across a thin plate like the ear pinna the cards
  // on the far face would converge THROUGH it. Projected onto each card's own
  // tangent plane, the pull can only ever comb sideways.
  vec3 toSite = aClump.xyz - position;
  toSite -= nb * dot(toSite, nb);
  float sl = length(toSite);
  // A card at a cell corner is ~0.87 cells from its site; cap the lever so a
  // handful of outliers cannot swing further than the lock is wide.
  float slMax = ${(CARD_SHAPE.clumpCell * 0.6).toFixed(5)};
  if (sl > slMax) toSite *= slMax / sl;
  offB += toSite * (uCardClump * v * v);

  // Per-vertex, and at this vertex's own point along the card rather than at
  // the root: uCardClump leans a tip toward its lock site, so the lateral
  // offset shrinks along the hair and the tuft highlight tapers with it.
  // aClump.xyz IS the bind-space lock site the cards were snapped to, so the
  // cards and the shells are shaded by the SAME lattice and cannot disagree
  // about where a tuft is.
  float aboveCoat = max(0.0, coat - L * vn * rise
        + uCoatLock * furLockShadow(position + offB, aClump.xyz, hdir, uSunDir * (m3 * sk3)));

  // sk / sk3 / m3 / rootO / rootW / wn are already computed above, for the
  // interior-vs-outline split; they are the same quantities.
  vec3 posO  = (sk * vec4(position + offB, 1.0)).xyz;
  vec3 hO    = normalize(sk3 * hdir);

  vec4 wp = modelMatrix * vec4(posO, 1.0);
  vec3 wh = normalize(m3 * hO);
  // Wind phase is the LOCK's: a tuft is a bundle of hairs that have matted
  // together, so it swings as one body. Per-card phase shears the bundle
  // apart on every gust and undoes the clumping in motion.
  float bendable = L * (0.30 + 1.0 * soft);
  vec3 W = furDynamics(rootW, bendable, lrnd, ${CARD_SHAPE.droopBoost});
  // Gravity for GUARD HAIR ONLY. furDynamics scales gravity, wind, gust and
  // the body's lag by one boost, so raising that to get a hair to hang also
  // makes it flap; and uDroop is shared with the shells, whose hair is
  // undercoat and does not hang. This term is the one the critic's "no
  // gravity" is about, and it is the only one of the three that is purely
  // vertical -- which is why it is nearly free on row-scan silhouette
  // metrics. It rides v*v with the rest of W: a cantilever pinned at the
  // root, so the sag is all in the outer half.
  //
  // AND IT MAY NOT LENGTHEN THE HAIR. A hair that hangs does not also reach
  // further from the skin, and reachReport's droop clause exists because a
  // term that let it once did -- it is where the "Afghan skirt" came from.
  // Adding this sag raw took the belly (region 15, the shallowest trunk coat
  // at 22.2 mm) from 1.228 to 1.903 x its own coat against a 1.3125 ceiling.
  // Projecting out the OUTWARD-normal component makes gravity a rotation of
  // the hair rather than an extension of it: it can comb a flank hair down
  // and pull a dorsal hair toward the back, and on a surface already facing
  // straight down it does nothing, because there the hair is already hanging.
  // So the clause is satisfied by construction instead of by a wider cap.
  //
  // AND IT MAY NOT SHORTEN IT EITHER, which the max() above did not say.
  // The clamp removes the sag's normal component only where that component
  // points OUT of the surface. On an UPWARD-facing surface it points IN, so
  // the whole of it survived and gravity subtracted perpendicular reach --
  // and the topline is the one place on the animal where the surface faces
  // up. Arithmetic on the dorsal band, region 13, soft 0.14 and lay 1.20:
  // rise puts the tip 0.95 L along the normal, this sag pulled it back
  // 0.55 L * (0.30 + soft) and furDynamics another 0.26 * 0.40 L of the same,
  // so the back kept 43-55% of the reach the flank got from the identical
  // card. That is measured on the coverage matte, not reasoned: see
  // uCardDroopSym in FUR_DEFAULTS for the before/after.
  //
  // Removing the component in BOTH directions is what the paragraph above
  // already claims this line does -- gravity becomes a pure comb in the
  // tangent plane, which can still hang a flank hair and pull a dorsal hair
  // caudally, and can no longer change how far any hair stands off its skin.
  // reachReport's clause is strengthened by it, not weakened: with the
  // symmetric projection the sag cannot move perpendicular reach at all.
  // BOTH gravity terms are projected, not just this one. furDynamics already
  // put uGravity * uDroop * bendable * droopBoost into W, and that copy is
  // subject to exactly the same objection -- on the topline it is another
  // pull straight into the skin. It is reconstructed here rather than
  // returned separately because furDynamics is shared with the shells, whose
  // gravity is the undercoat's and is not a stand-off question.
  vec3 cardSag = uGravity * (uCardDroop * bendable);
  vec3 dynGrav = uGravity * (uDroop * bendable * ${CARD_SHAPE.droopBoost});
  float nOld = max(0.0, dot(cardSag, wn));            // the old asymmetric clamp
  float nNew = dot(cardSag + dynGrav, wn);            // all of it, both signs
  W += cardSag - wn * mix(nOld, nNew, uCardDroopSym);
  wp.xyz += W * (v * v);
  vec3 hairW = normalize(wh * max(L, 1e-4) + 2.0 * v * W);

  vec3 toCam = normalize(cameraPosition - wp.xyz);
  vec3 B = cross(hairW, toCam);
  float bl = length(B);
  B = bl > 1e-5 ? B / bl : normalize(cross(hairW, vec3(0.0, 1.0, 0.0)));

  // Minimum hair WIDTH, in metres, not a fraction of the coat.
  //
  // Card width scaled purely with coat thickness left ear hairs 1.3 mm wide —
  // 0.9 px at the silhouette framing. TAA's neighbourhood clamp erases
  // sub-pixel high-contrast detail, so those hairs were being drawn and then
  // thrown away downstream, which is why the flank (7.5 px hairs) broke up
  // beautifully while the ears stayed a hard mesh curve. The floor keeps thin-
  // coat regions above the clamp's reach; thick-coat regions never hit it.
  float w = uCardWidth * clamp(furLength * uCoatScale, 0.0045, 0.06)
          * (0.55 + 0.9 * rnd) * pow(max(1.0 - v, 0.0), 0.5);
  wp.xyz += B * (side * w);

  vRoot = position;
  vAxis = hdir;
  // .x carries the SHELL coat depth to the card fragment shader, not the
  // card's own length. They are different numbers and the difference is the
  // point: uCardInteriorLen is 0.30, so a card away from the outline is 30%
  // of its full length and therefore sits *deeper inside the surrounding
  // pile* than a silhouette card of the same v. Shadowing a card by its own
  // length would make the buried ones the brightest thing in the coat, which
  // is roughly what they are now. (.x is the shell hair-length scale on the
  // shell path and has always been a hardcoded 1.0 here.)
  vShellMod = vec2(coat, uRegionC[ri].w > 0.0 ? uRegionC[ri].w : 1.0);
  vSunB = uSunDir * (m3 * sk3);   // see the shell path
  vWPos = wp.xyz;
  vNrm  = wn;
  vTan  = hairW;
  /*
   * CARDS MUST NOT CROSS THE CORNEA.
   *
   * The vibrissae are guarded by a sphere plus a sight cone; the cards were
   * guarded by neither. They read furSkinMask2 at their ROOT only, so a
   * card rooted outside the parting could still be combed across the eye by
   * lay, by the lock pull, or by a long lenMul draw -- and at macro_eye
   * one does, as a 2 px white scratch over the iris. Aperture area barely
   * notices it (0.4% of the aperture) and the eye is ruined anyway: the iris
   * is the one place on this animal where a single hair is legible.
   *
   * position + offB IS this vertex's own bind-space point along the card,
   * so evaluating the mask there tests the whole card, not its root, and does
   * it per vertex: the length that lies over the eye fades and the rest of
   * the card is untouched. It reuses the eye slot, so the guard volume is the
   * eyeball plus its lid margin by construction and cannot drift away from
   * the parting the shells use.
   *
   * Not covered: the world-space wind/gravity term W, which is applied after
   * skinning and is a few mm. Blowing a hair INTO a socket is not a thing the
   * wind does here, and testing it would need the mask in world space.
   */
  float rootMask = furSkinMask2(position).y;
  float tipMask  = furSkinMask2(position + offB).y;
  // .y is the base pass's vertex-colour weight and has never been read on the
  // card path; it carries the metres of coat above this vertex instead.
  vP0   = vec4(v, aboveCoat, aFurAO, ra.x * mix(rootMask, min(rootMask, tipMask), uCardEyeGuard));
  vP1   = vec4(rb.x, rb.y, ra.w, L);
  vCard = vec4(side * 0.5 + 0.5, v, rnd, rc.y);
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
${FUR_LOCK}
${FUR_SHADE}

uniform float uCardInner;
uniform float uCardTipEdge;    // vEdge exponent at a card's TIP; see below
uniform float uCardOpacity;
uniform float uCardCut;         // alpha below which a card fragment is discarded
uniform float uCardHairs;      // hairs per card, x the authored 2-5; see below
uniform float uCardHairAlign;  // 1 = the hair lattice lands on the card's edges
uniform float uCardRootRag;    // per-hair root fade depth; 0 = one straight spine
uniform float uCardDuty;       // share of a card's AREA that is hair; see below
uniform float uCardDutyMax;    // ceiling on one hair's half-width in its cell
uniform float uCardHairLen;    // shortest per-hair length, in card lengths
uniform float uCardHairFade;   // per-hair tip ramp, in card lengths

varying vec4  vCard;
varying float vEdge;

void main(){
  float v   = vCard.y;
  float rnd = vCard.z;

  // Several hairs per card, each with its own radius, length and phase.
  //
  // uCardHairs multiplies that count. It is the one way to raise the number of
  // HAIRS on this animal without raising the number of CARDS: the geometry,
  // the draw call and the covered area are all identical, only the width of
  // the per-hair cell inside a card changes. That matters because the card
  // budget is now a performance budget (16.63 ms against 16.7 at the high
  // tier), so
  // more cards is not available and more hairs is free.
  float nRaw = uCardHairs * (2.0 + floor(rnd * 3.99));
  /*
   * THE CARD'S TWO LONG SIDES ARE THE CHEVRONS, and this is why they are
   * hard. Review blocker 6: "right-angled brackets / staples at macro_eye".
   * The postfx agent attributed them in one session -- hiding cardMesh
   * removes every bracket, hiding shellMesh leaves the brackets as the whole
   * image -- and this file's own comment above already said the cards "read
   * as flat bright ribbons with hard rectangular ends, a card SHAPE and card
   * ALPHA problem".
   *
   * It is the ALPHA, and specifically the hair lattice's phase. n is
   * uCardHairs x an integer, so at the shipping 2.4 it is 4.8 / 7.2 / 9.6 /
   * 12, and the lattice was then shifted by rnd * 7.31. Neither lands on the
   * card's edge, so the outermost hair is CUT by the geometry at vCard.x = 0
   * and 1 -- a full-opacity hair ending exactly on the quad boundary, which
   * is a perfectly straight hard alpha step running the whole length of the
   * card. Two of those plus the 3-segment polyline's kink is a bracket.
   *
   * Round n and drop the phase, and the lattice starts and ends on the card's
   * own edges: at vCard.x = 0 and 1, fr = 0, d = 1, and since rad <= 0.6 the
   * alpha there is 0 by construction. The card's silhouette becomes the
   * outermost HAIR's silhouette instead of the quad's. Per-hair radius,
   * length and shading still key off rnd and fi, so nothing about the
   * variation between cards is lost -- only the phase, which was never
   * visible except as this edge.
   */
  float n  = mix(nRaw, max(1.0, floor(nRaw + 0.5)), uCardHairAlign);
  float s  = vCard.x * n + rnd * 7.31 * (1.0 - uCardHairAlign);
  float fi = floor(s);
  float fr = fract(s);
  float hr = hash11(fi * 1.7 + rnd * 31.0);

  float d   = abs(fr - 0.5) * 2.0;
  /*
   * THE HAIR LATTICE'S DUTY CYCLE, and it is the only term in this shader
   * that can change how MUCH hair a card draws.
   *
   * d is a triangle wave over each hair cell and rad is the half-width
   * the hair occupies in it, so the fraction of the card's area that is hair
   * is exactly E[rad] -- INDEPENDENT OF uCardHairs. Raising the hair count
   * subdivides the same covered area into more, finer strands; it cannot add
   * any. That is why uCardHairs 2.4 -> 5.0 moved macro detail and the contour
   * and left the fringe's fill where it was. See FUR_DEFAULTS.cardDuty.
   *
   * AND IT HAS A CEILING FOR A STRUCTURAL REASON, not a taste one. d runs
   * 0..1 across a hair cell, so rad >= 1 means the hair FILLS its cell: the
   * gap to its neighbour closes, adjacent hairs merge, and the card becomes
   * one opaque plate with straight sides. That also silently voids
   * uCardHairAlign's guarantee -- its note above reasons "since rad <= 0.6
   * the alpha there is 0 by construction", and the construction is what keeps
   * the card's own quad boundary from being a hard alpha step.
   *
   * At uCardDuty 0.85 the raw draw is 0.425 .. 1.275 and 32% of hairs are
   * over 1.0, which is what turned the macro_eye cards from combs into large
   * straight-edged petals. uCardDutyMax caps it so every hair keeps a gap and
   * alpha is still 0 at vCard.x 0 and 1. It costs ~6% of the mean duty.
   */
  float rad = min(uCardDuty * (0.50 + 1.00 * hr), uCardDutyMax);
  float aa  = clamp(fwidth(s) * 1.6, 0.02, 1.2);
  float a   = 1.0 - smoothstep(rad - aa, rad + aa, d);

  /*
   * PER-HAIR LENGTH, and it is the depth of the coat's OUTER BAND.
   *
   * This was 0.42 + 0.58 * hash with a fixed 0.30 fade: every hair in a
   * card ended somewhere between 42% and 100% of the card's length, so at
   * v = 0.9 only the ~17% of hairs whose draw came up long were still being
   * drawn. A card's outer half is therefore a SPRAY, not a tuft -- which is
   * what the 62 px deep, 24% filled fringe band at portrait is made of. See
   * FUR_DEFAULTS.cardHairLen for the measurement and the derivation.
   *
   * uCardHairFade is the ramp, in card lengths. It cannot be zero -- a hard
   * end on every hair at once is the straight tip edge this term exists to
   * break -- but it does not have to be 0.30 of the card either.
   */
  float hlen = uCardHairLen + (1.0 - uCardHairLen) * hash11(fi * 3.3 + rnd * 11.0);
  float tipFade = 1.0 - smoothstep(hlen - uCardHairFade, hlen, v);
  a *= tipFade;
  /*
   * THE CARD'S ROOT EDGE IS THE SPINE OF THE STAPLE.
   *
   * This was a constant smoothstep(0.0, 0.12, v): every hair in the card
   * started at the same v, so the card's root end was one straight line
   * across its whole width, ramping over 12% of the card. At macro_eye a
   * card is 100-270 px wide and that line is the crossbar the parallel hairs
   * hang off -- which is the shape review blocker 6 calls a staple. Rendered
   * with the shells hidden, the isolated cards at that framing are combs:
   * parallel bars on a straight spine.
   *
   * Per hair, and deeper. The spine becomes a ragged edge rather than a
   * line, and the ramp is long enough that no single hair contributes a hard
   * step. It cannot cost the outline -- this is the end of the card BURIED
   * in the shells, and the tip is untouched.
   */
  float hroot = max(0.02, uCardRootRag * (0.35 + 0.65 * hash11(fi * 5.7 + rnd * 17.0)));
  a *= smoothstep(0.0, hroot, v);

  // Sub-pixel cards dissolve to their mean instead of flickering.
  //
  // NOT A LEVER ON THE PIXEL LATTICE, measured: a bias on fwidth(s) here that
  // pulls the dissolve 1.6x, 2.5x and 4x earlier moved the animal's coverage
  // at the profile framing by 15 px in 410 393, and the interior contrast by
  // 0.003.
  // fwidth(s) along the lower contour is already far below 0.30, so this term
  // is not running there at all. See FUR_DEFAULTS.cardCut for what is.
  float lod = 1.0 - smoothstep(0.30, 0.85, fwidth(s));
  a = mix(clamp(rad * 0.70, 0.0, 1.0) * tipFade * smoothstep(0.0, 0.12, v), a, lod);

  // Strongest exactly where the surface turns away — the silhouette.
  // Interior opacity floor, per region.
  //
  // vEdge is 1 - |dot(surfaceNormal, view)|, so it is LOW wherever we are
  // looking at a surface face-on — which on a flat plate like the ear pinna is
  // almost everywhere, including the rim we need broken up. The global floor
  // of 0.17 therefore hides the ear fringe at exactly the framing that scans
  // it. Flat, thin parts get their own higher floor.
  //
  // Gate the card's ROOT, not its TIP. vEdge is 1 - |dot(surfaceNormal, view)|,
  // so on a flat plate seen face-on — the ear pinna at every head-on framing —
  // it is low over the whole plate INCLUDING the rim, and the gate was hiding
  // exactly the fringe that has to break that outline. Measured on a coverage
  // pass, the frontal ear silhouette was a bare, facetted mesh triangle.
  //
  // The fix is not a higher floor. That was tried, it makes cards ~70% opaque
  // face-on, and it lays a solid mat over the pinna which reads HARDER than
  // the shells did. Instead, soften the falloff toward the tip: a card's root
  // is buried in the shells and contributes nothing but cost, while its tip is
  // the only part that can ever be over sky.
  float innerFloor = max(uCardInner, vCard.w);
  float tipOut = smoothstep(uCardTip, 1.0, v);
  //
  // uCardTipEdge is that softened tip exponent, and it is the one number that
  // decides how much card is visible over the INTERIOR of the animal. At the
  // outline vEdge -> 1 and pow(1, anything) == 1, so raising it cannot cost a
  // single pixel of silhouette; it can only fade the tips that stand over
  // coat. At 0.60 a tip was 38% opaque on a face-on surface (vEdge ~ 0.2),
  // which at the nape framing is a field of separate needles off the neck --
  // hiding the cards there removes every one of them and leaves the shells'
  // smooth granular surface.
  float edge = mix(innerFloor, 1.0,
                   pow(clamp(vEdge, 0.0, 1.0), mix(2.6, uCardTipEdge, tipOut)));
  a *= edge * uCardOpacity * vP0.w;
  // THE DEPTH-WRITE THRESHOLD, not just a fill saving. The card material is
  // transparent AND depthWrite: true, so any fragment that survives this test
  // stamps a NEAR depth into the buffer even at 1% alpha -- and TAA reprojects
  // through depth (it has no velocity buffer). Around the coat's fringe that
  // leaves a buffer of card-tip depths belonging to hairs you cannot see, and
  // which of them wins the depth test changes with the sub-pixel jitter. See
  // FUR_DEFAULTS.cardCut.
  if (a < uCardCut) discard;

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
    //
    // TRIED AND REVERTED, so nobody spends the round on it again: lifting the
    // weight to 1.0 wherever the hair is well resolved on screen
    // (1 - smoothstep(0.10, 0.24, fwidth(s)), which is 1 at macro_eye and 0
    // at the framings the grey-patch guard was built for) changes the macro
    // frame by nothing you can see —
    // shots/fur-p3/macro_eye.png against shots/fur-p3-nocardN/macro_eye.png.
    // It cannot: the card already rotates about its hair axis to FACE the
    // camera, so Vp ~ V, and on a face-on surface N ~ V too. Ncyl and N agree
    // everywhere except within a pixel or two of each hair's own edge.
    //
    // So "no Kajiya-Kay travelling highlight on individual strands" is not
    // the cylinder normal being suppressed. The cards at macro read as flat
    // bright ribbons with hard rectangular ends, which is a card SHAPE and
    // card ALPHA problem, not a shading-normal one. Left for whoever takes it
    // on with a proper metric; a no-op wired into the render is the one thing
    // this file has enough of.
    N = normalize(mix(N, Ncyl, (0.12 + 0.82 * clamp(vEdge, 0.0, 1.0)) * lod));
  }

  float ao = (1.0 - vP0.z * uAOBake) *
             mix(uAOInner + 0.3, 1.05, pow(clamp(v, 0.0, 1.0), uAOPow * 0.6));
  // That AO runs 0.96 at the root to 1.05 at the tip -- a 9% ramp, which is
  // to say the card layer has had no interior occlusion at all. A card is a
  // guard hair rooted at the skin and passing through the entire undercoat,
  // so its root is the most occluded thing in the coat and its tip the least
  // occluded. uCoatSigmaCard scales the extinction because a guard hair
  // pushes through the pile rather than lying in it, and because the card is
  // a billboard several hairs wide: the same sigma the shells use makes the
  // roots read as hard black sticks.
  vec2 sh = furSelfShadow(vP0.y * uCoatSigmaCard, dot(normalize(vNrm), uSunDir));
  vec3 col = furShade(N, T, V, clamp(0.5 + 0.5 * v, 0.0, 1.0), ao, hr, vP1.z, vec3(1.0),
                      false, 1.0 - clamp(a, 0.0, 1.0) * 0.55, vShellMod.y, sh);

  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;
}
