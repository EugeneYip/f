/**
 * FurMaterial — the shared uniform block and the three ShaderMaterials that
 * consume it (base / shell / card). OWNER: fur agent.
 *
 * All three materials point at ONE uniforms object, so a single per-frame sync
 * keeps the skin, the shells and the cards lit identically. That matters more
 * than it sounds: any drift between them shows up instantly as the coat
 * "detaching" from the animal.
 *
 * Lighting is computed from `ctx.sunDirection / sunColor / sunIntensity /
 * skyColor / groundBounce`, which the sky agent rewrites every frame, rather
 * than from three's light list — fur is not a Lambert surface and the standard
 * BRDF has nowhere to put forward scattering. The diffuse and ambient terms are
 * still scaled by 1/PI so the fox sits at the same exposure as everything shaded
 * by MeshStandardMaterial (the snow, chiefly).
 */
import * as THREE from 'three';
import {
  furVertexShader, furFragmentShader,
  cardVertexShader, cardFragmentShader,
  REGION_COUNT, CARD_SHAPE,
} from '../shaders/fur.glsl.js';

const c = (hex) => new THREE.Color(hex);

/* --------------------------------------------------------------------------
 * Per-region coat character.
 *
 *   A = [density, lengthScale, lay, tipWhite]
 *   B = [clumpScale, freqScale, baseTint, cardWeight]
 *
 * `lay` is how far hairs fold over along the flow field: high on soft underfur
 * (belly, cheek, throat), LOW on the tail — a brush stands out radially, it
 * does not lie down, and that is the whole difference between a brush and a
 * whip. `freqScale` raises the strand frequency where the anatomy is small
 * (muzzle, paws, ears) so the hairs stay in proportion to the body part.
 * `cardWeight` is the silhouette budget: ruff, tail, ear fringe, cheek, hock
 * and belly per the bible, plus the dorsal line, which is on the outline in
 * every side-on framing.
 * ------------------------------------------------------------------------ */
/**
 * Per-region interior opacity floor for cards (uRegionC.y), 0 = use the global.
 *
 * Needed for thin, flat parts. On the ear pinna and the skull the surface
 * faces the camera over almost its whole extent, so the vEdge gate that keeps
 * interior cards faint on the body suppresses the very fringe that has to
 * break the outline.
 */
export const CARD_INNER_FLOOR = {
  // Deliberately EMPTY for the head. Raising the floor there made cards 70%
  // opaque face-on, so they laid a solid mat over the flat pinna and replaced
  // the shells own soft granular edge with a crisp one — the ear got HARDER.
  // The shells already break the ear outline on their own; cards must stay
  // sparse and faint over a flat surface and only assert at its rim.
  18: 0.34, 19: 0.38, 21: 0.34, 22: 0.38,      // legs and hock are cylinders
};

/**
 * Per-region SHELL hair-length scale (uRegionC.z), 1.0 = full.
 *
 * Below 1 the shells feather out before the coat's nominal outer surface,
 * handing the silhouette to the cards. Only useful where the coat is too
 * shallow for the shells to ramp over more than a pixel or two — the head and
 * the lower legs.
 */
/*
 * These were pulled well below 1 because "the shells present a near-binary
 * boundary only a few pixels out from the mesh, and that step sits on top of
 * the cards' graded fringe and flattens it". That binary boundary was the
 * grazing-angle collapse of the hair field, and it is fixed -- measured on a
 * coverage pass, the shells ALONE now break their own outline (longest smooth
 * contour run 0.2-0.9% of the contour, against 5-10% before). Feathering them
 * out early now costs reach on exactly the regions that have the least of it,
 * so the handicap is much gentler: still short enough that the cards lead on
 * the outline, no longer short enough to leave a bare mesh curve under them.
 */
export const SHELL_LEN_SCALE = {
  1: 0.96, 2: 0.96, 4: 0.96, 5: 0.96, 6: 0.94, 7: 0.94,   // muzzle..ears
  18: 0.90, 19: 0.88, 20: 0.86, 21: 0.90, 22: 0.88, 23: 0.86,
};

/**
 * Per-region transmission boost (uRegionC.w), 1.0 = global strength.
 *
 * The head silhouette fails not because the edge is hard but because a backlit
 * white fox is nearly isoluminant with a bright sky there — the failing rows
 * measured a flat coverage profile around 43/765, so there is almost nothing
 * to ramp. Raising transmission globally fixes that but drags the body core up
 * with it and breaks the rim/core ratio, so the lift has to be local.
 */
export const TRANS_BOOST = {
  1: 2.6, 2: 2.4, 4: 2.8, 5: 2.8, 6: 3.2, 7: 3.0,   // muzzle, jaw, forehead, skull, ears
  18: 1.6, 19: 1.8, 21: 1.6, 22: 1.8,               // legs
};

