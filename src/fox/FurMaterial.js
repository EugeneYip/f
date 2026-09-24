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
/**
 * Per-region multiplier on uCardFloor, the ABSOLUTE guard-hair stand-off
 * (uCardFloorScale in the card vertex shader). 1.0 = the global floor.
 *
 * THE FLOOR IS WHY THE HAIR IS THE SAME LENGTH EVERYWHERE. It exists for a
 * good reason -- "a fox's guard hairs over the muzzle, brow and cannon are not
 * proportionally shorter than the ones over its flank, they stand out of a
 * much shallower undercoat" -- but as a single global number it tops every
 * shallow region up to the SAME absolute reach, which is the mechanism behind
 * the review's "the length and direction are identical on the shoulder, flank,
 * haunch, cheek and muzzle" and behind 4h's lost muzzle/skull contrast:
 *
 *     region    coat mm   stand mm   drawn hair mm    vs skull
 *       muzzle    10.4      8.96         23.2           2.1 : 1
 *       skull     33.9      6.61         48.6              --
 *
 * against a coat contrast of 3.3:1 that anatomy authored on purpose. Bible 5
 * puts the muzzle, the paws and the forehead at 2-6 mm of hair; 23 mm is not
 * that, and the floor is the whole of the difference.
 *
 * THE TABLE IS EMPTY, AND THAT IS A MEASURED RESULT, NOT AN OVERSIGHT. The
 * obvious first entry is the muzzle, and it is in DIRECT CONFLICT with review
 * blocker 1: the muzzle's 23 mm of guard hair is what stops its silhouette
 * being bare mesh. Four-direction contour scan on the coverage matte at
 * `profile`, 1400x900, one page session, one instant, muzzle band x 361..488
 * (the residual 11 are the rhinarium and uNoseFade's own ramp, which 4f rule
 * 3 allows to be bare):
 *
 *     muzzle / jaw floor scale   bottom cliffs   top cliffs   median ramp
 *       1.00 / 1.00  (shipped)      11 / 114       3 / 114       13 px
 *       0.50 / 0.65                 14             7              8
 *       0.25 / 0.45                 19            10              6
 *       0.10 / 0.30                 22            13              6
 *
 * AND MORE CARDS CANNOT PAY FOR SHORTER ONES. Holding the floor at 0.50 and
 * raising the muzzle card weight from the shipped 4.5/3.8 to 6.0/5.0 and then
 * 9.0/7.0 leaves the bottom cliffs at 15 either way, and taking that many
 * cards off the body costs the whole outline: the frame's top-scan cliffs go
 * 7 -> 23 and left p10 1.347 -> 1.285. Density does not substitute for reach
 * at a contour; it is the reach that puts hair over sky.
 *
 * So the two requirements are genuinely opposed at the muzzle, and blocker 1
 * wins -- the same resolution 4h itself reached when rule 2 and rule 3 could
 * not both hold there. The contrast stays at 2.1:1 and is a known debt.
 *
 * The lever is left wired for regions where the conflict does NOT bite; they
 * have not been measured yet. It is bounded the same way the global floor is:
 * reachReport()'s clause B now tests uCardFloor x max(scale) against
 * CARD_SHAPE.standFloorMax, so raising a scale above 1.0 is not a way around
 * the cap, and reachReport reads the table per region. The mistake
 * CARD_LEN_SCALE made was a guard that could not see the table it was meant
 * to bound; it is not repeated here.
 */
export const CARD_FLOOR_SCALE = {
  // empty on purpose -- see above. 1.0 is the global floor.
};

/**
 * Per-region share of `cardInteriorLen`, the card-length multiplier that is
 * applied AWAY from the outline (uCardIntMix in the card vertex shader).
 *
 * 1.0 = the global value · 0 = exempt · above 1 extrapolates, i.e. that
 * region's interior coat is shorter still. See the long note in the card
 * vertex shader for why an interior card and a contour card are not the same
 * card: for a smooth surface the outline is exactly where N.V = 0, so the
 * cards that can put hair over sky and the cards that make the flank read as
 * separated strands are disjoint sets, and length can be cut in one without
 * being cut in the other. Every earlier attempt on the review's "long combed
 * hair" cut both at once and paid 6-8% of the animal for it.
 *
 * TWO KINDS OF EXEMPTION, both measured, both for the same reason -- vEdge is
 * a poor outline test on a THIN PLATE. The card fragment shader already
 * carries this warning for uCardInner: on the ear pinna seen face-on the
 * surface faces the camera over its whole extent INCLUDING the rim that has
 * to break the outline, so an interior/outline split keyed on vEdge would
 * shorten the rim fringe with the rest. The ears are therefore exempt, and
 * the nose is exempt because its coat is uNoseFade's and not a length
 * question at all.
 */
