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
  /*
   * 8-10 THE NECK. There is no hourglass notch here, and the three columns
   * that said there was are a front leg, a belly and a hind leg.
   *
   * The report was column HEIGHTS on the coverage matte at `profile`, 1280 px
   * wide: 319 px at x=543 "head + ruff", 171 px at x=643 "neck", 306 px at
   * x=768 "body" -- a neck thinner than either neighbour, i.e. a head stuck
   * on rather than grown out of the shoulders (4e). Those three numbers
   * reproduce exactly (319 / 169 / 299 here). What they measure does not.
   *
   * The rig's own bones, projected into that same frame: jaw 437, head 460,
   * neck02 481, neck01 509, chest 539, spine04 581, spine03 626, spine01 716,
   * hips 764, tail01 824. So x=543 is the CHEST, x=643 is mid-BACK and x=768
   * is the HIP. The neck is x 460-539 and none of the three samples is in it.
   *
   * And the quantity is not a height. Per column, covered pixels vs the
   * top-to-bottom span:
   *
   *     x=543   top 311  bottom 631  mass 319   the front leg, to the snow
   *     x=643   top 326  bottom 499  mass 169   belly: no leg in this column
   *     x=768   top 324  bottom 630  mass 299   a hind leg, to the snow
   *
   * The "notch" is the gap between the forelimbs and the hindlimbs, i.e. the
   * animal's own waist seen between its legs -- which 4f asks for.
   *
   * MEASURED PROPERLY -- the contiguous trunk run containing the topmost
   * covered pixel, gaps of up to 8 px closed first, because a furry outline's
   * topmost pixel is usually an isolated hair tip and a raw run from it
   * returns 1 px (it did, on 11 of 29 columns, before the closing):
   *
   *     station          crown  neck02  neck01  min over 460..539  withers
   *       coat            213     212     201      196 @ x=502       334
   *       COAT HIDDEN     169     182     156      150 @ x=536       150
   *
   * The coated neck is 0.92 of the crown and the bare neck 0.89, so the coat
   * makes that transition FLATTER, not deeper, and it is nearly flat already.
   * The dorsal contour runs 257 -> 323 px from crown to spine04 without a
   * dip-and-rise: the deepest row between the crown and the back is 330 at
   * x=593 against a highest back row of 309, a 21 px step that is 6 px on the
   * bare mesh and 15 px with the cards hidden -- i.e. it is hair tips, not
   * shape. 41687a6's tail notch, for scale, is a 20 px step in the other
   * direction on a contour that is otherwise monotone.
   *
   * So the ruff's depth and its extent along the neck are both fine on this
   * evidence and NEITHER IS WORTH BUYING. Do not deepen region 10 to close a
   * gap between a fox's legs. If the neck is revisited, measure the trunk run
   * between x=460 and x=539, not a column mass, and put the probe on the rig's
   * bones rather than on eyeballed x values.
   */
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
  /*
   * 24-26 THE TAIL. The lengthScales here are the tail's SHAPE, not a
   * character knob, and they are set against the core radii the anatomy
   * agent publishes (TAIL_R, metres: .0266 .0278 .0274 .0262 .0246 .0224
   * .0196 .0162 .0126 .0095; tailBase is control points 0-1, tailMid 2-6,
   * tailTip 7-9). Coat depth x core radius is what the eye reads:
   *
   *              coat mm   core mm   TOTAL RADIUS   diameter
   *   was  base     51.4      27.2         78.6       157 mm
   *        mid      67.1      24.0         91.1       182 mm
   *        tip      48.0      11.0         59.0       118 mm
   *   then base     18.0      27.2         45.2        90 mm
   *        mid      36.0      24.0         60.0       120 mm
   *        tip      40.7      11.0         51.7       103 mm
   *   now  base     18.0      27.2         45.2        90 mm
   *        mid      51.8      24.0         75.8       152 mm
   *        tip      52.9      11.0         63.9       128 mm
   *
   * Bible 4 gives the one sourced figure: "tail 0.32 m (bushy, ~0.10 m
   * diameter with fur)". The tail was rendering at 0.18 m across its middle
   * -- 1.8x the spec and 0.72x the coated TORSO (127 mm radius) -- so it was
   * not a brush attached to a fox, it was a second body. That, and not the
   * croup, is why "the rear is one continuous furry mass".
   *
   * THAT FIGURE CONTRADICTS THE SENTENCE IT IS IN, and the middle row above
   * is what happens when you follow it. Bible 4's very next clause is "winter
   * coat thickness up to 0.05 m on the flank, THICKER ON THE TAIL and ruff",
   * and 0.10 m of diameter leaves 23-26 mm of coat over a 24-27 mm core --
   * half the flank's 48 mm, not more than it. No core radius >= 0 satisfies
   * both halves of that sentence. REFERENCE-FOX 2b breaks the tie with the
   * only directly measured per-region numbers on the project (ASM #2, one
   * specimen, combed guard-hair length): lower back 20-35 mm against TAIL
   * 60-70 mm -- the tail is 2-3x the back on the same animal -- and bible 4b
   * says outright "tail fur ... is the longest on the animal". At mid 36 mm
   * ours was 0.75x the flank, i.e. the sourced ORDERING was inverted.
   *
   * So mid goes to 51.8 mm: the smallest depth that is actually deeper than
   * the flank's 48 mm, and well under the 60-70 mm measurement (which
   * REFERENCE-FOX itself warns is combed length and overstates standing
   * loft). That is half of 7df3911's cut given back, not the cut undone.
   *
   * Measured on the exact coverage matte at `profile`, in one page session at
   * one instant, seven arms. Mass and height are of the column at the brush's
   * widest station; the waist is the minimum-mass column in the first half of
   * the span behind the rump (bounding that search matters -- unbounded it
   * always lands on the last column before the tip and every arm returns
   * exactly 1.000):
   *
   *   arm (mid/tip lengthScale)   brush/waist  brush h   brush area  coverage
   *     COAT HIDDEN (control)        1.444       64 px    12 342 px   83 730
   *     0.73 / 1.00  (was)           1.568      130 px    24 736 px  152 056
   *     0.90 / 1.15                  1.666      141 px    27 223 px  155 366
   *     1.05 / 1.30  SHIPPED         1.812      152 px    29 562 px  158 595
   *     1.20 / 1.45                  1.927      157 px    31 966 px  161 850
   *
   * The control is the point: with the coat hidden the bare tail already
   * reads 1.444, so at 0.73 the whole coat was adding 0.12 to the brush's
   * separation from its own root. It now adds 0.37. The dorsal contour is
   * the other half of it -- at 0.73 the topmost covered row ran 353 356 350
   * 361 360 373 across the tail root, a monotone descent with no notch in it
   * at all, and at 1.05 it runs 359 362 342 351 353 364, which steps back UP
   * by 20 px behind the waist. That step is the notch, and it is the thing
   * that was missing.
   *
   * COSTS, stated rather than buried: the animal's total coverage grows 4.3%
   * at `profile` (bible 4f rule 4 is about the body, but it cuts both ways),
   * and 152 mm is 1.52x bible 4's own 0.10 m figure. Lowering tailBase below
   * 0.40 was swept too -- 0.30 buys 0.11 more on the ratio -- and is NOT
   * shipped, because 18 mm at the root is the number that was verified not to
   * expose skin under bible 4f rule 3 and 13.5 mm is below the hock's 16.8.
   *
   * The croup hypothesis is disproved and must not be re-tested: deepening
   * or pulling back the croup coat (region 16) does not move the notch at
   * all. Only the tail's own coat does. Measured by sweeping region 24's
   * lengthScale alone on the exact matte at `profile`, dorsal-contour
   * convexity deficiency: 1.14 -> 26.1 px, 0.58 -> 32.2, 0.40 -> 37.7,
   * 0.25 -> 42.0. Monotone, and visible in the render at every step.
   *
   * The PROFILE across the three regions is the point, not the three numbers
   * separately: shallow at the root so the tail has a waist where it leaves
   * the croup's 43.8 mm, deep through the middle so the brush has mass, and
   * only slightly tapering at the tip, because a tail that tapers to a point
   * is a whip. 18 mm at the root is still deeper than the hock's 16.8 mm, so
   * it does not expose skin (bible 4f rule 3) -- verified on the matte.
   */
  /*
   * freqScale (b[1]) follows the tail's new size, per this table's own rule:
   * it exists so "the hairs stay in proportion to the body part". The brush
   * went from 182 mm across to 120 mm and its hair field did not, so the
   * strands were suddenly coarse relative to it -- spec's tail-detail probe
   * read 1.17 levels before the resize and 1.06 after. 1.30 is the ratio the
   * render supports: 1.70 resolves into noise rather than hair. clumpScale
   * (b[0]) stays BELOW 1 on purpose; big locks are what a brush is.
   */
  /* 24 tailBase      */ { a: [1.04, 0.40, 0.45, 0.34], b: [0.85, 1.30, 1.00, 1.70] },
  /* 25 tailMid       */ { a: [1.06, 1.05, 0.30, 0.42], b: [0.78, 1.30, 1.00, 2.10] },
  /* 26 tailTip       */ { a: [1.04, 1.30, 0.34, 0.36], b: [0.82, 1.30, 1.00, 1.85] },
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
  /*
   * Shells below this share of shellFill take the cheap path in the shell
   * fragment shader: no strand/micro/clump field, no per-strand cylinder
   * normal, no specular or transmission lobe. They are solid felt with the
   * whole coat stacked above them, so nothing they compute can reach the eye.
   *
   * It was a literal 0.40. It is a knob now because the frame budget stopped
   * having headroom -- `high` measures 16.70 +/- 0.06 ms against a 16.7 ms
   * budget, so the gate's own pass/fail is a coin flip at HEAD and anything
   * added to the coat has to be paid for. Interleaved in one page session at
   * audit's exact measurement (1280x800, high, hero, D.step + D.render x40
   * behind a readPixels fence), 4 reps:
   *
   *     uShellDeep   frame ms   profile coverage   head/body/legs p10   macro fine
   *       0.40        16.70         189 731        1.151/1.899/1.764       5.374
   *       0.55        16.42         189 731        1.151/1.899/1.764       5.238
   *       0.70        16.22         189 732        1.151/1.899/1.764       5.083
   *       0.80        16.01         189 734        1.151/1.899/1.764       4.872
   *
   * The silhouette is untouched -- coverage moves by 3 px in 190 000 and the
   * three contour bands are identical to three decimals, because the outer
   * shells are the ones on the outline and this only reaches the inner ones.
   * What it does cost is interior detail at MACRO, where the coat is hundreds
   * of pixels deep and you can genuinely see into it: 2.5% of the fine-detail
   * measure at 0.55, 5.4% at 0.70, 9.3% at 0.80. 0.55 is the value whose
   * saving (0.28 ms, 6% of the shells' own 4.30 ms) is worth that, and it is
   * seven times the 0.04 ms that cardHairs 2.4 costs.
   *
   * For scale, measured the same way: the shells cost 4.30 ms of the frame,
   * the cards 0.51 ms, and everything else on the screen 12.44 ms.
   */
  shellDeep: 0.55,
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
  /*
   * Saturation of the AMBIENT term only (furShade: amb is mixed toward its own
   * luma, so this is luminance-preserving and leaves the sun and the rim
   * alone). 1.0 put the coat's bulk at B-R +34 against bible 3's shaded-fur
   * swatch #b9c7d8, which is B-R +31; 0.70 lands it on +31 exactly. Measured
   * with spec.mjs's own sampler, six arms in one page session at one instant:
   *
   *     ambientSat   coat B-R   snow B-R   excess (want <= 10)   coat/snow L
   *       1.00         33.9       24.4          9.5                 0.849
   *       0.85         32.4       23.5          8.9                 0.845
   *       0.70         30.8       23.0          7.8                 0.843
   *       0.55         29.2       22.6          6.6                 0.841
   *
   * skyHorizon moves the same number about as far (0.75 -> 30.0) but it is
   * the sky-vs-bounce MIX, tuned in its own comment against the same swatch,
   * so the saturation is the honest place to take this.
   *
   * The target is the swatch, not the threshold. Bible 4b's "shaded fur goes
   * blue-grey, never pink" still binds: at 0.70 the coat is 31 levels bluer
   * than it is red, which is blue-grey.
   */
  ambientSat: 0.70,
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
  /*
   * Absolute guard-hair stand-off past the coat, metres, and the share of it
   * the SHORTEST lock gets. cardFloorLow 1.0 means every lock gets all of it,
   * i.e. the draw is OFF and this is the constant floor f1fb47a shipped.
   *
   * MEASURED NEGATIVE, recorded so it is not re-run. Making the stand-off
   * vary per lock is the obvious fix for "no variation in length" and it
   * looks right in a crop, and it costs the silhouette more than it buys.
   * Three configurations against the constant, all on tools/spec.mjs:
   *
   *   peak 12 mm, low 0.45, pow-1.5 draw (mean 8.0 mm)
   *       matte at profile  body 1.262 -> 1.100  legs 1.162 -> 1.045   FAIL
   *       frontal leg band  1.208 -> 1.047                             FAIL
   *   peak 12 mm, low 0.60, pow-1.5 draw (mean 9.1 mm)
   *       spec's own blindness control tripped -- coated 1.462 against a
   *       bare-mesh 1.224, needs 1.25x -- and SKIPPED five checks, so the
   *       run returned 29 checks instead of 34 and read as an improvement.
   *   peak 12 mm, low 0.50, sqrt draw: mean EXACTLY the 10 mm it replaces
   *       control tripped again, 1.390 against 1.226. 28 checks.
   *
   * So it is not the mean. A per-lock draw lowers the 10th-percentile row by
   * construction -- p10 finds the rows whose locks came up short -- and every
   * silhouette check here is a p10. The knob is left in place with the draw
   * off because the next agent will otherwise reach for it too; if it is to
   * be revived, the variation has to be UPWARD of the current constant, and
   * CARD_SHAPE.standFloorMax leaves only 20% of headroom for that.
   *
   * COUNT THE CHECKS in any spec run that touches this. Two of the three
   * arms above deleted checks rather than failing them.
   */
  cardFloor: 0.010,
  cardFloorLow: 1.00,
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
  /*
   * GUARD-HAIR SHAPE. The two knobs behind bible 5's "curvature under the
   * hair's own weight" and the critic's "frizzy uniform needles radiating
   * outward ... no gravity, no crossing".
   *
   * cardCurve reparametrises a card ALONG ITSELF and moves its tip by exactly
   * nothing: both the normal and the tangential term are mixed between the
   * old shape and a hooked one that agrees with it at v = 0 and v = 1. The
   * hair leaves the skin more steeply (v^0.70 instead of v) and does all of
   * its combing over in the outer third (v^2 * (1.32 - 0.32 v) instead of
   * v * (0.42 + 0.58 v)). That matters here specifically because every
   * silhouette metric on this project is a 10th percentile over scanlines of
   * the OUTERMOST coverage, so a shape change that holds the tip fixed cannot
   * lower one -- which is the trap f88f36e documented for the stand-off, and
   * the reason this is a reparametrisation rather than more `lay`.
   *
   * cardDroop is gravity for guard hair only, in addition to what furDynamics
   * already applies through CARD_SHAPE.droopBoost. It is separate from uDroop
   * because uDroop also drives the shells, and the shells' hair is undercoat.
   * This one DOES move the tip, downward -- which is nearly free on the same
   * metrics for the opposite reason: they scan rows horizontally, so vertical
   * sag is perpendicular to every ramp they measure.
   *
   * Swept together on the exact coverage matte at `profile`, one page session,
   * one instant. `flat` is cardCurve 0 / cardDroop 0, i.e. byte-for-byte the
   * shape that shipped before this:
   *
   *   arm                       coverage   head p10   body p10   legs p10
   *     flat (the old shape)     158 590     1.069      1.559      1.458
   *     curve 1.0, droop 0       163 960     1.112      1.917      1.871
   *     curve 0,   droop 0.28    158 790     1.000      1.679      1.602
   *     curve 1.0, droop 0.28    163 xxx     1.112      2.493      1.871
   *     curve 1.0, droop 0.55    165 313     1.105      2.453      2.038  <-
   *     curve 1.0, droop 0.90    167 629     1.052      3.053      1.949
   *
   * Every band improves, which is the opposite of what the last three
   * attempts at hair character cost, and it is not an accident: the curve
   * holds the tip and the sag is perpendicular to the scan.
   *
   * 0.90 is where it stops being fur. The coat combs into a straight vertical
   * curtain and loses its loft -- it reads wet, and the ear rims go from a
   * fringe to a pompom (shots/fur-look1/nape.curvedroop90.png against
   * nape.curvedroop55.png). The metrics do not see that: 0.90 has the best
   * body p10 in the table. This is a case where the render decides and the
   * number only keeps it honest.
   */
  cardCurve: 1.0,
  cardDroop: 0.55,
  // Fraction of a card's lateral distance to its lock's site taken out by the
  // tip. 0 restores the pre-clump coat (an even spray of independent hairs);
  // much above 0.7 the locks pinch to points and the coat reads wet.
  cardClump: 0.55,
  /*
   * HAIRS PER CARD, as a multiple of the authored 2-5. 1.0 is byte-for-byte
   * the coat that shipped before this.
   *
   * "The coat reads shaggy -- long clumped strands hanging down, a wet
   * sheepdog rather than a dense arctic fox pile." Attributed first, on the
   * shaded frame at `profile` in one page session at one instant: hiding the
   * CARDS leaves a soft granular mass with no strands in it at all, so the
   * strands are cards and not the shells' hair field. Measured at the
   * framing the harness actually ships (2100x1350 backbuffer, i.e. shoot's
   * 1400x900 at dsf 1.5 -- at 1280x800 the same arms are indistinguishable),
   * a visible strand is 4-7 mm wide and 45-90 mm long against a 47 mm flank
   * coat. That aspect ratio IS the defect.
   *
   * The two knobs that shorten a strand both cost the outline, and the price
   * is the one already refused for the head band:
   *
   *     arm                      coverage   head p10  body p10  legs p10
   *       shipped                 158 589     1.110     1.733     1.487
   *       uCardFloor 0            146 575     1.000     1.128     1.058
   *       uCardLength 1.20->1.05  149 192     1.101     1.220     1.393
   *
   * -7.6% and -5.9% of the animal, and the body band collapses. Not bought.
   *
   * The knobs that are free do not move it. At 2100x1350, coverage and all
   * three bands within their own run-to-run noise, and the render identical
   * to the eye: uCardClump 0.55 -> 0 / 0.15 / 0.30, uClumpAO 0.75 -> 0,
   * uClumpPull 0.74 -> 0.30. And uCardTipEdge, which this file's own comment
   * calls "the one number that decides how much card is visible over the
   * INTERIOR", is a no-op on a body seen side-on: vEdge -> 0 there, so
   * pow(vEdge, anything) -> 0 and the mix lands on uCardInner whatever the
   * exponent is. 1.40 -> 2.0 -> 3.0 moved the interior luminance by 0.01 of
   * 159. uCardInner 0.17 -> 0 is the term that actually fades interior cards
   * (interior contrast 3.79 -> 3.31), and it fades them everywhere without
   * touching the strands on the outline, which is where the shag reads.
   *
   * So: leave the geometry alone and raise the HAIR count inside it. The card
   * budget is a performance budget now (16.63 ms against 16.7 at the high
   * tier), so more cards is not available -- but more hairs per card is free.
   * Same vertices, same draw call, same fragments, same covered area; only the
   * per-hair cell inside a card gets narrower. Measured at `profile`,
   * 2100x1350, one session, one instant:
   *
   *     uCardHairs  coverage   interior contrast  head p10  body p10  legs p10
   *       1.0        426 454         5.298          1.133     2.188     2.168
   *       1.6        427 147         5.026          1.244     2.596     2.213
   *       2.4        426 966         4.775          1.223     2.427     2.384
   *       3.5        427 130         4.564          1.244     2.357     2.363
   *
   * Coverage is flat to +0.1% and every band holds or improves, so this is not
   * bought with silhouette. The interior contrast falling is the point: the
   * same mass, resolved into more and finer hairs, stops reading as separated
   * locks. 3.5 reads denser still and is NOT shipped, because at MACRO the
   * hairs start going sub-pixel and the card LOD dissolves them to a flat
   * ribbon -- fine detail at `macro_eye` runs 5.341 (1.0), 5.401 (2.4), 5.198
   * (3.5), so 2.4 is the largest value that costs the macro framings nothing.
   *
   * WHAT THIS DOES NOT FIX, so it is not claimed: the strands are still 45-90
   * mm long, because nothing here moved a card. The coat reads as fine long
   * fur rather than as a wet sheepdog; a genuinely compact winter pile needs
   * the strand SHORTER, and the only two terms that do that are priced above.
   */
  cardHairs: 2.4,
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
    uShellDeep: { value: d.shellDeep },
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
    uCardFloorLow: { value: d.cardFloorLow },
    uCardInner: { value: d.cardInner },
    uCardTipEdge: { value: d.cardTipEdge },
    uCardJitter: { value: d.cardJitter },
    uCardClump: { value: d.cardClump },
    uCardCurve: { value: d.cardCurve },
    uCardDroop: { value: d.cardDroop },
    uCardOpacity: { value: d.cardOpacity },
    uCardHairs: { value: d.cardHairs },
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