/**
 * Card length relative to the local coat, per region (uRegionC.x).
 *
 * THIS TABLE IS INSIDE `CARD_SHAPE.reachBand` AND MUST STAY THERE. It used to
 * carry 1.3–1.8 on the head, the legs and the paws, and that is what the
 * "sea urchin" coat was. Measured at `frontal`, the card tip's perpendicular
 * reach past the skin, as a multiple of the LOCAL coat depth:
 *
 *     muzzle / earOuter / pawFront / pawHind   2.01   (2.09–2.34 x the shells)
 *     jawLower / earInner                      1.79
 *     forehead / legUpper / hock               1.56
 *     skull                                    1.45
 *     everything else                          1.12   <- the band
 *
 * against a documented band of 1.10–1.25. So on every region that reads as
 * needles, the outer HALF of each card stood over open sky with no coat behind
 * it, while the body — the one part of the animal that was authored at 1.0 —
 * read as soft fur. Hiding the cards (`shots/fur2-layer/frontal.nocards.png`)
 * removed every spike and left the shells' own soft granular edge intact, so
 * the attribution is not in doubt.
 *
 * `FurSystem.reachReport()` said `ok: true, mean 1.117` throughout. It was
 * blind: it multiplied the global `uCardLength` by `lenMul` and `rise` and
 * never looked at `uRegionC.x` at all, on the stated grounds that the
 * per-region length scale "multiplies the coat and the card equally". That is
 * true of `uRegionA.y`, which scales the coat, and false of this table, which
 * scales only the card. It now iterates the regions.
 *
 * The justification for the old numbers has also expired. It was "the ear
 * fringe was 4.7 mm against a 2.6 mm pixel at the silhouette framing". The ear
 * coat is 17.4 mm now and the skull coat 38 mm — anatomy deepened the head
 * per bible 4f — so a coat-proportional fringe is 14 px at `silhouette` and
 * 50 px at `frontal`. There is nothing left to compensate for.
 *
 * There is also no headroom left to spend. `lenMul` already runs to 1.10, so
 * at scale 1.0 the LONGEST third of the cards in a region reaches 1.254 —
 * the band ceiling, exactly. A first pass at this put the short-coat regions
 * on 1.06–1.10 and the fixed `reachReport()` immediately failed them at 1.379.
 * The per-card spread is where the variation belongs; the region table is not
 * a second place to add some. So: 1.0, everywhere, and the clamp in
 * `buildFurUniforms` makes that the only value the band admits.
 */
export const CARD_LEN_SCALE = {
  0: 1.0, 1: 1.0, 2: 1.0, 3: 1.0, 4: 1.0, 5: 1.0, 6: 1.0, 7: 1.0,
  8: 1.0, 9: 1.0, 10: 1.0, 11: 1.0, 12: 1.0, 13: 1.0, 14: 1.0,
  15: 1.0, 16: 1.0, 17: 1.0, 18: 1.0, 19: 1.0, 20: 1.0,
  21: 1.0, 22: 1.0, 23: 1.0, 24: 1.0, 25: 1.0, 26: 1.0,
};