/*
 * AND THIS TABLE IS WHERE THE COAT STOPS BEING THE SAME LENGTH EVERYWHERE.
 * Review 4 on blocker 5: "the damning detail is uniformity -- length and
 * direction are identical on the shoulder, flank, haunch, cheek and muzzle",
 * and section A calls it suspicious evenness. ac5ed4c named the mechanism
 * (uCardFloor is one global absolute stand-off) and had to leave its own
 * lever empty, because cutting the muzzle's reach is in DIRECT CONFLICT with
 * blocker 1 -- that reach is what stops the muzzle's silhouette being bare
 * mesh, and the numbers it measured show the conflict is real:
 *
 *     muzzle / jaw floor scale   bottom cliffs   top cliffs
 *       1.00 / 1.00  (shipped)      11 / 114       3 / 114
 *       0.25 / 0.45                 19            10
 *
 * The interior/outline split dissolves that conflict, because the two
 * requirements were never about the same hair. Shortening a region here
 * touches only the cards that cannot be on its contour at any framing, so
 * blocker 1's fringe is kept at full reach while 4h's short muzzle coat is
 * restored over the part of it you look at. Measured at `profile`, 2100x1350,
 * one session, one instant, the whole table below against a flat 1.0:
 * coverage 416 498 -> 416 598 and the four contour p10s 1.562/2.156/1.917/
 * 1.856 -> 1.562/2.191/1.917/1.901. It is free.
 *
 * With cardInteriorLen 0.30 the drawn interior multiplier is 1 + mix*(0.30-1),
 * floored at 0.12 in the shader:
 *
 *     mix 0.55 -> 0.615 · 0.75 -> 0.475 · 1.00 -> 0.300 · 1.20 -> 0.160
 *
 * so the muzzle's 23.2 mm of drawn guard hair becomes 3.7 mm over its own
 * flat, against the skull's 48.6 mm becoming 29.9 -- 8:1 where it reads,
 * against the 2.1:1 ac5ed4c had to accept, and bible 5's 2-6 mm for muzzle,
 * paw and forehead hair. The skull, ruff and tail are held back deliberately:
 * 4h's contrast is between a SHORT muzzle and a DEEP skull, and the tail has
 * to stop reading as a constant-diameter extension of the torso.
 */