export const REGION_TABLE = [
  /*
   * 0 nose — density is 0.98, NOT 0, and the bare pad is uNoseFade's job.
   *
   * Zero density here meant the ENTIRE `nose` region rendered with no coat at
   * all, and that region is not the rhinarium: it carries 69 vertices at this
   * mesh resolution and spans roughly 40 mm across the front of the muzzle,
   * against a real rhinarium of 8-10 mm. Measured at the `chin` framing,
   * 25.5% of the animal's whole projected skin area came back at coat
   * transmittance 1.0 -- bare skin, in a review pose, which is a flat failure
   * of bible 4f rule 3. Raising it to 0.98 takes that to 0.0% exactly.
   *
   * Two mechanisms were defining the bare pad and they disagreed by a factor
   * of five. Now one does: uNoseFade clears 4 mm fully bare, full coat by
   * 7 mm, centred on the region's own bind-space centroid. The length scale
   * of 0.30 still keeps whatever coat does grow here down to about a
   * millimetre, which is what stops it reading as fur on the nose leather.
   */
  /* 0 nose          */ { a: [0.98, 0.30, 0.00, 0.00], b: [1.00, 2.40, 1.00, 0.00] },
  /* 1 muzzle        */ { a: [0.98, 1.40, 0.60, 0.10], b: [1.55, 1.60, 0.90, 1.20] },
  /* 2 jawLower      */ { a: [0.98, 1.00, 0.80, 0.18], b: [1.40, 1.30, 0.90, 1.10] },
  /* 3 cheek         */ { a: [1.05, 1.34, 1.35, 0.50], b: [0.80, 1.00, 1.00, 1.70] },
  /* 4 forehead      */ { a: [1.00, 1.10, 0.90, 0.10], b: [1.40, 1.35, 0.90, 1.80] },
  /* 5 skull         */ { a: [1.00, 1.40, 0.95, 0.16], b: [1.20, 1.25, 1.00, 1.70] },
  /* 6 earOuter      */ { a: [1.00, 1.00, 0.80, 0.26], b: [1.45, 1.70, 0.90, 2.60] },
  /* 7 earInner      */ { a: [0.90, 1.00, 1.20, 0.55], b: [1.30, 1.55, 0.80, 2.20] },
  /* 8 throat        */ { a: [1.00, 1.10, 1.20, 0.45], b: [0.95, 1.10, 1.00, 0.85] },
  /* 9 neck          */ { a: [1.00, 1.08, 1.05, 0.35], b: [0.90, 1.00, 1.00, 0.90] },
  /* 10 ruff          */ { a: [1.05, 1.16, 1.15, 0.55], b: [0.72, 0.95, 1.00, 1.60] },
  /* 11 chest         */ { a: [1.00, 1.04, 1.10, 0.38], b: [0.92, 1.00, 1.00, 0.72] },
  /* 12 shoulder      */ { a: [1.00, 1.08, 1.15, 0.30], b: [0.95, 1.00, 1.00, 0.95] },
  /* 13 back          */ { a: [1.00, 1.04, 1.20, 0.26], b: [0.95, 1.00, 1.00, 1.05] },
  /* 14 flank         */ { a: [1.00, 1.10, 1.05, 0.30], b: [0.90, 1.00, 1.00, 0.82] },
  /* 15 belly         */ { a: [1.00, 1.12, 1.30, 0.42], b: [0.95, 1.05, 0.90, 0.80] },
  /* 16 croup         */ { a: [1.00, 1.04, 1.25, 0.28], b: [0.92, 1.00, 1.00, 1.10] },
  /* 17 haunch        */ { a: [1.00, 1.08, 1.05, 0.30], b: [0.92, 1.00, 1.00, 0.82] },
  /* 18 legFrontUpper */ { a: [1.00, 1.10, 1.00, 0.24], b: [1.10, 1.35, 0.25, 1.05] },
  /* 19 legFrontLower */ { a: [1.00, 1.15, 0.85, 0.24], b: [1.20, 1.60, 0.16, 1.60] },
  /* 20 pawFront      */ { a: [1.00, 1.15, 0.60, 0.16], b: [1.55, 2.05, 0.14, 1.30] },
  /* 21 legHindUpper  */ { a: [1.00, 1.10, 1.05, 0.28], b: [1.05, 1.30, 0.25, 1.05] },
  /* 22 hock          */ { a: [1.00, 1.10, 0.95, 0.32], b: [1.15, 1.50, 0.16, 1.70] },
  /* 23 pawHind       */ { a: [1.00, 1.15, 0.60, 0.16], b: [1.55, 2.05, 0.14, 1.30] },
  /* 24 tailBase      */ { a: [1.04, 1.14, 0.45, 0.34], b: [0.85, 0.95, 1.00, 1.70] },
  /* 25 tailMid       */ { a: [1.06, 1.36, 0.30, 0.42], b: [0.78, 0.92, 1.00, 2.10] },
  /* 26 tailTip       */ { a: [1.04, 1.18, 0.34, 0.36], b: [0.82, 0.95, 1.00, 1.85] },
];

/** Authoring defaults. Every one of these is live-tweakable via ctx.fur.set(). */
export const FUR_DEFAULTS = {
  // coat shape
  coatScale: 0.93,
  lay: 0.44,
  droop: 0.26,
  windBend: 1.0,
  waveFreq: 5.2,
  waveSpeed: 3.1,

  // hair field (metres -> per-metre frequencies)
  clumpFreq: 136,     // ~7.4 mm tufts; coarser reads as dirt, not fur
  strandFreq: 1080,    // ~0.93 mm; fine enough to blur into a mass at body distance
  microFreq: 7000,   // x region freqScale (1.3-1.6 on the face) lands ~2-3 px at macro
  clumpPull: 0.74,
  strandRoot: 0.58,
  strandTip: 0.15,
  hairLenMin: 0.52,
  density: 1.0,
  fill: 1.0,
  // Where the undercoat's felt stops, as a multiple of shellFill, and how far
  // that boundary is jittered per clump/strand. It used to run to 1.18x
  // shellFill unjittered, which at grazing incidence is a smooth opaque sheet
  // over the inner half of the coat -- the coat's outline was that sheet's
  // edge rather than hair.
  // Cap on 1/|N.V| for the undercoat's Beer-Lambert boost. At 6 the felt hits
  // alpha 1.0 several pixels before the coat's outer surface, which both seals
  // the outline into a smooth curve and kills the transmission term above.
  pathKMax: 2.5,
  fillTop: 1.12,
  fillJitter: 0.30,
  cardTip: 0.45,
  coatVarFreq: 15,

  // shading
  //
  // `ambient` is divided by PI in the shader, so 4.0 is a response of 1.27 x
  // the incident hemisphere radiance -- above a Lambertian 1.0 on paper, and
  // below it in practice, because the very next factor is `ao`, whose own
  // authored floor is 0.54. It was 2.45, i.e. 0.78 before AO and ~0.5 after,
  // on a medium whose whole character is that light bounces around inside it
  // and comes back out. Measured differentially, that put the coat at 0.66 x
  // the luminance of the snow behind it; bible 4b says an arctic fox is
  // "only slightly brighter than its background", never darker.
  ambient: 4.0,
  ambientSat: 1.0,
  // See furShade(): uSkyColor is the ZENITH, which is the darkest and bluest
  // patch of a polar sky, and using it as the whole upward irradiance is the
  // single largest contributor to the blue cast. 0.65 was chosen by measuring
  // the coat's r-b against bible 3's own shaded-fur swatch #b9c7d8 (r-b =
  // -31): at 0.65 the shaded coat lands on -29/-31 at `frontal`/`profile`,
  // against -54/-53 before.
  skyHorizon: 0.65,
  sunSat: 0.30,
  transSat: 0.16,     // scattered light keeps almost none of the sun's hue       // how much of the sun's chromaticity survives scattering
  wrap: 0.40,
  trans: 10.0,        // divided by PI in the shader
  transPow: 3.4,
  // Transmission used to be gated on pow(1 - alpha, 3.0). alpha saturates at
  // exactly the depth where the undercoat felt becomes opaque, and the oblique
  // path factor drives that boundary hard against the mesh silhouette -- so the
  // glow switched OFF across a one-pixel line that traced the skin outline, and
  // the coat inside it read as a separate flat plate. That luminance step, not
  // any geometry, is what "you can see where the bone stops and the coat
  // starts" was actually showing. Softening the exponent and widening the
  // grazing falloff spreads the rim over a band about one coat deep, which is
  // what a backlit coat does. uTrans is retuned to hold the rim's brightness.
  transThin: 1.2,
  transGraze: 3.0,
  transFloor: 0.7,
  aoInner: 0.66,
  aoPow: 0.90,
  aoFloor: 0.54,
  shellJitter: 1.15,
  tuftAmt: 1.0,
  clumpAO: 0.75,
  aoBake: 0.22,
  rim: 0.30,
  // How much of the undercoat felt's opacity the strand layer modulates.
  // See furHair(): the felt is the one layer with no hair in it, and wherever
  // max(a, under) picks it the coat renders as a flat plate the width of a
  // lock. 1.0 gives it the strands at 0.62-1.00 of full opacity -- felt, so
  // modulated but never cut through.
  feltStrand: 1.0,
  strandRound: 1.0,   // 1.0 = the true per-hair cylinder normal; above this the
                       // mix() extrapolates past it and detail degrades again
  strandAniso: 6.0,   // strand cells are tubes along the hair, not balls

  specShiftA: -0.085,
  specShiftB: 0.16,
  specPowA: 105,
  specPowB: 22,
  specGainA: 0.50,
  specGainB: 0.26,
  specJitter: 0.11,

  /*
   * Coat dynamics gains (bible 4f: "deep fur ... moves a beat behind the
   * body"; the user's words are "a different visual experience from a truly
   * bouncy one").
   *
   * coatLagGain multiplies the published body-space lag before it is rotated
   * into world space. 1.0 means the tip of a full-depth 48 mm coat moves by
   * the whole published displacement, which peaks near 20 mm at a gallop and
   * is a spring, not a step.
   *
   * coatSquash is the fraction of coatCompress that reaches the hair LENGTH.
   * coatCompress reaches 0.20 on a gallop landing and is authored to dip to
   * about -0.55 on the rebound, so 0.35 gives a 7% crush and up to a 19%
   * overshoot -- squash and stretch, on the one quantity a bone cannot move.
   */
  coatLagGain: 1.0,
  coatSquash: 0.35,
  coatRuffle: 0.055,

  // cards
  cardWidth: 0.115,
  cardLength: 1.20,
  /*
   * Minimum guard-hair stand-off past the coat, METRES. See the card vertex
   * shader for the derivation: the reach band is a RATIO, and a ratio cannot
   * break a 4 mm coat's outline.
   *
   * Swept on the true coverage matte at `profile`, which is the framing that
   * fails — outline path length over net crossing, 10th percentile, against a
   * 1.15 floor, plus the animal's total covered area:
   *
   *      floor      head    body    legs    coverage px   fringe share
   *      0 mm      1.000   1.276   1.000      154 268        0.183
   *      6 mm      1.181   1.183   1.364      157 603        0.199
   *     10 mm      1.226   1.769   1.716      163 937        0.226
   *     16 mm      1.452   2.001   2.103      174 573        0.269
   *
   * 6 mm clears the floor on all three bands but by 0.03 on two of them,
   * which is inside the run-to-run spread of the metric (the same build
   * measured twice moved the body band 1.056 -> 1.073). 16 mm grows the
   * animal 13% and takes the fringe share past a quarter of it — 4f rule 4
   * cuts both ways, and that is a different animal. 10 mm clears all three
   * with margin for 6% more area.
   */
  cardFloor: 0.010,
  cardInner: 0.17,
  /*
   * vEdge exponent at a card TIP. THE ONE KNOB for how much card stands over
   * the INTERIOR of the animal, and it is free at the outline: there
   * vEdge -> 1 and pow(1, anything) == 1, so raising it cannot cost a pixel
   * of silhouette. At the authored 0.60 a tip was 38% opaque on a face-on
   * surface (vEdge ~ 0.2), which at the nape framing is a field of separate
   * needles standing off the neck -- hiding the CARDS removes every one of
   * them and leaves the shells smooth granular surface, so they are cards.
   * 1.40 takes that 38% to 10%.
   */
  cardTipEdge: 1.40,
  cardJitter: 1.05,
  cardOpacity: 1.0,
  // Fraction of a card's lateral distance to its lock's site taken out by the
  // tip. 0 restores the pre-clump coat (an even spray of independent hairs);
  // much above 0.7 the locks pinch to points and the coat reads wet.
  cardClump: 0.55,
};