export const CARD_INTERIOR_MIX = {
  0: 0.0,                     // nose -- uNoseFade owns this coat
  1: 1.20, 2: 1.10,           // muzzle, jawLower -- bible 5's 2-6 mm
  3: 1.00,                    // cheek
  4: 0.75, 5: 0.55,           // forehead, skull -- 4h's deep skull
  6: 0.60, 7: 0.60,           // ears: see below
  8: 0.85, 9: 0.90, 10: 0.60, // throat, neck, ruff -- the ruff reads deep
  11: 0.85, 12: 1.00, 13: 0.95, 14: 1.00, 15: 0.90, 16: 0.95, 17: 1.00,
  18: 1.00, 19: 1.15, 20: 1.25,      // front leg, cannon, paw
  21: 1.00, 22: 1.15, 23: 1.25,      // hind leg, hock, paw
  24: 0.60, 25: 0.55, 26: 0.55,      // tail -- a brush, not a flank
};
/*
 * THE EARS ARE THE ONE ENTRY WITH A MEASURED COST, and they are here rather
 * than exempt because the review asks whether their raggedness is fur's. It
 * is: cropped at `portrait`, the pinna is a mass of 60-120 px spikes
 * radiating off its FACE as well as its rim, with no defined edge anywhere.
 * At 1.0 the near pinna gets a body again and the fringe retreats to the rim.
 * The cost, at `portrait` / `profile` in the same session:
 *
 *     ear mix   portrait coverage   top p10   left p10   profile left p10
 *       0.0          1 363 398       2.836      1.429         1.562
 *       0.5          1 359 473       2.714      1.390         1.562
 *       1.0          1 358 379       2.622      1.390         1.520
 *
 * 0.60 is taken rather than 1.0 because of the warning the card fragment
 * shader already carries for uCardInner and this file for CARD_INNER_FLOOR:
 * on a thin plate seen FACE-ON, vEdge is low over the rim as well as the
 * middle, so the split cannot tell the ear's outline from its interior at
 * the frontal framings -- and those are not the framings measured above.
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
  /*
   * 1-2 THE MUZZLE'S CARD BAND, which did not exist. Review blocker 1: the
   * muzzle's silhouette is bare mesh -- "a razor-sharp hairless wedge".
   *
   * IT DOES NOT SHOW UP IN ANY CHECK WE HAVE, and that is the first half of
   * the finding. tools/matte.mjs and tools/spec.mjs walk in from the LEFT, row
   * by row; at `profile` the muzzle is a near-horizontal wedge whose contour is
   * entirely TOP and BOTTOM, so no row scan ever crosses it. Scanned in all
   * four directions on the same matte at 1400x900:
   *
   *     arm        left p10  right p10  top p10  bottom p10   bottom cliffs
   *       coat       1.205     1.757     1.377     1.395        32 / 819
   *       COAT OFF   1.000     1.000     1.000     1.000       755 / 779
   *       CARDS OFF  1.000     1.000     1.000     1.000       458 / 820
   *
   * and the muzzle band alone (x 361..488, nose anchor at 381, jaw at 478)
   * read 29 of 114 BOTTOM columns at tv 1.000 with a 0-1 px ramp.
   *
   * SECOND HALF: the statistic itself was dropping cliffs. matte.mjs records a
   * row only if net = |cov(x90) - cov(x2)| > 0.3 -- but on a perfectly hard
   * edge the first sample over 0.02 is ALREADY over 0.90, so x90 == x2, net is
   * 0, and the row is discarded. With the whole coat hidden only 56 of ~400
   * rows survived that filter, and the bare mesh scored a clean p10 on the 56
   * that did. A cliff has to SCORE 1.000, not be deleted. The CARDS OFF row
   * above is the control that proves the corrected statistic separates: 458 of
   * 820 bottom columns are cliffs with the cards hidden, against 32 with them.
   * (It also says the shells alone do NOT break their own outline, which the
   * SHELL_LEN_SCALE note above claims they do.)
   *
   * THE FIX IS DENSITY, AND IT IS FREE. cardWeight redistributes a FIXED card
   * budget, so triangles, draw calls and fill are all unchanged -- which
   * matters because `high` sits on its 16.7 ms budget. Swept live by mutating
   * REGION_TABLE and calling FurSystem._buildCards(), one page session, one
   * instant; the seed is fixed, so a rebuild with unchanged weights is a
   * control and it came back byte-identical to base:
   *
   *     muzzle / jaw cardWeight   muzzle bottom cliffs   frame bottom cliffs
   *       1.20 / 1.10 (was)            29 / 114               32 / 819
   *       3.00 / 2.60                  13 / 114               23 / 819
   *       4.50 / 3.80 SHIPPED          11 / 114               17 / 819
   *       6.00 / 5.00                  11 / 114               17 / 819
   *
   * and at 4.50 the residual eleven are x 375-381 and x 387-390 -- the
   * rhinarium and uNoseFade's own 4-7 mm ramp, which bible 4f rule 3 names as
   * one of the three places bare skin is allowed. Everything from x=396 back
   * now ramps over 4-19 px. 6.00 buys nothing further, so it is not taken.
   * The rest of the outline does not pay: left p10 1.205 -> 1.164, right
   * 1.757 -> 1.641, both inside this statistic's run-to-run spread, and the
   * frame's total cliff count falls.
   *
   * WHAT THIS DOES NOT FIX. 4h's contrast between a short muzzle coat and a
   * deep skull coat is real and the CARDS are what erased it, not the coat.
   * Coat depth is 10.4 mm on the muzzle against 33.9 on the skull, 3.3:1 as
   * intended -- but uCardFloor is an ABSOLUTE 10 mm stand-off applied
   * globally, so it tops the muzzle's hair up by 8.96 mm and the skull's by
   * only 6.6, and the drawn guard hair comes out 23.2 mm against 48.6, i.e.
   * 2.1:1. The floor is the term that flattens every region's hair toward one
   * length. Making it per-region is the fix and it is not this change.
   */
  /* 1 muzzle        */ { a: [0.98, 1.40, 0.60, 0.10], b: [1.55, 1.60, 0.90, 4.50] },
  /* 2 jawLower      */ { a: [0.98, 1.00, 0.80, 0.18], b: [1.40, 1.30, 0.90, 3.80] },
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
  /*
   * 12-16 THE TOPLINE, and why the coat cannot put a withers or a croup on it.
   *
   * The reported defect: at `profile` the matte topline descends from the ear
   * tip monotonically and then goes FLAT across the back -- no withers rise,
   * no croup rise, which is what makes the animal read as a guinea pig at
   * `hero_long` and a wolverine at `paws`. A canid profile is ears, poll dip,
   * WITHERS rise, level back, CROUP rise, tail drop.
   *
   * Measured on the coverage matte at `profile`, one page session, one
   * instant, as TURNING POINTS of top[x] rather than as column heights.
   * Withers = the highest point between chest and spine04+20; saddle = the
   * lowest point between there and spine01; croup = the highest point between
   * spine01 and tail01:
   *
   *     arm             withers    saddle     croup    withers rise  croup rise
   *       coat          296@529   329@605   313@710        33            16
   *       COAT HIDDEN   334@529   353@601   346@706        19             7
   *       back x0.80    296@529   335@619   316@706        39            19
   *       shoulder x1.50  -- identical to the coat row, to the pixel --
   *       croup x1.50     -- identical to the coat row, to the pixel --
   *
   * TWO THINGS, and they point in opposite directions.
   *
   * 1. THE WITHERS IS NOT A TURNING POINT AT ALL, on the coat or on the bare
   *    mesh. In every arm the highest point inside the withers window lands
   *    exactly on the window's LEFT EDGE (x=529), which is what a window
   *    maximum does when the curve through it is still monotonically
   *    descending. There is no bump to find. The bare mesh has none either,
   *    so the coat is not hiding one -- the skin's own topline runs downhill
   *    from the poll into the mid-back saddle. That is anatomy's.
   *
   * 2. THE CROUP RISE IS REAL AND THE COAT ALREADY DOUBLES IT: 7 px on the
   *    bare mesh, 16 px with the coat. So the coat is not flattening this one.
   *
   * AND THE COAT HAS NO LEVER ON EITHER. Deepening region 12 (shoulder) by
   * 50% or region 16 (croup) by 50% moves the topline by ZERO pixels -- the
   * three turning points are identical to the pixel -- and adds only 327 and
   * 249 px of coverage in 158 635. Those regions are LATERAL here; they are
   * barely on the profile outline. Cutting region 13 (back) by 20% moves the
   * saddle 6 px and costs 1259 px. So the whole dorsal contour from withers
   * to croup is ONE region with ONE depth, and a region table cannot carve a
   * withers into it however the numbers are set. The region assignment is
   * FoxAnatomy's and FoxSurface's, not this file's.
   *
   * If a later agent wants the coat to carry the topline, the prerequisite is
   * a dorsal region split, not a number here.
   */
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
   *
   * ----------------------------------------------------------------------
   * RE-MEASURED AND RE-REFUSED, with the dense coat and 14 shells.
   *
   * The brief for this wave asked whether 0.55 -> 0.85 was worth taking now
   * that the cards carry far more of the pile (band fill 0.243 -> 0.416), and
   * asked for the detail cost to be re-measured rather than inherited. It is
   * worse than the 7% my predecessor refused, and the reason the old number
   * understated it is that it was read at macro_eye, which is not where this
   * defect lives.
   *
   * Frame, paired ABBA at hero/idle/high/1280x800, six interleaved
   * measurements per arm, minimum over them:
   *
   *     0.55   15.960 min   16.160 med
   *     0.70   15.760       16.050      -0.200 / -0.110 ms
   *     0.85   15.570       15.700      -0.390 / -0.460 ms
   *
   * Look, same protocol, mean |p - blur3(p)| over the eroded coverage
   * interior -- and measured at the NAPE as well as the cheek, because §4b's
   * waxy-interior defect is named at cheek, skull AND nape:
   *
   *     arm      portrait fine   nape fine     nape coarse
   *      0.55       2.766          1.520          1.905
   *      0.70       2.757          1.491 -1.9%    1.970
   *      0.85       2.613 -5.5%    1.207 -20.6%   2.042 +7.2%
   *
   * 0.85 costs a FIFTH of the nape's fine detail and adds 7% to its coarse
   * detail -- fine energy out, coarse energy in, which is the waxy failure
   * getting measurably worse at the exact region the review names. Refused
   * again, and now there is no case for it at all: the shell-spacing ceiling
   * pays 0.93-1.07 ms rather than 0.39 and pays it in the other direction on
   * detail. 0.70 is nearly free on both counts (-0.20 ms, -0.3%/-1.9%) and is
   * the arm to reach for first if a later wave needs half a millisecond.
   */
  shellDeep: 0.55,
  fillTop: 1.12,
  fillJitter: 0.30,
  cardTip: 0.45,
  coatVarFreq: 15,
  /*
   * The strand octave's own LOD band, cells per pixel: full strength below x,
   * gone above y. THIS IS THE WAXY CHEEK AND NAPE.
   *
   * The shared octaveFade dissolves an octave between 0.13 and 0.40 cells per
   * pixel, i.e. cells of 7.7 px down to 2.5 px. The strand layer is the one
   * carrying the hair, and on the FACE (region freqScale 1.3-1.6, so cells of
   * 0.58-0.72 mm) the portrait framing puts it at 0.38 cells per pixel -- a
   * 2.6 px cell, 98% dissolved. 0.25/0.50 is chosen so the octave is fully
   * gone by a 2 px cell, which is point-sample Nyquist: it restores an octave
   * that was being thrown away an octave early and it asks nothing of TAA
   * that the coat's stochastic alpha did not already ask.
   *
   * MEASURED, one page session per row, arms alternated, mean |p - blur3(p)|
   * over the eroded coverage interior:
   *
   *     band            portrait fine   nape fine
   *       0.13 / 0.40       2.904         1.520      (the shared band)
   *       0.25 / 0.50       4.058 +40%    2.034 +34%
   *       0.22 / 0.55       4.007         2.065
   *       0.30 / 0.70       4.425 +52%    2.181 +44%
   *       0.36 / 0.85       4.484         2.300
   *
   * with coverage flat to 0.15% and band fill flat to 0.5% in every arm. The
   * curve is nearly flat past 0.50, so the wider bands buy little and spend
   * it on cells below 2 px. Not taken.
   *
   * It changes nothing at body range: at `hero` and `profile` the strand
   * cells are already 1.1-1.3 cells per pixel and the layer is off under
   * either band, so this costs nothing in the frame budget.
   */
  strandFade: [0.25, 0.50],

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

  /*
   * Whether the guard-hair sag is allowed to change how far a card stands off
   * the skin. 1 = no (the normal component is projected out in BOTH
   * directions); 0 = the old asymmetric clamp, which removed it only where it
   * pointed outward.
   *
   * THIS IS THE TOPLINE, AND IT IS THE LARGEST SINGLE CONTOUR DEFECT IN THE
   * BUILD. `contour has no bare run at profile` fails on all four edges, and
   * mapping every failing scan back onto the coverage matte puts the top
   * edge's failures in one place: the dorsal line from the withers to the
   * croup, and the top of the tail. Nowhere else on the animal faces up.
   *
   * The cause is the sign the old clamp did not consider. Gravity is world
   * -Y; on the flank the normal is horizontal so the sag is tangential and
   * combs the hair down, on the belly the normal points down so the outward
   * component was clamped away -- and on the BACK the normal points up, the
   * sag's normal component points straight into the skin, max(0, .) is 0, and
   * the whole of it survived as a subtraction from reach. The dorsal card
   * kept under half the stand-off the identical card gets on the flank.
   *
   * Measured on the exact coverage matte, spec.mjs's own scan (1920x1200,
   * 1.48 px/mm, 1.5 mm box filter, cliffs scored 1.0), both arms in ONE page
   * session at ONE simulation instant, `profile`:
   *
   * ABBA, four arms in the order 0 1 1 0, so the two readings of each value
   * bracket the other arm and the run-to-run spread is visible in the table
   * itself rather than asserted. BOTH gravity terms are covered -- this one
   * and the copy furDynamics already put into W:
   *
   *     quantity            sym 0  sym 0     sym 1  sym 1
   *     top    % bad         22.6   23.9       9.5    8.4    -61%
   *     top    cliffs          35     42         5      6    -86%
   *     right  % bad         14.0   13.4       4.4    2.2    -76%
   *     left   % bad          8.8    9.4      10.5    9.3    unmoved
   *     bottom % bad          7.0    6.7       7.8    7.8    unmoved
   *     head   worstP10     1.000  1.106     1.512  1.608    clears 1.15
   *     legs   worstP10     1.991  2.035     2.705  2.558
   *     body   worstP10     1.000  1.000     1.000  1.000    still fails
   *
   * The topline also gets measurably TALLER: the topmost covered row moves
   * from y 384/383 to y 372/369 on a 615 px animal, which is the 12 px of
   * stand-off gravity was taking off the back.
   *
   * The two edges that move are exactly the two that see an upward-facing
   * surface at this framing -- the topline, and the right edge where it wraps
   * the croup and the top of the tail. The two that do not move are the ones
   * whose surfaces face down or sideways, where the old clamp was already
   * doing the right thing. That pattern is the check on the mechanism: a
   * change that improved everything equally would not be this term.
   *
   * It is free: no geometry, no fill, one mix() in the card vertex shader.
   */
  cardDroopSym: 1.0,

  /*
   * THE INTERIOR COAT'S LENGTH, as a multiple of the outline coat's.
   *
   * Review blocker 5: "the coat is long combed hair, not a dense pile --
   * long straggly individually-resolvable strands with dark gaps between
   * them, ON THE INTERIOR of the body, not just at the silhouette". 250d67e
   * attributed the strands to the CARDS (hiding them leaves a granular mass
   * with no strands anywhere) and then priced the only two knobs that shorten
   * one: uCardFloor 0 costs 7.6% of the animal's coverage and uCardLength
   * 1.20 -> 1.05 costs 5.9%, both of which also collapse the body band. That
   * is what this number is for -- it shortens a card only where the card
   * cannot be on the outline, so the outline does not pay.
   *
   * cardEdgeLen is the vEdge band it ramps out over. The upper end is where a
   * card starts being able to reach the contour; see the geometry in the card
   * vertex shader.
   */
  /*
   * MEASURED, `profile`, 2100x1350, one page session, one instant, against a
   * `nocards` positive control in the same session. "STRAND" is the rms of
   * the 4/8/16 px octaves of luminance inside the coverage matte eroded by
   * 25 px -- the animal's INTERIOR, with the whole fringe and everything the
   * contour metric grades removed, so the two instruments cannot be reading
   * the same pixels:
   *
   *   arm                 interior   STRAND   coverage   L/R/T/B contour p10
   *     base                141.5     6.289    419 063   1.510 2.072 1.746 1.791
   *     0.30 / [.40,.62]    131.2     3.551    416 009   1.532 2.018 1.720 1.651
   *     NO CARDS AT ALL     131.2     3.344    339 457   1.000 1.000 1.000 1.000
   *
   * The interior lands on the cards-free coat to a tenth of a level and the
   * strand band to 6%, while the outline keeps 96% of what the cards
   * contribute to it -- 0.9% of the animal against the 7.6% and 5.9% that
   * uCardFloor 0 and uCardLength 1.05 cost for the same interior effect in
   * 250d67e. All four contour p10s stay far above 4f's 1.15 floor and the
   * frame's cliff count falls 1844 -> 1839.
   *
   * THE BAND. Pushed one notch further out, [0.62, 0.74], the left p10
   * collapses 1.440 -> 1.000 and coverage falls 0.42%: that is the measured
   * position of the "a card can still reach the contour" boundary and it
   * agrees with the cylinder estimate in the shader to within a tenth. 0.62
   * is inside it. [.40,.62], [.45,.58] and [.50,.62] are equivalent on every
   * number above; the widest ramp is taken because the transition from
   * granular interior to hairy outline is a thing you can see.
   *
   * THE LENGTH SATURATES. 0.40 and 0.25 read 153.1 and 152.4 at `portrait`:
   * below about 0.4 the card is already inside the shells and shortening it
   * further removes nothing more. 0.30 sits under that knee with margin and
   * is not the smallest value that works, which is deliberate -- a card that
   * is merely hidden is cheaper to get wrong than one that is annihilated.
   *
   * WHAT IT DOES NOT FIX, measured in the same table: the interior is now
   * 131.2 where it was 141.5, and every level of that is the bright card tips
   * no longer being drawn over it, because `nocards` reads 131.2 as well. The
   * review's "the lit coat is 10-20% darker than lit snow" is therefore now
   * entirely a SHELL shading question, with the cards no longer papering over
   * it. That is the next thing, and it is not this knob.
   */
  /*
   * THREE THINGS MEASURED AFTER THE DENSITY FIX, all negative, all recorded
   * here so the next agent does not spend a wave on them. `portrait`,
   * 1400x900, one session, one instant, on the same coverage matte; `int` is
   * the mean radiance of the animal over BLACK inside the matte eroded 25 px,
   * so it is the coat's own light with the backdrop and post removed.
   *
   * 1. INTERIOR CARDS DO NOT GIVE THE INTERIOR ITS TEXTURE. The waxy
   *    textureless cheek and skull at `portrait` is the most visible defect
   *    left, and lengthening the interior cards is not the lever:
   *
   *        cardInteriorLen   interior strand rms   cov       left p10
   *          0.30 (shipped)        4.07          619 471       1.21
   *          0.55                  3.90          620 136       1.23
   *          0.80                  4.05          621 462       1.39
   *
   *    Flat inside noise. c0ae204 already said why -- with the cards gone the
   *    interior reads 131.2 where the coat reads 131.2 -- and this confirms it
   *    from the other direction: the interior is the SHELLS' image and card
   *    length cannot change it. (0.80 does buy 0.18 of left contour p10 and
   *    0.3% of coverage for nothing, which is worth knowing separately.)
   *
   * 2. THE COAT'S BRIGHTNESS IS NOT A FUNCTION OF SHELL COUNT, so the
   *    "15 levels darker at high than at low" is not unconserved per-shell
   *    energy:
   *
   *        furShells   6      11     18     26
   *        interior  197.7  196.3  197.2  197.1
   *
   *    1.4 levels across a 4.3x range of shells, non-monotonic. And the whole
   *    TIER, which also switches furAniso, uMicroOn, the env map size and the
   *    card budget, reads `low` 193.8 against `high` 196.8 -- 3 levels, and
   *    DARKER at low, the opposite direction to the brief. uAniso 0 and
   *    uMicroOn 0 are worth -1.0 and -1.2 levels each. So whatever the 15
   *    levels is, it is downstream of this material: it is in the graded
   *    frame, not in the coat's radiance.
   *
   * 3. `low`'s OUTLINE IS MONOTONE EVERYWHERE -- all four contour p10s read
   *    1.000 at the low tier against 1.20/1.00/1.78/1.00 at high, with band
   *    fill 0.371 against 0.428. 6 shells and 2500 cards cannot break it.
   *    That is a Quality.js number and not fur's to change, but no metric on
   *    the project measures any tier but `high`, so it has never been seen.
   */
  cardInteriorLen: 0.30,
  cardEdgeLen: [0.40, 0.62],
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
   *
   * tools/spec.mjs, the same build measured with cardHairs 1.0 / shellDeep
   * 0.40 and with the shipped 2.4 / 0.55:
   *
   *     check                                    before   after
   *       fur reads as hair at macro: muzzle      7.14     7.73   fine
   *       (fine-share)                            0.76     0.78
   *       macro reference carries hair detail    11.41    11.80   fine
   *       matte silhouette is hair: head p10      1.138    1.139   (still FAIL)
   *       [unvalidated] fur covers camera-facing  1.10     0.98   (warn both)
   *
   * So the macro checks gain, the head band does not move, and the one thing
   * that costs is the unvalidated tail-interior warn -- which was already
   * under its own 1.2 floor and whose author records that it "passes at 2.74
   * while a critic reading the same frame called the tail a flat white blade",
   * i.e. it does not track the defect it is named for. The rendered tail at
   * `tail` is softer and denser after, not flatter: shots/fur-before/tail.png
   * against shots/fur-after/tail.png.
   */
  /*
   * 2.4 -> 5.0. 250d67e took this 1.0 -> 2.4 and stopped there on the grounds
   * that "at macro the hairs go sub-pixel and the card LOD dissolves them to
   * a flat ribbon". Re-measured in both places at once, that cost does not
   * appear and the benefit does, in three independent directions:
   *
   *   `profile`, 2100x1350, one session, one instant, four-direction contour:
   *     uCardHairs   coverage   left    right    top    bottom
   *       2.4         416 160   1.529   1.807   1.730   1.607
   *       3.5         416 126   1.541   2.020   1.915   1.655
   *       5.0         416 496   1.562   2.156   1.917   1.856
   *
   *   `macro_eye`, whole frame, Sobel on luminance, ppm above 40 levels and
   *   the 99.9th percentile -- the hard-edge density review blocker 6 is
   *   about, with `nocards` as the floor:
   *     2.4   6292 ppm   p99.9 60.3        1 px detail 5.485
   *     3.5   6673       p99.9 59.7                    5.558
   *     5.0   5783       p99.9 55.7                    5.584
   *     NO CARDS AT ALL  3239 ppm  p99.9 47.6          5.467
   *
   * So the 1 px band -- the thing the dissolve was supposed to eat -- goes
   * UP, not down, and every contour edge improves. The cost is zero in the
   * fragment shader: `n` only scales the coordinate the hair lattice is
   * sampled at, so the instruction count does not depend on it.
   */
  cardHairs: 5.0,
  /*
   * ALPHA BELOW WHICH A CARD FRAGMENT IS DISCARDED. Shipped unchanged at the
   * 0.004 it was hard-coded at; it is a knob now because it is one of the two
   * levers on review blocker 6, and both levers are priced below.
   *
   * BLOCKER 6, "the coat's lower contour is a pixel lattice, not hair" --
   * right-angled chevrons and staples along the tail and legs. Attributed at
   * `profile`, 2100x1350, one page session, one instant, six arms:
   *
   *     hide the FUR        lattice GONE
   *     hide the CARDS      lattice GONE          (so it is not the shells)
   *     hide POST           lattice GONE
   *     DOF scale 0         lattice UNCHANGED, statistics identical to base
   *     bloom 0             lattice UNCHANGED, statistics identical to base
   *     card LOD dissolve 1.6x / 2.5x / 4x earlier
   *                         lattice UNCHANGED; coverage moves 15 px in
   *                         410 393. fwidth of the per-hair cell is already
   *                         far under the dissolve threshold down there.
   *
   * So it is the CARDS resolved by TAA, and the mechanism is depth. The card
   * material is `transparent: true` AND `depthWrite: true`, so every fragment
   * that survives this cut stamps a NEAR depth even at 1% alpha; TAA has no
   * velocity buffer and reprojects through depth (see src/fx/TAA.js, which
   * says so); and around the fringe WHICH faint card wins the depth test
   * changes with the sub-pixel jitter. The resolve turns that into a grid.
   *
   * BOTH FUR-SIDE FIXES WORK AND BOTH COST THE OUTLINE. spec's new
   * four-direction "contour has no bare run at profile" checks, share of scans
   * under the 1.15 hair floor, 4f allows 2%:
   *
   *     arm                        left    right    top    bottom   lattice
   *       shipped                  6.3%    1.9%    4.2%    4.0%     present
   *       cards depthWrite false   6.7%    2.6%    8.9%    6.2%     GONE
   *       cardCut 0.12               --      --      --      --     nearly gone
   *
   * and on the four-direction cliff count at 1400x900, cardCut 0.004 -> 0.08
   * -> 0.12 runs 48 -> 73 -> 94 bare columns while coverage falls 3.6%.
   * depthWrite false raises coverage 0.7% and removes the lattice completely,
   * and is the standard treatment for alpha-blended hair cards -- but it makes
   * every one of the four directions worse, including the two that currently
   * pass, so it is not shipped either.
   *
   * THE CHEAP FIX IS NOT OURS. A card that is 1% opaque should not be writing
   * depth at all, and the two ways to arrange that in one pass -- gl_FragDepth
   * or a second depth-only card pass -- cost early-Z and fill respectively, on
   * a frame budget with no headroom. The other end is TAA's depth
   * reprojection, which is postfx's file. Handing it over with the controls
   * above rather than paying for it here.
   */
  /*
   * 1 = the per-hair lattice inside a card lands on the card's own two long
   * edges, so the outermost hair is not cut by the quad boundary. See the
   * long note in the card fragment shader: an uncut hair against the
   * geometry edge is a straight hard alpha step the whole length of the
   * card, and that step is review blocker 6's "right-angled brackets".
   * 0 restores the shipped-before behaviour for A/B.
   */
  cardHairAlign: 1.0,

  /**
   * Depth of the per-hair root fade inside a card, as a fraction of the card.
   * It replaces a constant 0.12 that every hair shared, which drew the card's
   * root end as one straight crossbar. 0.12 reproduces the old behaviour.
   */
  cardRootRag: 0.45,

  /**
   * THE THREE NUMBERS THAT DECIDE WHETHER THE COAT IS A PILE OR A SPRAY.
   *
   * Review blocker 5 -- "long straggly individually-resolvable strands with
   * dark gaps between them" -- has been worked four times through card
   * LENGTH, and four levers in that dimension are now dead (uCardFloor,
   * uCardLength, cardClump/clumpAO/clumpPull, per-lock stand-off,
   * uCardTipEdge). It is not a length defect. Measured at `portrait`,
   * 1400x900, one page session, one instant, on the true two-clear-colour
   * coverage matte, walking in from each of the four frame edges to the first
   * sustained cov > 0.95:
   *
   *     arm        band depth px (L/R/T/B)   band FILL    fringe share
   *       shipped      62 / 66 / 43 / 65     0.245        0.115
   *       no cards     18 / 13 / 14 / 19     0.359        0.019
   *       cards only  113 /123 /104 / 92     0.222        0.282
   *
   * So the coat's outer band is 62 px deep and 24% hair -- three quarters of
   * it is air -- and the cards own that: hiding them takes the band to a
   * quarter of the depth at half again the fill, and they own 83% of all the
   * partial-coverage area on the animal. THAT is the defect, stated as a
   * number for the first time, and none of the four contour metrics can see
   * it: all of them grade tv/net, which a field of separated spikes scores
   * BETTER on than a dense pile does.
   *
   * What makes the band sparse is not the card count. It is that a card's
   * outer half is a spray:
   *
   *   * cardDuty is the share of a card's AREA that is hair, E[rad] in the
   *     fragment shader. It was 0.40 by construction -- and, critically, it
   *     is INDEPENDENT of cardHairs: the hair lattice is a triangle wave per
   *     cell, so more hairs means finer hairs over the same covered area.
   *     Raising cardHairs 2.4 -> 5.0 could not have changed the fill and did
   *     not. This is the knob that adds hair rather than subdividing it.
   *   * cardHairLen was 0.42, so per-hair length was uniform on [0.42, 1.0)
   *     of the card. At v = 0.9 only the ~17% of hairs that drew long are
   *     still there; at v = 0.6, 45% of them are gone. The outer half of
   *     every card is a handful of surviving hairs with holes between them,
   *     which is precisely "individually-resolvable strands with dark gaps".
   *   * cardHairFade was a fixed 0.30 of the card -- on top of the draw
   *     above, a third of the card's length spent ramping each hair out.
   *
   * 0.42 / 0.30 / 0.40 reproduce the shipped-before behaviour exactly, and
   * the A/B in this commit confirms it to four decimals on all nine
   * statistics.
   *
   * THE SWEEP, `portrait`, 1400x900, one session, one instant. `base` is the
   * three values at 0.40 / 0.42 / 0.30 and reproduces the pre-refactor build
   * to a pixel, which is this refactor's positive control:
   *
   *   arm                        cov      band fill L   depth L   p10 L/T   strand
   *     base                   604 422      0.245         62     1.19/2.12   3.87
   *     cardHairs 5 -> 14      605 185      0.242         65     1.05/2.39   3.94
   *     duty 0.70              605 963      0.310         61     1.05/2.45   4.03
   *     hairLen .80 fade .12   617 864      0.293         66     1.15/2.15   3.94
   *     SHIPPED (.85/.85/.10)  619 474      0.431         63     1.20/1.86   4.23
   *     + cardHairs 12         619 727      0.434         63     1.14/2.16   4.14
   *     duty 1.00              619 526      0.445         52     1.09/1.00   4.17
   *     + cardLength 1.10      608 010      0.432         58     1.00/1.64   4.11
   *     + interiorLen 0.12     619 201      0.432         63     1.17/1.72   4.11
   *     + furCards 13k -> 26k  630 084      0.435         64     1.41/2.26   4.12
   *
   * The band's fill goes 0.245 -> 0.431, a 76% denser coat, while its depth
   * and both measured contour p10s hold and coverage RISES 2.5% -- so this is
   * not the length-for-silhouette trade that four previous attempts ran into.
   * It is not a trade at all. Paired ABBA at `hero`/idle/high/1280x800 it
   * costs 0.025 ms against a 0.05 ms arm-to-arm spread: free.
   *
   * THREE THINGS THE SWEEP SETTLES, so they are not re-run:
   *
   *   * cardHairs is NOT the lever, as the duty-cycle algebra says. 5 -> 12 on
   *     top of the shipped duty buys 0.003 of fill. It stays at 5.0; raising
   *     it also drives fwidth(s) past the lattice's LOD dissolve, which turns
   *     cards back into the constant-alpha plates blocker 6 is about.
   *   * duty 1.00 IS too much: the hairs merge, and the top contour p10
   *     collapses 1.86 -> 1.00, i.e. the outline goes monotone -- a solid mat,
   *     which is the failure mode the uCardInner note already warns about.
   *     0.85 is the last value that keeps it.
   *   * cardLength 1.10 and interiorLen 0.12 were tried as ways to PAY for
   *     this and neither is needed: 1.10 costs 1.9% of coverage and takes the
   *     left p10 to 1.000, and interiorLen 0.12 buys 0.032 ms, inside noise.
   *     Both are left where they are.
   *
   * AND WHAT IT COSTS, at `profile`, which is where the silhouette gates
   * live. Same session, same instant, `prev` being all four values restored:
   *
   *   arm        cov       band fill L/R/T/B        contour p10 L/R/T/B
   *     prev   185 130   .228/.253/.314/.243      1.36/1.82/1.48/1.49
   *     SHIPPED 194 162  .422/.471/.571/.467      1.16/1.77/1.18/1.78
   *     nocards 151 059  .573/.438/.503/.573      1.00/1.00/1.00/1.00
   *
   * The band fill nearly doubles on every edge and coverage goes UP 4.9%, and
   * THE LEFT AND TOP CONTOUR p10s PAY FOR IT: 1.36 -> 1.16 and 1.48 -> 1.18,
   * both still over 4f's 1.15 floor but with 0.01 and 0.03 of margin where
   * they had 0.21 and 0.33. Read that before moving anything here.
   *
   * IT IS ALSO WHY THAT METRIC CANNOT BE THE ONE THAT DECIDES THIS. tv/net is
   * total variation over net rise, so it is maximised by an outline that
   * alternates hair and gap and minimised by a monotone ramp -- a dense pile's
   * outline is closer to monotone than a spray's, and the metric therefore
   * scores the DEFECT higher than the fix. It is a fine guard against a bare
   * mesh edge (nocards reads 1.000 on all four) and it is not a coat-quality
   * measure. The band fill above is the one that separates them.
   *
   * WHAT IS STILL WRONG, measured rather than argued: the band is still 63 px
   * deep at `portrait` against 18 px for the coat with no cards at all, and
   * the strand width has gone 1.3 -> 2.7 px because duty widens a hair inside
   * a fixed cell. More cards is the one arm that improved the fill further
   * (0.435 at 26k, and the best left p10 in the sweep at 1.41) and it is the
   * one that costs triangles -- which is the cheap resource here: 1.27M of a
   * 3.5M budget, and the WHOLE card mesh's fragment cost is 0.545 ms of a
   * 6 ms fur budget (paired, hero/idle/high/1280x800, cards hidden against
   * base). If anyone wants both the fill and the contour margin back, the
   * furCards tier budget is where it is.
   */
  cardDuty: 0.85,
  /*
   * AND THE CEILING ON ONE HAIR'S HALF-WIDTH IN ITS CELL, which the duty
   * above needs in order to be legal. `d` runs 0..1 across a hair cell, so
   * rad >= 1 fills the cell: the gap to the next hair closes and the card
   * becomes one opaque plate. It also voids uCardHairAlign's guarantee, whose
   * own note reasons "since rad <= 0.6 the alpha there is 0 by construction".
   * At duty 0.85 the raw draw is 0.425 .. 1.275 and 32% of it is over 1.0.
   *
   *   uCardDutyMax   band fill L   top p10   gaps L   run L   cov
   *     9.0 (off)       0.429       1.92     21.95     2.7   619 492
   *     0.85            0.406       2.20      7.65     2.5   619 464
   *     0.70            0.381       1.96      7.81     2.0   619 432
   *
   * 0.85 costs 5% of the fill -- the arithmetic says 6% -- for 15% of the top
   * contour p10 and a third of the merge-and-break transitions, at identical
   * coverage. 0.70 gives the fill back up and buys nothing.
   */
  cardDutyMax: 0.85,
  cardHairLen: 0.85,
  cardHairFade: 0.10,

  cardCut: 0.004,
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
  const floorScale = [];
  const intMix = [];
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
    floorScale.push(CARD_FLOOR_SCALE[i] ?? 1.0);
    intMix.push(CARD_INTERIOR_MIX[i] ?? 1.0);
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
    uStrandFade: { value: new THREE.Vector2(...d.strandFade) },

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
    uCardFloorScale: { value: floorScale },

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
    uCardDroopSym: { value: d.cardDroopSym },
    uCardOpacity: { value: d.cardOpacity },
    uCardHairs: { value: d.cardHairs },
    uCardHairAlign: { value: d.cardHairAlign },
    uCardRootRag: { value: d.cardRootRag },
    uCardDuty: { value: d.cardDuty },
    uCardDutyMax: { value: d.cardDutyMax },
    uCardHairLen: { value: d.cardHairLen },
    uCardHairFade: { value: d.cardHairFade },
    uCardInteriorLen: { value: d.cardInteriorLen },
    uCardEdgeLen: { value: new THREE.Vector2(d.cardEdgeLen[0], d.cardEdgeLen[1]) },
    uCardIntMix: { value: intMix },
    uCardCut: { value: d.cardCut },
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