/**
 * Reach, as a multiple of the local coat, that a per-region card scale buys —
 * and the scale that buys a given reach. One expression, both directions, so
 * the table above, the clamp below and `reachReport()` can never disagree
 * about the arithmetic again.
 */
export function cardReachFor(scale, cardLength = FUR_DEFAULTS.cardLength,
                             lenMul = CARD_SHAPE.lenMulMean) {
  return scale * cardLength * lenMul * CARD_SHAPE.rise;
}
export function cardScaleForReach(reach, cardLength = FUR_DEFAULTS.cardLength) {
  return reach / cardReachFor(1, cardLength);
}

export function buildFurUniforms(ctx) {
  const d = FUR_DEFAULTS;
  const regionA = [];
  const regionB = [];
  const regionC = [];
  // The band is a hard bound on the TABLE, not advice. Authoring 1.8 here once
  // put the card tips at 2.0x the local coat and produced the urchin coat; a
  // guard that only checks the global knob cannot see that, so clamp at the
  // point the value enters the uniform and name any region that bites.
  const loS = cardScaleForReach(CARD_SHAPE.reachBand[0], d.cardLength);
  const hiS = cardScaleForReach(CARD_SHAPE.reachBand[1], d.cardLength);
  const clamped = [];
  for (let i = 0; i < REGION_COUNT; i++) {
    const r = REGION_TABLE[i] ?? { a: [1, 1, 1, 0.3], b: [1, 1, 1, 0.8] };
    const want = CARD_LEN_SCALE[i] ?? 1.0;
    const got = Math.min(hiS, Math.max(loS, want));
    if (Math.abs(got - want) > 1e-3) {
      clamped.push(`${i}:${want.toFixed(2)}->${got.toFixed(2)}`);
    }
    regionA.push(new THREE.Vector4(...r.a));
    regionB.push(new THREE.Vector4(...r.b));
    regionC.push(new THREE.Vector4(got, CARD_INNER_FLOOR[i] ?? 0,
                                   SHELL_LEN_SCALE[i] ?? 1.0, TRANS_BOOST[i] ?? 1.0));
  }
  if (clamped.length) {
    console.warn(`[fur] CARD_LEN_SCALE outside reachBand ${CARD_SHAPE.reachBand} — ` +
                 `clamped ${clamped.join(' ')}`);
  }

  return {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),

    uSunDir: { value: new THREE.Vector3().copy(ctx.sunDirection) },
    uSunColor: { value: new THREE.Color().copy(ctx.sunColor) },
    uSunIntensity: { value: ctx.sunIntensity ?? 7 },
    uSkyColor: { value: new THREE.Color().copy(ctx.skyColor) },
    uGroundBounce: { value: new THREE.Color().copy(ctx.groundBounce) },
    uAmbient: { value: d.ambient },
    uAmbientSat: { value: d.ambientSat },
    uSkyHorizon: { value: d.skyHorizon },
    uSunSat: { value: d.sunSat },
    uTransSat: { value: d.transSat },

    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector3().copy(ctx.wind) },
    uWindSpeed: { value: ctx.windSpeed ?? 2.4 },
    uWindGust: { value: 0 },
    uGravity: { value: new THREE.Vector3(0, -1, 0) },

    /*
     * The animal's own motion. Written every frame by syncFurUniforms from
     * ctx.fox.coatLag / coatCompress / agitation, which animation has been
     * publishing for several rounds with ZERO consumers anywhere in
     * src/fox/** or src/shaders/** -- so up to now the coat was
     * bit-identical asleep and at a gallop, and everything that looked like
     * secondary motion in the fur was ctx.wind.
     */
    uCoatLag: { value: new THREE.Vector3() },
    uCoatCompress: { value: 0 },
    uCoatSquash: { value: d.coatSquash },
    uAgitation: { value: 0 },
    uCoatRuffle: { value: d.coatRuffle },

    uEyeL: { value: new THREE.Vector3(-0.027, 0.318, 0.222) },
    uEyeR: { value: new THREE.Vector3(0.027, 0.318, 0.222) },
    // The coat parts around the eye over a SLOT sized by the EYEBALL.
    //
    // All three are radii in metres, in the anisotropic metric furSkinMask2
    // builds off the optical axis, and all three are overwritten at init from
    // the eyeball Eyes.js actually draws (FurSystem.eyeClearance). These are
    // only what is used if neither anatomy nor the face agent has published
    // eye metadata yet.
    //
    //   x  bare: no coat at all inside the lid margin
    //   y  where COVERAGE is restored — just past the margin, so the
    //      surround is short fur and never bare skin (bible 4f rule 3)
    //   z  where LENGTH is restored — much further out, so the coat thickens
    //      back gradually instead of walling the eye in
    //
    // There is deliberately no "per metre of local coat" term any more. It was
    // self-defeating -- the clearance grew as fast as the thing it was meant to
    // clear -- and it went from harmless to fatal purely because the head coat
    // got deeper underneath it. See furSkinMask2 in fur.glsl.js.
    uEyeFade: { value: new THREE.Vector3(0.0104, 0.0117, 0.0320) },
    // Bind-space optical axes, overwritten at init from fox.eyes[side].look.
    // Default points straight ahead so a rig with no eye metadata still gets
    // a sane (if unrotated) slot rather than a NaN.
    uEyeAxisL: { value: new THREE.Vector3(-0.58, 0.15, 0.80).normalize() },
    uEyeAxisR: { value: new THREE.Vector3(0.58, 0.15, 0.80).normalize() },
    // The fissure is about 1.75x as wide as it is tall, so the parting is
    // too: a ROUND parting big enough to expose the eye must shave past the
    // lids, because the globe is 22.5 mm across and the fissure 13.8 mm.
    // x scales the along-fissure component before the radius test, so < 1
    // reaches FURTHER temporally and nasally; y > 1 pulls the parting in
    // above and below, which is what keeps coat on the brow and the cheek.
    // Overwritten at init from the cornea Eyes.js drew; see eyeAperture().
    uEyeSlot: { value: new THREE.Vector2(1 / 1.32288, 1.32288) },
    // Cards are cut where their own length would sweep across the cornea —
    // see the card vertex shader. Kept as a uniform so it can be A/B'd at
    // runtime; there is no reason to author it below 1.
    uCardEyeGuard: { value: 1 },
    uNose: { value: new THREE.Vector3(0.001, 0.293, 0.274) },
    // the rhinarium is ~8-10 mm across, so ~4 mm of bare pad and full
    // coat by 7 mm; 18 mm was clearing the entire muzzle
    uNoseFade: { value: new THREE.Vector2(0.0040, 0.0070) },
    uShellCount: { value: 18 },
    uCoatScale: { value: d.coatScale },
    uLay: { value: d.lay },
    uDroop: { value: d.droop },
    uWindBend: { value: d.windBend },
    uWaveFreq: { value: d.waveFreq },
    uWaveSpeed: { value: d.waveSpeed },

    uClumpFreq: { value: d.clumpFreq },
    uStrandFreq: { value: d.strandFreq },
    uMicroFreq: { value: d.microFreq },
    uClumpPull: { value: d.clumpPull },
    uStrandRoot: { value: d.strandRoot },
    uStrandTip: { value: d.strandTip },
    uHairLenMin: { value: d.hairLenMin },
    uDensity: { value: d.density },
    uFill: { value: d.fill },
    uPathKMax: { value: d.pathKMax },
    uFillTop: { value: d.fillTop },
    uFillJitter: { value: d.fillJitter },
    uCardTip: { value: d.cardTip },
    uCoatVarFreq: { value: d.coatVarFreq },

    uFurLit: { value: c(0xfdfcfa) },
    uFurUnder: { value: c(0xdcd3c6) },
    /*
     * The blue of shaded fur is DOUBLE-COUNTED if this carries all of it.
     *
     * (0.72, 0.845, 1.0) is exactly #b9c7d8 / #fdfcfa in linear — bible 3's
     * shaded-fur swatch divided by its lit one — so it was derived correctly
     * and applied in the wrong place. Those swatches are under a "Role"
     * column beside "Snow (shadow) #6d8cb8", and snow's albedo is not blue:
     * they are what each surface must LOOK like, not what to multiply its
     * albedo by. The look already comes from the illuminant, because unlit
     * coat here is lit by nothing but a blue sky. Charging it a second time
     * against the albedo is why the shaded coat measured r-b = -53 when the
     * swatch it was derived from is -31.
     *
     * What survives is a token: real fur in shade is marginally cooler than
     * the same fur in sun (the sun is the only warm source in the scene), so
     * the tint stays, softened until the measured shade lands on the swatch.
     */
    uShadowTint: { value: new THREE.Vector3(0.90, 0.95, 1.0) },
    uSpecTintA: { value: c(0xfff3e2) },
    uSpecTintB: { value: c(0xffe8cc) },
    uTransTint: { value: c(0xfffaf3) },
    uSpecShiftA: { value: d.specShiftA },
    uSpecShiftB: { value: d.specShiftB },
    uSpecPowA: { value: d.specPowA },
    uSpecPowB: { value: d.specPowB },
    uSpecGainA: { value: d.specGainA },
    uSpecGainB: { value: d.specGainB },
    uSpecJitter: { value: d.specJitter },
    uWrap: { value: d.wrap },
    uTrans: { value: d.trans },
    uTransPow: { value: d.transPow },
    uTransThin: { value: d.transThin },
    uTransGraze: { value: d.transGraze },
    uTransFloor: { value: d.transFloor },
    uAOInner: { value: d.aoInner },
    uAOPow: { value: d.aoPow },
    uAOBake: { value: d.aoBake },
    uAOFloor: { value: d.aoFloor },
    uShellJitter: { value: d.shellJitter },
    uTuftAmt: { value: d.tuftAmt },
    uClumpAO: { value: d.clumpAO },
    uAniso: { value: 1 },
    uStrandRound: { value: d.strandRound },
    uStrandAniso: { value: d.strandAniso },
    uMicroOn: { value: 1 },
    uFeltStrand: { value: d.feltStrand },
    uRim: { value: d.rim },

    uStochastic: { value: 0 },
    uFrameSeed: { value: 0 },

    uRegionA: { value: regionA },
    uRegionB: { value: regionB },
    uRegionC: { value: regionC },

    uCardWidth: { value: d.cardWidth },
    uCardLength: { value: d.cardLength },
    uCardFloor: { value: d.cardFloor },
    uCardInner: { value: d.cardInner },
    uCardTipEdge: { value: d.cardTipEdge },
    uCardJitter: { value: d.cardJitter },
    uCardClump: { value: d.cardClump },
    uCardOpacity: { value: d.cardOpacity },
  };
}

/** Opaque skin + undercoat. Replaces the anatomy agent's review material. */
export function makeBaseMaterial(uniforms) {
  const m = new THREE.ShaderMaterial({
    name: 'furBase',
    uniforms,
    vertexShader: furVertexShader('base'),
    fragmentShader: furFragmentShader('base'),
    vertexColors: true,
    fog: true,
    lights: false,
    transparent: false,
    depthWrite: true,
    side: THREE.FrontSide,
  });
  return m;
}

/**
 * The shells. Alpha-blended, inner-to-outer.
 *
 * Instanced rendering guarantees primitive order runs instance 0, 1, 2 … so
 * drawing the innermost shell as instance 0 gives correct back-to-front
 * compositing through the coat for free, with no sort and no depth writes.
 */
/*
 * THE COAT WRITES DEPTH. This is the single most consequential line in the
 * file and it is not an optimisation — read this before turning it off.
 *
 * With depthWrite off, the depth buffer contains the SKIN and nothing else,
 * because the skin is the only opaque thing the fox draws. Every pixel of
 * coat outside the skin's own outline therefore reports the depth of the
 * SNOW BEHIND THE ANIMAL. DoF reads that buffer, computes a full background
 * circle of confusion for those pixels, and replaces them with the blurred
 * far field — deliberately, and it says so: its prepare pass picks "the
 * sub-sample that is MOST out of focus" and weights colour toward that
 * surface, so a fringe pixel that is 40% hair over sky is resolved as sky.
 *
 * The result is a hard-edged, in-focus plate exactly the shape of the skin
 * mesh, with the coat outside it washed into the background. That plate is
 * what four rounds of work read as "the skin showing through the coat", and
 * it is neither the skin (measured: ZERO of the skin's own radiance reaches
 * the frame — the coat is completely opaque over it) nor the coat's own
 * outline (measured: postfx off, the silhouette is hair everywhere).
 *
 * Shells are drawn inner-to-outer, so each successive shell is NEARER and
 * passes the depth test against the one below it; writing depth costs the
 * blend nothing. Discarded fragments write no depth, so the depth silhouette
 * is hair-shaped rather than an offset envelope. Cards write depth too: they
 * are the OUTERMOST thing the animal has, and without them the strand fringe
 * is the one part still left outside the depth buffer and still blurred away.
 *
 * Consequences that are intended, not accidents: whiskers, cornea, breath and
 * snow particles all draw after the coat and are now depth-tested against it,
 * so a whisker root buried in the ruff is hidden and a flake passing behind
 * the tail is occluded. That is what the coat being real geometry means.
 */
export function makeShellMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    name: 'furShell',
    uniforms,
    vertexShader: furVertexShader('shell'),
    fragmentShader: furFragmentShader('shell'),
    fog: true,
    lights: false,
    transparent: true,
    depthWrite: true,
    depthTest: true,
    blending: THREE.NormalBlending,
    side: THREE.FrontSide,
  });
}

export function makeCardMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    name: 'furCard',
    uniforms,
    vertexShader: cardVertexShader(),
    fragmentShader: cardFragmentShader(),
    fog: true,
    lights: false,
    transparent: true,
    depthWrite: true,
    depthTest: true,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
}

/**
 * Pull the frame's lighting and weather state onto the uniform block.
 *
 * The sun/sky values are whatever the atmosphere agent computed this frame —
 * never hardcoded here — and the wind vector is scaled exactly as
 * SnowParticles scales it, so blowing snow and blowing fur agree.
 */
/** Scratch for the body -> world rotation of the coat lag; never allocate per frame. */
const _q = new THREE.Quaternion();

export function syncFurUniforms(u, ctx) {
  u.uSunDir.value.copy(ctx.sunDirection);
  u.uSunColor.value.copy(ctx.sunColor);
  u.uSunIntensity.value = ctx.sunIntensity ?? 7;
  u.uSkyColor.value.copy(ctx.skyColor);
  u.uGroundBounce.value.copy(ctx.groundBounce);

  u.uTime.value = ctx.time;

  /*
   * The coat's own inertia. ctx.fox.coatLag is BODY space (x lateral,
   * y vertical, z longitudinal, metres) and furDynamics adds it in WORLD
   * space alongside gravity and wind, so it has to be rotated by the
   * animal's world orientation -- a coat lagging "backwards" has to lag
   * backwards along the direction the fox is actually facing, not along -Z.
   * Read defensively: animation may not have run yet, and a fur that throws
   * here would take the whole coat down with it.
   */
  const fox = ctx.fox;
  if (fox?.coatLag) {
    u.uCoatLag.value.copy(fox.coatLag).multiplyScalar(FUR_DEFAULTS.coatLagGain);
    const root = fox.root;
    if (root) {
      root.updateWorldMatrix(true, false);
      u.uCoatLag.value.applyQuaternion(root.getWorldQuaternion(_q));
    }
  } else {
    u.uCoatLag.value.set(0, 0, 0);
  }
  u.uCoatCompress.value = fox?.coatCompress ?? 0;
  u.uAgitation.value = fox?.agitation ?? 0;

  u.uWindDir.value.copy(ctx.wind);
  const gust = ctx.windGust ?? 0;
  u.uWindSpeed.value = (ctx.windSpeed ?? 2.4) * (1 + 1.4 * gust);
  u.uWindGust.value = gust;
  // NOTE: the authoritative per-sample seed is written in FurSystem's
  // onBeforeRender from ctx.postfx.taaSampleIndex — update() runs once per
  // step, which is too coarse while TAA is accumulating. This is the fallback
  // for when there is no postfx chain at all.
  u.uFrameSeed.value = (ctx.postfx?.taaSampleIndex ?? ctx.frame) % 64;
}
