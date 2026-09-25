/**
 * Eyes — the single most-scrutinised 12 mm of the whole render.
 * OWNER: face agent.  (ART_DIRECTION.md §4b · REVIEW.md category C)
 *
 * §4b, binding: "Iris amber/golden-brown, noticeably warm, with a darker
 * outer ring. Pupil round and black. DARK, ALMOST BLACK EYELID RIMS surround
 * the eye — this is what makes the eye read at distance, and it is the single
 * most important detail on the face. Eyes forward-set and comparatively
 * large, with a wet corneal highlight."
 *
 * ---------------------------------------------------------------------------
 * ANATOMY IS READ AT RUNTIME. Nothing here is a hardcoded world position.
 * Every eye is parented to `ctx.fox.anchors.eyeL/eyeR`, which are themselves
 * parented to the `head` bone, so the skull can move, rescale or be remeshed
 * underneath us and the eye simply rides along. The globe radius, the optical
 * axis and the forward seat are all *measured* off `ctx.fox.eyes` and
 * `ctx.fox.field` during init.
 * ---------------------------------------------------------------------------
 *
 * Construction, per eye (all children of a group at the eyeball centre, with
 * local +Z along the optical axis):
 *
 *   globe    opaque. Sclera + iris + pupil. The iris is NOT painted on the
 *            surface: the view ray is refracted through the corneal dome and
 *            intersected with a virtual iris plane 3.4 mm further back, so the
 *            iris genuinely sits behind a lens and slides as the camera moves.
 *            That parallax is the whole difference between a bead and an eye.
 *            Also carries the refractive caustic on the lower iris and the
 *            contact shadow cast by the upper lid.
 *   cornea   additive overlay on the corneal cap only. Two tight GGX lobes,
 *            Fresnel-weighted: one on the sun, one on the sky. The broad,
 *            physically-correct env reflection is NOT here — it is three's
 *            own clearcoat lobe on the globe, so it is lit by the real PMREM
 *            and by all four of Environment.js's lights. This mesh exists to
 *            guarantee a discrete, bloomable catchlight that sits in front of
 *            the refracted iris instead of sliding with it.
 *   lids     one mesh per eye carrying both lids. The palpebral aperture is a
 *            true almond: two curves that meet at the canthi, evaluated in the
 *            vertex shader from a blink uniform, so closure is free and exact.
 *            The first 6% of the band is the near-black lid margin §4b asks
 *            for, and it is also where the wet meniscus lives.
 *
 * Public surface:
 *   ctx.eyes.setBlink(t [, side])   0 open .. 1 closed. null clears the
 *                                   override and returns control to the rig.
 *   ctx.eyes.setLook(vec3 | null)   world-space gaze target.
 *   ctx.eyes.setPupil(f)            0 dilated .. 1 contracted.
 *
 * Read defensively from the animation agent: `ctx.fox.blinkL/blinkR` and
 * `ctx.fox.gazeYaw/gazePitch` are used when present and ignored when not.
 *
 * ---------------------------------------------------------------------------
 * A MULTI-ARM IN-PAGE A/B MUST RESET TAA BETWEEN ARMS, and nothing in this
 * tree did. Recorded here rather than in AGENTS.md because that file is the
 * orchestrator's, and this is the kind of finding that costs a whole round
 * when it is not written down where the next agent will trip over it.
 *
 * TAA.js resolves with uAlpha = 1/(n+1) and caps n at 250 while the scene is
 * static. Nothing resets it when an A/B applies its next arm, so the SECOND
 * arm of a page session is a 1/50 blend of itself over the FIRST arm's
 * converged image, and the sixth is a 1/251 blend. Demonstrated with three
 * IDENTICAL arms, 48 frames each, measuring the same masked pixels:
 *
 *     base 135.8     base2 110.9     base3 99.4
 *
 * -- the value tracks arm POSITION, not arm content, and an earlier arm that
 * had tinted the eye pure green was still plainly visible in the base3 PNG
 * three arms later. With ctx.postfx.reset() called after applying each arm
 * and before rendering, the same three arms measure 67.1 / 67.1 / 67.1, bit
 * identical, and a real variant separates cleanly and repeatably.
 *
 * tools/ab.mjs renders 22 frames per variant and does not reset, so its
 * variants 2..N are mostly variant 1. Contamination can only SHRINK a
 * difference, so a positive result from it still stands; a null result from
 * it means nothing at all.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * WHAT THE FACE COSTS, because the [high] frame budget keeps failing and the
 * lid work keeps being suspected. Paired in ONE page session at ONE sim
 * instant, `portrait`/`high`/1280x800, 90 frames per arm through
 * FoxDebug.measureFrameMs (which forces a readPixels sync, so the GPU is in
 * the number), each arm measured TWICE so the repeatability floor is part of
 * the result rather than an assumption:
 *
 *   arm       pass1    pass2    mean     delta vs base
 *   base      24.490   24.406   24.448     --
 *   nofd      24.346   24.409   24.377   -0.071 ms   FaceDetail's 5 meshes
 *   noeye     24.492   24.374   24.433   -0.015 ms   all 6 eye meshes
 *   nolid     24.379   24.474   24.427   -0.021 ms   both lid bands
 *   nowhisk   24.440   24.222   24.331   -0.117 ms   53 strands
 *   base pass1 - base pass2 = 0.084 ms
 *
 * So the ENTIRE eye -- globe, cornea, lids, the lid scatter, the rim ramp,
 * all of it -- is 0.015 ms against a 0.084 ms repeatability floor: not
 * measurable. The whole face package is about 0.2 ms. None of the frame's
 * overrun is here, and neither LID_SCATTER nor the RIM_* ramp is worth a
 * millisecond of anybody's suspicion. (The fur agent separately measured the
 * gate's own [high] figure at 15.66-22.24 ms on identical code, so a
 * cross-run 16.22 -> 17.19 is inside that instrument's spread.)
 * ---------------------------------------------------------------------------
 */
import * as THREE from 'three';
import { clamp, saturate, lerp, rng, TAU } from '../util/math.js';
import { HASH, SIMPLEX3, WORLEY3, UTIL } from '../shaders/noise.glsl.js';

// --- proportions, as fractions of the measured globe radius ----------------
//
// SOURCED, and it closes REFERENCE-FOX.md §3d's "clean, complete gap". §3d
// suggested chasing comparative canid ophthalmology, and that works: there is
// no ocular measurement for either Vulpes, but there is for a wild fox of
// almost exactly our animal's build.
//
//   Cerdocyon thous, 5.1-5.6 kg, n = 5 animals / 8 eyes, callipers on
//   enucleated globes (PLOS ONE 2019, e0224245, open access):
//     globe diameter          15.8 - 16.3 mm  (median)
//     CORNEAL DIAMETER        13.52 mm horizontal, 13.53 vertical
//     palpebral fissure       17.32 mm  (and 17.45 +- 1.55 mm live, in a
//                             second independent study, PMID 31961037)
//   Small domestic dog, 4.2-8.6 kg, same paper, n = 10 eyes:
//     globe 19.4-19.9 mm, cornea 14.32 mm horizontal
//
// The load-bearing result is that GLOBE size differs significantly between
// the two (p < 0.0155) and CORNEAL diameter does not (p > 0.122). A canid
// carries a nearly size-invariant cornea on a globe that does scale — so a
// small fox is, proportionally, almost all cornea. 13-14 mm is well supported
// for a 3.0-4.5 kg arctic fox.
//
// CORNEA_R was 0.685, which puts the limbus at 0.49 R — the HUMAN ratio
// (11.7 mm cornea on a 24 mm globe), and 10.4 mm of cornea on our globe. That
// is the single measurable reason the eye read as an amber bead in a black
// ring. 0.815 lands the limbus near 0.65 R = 13.6 mm of cornea.
//
// Our globe is 21.1 mm across, which is a 20-35 kg dog's eye rather than a
// fox's — but it is set by the socket the anatomy agent carved, not by us, so
// it is reported rather than fought. See the note on the fissure below.
// CORNEA_R IS NO LONGER A CONSTANT — see `_buildEye`. It is solved per eye so
// the LIMBUS lands on CORNEA_DIA whatever the socket does to the globe, which
// is what the sourced result above actually says: corneal diameter is
// size-invariant across canids and globe diameter is not. 13.5 mm is the
// callipered Cerdocyon thous figure (13.52 horizontal / 13.53 vertical).
const CORNEA_DIA = 0.0135;
// ...but never more than this share of the globe DIAMETER. Past about 0.86 the
// cap radius approaches R, zc collapses toward zero and the smooth-max has
// nothing left to blend, so the profile turns into a hemisphere with a crease
// round its equator instead of an eye.
const CORNEA_OF_GLOBE = 0.84;
const CORNEA_BULGE = 0.075; // apex stands this much proud of the scleral sphere
const BLEND_K = 0.055;      // limbal smooth-max blend width
const IRIS_DEPTH = 0.295;   // anterior chamber: apex -> iris plane
const IRIS_R = 0.90;        // iris radius / limbus radius (cornea magnifies it back)

// --- palpebral aperture, in gnomonic tangent units on the globe ------------
// (x, y) here are tan(angle) from the optical axis, so 0.70 ~ 35 degrees.
//
// The fissure is WIDE relative to the cornea, and ours was narrower than it.
// Measured (same two sources as above): palpebral fissure 17.3-17.5 mm over a
// 13.5 mm cornea, i.e. FISSURE / CORNEA = 1.28. Ours was 11.9 mm of fissure
// over 14.5 mm of cornea — 0.82, the wrong side of 1. That is what made the
// eye read as a slit: not that the cornea was covered top and bottom (it
// should be) but that the fissure did not reach the corners of it.
//
// Aperture HEIGHT has no measured value for any canid — that search came back
// a clean GAP — so it is derived instead: at 17.3 mm long and the old 2.03:1
// the height would be 8.5 mm, covering ~37% of a 13.5 mm cornea, which is
// plausible for a canid at rest. Height is therefore held near 0.63 x corneal
// diameter and only the WIDTH is opened up. That also keeps faith with
// REFERENCE-FOX.md §6's warning: the cuteness literature it cites measures
// eye AREA relative to the face, and widening a real dimension toward a
// measured target is a different act from rounding a slit into a circle
// because circles look cuter.
//
// AP_W IS NO LONGER A NUMBER. It is measured, per eye, off the live socket,
// because a constant here is what made the anatomy agent's anisotropic eye
// slot a no-op: they widened the nasal wall from 37.5 to 44.0 degrees and the
// rendered fissure/cornea did not move off 0.97, because 0.780 was already
// under BOTH caps. `_measureAperture` now walks each meridian of the seated
// globe against `fox.field` and reports where the skin closes over it, and
// the canthi are placed just inside that. When the anatomy changes the socket
// again, the fissure follows on its own.
//
// AND THE SOURCED TARGET IS NOT THE QUANTITY WE COMPUTE. The previous pass
// compared our `2 R sin(atan(AP_W))` — a CHORD BETWEEN THE CANTHI ACROSS THE
// GLOBE — against the callipered 17.32 mm palpebral fissure of Cerdocyon
// thous, and called the 0.97 : 1.28 gap a defect to close. It cannot be
// closed and it never could: that animal's globe is 15.8-16.3 mm across, so
// its 17.32 mm fissure EXCEEDS ITS OWN GLOBE DIAMETER. It is a canthus-to-
// canthus measurement across the FACE, with the lid margins running off the
// globe and onto the orbital rim at both corners; our lid band rides the
// globe, so the largest number this file can print is 2R = 22.5 mm at +/-90
// degrees, and any socket at all caps it far below that. f/c 1.28 is not a
// target we are failing, it is a different measurement.
//
// What the same two sources DO give us, apples to apples, is the ordering:
// fissure > cornea, i.e. the lid margins clear the LIMBUS horizontally and
// the cornea is cut only top and bottom. That is a statement about angles on
// the globe and it transfers. With limbus at asin(limbusR/R) ~ 39.5 degrees,
// the aperture has to reach past 39.5 on both sides — which the socket can
// just do (it opens 97.9 degrees in total) but only if the globe is not
// rotated so far nasally that the fissure cannot stay centred on it. Hence
// CONVERGE_MAX_OFF below.
// 1.10 (47.7 degrees) was the binding ceiling the moment the globe shrank and
// the limbus moved out to 52 degrees: the fissure would then have been pinned
// INSIDE the limbus and the lid margins would have cropped the iris left and
// right — the black O-ring, arrived at from the other side. The ceiling that
// is supposed to bind is the measured socket wall plus `limbusTh +
// SCLERA_CLEAR`; this one is only a backstop against a wild measurement, so
// it is set where it cannot be the thing that decides the fissure.
const AP_W_CEIL = 1.90;     // never wider than this, whatever the socket allows
const AP_W_FLOOR = 0.62;    // ...nor narrower; below this the eye is a slit

// AND THE CEILING THAT ACTUALLY BINDS IS THE LIMBUS, NOT A CONSTANT.
//
// The sourced ordering above ("fissure > cornea") says the lid margins must
// clear the limbus horizontally. It does not say BY HOW MUCH, and that turns
// out to be the whole of blocker 11. Measured off the live rig: the socket
// opens T 60.2 / N 67.5 degrees, so `apTh` was pinned at its 1.10 ceiling —
// canthi at +/-47.7 degrees against a limbus at 39.5 — leaving 8.2 degrees of
// bare pigmented sclera standing at EACH canthus. In the render that is
// 85-100 px of near-black on a 575 px aperture at `macro_eye` row 646, i.e.
// nearly a third of the opening is black, and §4b's amber iris reads as a
// bead sitting in a hole. A canid's iris nearly fills its fissure.
//
// So the clearance is authored directly, in degrees outside the limbus, and
// the ceiling follows the cornea wherever the anatomy agent puts it. 3
// degrees keeps the ordering (fissure 14.7 mm over a 13.8 mm cornea, f/c
// 1.07) and leaves a sliver at the corner instead of a wedge. It must stay
// above CONVERGE_RECESS or `convMax` goes to the follow angle alone.
const SCLERA_CLEAR = 3.0 * Math.PI / 180;
const AP_WALL_MARGIN = 1.5 * Math.PI / 180;  // keep the canthus off the wall
// AP_UP / AP_DN ARE DERIVED PER EYE (see `_buildEye`), not authored. They used
// to be gnomonic tangents — 0.477 / 0.413, i.e. 25.5 and 22.4 degrees off the
// optical axis — and a fixed ANGLE is a fissure whose height in millimetres
// scales with the globe. The derivation the note below gives ("held near 0.63
// x corneal diameter") is about the CORNEA, so state it that way and let both
// follow the socket.
const AP_H_OF_CORNEA = 0.63;  // fissure height / corneal diameter, at u = 0
const AP_UD_SPLIT = 0.536;    // ...of which this share sits above the axis
const AP_TILT = 0.045;      // canthal tilt — outer corner rides higher

// How far proud of the *surrounding skin* the corneal apex is seated. The
// socket the anatomy agent carves is a shallow dish and the fur agent only
// fades the coat to ~25% at the aperture, so a flush eye is a buried eye.
//
// SKIN IS NO LONGER THE RIGHT DATUM. §4f moved the bulk into the coat and the
// skull coat went 7.5 -> 26 mm; measured off `furLength`, the orbital rim now
// authors 8-14 mm of hair within 16 mm of the eyeball centre, and the socket
// FLOOR itself authors 8.3 mm. 1.8 mm of clearance over the skin is 1.8 mm
// under six millimetres of hair. So the clearance is the skin clearance PLUS a
// bounded share of the coat actually measured at the socket — bounded, because
// an eye pushed out far enough to clear every hair is a marble on a stick.
const APEX_CLEARANCE = 0.0018;
const COAT_CLEAR_SHARE = 0.55;  // of the locally authored coat depth...
const COAT_CLEAR_MAX = 0.0036;  // ...up to this much extra push
const MAX_SEAT_PUSH = 0.0058;   // never shove the eye more than this far out
const MAX_SEAT_PULL = -0.0022;  // ...nor sink it

// Globe-to-socket fit. Past the aperture the globe must sit inside the skin.
const FIT_ANGLE = 60 * Math.PI / 180;
const FIT_MARGIN = 0.97;

// ORBITAL AXIS vs VISUAL AXIS. `fox.eyes[side].look` is the socket's surface
// normal — the ORBITAL axis — and on this skull it diverges 35.9 degrees from
// the midline. No canid's eye points there. The orbital rims of a fox face far
// out to the side while the globes sit rotated forward inside them, which is
// what "forward-set" in §4b actually describes and why a fox can look at you
// at all. Pointing the globe down the socket normal means that at `frontal`
// framing the camera sees each eye from 36 degrees off its own axis, so the
// iris foreshortens to a sliver, the lid margin crosses in front of it, and
// the eye reads as a dark bead however bright the iris is.
//
// So: the SOCKET (lids, seat, fit, spread) is still built on the measured
// normal, and only the globe is converged. The lids therefore still fit the
// skull exactly, and the iris sits slightly nasal inside the fissure — which
// is precisely what an animal looking at the lens looks like.
//
// AND THAT LAST SENTENCE IS THE BLACK O-RING. "Slightly nasal" measured out at
// 8.83 degrees, which on an R = 11.25 mm globe walks the corneal disc 1.7 mm
// nasal inside a fissure that is still centred on the ORBITAL axis. The lid
// then crosses 10.4 degrees INSIDE the limbus nasally and stands 7.3 degrees
// OUTSIDE it temporally, so one side is margin-on-cornea and the other is a
// band of bare, doubly-darkened sclera. Measured at `macro_eye`, row 860: 90
// px of dark nasally against 265 px temporally, on a 535 px iris. The ratio
// the geometry predicts is 1.49 and the render shows 1.58.
//
// The fissure cannot simply follow the globe: it is centred on the orbital
// axis because that is where the socket's opening is, and the nasal wall is
// the near one. So the convergence is CLAMPED instead — the globe may rotate
// only as far nasally as the fissure can still clear the limbus on the side
// it is rotating away from. That bound is measured, not chosen: see
// `_apertureFor`. At the socket as it stands the clamp bites at ~3 degrees,
// which is a third of the 8.83 this constant used to buy.
const EYE_CONVERGE = 0.30;   // share of the lateral splay taken out
const EYE_LEVEL = 0.50;      // ...and of the upward tilt
const CONVERGE_RECESS = 0.5 * Math.PI / 180;  // sclera to leave on the tight side

// How far the lid band sweeps outward over the globe, in radians of arc from
// its own margin. It has to reach from the aperture edge to wherever the skin
// starts covering the globe (about 50 degrees off axis) with room to spare,
// or a ring of bare sclera shows between lid and face.
const LID_SPREAD = 0.62;         // fallback when the SDF is unavailable
const LID_SLACK = 0.10;          // tuck this much further under the skin
// The floor has to be at least as long as the colour ramp that lives on the
// band, or the band ENDS MID-RAMP and its outer edge is a dark line drawn on
// the face — which is the failure the millimetre-authored ramp was written to
// avoid, arrived at from the geometry side. 0.17 rad is 1.9 mm of arc on this
// globe against a 3.2 mm ramp; 0.30 rad is 3.4 mm and just clears it.
const LID_SPREAD_MIN = 0.30;
const LID_SPREAD_MAX = 0.95;

// --- how wide the dark is, in metres of arc from the free edge -------------
//
// THIS IS THE REASON THE EYE DID NOT READ AT NORMAL FRAMINGS, and it is the
// opposite of the reported symptom. The critic's "no dark eyelid rim" at
// `frontal` and `portrait` is not a missing rim; the whole 3.4-5.5 mm lid
// band was rendering dark, so there was nothing for a rim to be a rim
// AGAINST. Attributed by tinting each surface a unique primary and reading
// the mask back off the untinted frame at `portrait`: 910 px of margin at
// (8,8,10), 1857 px of periocular skin at (26,28,36) and 2402 px of lid FUR
// at (38,50,69) — against coat immediately outside the socket at ~(180,190,
// 200). Four thousand pixels of black around an amber disc is a hole in the
// face with a bead in it, which is exactly the phrase the critic used.
//
// At 0.13 m that band is 300 px across and reads as a shaded lid, which is
// why `macro_eye` looked right while the same geometry at 0.55 m collapsed
// into one featureless blob 25 px wide. Nothing was scale-dependent except
// the reader.
//
// So: the same ramp, pulled in about 30%, so the dark is a LINE at the
// framings a viewer actually sees and still a modelled lid at macro.
//   frontal, 0.1615 mm/px : margin 5.0 px · ring out to 8.7 px · fur by 20 px
//   macro,   0.0239 mm/px : margin 33 px  · ring out to 59 px  · fur by 134 px
// AND THE RAMP IS NOT WHAT THE FRAME SHOWS, because LID_SCATTER is gated by
// `feFurry` — the same smoothstep that fades the fur COLOUR in. So every
// millimetre of band inside RIM_FUR_1 renders with a fraction of the
// multiple-scattering term, i.e. at a fraction of the coat's brightness. The
// ramp authors 1.40 mm of dark; the render delivered 3.0 mm of it, because
// the periocular-skin zone from 1.40 to 3.20 mm is skin-coloured (albedo
// 0x8d8076, L 129 of 255) and shaded as one dielectric bounce under a sunless
// sky. Measured along the UP meridian at `macro_eye`, in true degrees off the
// optical axis (the page's own projection of globe points, not a guessed
// px/mm), free edge at 25.5 deg, local coat p50 190:
//
//   vArc mm   0.66  1.04  1.61  2.18  2.75  2.94  3.51  3.89  4.65  5.03
//   lum        1.9   5.9  22.5  32.2  68.9  87.6 129.1 143.0 130.6 112.5
//   vs coat   -99%  -97%  -88%  -83%  -64%  -54% -32%  -25%  -31%  -41%
//
// So the run darker than half the coat reached vArc 2.94 mm, and with the
// 1.4 mm of iris the lid contact shadow takes off the top of the cornea the
// continuous dark was 4.4 mm — 32% OF A CORNEAL DIAMETER (13.8 mm) above the
// amber, and as much again below it. That is the "heavy dark outline, drawn
// on rather than lit" the review describes: the eye's apparent size is the
// iris plus two thirds of a cornea of black.
//
// A canid's lid margin is a pigmented LINE and the haired skin starts at it —
// cilia on the upper lid root in the margin itself. A 3.2 mm hairless ring
// round the fissure is precisely what §4f rule 3 forbids, which the previous
// pass argued about the band's noise and then left at 3.2 mm of width.
//
// Fur (and therefore the scatter) now takes over at 0.75 mm and owns the
// surface by 1.90 mm, so the authored dark and the rendered dark agree:
//   portrait, 0.145 mm/px : margin 3.4 px · ring out to 6.9 px · fur by 13 px
//   macro,    0.029 mm/px : margin 17 px  · ring out to 34 px  · fur by 65 px
const RIM_MARGIN_0 = 0.00028;    // near-black tarsal margin starts fading here
const RIM_MARGIN_1 = 0.00070;    // ...and is gone here
const RIM_RING_1 = 0.00100;      // dark periocular skin ends
const RIM_FUR_0 = 0.00075;       // short lid fur starts taking over
const RIM_FUR_1 = 0.00190;       // ...and owns the surface from here out

// Short white lid fur is a multiple-scattering medium and an ordinary
// single-bounce dielectric is not. Under this scene's sky-only fill the
// difference is the 4.7x measured above. This is the extra irradiance the
// furry part of the band keeps, as a multiplier on the sky/bounce hemisphere;
// it is masked to zero on the margin so the black line stays black. Swept
// against the coat next to the socket — see the commit.
// MEASURED AGAIN, AND 2.15 OVERSHOT BY A FACTOR OF THREE. The band is short
// white fur over skin and its job is to DISAPPEAR into the coat; above parity
// it becomes a bright ring with a black hole in it, which is the googly-doll
// read review 4 blocker 11 describes.
//
// MY FIRST SWEEP OF THIS CONSTANT WAS ITSELF WRONG, and in the way AGENTS.md
// warns about: the probe was a single column, and its "coat" sample sat
// 130-210 px above the socket, up on the lit BROW at 187 levels. Against that
// reference 1.70 looked like parity. The coat a viewer actually compares the
// band against is the coat 4-20 px outside it, down in the orbital hollow,
// and that reads 142. Same render, same frame, -45 levels of reference.
//
// Re-swept with the honest reference: six arms in one page session at one sim
// instant, 22 TAA frames each, the band isolated by MASK (lids hidden for the
// membership test, then tinted per-zone for the margin/skin/fur split) rather
// than by position, median over ~50 000 band pixels against ~22 000 coat
// pixels in a 4-20 px shell. The coat reference held at 141.6-142.4 across
// all six arms, which is what makes the comparison a measurement:
//
//   scatter   band p50   vs coat
//     1.62      181.2     +27.2 %
//     1.30      172.2     +21.3 %
//     1.00      161.3     +13.8 %
//     0.70      147.0      +3.7 %
//     0.40      126.1     -10.9 %
//     0.00       69.5     -50.9 %
//
// So parity is 0.65, and 0.60 lands ~2 % under it — where periocular skin
// belongs, and where the near-black margin (p50 15) has 120 levels of coat
// to be a rim against.
const LID_SCATTER = 0.60;

// SOCKET OCCLUSION ON THE LID BAND — the missing term behind "a pale grey-blue
// ring surrounding the iris, like a visible sclera".
//
// LID_SCATTER was swept to coat PARITY (band p50 within 2% of the coat 4-20 px
// outside it) and the band still reads as a pale ring, which looks like a
// contradiction until you ask what the reference is. Parity with the coat is
// the wrong target: the band lies in the bottom of the orbital recess, under
// a brow and behind a lid fold, and a cavity does not receive the full sky.
// The coat 4-20 px outside the socket is ON the rim and does. So a band at
// parity is a band 25-35% too bright for where it sits, and because it is
// also the only smooth surface in the frame it reads as wet sclera.
//
// This is a cavity term, not a fudge: it is largest at the free edge (deepest
// in the recess, closest to the lid fold that overhangs it) and decays to
// nothing by the outer boundary, where the band is continuous with the face
// and should match it exactly. LID_AO_LAMBDA is in metres of arc so it does
// not rescale when the socket or the coat does.
const LID_AO = 0.38;             // peak occlusion at the free edge
const LID_AO_LAMBDA = 0.0019;    // e-folding distance outward, metres of arc

// The upper lid's crease. A canid's upper lid folds back on itself a couple
// of millimetres above the margin, and the groove is the only thing that
// tells a viewer the lid has THICKNESS rather than being a decal printed on
// the globe. Authored in metres of arc for the same reason the rim ramp is.
const LID_CREASE = 0.30;         // how deep the groove shades
const LID_CREASE_AT = 0.0027;    // where its centre sits, metres of arc
const LID_CREASE_W = 0.0012;     // and its half-width

// The canthi. A lid margin is NOT one width: it is a line along the free edge
// that broadens into a blunt triangle where the two lids meet, and at the
// MEDIAL canthus it broadens further around the lacrimal caruncle. A margin of
// constant width is the specific thing the review means by "a uniform-width
// dark annulus that does not thicken at the corners".
const CANTH_FROM = 0.60;         // |u| at which the corner starts broadening
const CANTH_WIDEN = 2.30;        // margin width multiplier at the lateral canthus
const CANTH_WIDEN_NASAL = 3.60;  // ...and at the medial one, which is blunter
const CARUNCLE_ARC = 0.00085;    // caruncle reach outward from the free edge

// How far the middle of the lid band stands proud of the globe, as a fraction
// of the globe radius. THIS IS HALF OF THE PALE RING OUTSIDE THE DARK ONE.
//
// Swept in one page session at one sim instant, five arms, 22 TAA frames
// each, read along the up meridian in true millimetres of arc from the free
// edge (the px->degree map comes from the page's own projection; see the
// note on RIM_* above). Two things move together, and both are the ridge:
//
//   swell              0.070   0.050   0.032   0.016   0.000
//   lum at vArc 1.42    27.2    35.1    44.7    53.5    65.0   <- inner slope
//   lum at vArc 1.80    74.1    87.5   100.3   112.4   125.2
//   crest (2.4-4.0)   145-148 143-148 145-148 140-148 140-148
//   trough (4.6-5.2)    112.5   114.8   118.5   122.6   122.5   <- far slope
//   trough vs face      -30%    -29%    -27%    -26%    -26%
//   trough WIDTH        5 deg   4 deg   2 deg   1 deg   1 deg
//
// The crest does not brighten with the swell -- the band is always DARKER
// than the face beyond it (145 against 164), so the ring does not read as
// pale because it is bright. It reads as a ring because the ridge's far
// slope turns away from the sky and lays a shadow LINE round the outside of
// it, and that line goes from 5 degrees of arc wide to 2. The inner slope
// does the same thing on the other side, which is why less swell also makes
// the dark rim narrower for free (27 -> 45 at vArc 1.42 mm).
//
// 0.032 keeps a modelled fold and 0.000 is a decal on a sphere, so it is not
// a case of less is better all the way down. Held at 0.032 = 0.35 mm.
const LID_SWELL = 0.032;

// --- cilia -----------------------------------------------------------------
//
// §4b does not name eyelashes, but review 5 does, twice, and it is right that
// nothing here had any: the strands crossing the eye at `macro_eye` are
// Whiskers.js's BROW row (BROW_N = 4), rooted well above the orbit and
// hanging down over it, which is a different structure and reads as stray
// hair rather than as a lid.
//
// Cilia root IN the tarsal margin itself, so these are built from the SAME
// aperture curves the lid geometry uses, at aS = 0, and carry the SAME blink
// rotation -- a lash that does not close with the lid is worse than no lash.
// Upper lid only: a canid's lower lid is effectively aciliate.
//
// SOURCED SIZE, loosely: carnivore upper cilia run 2-5 mm. On a 13.5 mm
// cornea 3 mm is a lash that reaches about a fifth of the way across the eye,
// which is what the reference photographs show. The shaft is 50-70 microns,
// i.e. sub-pixel at every framing in `shots/` except `macro_eye`, so the
// ribbon carries the same screen-space width floor and energy-preserving
// tent Whiskers.js uses -- without it a lash alternates between invisible and
// crawling, which is worse than absent.
const LASH_N = 14;                 // per eye, upper lid
const LASH_U = 0.84;               // spread over |u| <= this, off the canthi
const LASH_LEN = [0.0028, 0.0046]; // shortest at the canthi, longest mid-lid
const LASH_CURL = 0.34;            // share of length spent curling off the globe
const LASH_CURL_N = 1.00;          // curl direction: along the lid's normal...
const LASH_CURL_R = 0.00;          // ...and radially outward, both invisible here
// Swept against the on-screen sagitta: 0 / 0.8 / 1.6 / 3.0 / 5.0 gives
// 0.87 / 1.29 / 2.60 / 3.86 / 5.22 px of bow on a 120 px strand, with the
// strand length unchanged, so it is a genuine curve and not a shortening.
// 3.0 is a definite curve that is still restrained. Note it is scaled by the
// strand's own aSkew, so the mid-lid cilia stay nearly straight and the ones
// toward the canthi curve most -- which is how a lash line actually fans.
const LASH_CURL_S = 3.00;          // ...and laterally, which is the one that reads
const LASH_THICK = 0.000078;       // shaft at the follicle
const LASH_TIP = 0.000013;
const LASH_MIN_PX = 1.05;          // screen-space width floor
const LASH_SEGS = 5;

// WHERE THE FOLLICLE IS. "Built from the aperture curves at aS = 0" was only
// half the statement, and the missing half is radial.
//
// aS = 0 is the right ANGLE — it is the free edge of the fissure. But the lid
// BAND at aS = 0 does not sit on the globe: `buildLids`'s vertex is
// feDir * (feGlobeR + feProud) with feProud = uR * (0.010 + 0.048) at aS = 0,
// i.e. 0.058 R proud, while the lash rooted at feGlobeR + 0.012 R. On an
// 11.56 mm globe that is 0.53 mm of lid thickness the follicle was under, and
// because the root direction is 23 degrees off the optical axis a smaller
// radius projects INWARD: measured at macro_eye, the upper margin at u = 0
// lands at y = 433.1 px and the lash root at y = 441.0 px, so every follicle
// sat 7.9 px inside the palpebral aperture, on the bare globe. Matted against
// a no-lash arm, 563 px of cilia ink (22.9 % of it) fell on the exposed globe.
//
// Two changes, both taken from the lid's own solve so the two can never
// disagree again: the root carries the lid's `feProud`, and it sits a fixed
// arc ANTERIOR of the free edge rather than on it — cilia emerge from the
// anterior lamella, in front of the mucocutaneous junction, not out of the
// tarsal edge itself. In millimetres, not in band fractions: `aSpread` is
// measured per column and runs 3:1 around one socket, so a fixed fraction of
// the band would put the lash line three times further back under the brow
// than at the canthus.
const LASH_ROOT_ARC = 0.00045;     // metres of arc anterior of the free edge

/** Gnomonic tangent -> sine of the angle: where that margin sits on the globe. */
const chord = (t) => t / Math.sqrt(1 + t * t);

const smoothstep01 = (a, b, x) => {
  const t = clamp((x - a) / (b - a || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
};

const F0_TEAR = 0.028;      // tear film, n = 1.336

// THE TEAR FILM'S ROUGHNESS IS WHAT DRAWS THE HARD LINE ACROSS THE PUPIL.
//
// Review 6 measures a navy pupil with a hard horizontal terminator: above it
// (8.5, 14.1, 22.8), below (7.1, 8.2, 11.7), completing in ~5 px on a 130 px
// pupil. Attributed here, in one page session at one sim instant with TAA
// reset per arm, and it is none of the things it looks like:
//
//   arm                          pupil upper / lower, B-R
//   base                          +16.7 / +5.1      the step
//   uPupilCol -> pure red         upper (78.5, 9.6, 21.7), lower (74.4, 0.5,
//                                 0.6) -- both halves ARE the pupil, and the
//                                 difference is an ADDITIVE (4, 9, 21), not
//                                 a multiplicative shadow
//   uCaustic = 0                  identical
//   cornea overlay hidden         identical
//   AO / bloom / DoF / rays / TAA identical, each skipped individually
//   ball rolled 0.7 rad           iris fibres rotate, THE LINE DOES NOT --
//                                 so it is not in the globe's object space
//   scene.environment = null      LINE GONE, pupil uniformly black
//
// So it is the 256 px PMREM's sky/ground horizon, reflected in the clearcoat
// at a roughness sharp enough to resolve it. The comment at
// `material.clearcoatRoughness` already predicted exactly this and set 0.075
// to avoid it; 0.075 was not enough.
//
// A TRAP WORTH THE LINE: `material.envMapIntensity` is a NO-OP on this
// material. 0.85 -> 0 and 0.85 -> 6.0 both produced byte-identical pixels,
// with and without `needsUpdate`. The globe has no envMap of its own
// (`scene.environment` supplies it), and on that path the scene's own
// intensity is what scales the reflection. An A/B arm built on
// envMapIntensity here measures nothing at all -- which is the failure mode
// AGENTS.md warns about, and it cost me two runs.
// SWEPT, one page session, one sim instant, TAA reset per arm. The split is
// present or absent, and the metric that separates them is how many pupil
// rows fall above the largest row-to-row jump in B-R: with the split the jump
// lands at the terminator and 6369 px sit above it; without, the jump lands
// on the pupil's own top edge and 19-48 px do.
//
//   uCoatRough   0.075   0.12   0.17   0.24   0.34
//   px above      6369     48     19     48     48
//   pupil rgb   see note  11/18/28  13/21/32  14/23/34  13/22/33
//
// 0.075 is the old value and it reproduces the defect exactly, which is the
// positive control. 0.12 already clears it; above that the pupil only gets
// brighter, and §4b wants it black. 0.13 for a little margin.
const COAT_ROUGH = 0.050;   // corneal tear film. See COAT_IBL below.
// THE CATCHLIGHT IS AN IMAGE OF A LIGHT SOURCE, so it is authored as one: a
// patch with an angular size, an aspect and an edge, not as a BRDF lobe. See
// the note in _corneaMaterial. uSkyLobe is its angular half-width in RADIANS
// OF REFLECTED RAY (the surface normal moves half as far, so a half-width w
// paints a highlight about w * Rc wide on the cornea); uSkyGain is its
// strength. Both stay uniforms so the pair can be swept in one page session
// at one sim instant rather than by re-rendering the file.
//
// SIZED AGAINST THE REVIEW'S OWN NUMBER. Review 6 measures the old dot at
// 7x7 px, "2.1 % of the 337 px iris width", and asks for a shaped
// reflection. On the exposed-globe matte the palpebral fissure is 469 px at
// macro_eye and the cornea 358 px across for 13.5 mm, so 0.24 rad of
// reflected ray is 0.12 rad of surface, i.e. 1.08 mm, i.e. about 57 px --
// 12 % of the fissure and 16 % of the cornea. That is a highlight a viewer
// reads as a reflection of something rather than as a speck of dust.
const SKY_LOBE = 0.21;      // catchlight half-width, radians of reflected ray
const CL_ASPECT = 0.62;     // its height as a fraction of its width
const CL_SOFT = 0.10;       // where the falloff starts, as a fraction of 1
const CL_FALLOFF = 1.60;    // and its curve; 1 is linear-in-smoothstep
const CL_CORE = 0.34;       // the hot core's extent
const CL_CORE_GAIN = 2.30;  // and how much brighter the core is
const CL_CORE_WHITE = 0.55; // how far the core is pushed to white
const CL_GND_W = 0.72;      // the snow reflection, relative to the sky's
const CL_GND_GAIN = 0.34;   // ...and its strength
// A PATCH IS NORMALISED TO 1 AND A GGX LOBE IS NOT. D peaks at 1/(pi a^2),
// so the lobe this replaces had a peak of 157 at a = 0.045, and the first
// patch at the inherited gain 0.55 was 14x too dim to measure -- six arms
// including gain 0 came back identical, which is the null result that means
// nothing. Swept by DIFFERENCE against an overlay-off arm (the v1 tool
// thresholded absolute luminance at 140 and the overlay's entire
// contribution sat under it): peak added luminance 104.8 / 130.2 / 150.4 at
// gain 9 / 18 / 36, and the highlight measures 52x30 px = 11.1 % of the
// 469 px fissure against review 6's "7x7 px, 2.1 % of the iris width".
const SKY_GAIN = 18.0;      // the catchlight's strength
// WHERE IT LANDS, swept at macro_eye. The highlight appears where the
// reflected view ray meets the patch, so aiming at V puts it dead centre on
// the cornea and aiming at world up puts it at the top of the limbus. At the
// inherited 2.39 it sat high on the IRIS, clear of the pupil, which reads as
// a blister on the eye. 2.39 / 1.20 / 0.70 / 0.45 / 0.25 walk it from above
// the pupil, to its upper edge, to beside it, to below it.
const CL_AIM = 0.72;        // world-up weight in the patch's aim, V weight 1
const CL_SIDE = -0.45;      // lateral slide of the patch, same units
// Seated so the patch SWALLOWS the hard point the clearcoat throws from
// Environment.js's key: swept (aim, side) = (0.90, -0.30) / (0.72, -0.30) /
// (0.72, -0.45) / (0.56, -0.45), which walks the ellipse from clear above
// the pupil, to its upper-right shoulder, to straddling the upper pupil with
// the point inside it, to entirely within the pupil. Straddling is the one
// that still reads as sitting IN FRONT of the iris rather than painted on
// it, which is the whole reason the overlay is a separate mesh.
const COAT_IBL = 0.0;       // globe specular IBL, ON THE CORNEA ONLY

/**
 * EVERY uniform this file injects, declared in ONE place.
 *
 * This block is prepended unconditionally to all five of our shader stages.
 * It used to be split across the aperture/globe/iris chunks, and because each
 * stage concatenates a DIFFERENT SUBSET of those chunks, a uniform used in one
 * chunk but declared in another compiled fine in one stage and failed in
 * another — `uR` and `uSunCol` were used by the iris chunk but declared only
 * by the globe chunk, which the globe's *fragment* stage does not include.
 * That surfaced as an intermittent "undeclared identifier", App.js disabled
 * the whole system, and the untextured blob left behind was mistaken for a
 * post-processing wash by two other agents. One block, no subsets, no repeat.
 *
 * Unused declarations in a given stage are free — GLSL compilers strip them.
 */
const EYE_UNIFORMS = /* glsl */ `
uniform float uR, uRc, uZc, uK, uCapDz;
uniform float uIrisR, uLimbusR, uPupilR, uFibreN, uCollarette, uEta, uIrisZ;
uniform float uCaustic, uWetness, uSunInt;
uniform float uApW, uApUp, uApDn, uApTilt, uBlinkU, uBlinkD;
uniform float uSpread;
uniform float uLidYaw, uLidPitch;
uniform float uLidScatter;
uniform float uLidSwell;
uniform float uNasalSign, uLidAO, uLidCrease, uCanthus;
uniform float uCoatRough, uSkyLobe, uSkyGain, uCoatIBL, uClAim, uClSide;
uniform vec3 uCaruncle;
uniform vec3 uIrisInner, uIrisMid, uIrisOuter, uLimbal, uPupilCol, uSclera;
uniform vec3 uMarginCol, uLidSkin, uLidFur;
uniform vec3 uCamL, uSunL, uUpL, uSunCol, uSkyCol, uBounceCol;
`;

/**
 * Shared GLSL: the aperture curves. Lid geometry and the globe's contact
 * shadow must agree on these exactly, so they are written once.
 *
 * NAMING. Everything injected from this file is prefixed `fe` (fox eye).
 * These chunks are spliced into three's own meshphysical program at a scope
 * we do not control, and an unprefixed helper that happens to match something
 * three adds in a future release fails as a shader compile error — which
 * App.js swallows into a disabled system and a silently empty socket. The
 * prefix is cheap; finding that bug is not.
 */
const APERTURE_GLSL = /* glsl */ `
float feSat(float x){ return clamp(x, 0.0, 1.0); }
float feApShape(float u, float p){ return pow(max(1.0 - u*u, 0.0), p); }
// The two margins meet exactly at u = +/-1, and "exactly" leaves a one-pixel
// crack at the canthus that the dark sclera shows through as a black notch.
// Lap them over each other slightly at the corners instead.
float feLap(float u){ return 0.022 * smoothstep(0.78, 1.0, abs(u)); }
float feApUpY(float u){ return uApUp * feApShape(u, 0.58) + uApTilt * u - feLap(u); }
float feApDnY(float u){ return -uApDn * feApShape(u, 0.72) + uApTilt * u + feLap(u); }
float feApClosedY(float u){ return -0.17 * uApDn * feApShape(u, 0.50) + uApTilt * u; }
float feLidUpY(float u){ return mix(feApUpY(u), feApClosedY(u), uBlinkU); }
float feLidDnY(float u){ return mix(feApDnY(u), feApClosedY(u), uBlinkD); }
`;

/** Shared GLSL: the globe's surface of revolution z = f(rho). */
const GLOBE_GLSL = /* glsl */ `
float feSmaxK(float a, float b, float k){
  float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0);
  return mix(b, a, h) + k * h * (1.0 - h);
}
float feGlobeZ(float rho){
  float zs = sqrt(max(uR * uR - rho * rho, 0.0));
  float ic = uRc * uRc - rho * rho;
  if (ic <= 0.0) return zs;
  return feSmaxK(zs, uZc + sqrt(ic), uK);
}
/**
 * Radius of the globe surface along a unit direction. The profile is given as
 * z = f(rho), so solve t*d.z = f(t*|d.xy|) by fixed point — it converges in
 * two steps for anything the lid can reach (d.z stays above ~0.6) and it is
 * exact on the optical axis. The lid has to ride over the real corneal dome,
 * not a sphere, or a closing lid saws straight through the cornea.
 */
float feGlobeR(vec3 d){
  float dz = max(d.z, 0.35);
  float dxy = length(d.xy);
  float t = uR;
  t = feGlobeZ(t * dxy) / dz;
  t = feGlobeZ(t * dxy) / dz;
  t = feGlobeZ(t * dxy) / dz;
  // Past the corneal cap the surface IS the scleral sphere, exactly, and the
  // fixed point above is not defined there: it divides by a clamped d.z and
  // flies outward, which turns a long lid band into a flare standing off the
  // face. The cap ends at rho = uRc, i.e. d.z = sqrt(1 - (uRc/uR)^2), so hand
  // the answer over to the sphere across that crossing.
  //
  // uCapDz IS A UNIFORM BECAUSE THE CAP RATIO IS NO LONGER A CONSTANT. This
  // was written as smoothstep(0.62, 0.52, d.z), the crossing for the old
  // fixed uRc/uR = 0.815. The cornea is now sized in millimetres and the
  // globe by the socket fit, so the ratio moves: at uRc/uR = 0.90 the
  // crossing is 0.436, and a hardcoded 0.62 hands the lid over to the
  // SPHERE while the cap is still 0.6 mm proud of it -- a closing lid then
  // saws straight through the cornea, which is the artefact this whole
  // fixed point exists to avoid.
  return mix(t, uR, smoothstep(uCapDz + 0.04, uCapDz - 0.06, d.z));
}
`;

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

const smaxK = (a, b, k) => {
  const h = clamp(0.5 + 0.5 * (a - b) / k, 0, 1);
  return lerp(b, a, h) + k * h * (1 - h);
};

/**
 * The globe: a sphere of radius R with a corneal cap of radius Rc smooth-maxed
 * onto its front. Normals are derived analytically from the profile rather
 * than by face averaging — a UV sphere's duplicated seam column averages to
 * two slightly different normals and leaves a visible hairline down the iris.
 */
function buildGlobe(R, Rc, zc, k, segW, segH) {
  const g = new THREE.SphereGeometry(1, segW, segH);
  g.rotateX(Math.PI / 2);                       // pole -> +Z (the optical axis)
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  const prof = (rho) => {
    const zs = Math.sqrt(Math.max(R * R - rho * rho, 0));
    const ic = Rc * Rc - rho * rho;
    return ic <= 0 ? zs : smaxK(zs, zc + Math.sqrt(ic), k);
  };
  const H = 2e-6;
  for (let i = 0; i < pos.count; i++) {
    const ux = pos.getX(i), uy = pos.getY(i), uz = pos.getZ(i);
    const rho = Math.hypot(ux, uy) * R;
    const x = ux * R, y = uy * R;
    if (uz <= 0) {                              // rear hemisphere: plain sphere
      pos.setXYZ(i, x, y, uz * R);
      nrm.setXYZ(i, ux, uy, uz);
      continue;
    }
    pos.setXYZ(i, x, y, prof(rho));
    if (rho < 1e-6) { nrm.setXYZ(i, 0, 0, 1); continue; }
    // n = normalize(-f'(rho) * rhoHat, 1)
    const dfd = (prof(rho + H) - prof(rho - H)) / (2 * H);
    const inv = 1 / rho;
    let nx = -dfd * x * inv, ny = -dfd * y * inv, nz = 1;
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm.setXYZ(i, nx / l, ny / l, nz / l);
  }
  pos.needsUpdate = true; nrm.needsUpdate = true;
  g.computeBoundingSphere();
  return g;
}

/**
 * The upper lid's cilia, as camera-facing ribbons rooted on the margin curve.
 *
 * Positions are placeholders exactly as they are for the lid band: the real
 * vertex position is solved in the vertex shader from the same aperture
 * curves, so a lash roots where the margin actually is at this blink and
 * follows it shut. `spreadAt` is the SAME per-column sampler `buildLids`
 * uses — the follicle has to know how long the band is at its own column to
 * convert LASH_ROOT_ARC into a position on it.
 */
function buildLashes(n, segs, seed, spreadAt) {
  const rnd = rng(seed);
  const count = n * (segs + 1) * 2;
  const pos = new Float32Array(count * 3);        // placeholder, shader solves it
  const aU = new Float32Array(count);
  const aT = new Float32Array(count);
  const aSide = new Float32Array(count);
  const aWidth = new Float32Array(count);
  const aLen = new Float32Array(count);
  const aCurl = new Float32Array(count);
  const aSkew = new Float32Array(count);
  const aSpread = new Float32Array(count);
  const idx = [];
  let v = 0;
  for (let k = 0; k < n; k++) {
    // Jittered off the even spacing, or fourteen lashes at identical pitch
    // read as a comb. Deterministic: rng(seed), never Math.random.
    const base = v;
    const u = clamp(((k + 0.5) / n * 2 - 1 + (rnd() - 0.5) * (1.4 / n)) * LASH_U, -0.97, 0.97);
    // Longest mid-lid, shortest at the canthi, which is how a lash line
    // tapers; plus 12% of scatter so no two are the same.
    const t = Math.pow(Math.max(0, 1 - u * u), 0.5);
    const len = lerp(LASH_LEN[0], LASH_LEN[1], t) * (0.88 + 0.24 * rnd());
    const curl = LASH_CURL * (0.72 + 0.56 * rnd());
    // Fan: lashes near a canthus lean toward it.
    const skew = u * 0.55 + (rnd() - 0.5) * 0.30;
    const spread = spreadAt(1, u);
    for (let i = 0; i <= segs; i++) {
      const tt = i / segs;
      const w = lerp(LASH_THICK, LASH_TIP, Math.pow(tt, 0.55)) * 0.5;
      for (const sd of [-1, 1]) {
        aU[v] = u; aT[v] = tt; aSide[v] = sd; aWidth[v] = w;
        aLen[v] = len; aCurl[v] = curl; aSkew[v] = skew;
        aSpread[v] = spread;
        v++;
      }
    }
    for (let i = 0; i < segs; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
  g.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  g.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1));
  g.setAttribute('aWidth', new THREE.BufferAttribute(aWidth, 1));
  g.setAttribute('aLen', new THREE.BufferAttribute(aLen, 1));
  g.setAttribute('aCurl', new THREE.BufferAttribute(aCurl, 1));
  g.setAttribute('aSkew', new THREE.BufferAttribute(aSkew, 1));
  g.setAttribute('aSpread', new THREE.BufferAttribute(aSpread, 1));
  g.setIndex(idx);
  return g;
}

/** The corneal overlay: a cap of the cornea sphere, nudged out of z-fighting. */
function buildCornea(Rc, zc, thetaMax, segW, segH) {
  const g = new THREE.SphereGeometry(Rc + 4e-5, segW, segH, 0, TAU, 0, thetaMax);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, zc);
  return g;
}

/**
 * Both lids of one eye as a single mesh. Positions are placeholders: the real
 * vertex position is evaluated in the shader from (aU, aS, aLid) so that a
 * blink costs one uniform write and no CPU work at all.
 */
function buildLids(R, apW, ap, nu, ns, spreadAt) {
  const count = 2 * (nu + 1) * (ns + 1);
  const pos = new Float32Array(count * 3);
  const aU = new Float32Array(count);
  const aS = new Float32Array(count);
  const aLid = new Float32Array(count);
  const aSpread = new Float32Array(count);
  const idx = [];
  let v = 0;
  for (let lid = 0; lid < 2; lid++) {
    const sign = lid === 0 ? 1 : -1;
    const base = v;
    for (let j = 0; j <= ns; j++) {
      const s = j / ns;
      for (let i = 0; i <= nu; i++) {
        const u = (i / nu) * 2 - 1;
        const ax = u * apW;
        const ay = (sign > 0 ? ap.up * Math.pow(Math.max(1 - u * u, 0), 0.58)
          : -ap.dn * Math.pow(Math.max(1 - u * u, 0), 0.72)) + ap.tilt * u;
        const l = Math.hypot(ax, ay, 1) || 1;
        const inx = ax / l, iny = ay / l, inz = 1 / l;
        const rl = Math.hypot(inx, iny) || 1;
        const th = Math.acos(clamp(inz, -1, 1)) + spreadAt(sign, u) * s;
        const st = Math.sin(th);
        pos[v * 3] = (inx / rl) * st * R * 1.06;
        pos[v * 3 + 1] = (iny / rl) * st * R * 1.06;
        pos[v * 3 + 2] = Math.cos(th) * R * 1.06;
        aU[v] = u; aS[v] = s; aLid[v] = sign;
        aSpread[v] = spreadAt(sign, u);
        v++;
      }
    }
    for (let j = 0; j < ns; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i;
        const b = a + 1, c = a + (nu + 1), d = c + 1;
        // Both lids must wind counter-clockwise as seen from OUTSIDE the eye
        // or FrontSide culls them and the bare globe shows through with no
        // aperture at all. +i is +x for both, but +j is +y on the upper lid
        // and -y on the lower, so the lower lid's triangles are mirrored.
        if (sign > 0) idx.push(a, b, c, b, d, c);
        else idx.push(a, c, b, b, c, d);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
  g.setAttribute('aS', new THREE.BufferAttribute(aS, 1));
  g.setAttribute('aLid', new THREE.BufferAttribute(aLid, 1));
  g.setAttribute('aSpread', new THREE.BufferAttribute(aSpread, 1));
  g.setIndex(idx);
  // The shader moves vertices; give the culler a sphere that covers every
  // blink position rather than letting three derive one from the rest pose.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), R * 1.45);
  return g;
}

// ---------------------------------------------------------------------------
// shader fragments
// ---------------------------------------------------------------------------

const IRIS_GLSL = /* glsl */ `

/** Procedural iris. r is normalised to the iris radius, a is the angle. */
vec3 feIris(float r, float a){
  float rr = clamp(r, 0.0, 1.35);

  // Radial stromal fibres. The angle is warped with radius so the fibres are
  // not dead-straight spokes, and three incommensurate harmonics keep them
  // from reading as a regular star.
  // atan() jumps by 2*PI across the -X axis. sin(k*a) only survives that jump
  // when k is an INTEGER, so the harmonic multipliers are integers rather than
  // the pretty irrational ratios you would otherwise reach for — 2.37 and 0.51
  // drew a hard seam straight across the iris. The warp is a function of
  // cos(a)/sin(a) and so is continuous on its own.
  float aw = a + 0.19 * snoise(vec3(cos(a) * 2.1, sin(a) * 2.1, rr * 1.9));
  float fib = 0.52 * sin(aw * 118.0)
            + 0.30 * sin(aw * 279.0 + 1.7)
            + 0.42 * sin(aw * 61.0 - 0.9);
  fib = fib * 0.5 + 0.5;
  float fibAmt = smoothstep(0.26, 0.92, rr) * 0.58 + 0.10;

  // Crypts — the pitted lacework just outside the collarette.
  vec3 cid;
  float w = worley3(vec3(cos(a) * 3.4, sin(a) * 3.4, rr * 4.6), cid).x;
  float crypt = smoothstep(0.12, 0.60, w);

  // §4b / §3 palette: warm amber core, golden-brown mid, dark outer ring.
  // Keep the amber broad. §4b wants "noticeably warm"; ramping to the dark
  // outer ring too early leaves a thin gold annulus on black, which is what
  // the first pass rendered and it reads as a doll's eye.
  vec3 c = mix(uIrisInner, uIrisMid, smoothstep(0.10, 0.62, rr));
  c = mix(c, uIrisOuter, smoothstep(0.68, 0.94, rr));

  // Collarette: the raised ruff about 40% out, brighter and crenulated.
  float coll = exp(-pow((rr - uCollarette) / 0.080, 2.0)) * (0.70 + 0.55 * fib);
  c += uIrisInner * coll * 0.50;

  c *= mix(1.0 - fibAmt * 0.52, 1.0 + fibAmt * 0.34, fib);
  c *= mix(0.84, 1.07, crypt);

  // Limbal ring — §4b's "darker outer ring". Hard and nearly black.
  c = mix(c, uLimbal, smoothstep(0.90, 1.02, rr) * 0.92);

  // Round black pupil with a thin bright pupillary ruff at its margin.
  c = mix(uPupilCol, c, smoothstep(uPupilR * 0.93, uPupilR * 1.07, rr));
  c += uIrisInner * 0.30 * exp(-pow((rr - uPupilR) / 0.050, 2.0));
  return c;
}
`;

// ---------------------------------------------------------------------------

export class Eyes {
  name = 'eyes';
  order = 150;               // after animation (100), before fur (200)

  constructor() {
    this.eyes = [];
    this.enabled = true;
    this._blinkOverride = { L: null, R: null };
    this._lookTarget = null;
    this._pupil = 0.5;
    this._pupilNow = 0.5;
    this._v = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
  }

  async init(ctx) {
    const fox = ctx.fox;
    if (!fox?.anchors?.eyeL || !fox?.anchors?.eyeR) {
      throw new Error('Eyes: ctx.fox.anchors.eyeL/eyeR missing — anatomy has not published yet');
    }
    const tier = ctx.quality.tier;
    const seg = (tier === 'low' ? 0 : tier === 'medium' ? 1 : 2);
    const GW = [28, 48, 72][seg], GH = [20, 34, 52][seg];
    const CW = [20, 30, 44][seg], CH = [8, 12, 18][seg];
    const LU = [20, 34, 52][seg], LS = [5, 9, 13][seg];
    const LN = [8, 11, LASH_N][seg];

    this.group = new THREE.Group();
    this.group.name = 'eyes';

    for (const side of ['L', 'R']) {
      this.eyes.push(this._buildEye(ctx, side, { GW, GH, CW, CH, LU, LS, LN }));
    }

    ctx.eyes = this;
    this._syncUniforms(ctx);
    const e = this.eyes[0];
    const deg = (r) => (r * 180 / Math.PI).toFixed(1);
    console.info(
      `[eyes] globe r ${(e.R * 1000).toFixed(2)} mm · cornea r ${(e.Rc * 1000).toFixed(2)} mm · ` +
      `apex ${(e.apexZ * 1000).toFixed(2)} mm · skin ${(e.skin * 1000).toFixed(2)} mm · ` +
      `coat ${(e.coat * 1000).toFixed(2)} mm · seated ${(e.seat * 1000).toFixed(2)} mm ` +
      `(coat wanted ${(e.seatWanted * 1000).toFixed(2)}, socket allowed ` +
      `${(e.seat * 1000).toFixed(2)})` + (e.seat < e.seatWanted - 1e-5
        ? ` · SOCKET-BOUND, cornea sits ${((e.seatWanted - e.seat) * 1000).toFixed(2)} mm deeper` : '') + ' · ' +
      `iris ø ${(2 * e.irisR * 1000).toFixed(1)} mm · cornea ø ${(2 * e.limbusR * 1000).toFixed(1)} mm · ` +
      // CHORD, not tangent-plane. The margin at u = 1 sits at angle
      // atan(apW) off the optical axis, so its half-width on the globe is
      // R*sin(atan(apW)), not R*apW. Reporting the tangent value overstated
      // the fissure by 21% and is why it took a measured comparison to notice
      // ours was too narrow.
      //
      // fissure/cornea is printed because two rounds of notes quote it, but
      // it is a GLOBE CHORD over a corneal diameter and the sourced 1.28 is
      // a canthus-to-canthus measurement across the face on an animal whose
      // fissure is longer than its own globe. They are not the same quantity.
      // `clears limbus` is the comparison that does transfer.
      `fissure ${(2 * e.R * chord(e.apW) * 1000).toFixed(1)}x` +
      `${(e.R * (chord(e.ap.up) + chord(e.ap.dn)) * 1000).toFixed(1)} mm ` +
      `(${(2 * chord(e.apW) / (chord(e.ap.up) + chord(e.ap.dn))).toFixed(2)}:1, ` +
      `fissure/cornea ${(e.R * chord(e.apW) / e.limbusR).toFixed(2)})`,
    );
    // How far the fissure has failed to keep up with the globe, unsigned.
    // Both angles are nasal-positive in their own side's frame, so this is
    // the one quantity that decides the crescent and it needs no per-side
    // special case.
    const lag = (x) => Math.abs(x.restYaw) - Math.abs(x.lidYaw);
    for (const x of this.eyes) {
      const w = x.win;
      console.info(
        `[eyes] ${x.side} socket opens T ${w ? deg(w.temporal) : '--'}° ` +
        `N ${w ? deg(w.nasal) : '--'}° U ${w ? deg(w.up) : '--'}° D ${w ? deg(w.down) : '--'}° ` +
        `${w ? '' : '(UNMEASURED — field unavailable, using fallback) '}· ` +
        `canthi ±${deg(x.apTh)}° (AP_W ${x.apW.toFixed(3)}) · limbus ${deg(x.limbusTh)}° · ` +
        `converge ${deg(x.restYawRaw)}° → ${deg(x.restYaw)}° (max ${deg(x.convMax)}°) · ` +
        `fissure follows ${deg(x.lidYaw)}° · ` +
        // The number that decides whether there is a black crescent: how far
        // outside the limbus each lid margin sits, measured from the CORNEAL
        // axis rather than the orbital one. Equal is the goal; 15.9 vs 0.5 is
        // what the critic called an asymmetric O-ring.
        `sclera N ${deg(x.apTh - lag(x) - x.limbusTh)}° / ` +
        `T ${deg(x.apTh + lag(x) - x.limbusTh)}°`,
      );
    }
  }

  // ------------------------------------------------------------------ build --
  _buildEye(ctx, side, segs) {
    const fox = ctx.fox;
    const anchor = fox.anchors[`eye${side}`];
    const meta = fox.eyes?.[side] ?? null;

    // --- globe radius: what the anatomy says, CLAMPED to what fits --------
    // The rig's nominal ball radius and the depth of the socket carved for it
    // are independent numbers, and right now they disagree: the ball is
    // 11.56 mm but the socket floor is only 8.56 mm down and the skin does not
    // wrap the ball until about 55 degrees off axis. Taking the nominal radius
    // literally puts a third of a 23 mm sphere outside the face — a marble
    // stuck on the head, which is what the first pass rendered.
    //
    // So: measure how much room the socket really has and shrink to fit. This
    // only ever shrinks, and it re-measures from the live SDF, so if the
    // anatomy agent deepens the socket the globe grows back on its own.
    let rNominal = 0.0116;
    if (meta?.centre && meta?.surface) {
      const c = meta.centre, sf = meta.surface;
      rNominal = Math.hypot(sf[0] - c[0], sf[1] - c[1], sf[2] - c[2]) +
        (meta.cornealProud ?? 0.003);
    }
    rNominal = clamp(rNominal, 0.006, 0.020);

    // SOLVE THE RADIUS AND THE SEAT TOGETHER, WITH THE SOCKET WINNING. They
    // are not independent, and until this round they were solved as if they
    // were: `_fitGlobeRadius` certified a radius against the socket measured
    // from the socket CENTRE, and the globe was then pushed `seat` further
    // out along the optical axis to lift the cornea clear of the coat. Every
    // millimetre of that push is spent out of the clearance the fit had just
    // certified, in the forward hemisphere where the skin is nearest.
    //
    // THE FIRST ATTEMPT AT THIS FIX WENT THE WRONG WAY ROUND, and the way it
    // failed is worth keeping, because it is counter-intuitive: shrinking the
    // globe to fit made the protrusion WORSE. The apex has to land at
    // meas + clear whatever the radius is, so the seated centre sits at
    // meas + clear - R(1 + BULGE): a SMALLER globe puts its centre FURTHER
    // OUT. Measured, that iteration ran to R = 6.36 mm and the seat cap at
    // 5.80 mm and still left the globe 2.85 mm outside the skin, against
    // 3.80 mm before it. Two thirds of the shrink bought nothing.
    //
    // So the seat is the variable that gives way, not the radius. `seatCeil`
    // is the largest push for which the socket still swallows the globe, and
    // the coat clearance is honoured only as far as that. A cornea sitting a
    // millimetre deeper in the hair than ideal is a shading question; a globe
    // outside the skull is a hard blue polygon drawn against the sky.
    const meas = this._measureSkin(fox, meta, rNominal);
    const coat = this._measureCoat(fox, meta, rNominal);
    const clear = APEX_CLEARANCE + Math.min(COAT_CLEAR_SHARE * Math.max(coat, 0), COAT_CLEAR_MAX);
    const seatCeil = (rx) => {
      if (this._fitGlobeRadius(fox, meta, MAX_SEAT_PUSH) >= rx) return MAX_SEAT_PUSH;
      let lo = MAX_SEAT_PULL, hi = MAX_SEAT_PUSH;
      for (let i = 0; i < 12; i++) {
        const m = 0.5 * (lo + hi);
        if (this._fitGlobeRadius(fox, meta, m) >= rx) lo = m; else hi = m;
      }
      return lo;
    };
    let R = rNominal, seat = 0;
    for (let it = 0; it < 3; it++) {
      const want = meas > 0 ? clamp(meas + clear - R * (1 + CORNEA_BULGE),
        MAX_SEAT_PULL, MAX_SEAT_PUSH) : 0;
      seat = Math.min(want, seatCeil(R));
      // With the seat already bounded by the fit this normally leaves R
      // alone; it only bites when even MAX_SEAT_PULL cannot contain the ball
      // the anatomy published, in which case the ball is genuinely too big
      // for its socket and shrinking is the only remaining move.
      const rFit = this._fitGlobeRadius(fox, meta, seat);
      R = rFit > 0 ? clamp(Math.min(rNominal, rFit), 0.55 * rNominal, rNominal) : rNominal;
    }
    const seatWanted = meas > 0 ? clamp(meas + clear - R * (1 + CORNEA_BULGE),
      MAX_SEAT_PULL, MAX_SEAT_PUSH) : 0;

    // THE CORNEA IS SIZED IN MILLIMETRES, NOT AS A FRACTION OF THE GLOBE, and
    // that is the finding that makes the shrink above safe to make.
    //
    // The sources already quoted at the top of this file say it outright:
    // globe size differs significantly between a 5 kg wild canid and a small
    // dog (p < 0.0155) and CORNEAL diameter does not (p > 0.122). A small
    // canid is proportionally almost all cornea. So when the socket fit takes
    // the globe down, the visible eye must NOT come down with it — the iris
    // and the limbal ring are the part of this render the last review listed
    // under "what is genuinely good", and shrinking them to keep a constant
    // ratio would trade a blocker for a worse one.
    //
    // CORNEA_R is therefore solved for, per eye, so the limbus lands on
    // CORNEA_DIA/2 — bisection on the same limbus test used below, which is
    // the only way to be sure the two agree. It is capped at CORNEA_OF_GLOBE
    // of the globe diameter because a cap radius approaching R degenerates:
    // zc goes to zero, the smooth-max has nothing to blend, and the profile
    // turns into a hemisphere with a crease round it.
    const limbusOf = (cf) => {
      const rc = cf * R, zcx = R * (1 + CORNEA_BULGE) - rc;
      for (let i = 1; i <= 96; i++) {
        const rho = (i / 96) * rc * 0.999;
        const zs = Math.sqrt(Math.max(R * R - rho * rho, 0));
        const zcn = zcx + Math.sqrt(Math.max(rc * rc - rho * rho, 0));
        if (zs > zcn) return rho;
      }
      return 0.5 * R;
    };
    const limbusWant = Math.min(0.5 * CORNEA_DIA, CORNEA_OF_GLOBE * R);
    let lo = 0.50, hi = 0.97;
    for (let i = 0; i < 24; i++) {
      const mid = 0.5 * (lo + hi);
      if (limbusOf(mid) < limbusWant) lo = mid; else hi = mid;
    }
    const corneaF = clamp(0.5 * (lo + hi), 0.50, 0.97);

    const Rc = corneaF * R;
    const zc = R * (1 + CORNEA_BULGE) - Rc;       // cornea sphere centre on +Z
    const k = BLEND_K * R;
    const apexZ = R * (1 + CORNEA_BULGE);
    const limbusR = limbusOf(corneaF);
    const irisZ = apexZ - IRIS_DEPTH * R;
    const irisR = IRIS_R * limbusR;

    // THE APERTURE IS SIZED OFF THE CORNEA, NOT OFF THE GLOBE, for the same
    // reason. (x, y) here are gnomonic tangents — tan(angle) off the optical
    // axis — so a constant AP_UP is a constant ANGLE, and a constant angle on
    // a smaller globe is a shorter fissure in millimetres. The note above
    // already derived the height it wants as a fraction of CORNEAL DIAMETER
    // ("held near 0.63 x corneal diameter"); this just stops that derivation
    // being silently re-scaled by whatever the socket does to R.
    const apHalf = 0.5 * AP_H_OF_CORNEA * 2 * limbusR;
    const tanOfChord = (mm) => {
      const s = clamp(mm / R, 0, 0.985);
      return Math.tan(Math.asin(s));
    };
    const ap = {
      up: clamp(tanOfChord(apHalf * 2 * AP_UD_SPLIT), 0.20, 1.60),
      dn: clamp(tanOfChord(apHalf * 2 * (1 - AP_UD_SPLIT)), 0.18, 1.60),
      tilt: AP_TILT,
    };

    // --- the optical axis, in the anchor's own frame ----------------------
    // `meta.look` lives in the skinned mesh's object space; the anchor hangs
    // off the head bone. Map one to the other through the bind inverse so a
    // reposed or rescaled skull changes nothing here.
    //
    // The orientation is composed as (bindInverse * qField) rather than taken
    // straight from the rotated axis, because those two differ by a TWIST
    // about the optical axis and the twist decides which way is "up" for the
    // eyelids. _lidSpreadSampler measures the skin through qField, so the
    // geometry has to be built in the same frame or the upper lid's measured
    // clearance gets applied to the side of the eye.
    const look = new THREE.Vector3(side === 'R' ? 0.58 : -0.58, 0.15, 0.80);
    if (meta?.look) look.fromArray(meta.look);
    look.normalize();
    const qField = new THREE.Quaternion()
      .setFromUnitVectors(new THREE.Vector3(0, 0, 1), look);

    const head = fox.bone?.('head');
    const bones = fox.skeleton?.bones;
    const bi = bones ? bones.indexOf(head) : -1;
    const qBind = new THREE.Quaternion();
    if (bi >= 0 && fox.skeleton.boneInverses?.[bi]) {
      qBind.setFromRotationMatrix(
        new THREE.Matrix4().extractRotation(fox.skeleton.boneInverses[bi]));
    }
    const qLocal = qBind.clone().multiply(qField);
    const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(qLocal).normalize();

    // The globe's rest rotation inside that socket (see EYE_CONVERGE above).
    // Expressed as a yaw/pitch in the socket's own frame so it simply adds to
    // whatever gaze the animation agent hands us.
    const conv = new THREE.Vector3(
      look.x * (1 - EYE_CONVERGE), look.y * (1 - EYE_LEVEL), look.z).normalize()
      .applyQuaternion(qField.clone().invert());
    const restYawRaw = clamp(Math.atan2(conv.x, Math.max(conv.z, 1e-3)), -0.55, 0.55);
    const restPitch = clamp(Math.asin(clamp(conv.y, -1, 1)), -0.35, 0.35);

    // (The seat was solved together with the radius above, bounded by the
    // socket. `seatWanted` is what the coat clearance asked for and `seat` is
    // what the socket allowed; the difference is printed at init so the next
    // reader can see whether the eye is sitting deeper than ideal, and by how
    // much, instead of having to re-derive it.)

    // --- the palpebral aperture, from the socket rather than from a number --
    const win = this._measureAperture(fox, meta, R, Rc, zc, k, seat);
    const limbusTh = Math.asin(clamp(limbusR / R, 0, 1));   // limbus, in radians off axis
    // THE FISSURE FOLLOWS THE GLOBE, as far as the nasal wall allows.
    //
    // The note that used to be here said the aperture must stay centred on the
    // orbital axis because "rotating it nasally walks it straight into the
    // near wall and comes out SHORTER (13.5 mm against 15.2 for a 3-degree
    // rotation)". That was measured on a socket that opened 97.9 degrees in
    // total. The anatomy agent's muzzle work has since moved the nasal wall
    // out: this socket now measures T 64.8 / N 54.8 = 119.6 degrees, and the
    // trade is no longer the one that measurement describes.
    //
    // Leaving the fissure centred while the globe converges 8.8 degrees is
    // what the critic is looking at. Measured on `macro_eye` with each
    // surface forced to a unique primary and the mask read back off the
    // untinted frame: 30 423 px of bare sclera, 28 989 of them (95.3 %) on
    // the temporal side — a 20 : 1 split, 128 px against 17 px on the iris
    // centre row, against an iris radius of 249 px. The geometry predicts
    // exactly that: temporal margin at apTh + restYaw = 15.9 degrees outside
    // the limbus, nasal margin at 0.5 degrees outside it.
    //
    // So rotate the fissure with the globe. The cost is width — the nasal
    // canthus is the one near a wall — and the cost is bounded and measured:
    // half-width becomes min(nasalRoom - follow, temporalRoom + follow).
    const nasalRoom = win ? win.nasal - AP_WALL_MARGIN : Math.atan(0.78);
    const tempRoom = win ? win.temporal - AP_WALL_MARGIN : Math.atan(0.78);
    // Never follow so far that the fissure's own half-width drops onto the
    // limbus: a margin inside the limbus clips the iris, which is the defect
    // this is here to cure, arriving from the other direction.
    const minHalf = limbusTh + CONVERGE_RECESS;
    const follow = win
      ? clamp(Math.min(Math.abs(restYawRaw), Math.max(0, nasalRoom - minHalf)), 0, 0.45)
      : 0;
    // The ceiling is whichever is TIGHTER: the absolute cap, or the limbus
    // plus the authored scleral clearance. See SCLERA_CLEAR — the absolute
    // cap was the binding one and it put 8.2 degrees of black at each canthus.
    const apCeil = Math.min(Math.atan(AP_W_CEIL), limbusTh + SCLERA_CLEAR);
    const apTh = win
      ? clamp(Math.min(nasalRoom - follow, tempRoom + follow),
        Math.min(Math.atan(AP_W_FLOOR), apCeil), apCeil)
      : Math.atan(0.78);
    const apW = Math.tan(apTh);
    // The globe may converge as far as the fissure has followed it, PLUS
    // whatever clearance the fissure still has outside the limbus. Past that
    // the lid margin crosses inside the limbus on the side the globe is
    // turning away from, which is the black O-ring.
    const convMax = follow + Math.max(0, apTh - limbusTh - CONVERGE_RECESS);
    const restYaw = clamp(restYawRaw, -convMax, convMax);
    // Signed in the socket's own frame: `restYawRaw` is already negative
    // toward the nose on the right eye and positive on the left, because
    // eye-local +X flips meaning between sides. The fissure takes the same
    // sign, so nothing here is a per-side constant.
    const lidYaw = clamp(restYawRaw, -follow, follow);

    // --- assemble ----------------------------------------------------------
    const root = new THREE.Group();
    root.name = `eye${side}`;
    root.quaternion.copy(qLocal);
    root.position.copy(axis).multiplyScalar(seat);
    anchor.add(root);

    const ball = new THREE.Group();          // carries gaze rotation
    ball.name = `eyeBall${side}`;
    root.add(ball);

    const u = this._makeUniforms(ctx, R, Rc, zc, k, irisZ, irisR, limbusR, apW, ap);
    // Which sign of the lid's own u is the NOSE. `restYawRaw` is the
    // convergence — the rotation that turns the globe toward the midline — so
    // its sign is nasal by construction, and it is already opposite between
    // the sides because eye-local +X is. Derived rather than switched on
    // `side`, because every per-side constant in this file has eventually
    // turned out to be one of them backwards.
    u.uNasalSign.value = restYawRaw >= 0 ? 1 : -1;

    const globe = new THREE.Mesh(
      buildGlobe(R, Rc, zc, k, segs.GW, segs.GH),
      this._globeMaterial(u, side),
    );
    globe.name = `eyeGlobe${side}`;
    globe.castShadow = false;
    globe.receiveShadow = false;
    ball.add(globe);

    const thetaMax = Math.min(Math.asin(clamp(limbusR / Rc, 0, 1)) * 1.06, Math.PI * 0.49);
    const cornea = new THREE.Mesh(
      buildCornea(Rc, zc, thetaMax, segs.CW, segs.CH),
      this._corneaMaterial(u),
    );
    cornea.name = `eyeCornea${side}`;
    cornea.renderOrder = 12;
    cornea.castShadow = false;
    ball.add(cornea);

    const spreadAt = this._lidSpreadSampler(fox, meta, R, apW, ap, seat, lidYaw);
    const lids = new THREE.Mesh(buildLids(R, apW, ap, segs.LU, segs.LS, spreadAt),
      this._lidMaterial(u));
    lids.name = `eyeLids${side}`;
    lids.castShadow = false;
    lids.receiveShadow = false;
    lids.frustumCulled = false;   // shader-moved verts; the bound is a guess
    // YXZ so the yaw is the outer rotation: `update` writes rotation.x every
    // frame (the lids follow the gaze a little) and that pitch has to happen
    // INSIDE the yawed frame, or the aperture tilts as the eye looks up.
    lids.rotation.order = 'YXZ';
    lids.rotation.y = lidYaw;
    root.add(lids);

    // Cilia, in the LID's frame (they root on the margin, which is yawed with
    // the fissure) rather than the globe's.
    const lashes = new THREE.Mesh(
      buildLashes(segs.LN, LASH_SEGS, side === 'L' ? 20261 : 20262, spreadAt),
      this._lashMaterial(u));
    lashes.name = `eyeLashes${side}`;
    lashes.castShadow = false;
    lashes.receiveShadow = false;
    lashes.frustumCulled = false;   // every vertex is solved in the shader
    lashes.renderOrder = 13;        // over the cornea's additive overlay (12)
    lashes.rotation.order = 'YXZ';
    lashes.rotation.y = lidYaw;
    root.add(lashes);

    return {
      side, anchor, root, ball, globe, cornea, lids, lashes, u, axis,
      R, Rc, zc, apexZ, irisZ, irisR, limbusR, seat, coat, skin: meas,
      apW, apTh, ap, limbusTh, win, restYawRaw, convMax, lidYaw, follow, seatWanted,
      nasalRoom, tempRoom,
      restYaw, restPitch,
      blink: 0, gazeYaw: 0, gazePitch: 0,
    };
  }

  /**
   * Distance from the eyeball centre out to the skin along the optical axis.
   * Uses the anatomy agent's own SDF, so it re-measures correctly after their
   * rework. Returns -1 when the field is unavailable or the ray misses.
   */
  /**
   * Build `spreadAt(lidSign, u)` — how far, in radians of arc, the lid band at
   * column `u` must sweep before the fox's own skin closes over the globe.
   *
   * Sampled at COLS columns per lid and linearly interpolated; the skin varies
   * smoothly enough around one socket that more would be wasted raycasts.
   * Falls back to a constant if the SDF is not available.
   */
  _lidSpreadSampler(fox, meta, R, apW, ap, seat = 0, lidYaw = 0) {
    const COLS = 25;
    const f = fox.field;
    const flat = () => LID_SPREAD;
    if (!f?.raycast || !meta?.centre || !meta?.look) return flat;

    const c = meta.centre;
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1), new THREE.Vector3().fromArray(meta.look).normalize());
    // The lid mesh is yawed `lidYaw` off the socket axis (the fissure follows
    // the converged globe), so a direction given in LID-local coordinates
    // reaches the field through q * Ry(lidYaw). Measuring in the unrotated
    // frame would apply the nasal column's clearance to the temporal column
    // and leave a crescent of bare sclera on one side only.
    if (lidYaw) {
      q.multiply(new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), lidYaw));
    }
    const d = new THREE.Vector3();
    // The lid rides the globe, and the globe is seated `seat` further out
    // along the optical axis than the socket centre these rays start from. A
    // sampler that ignores the seat stops the band exactly one seat-length
    // short of the skin and leaves a ring of bare sclera all the way round.
    const need = R + Math.max(seat, 0) + 0.0009;   // globe + lid thickness

    // Distance to the skin along a direction given in EYE-LOCAL coordinates.
    const skinAt = (lx, ly, lz) => {
      d.set(lx, ly, lz).normalize().applyQuaternion(q);
      const t = f.raycast(c[0] + d.x * 1e-3, c[1] + d.y * 1e-3, c[2] + d.z * 1e-3,
        d.x, d.y, d.z, 0.07);
      return t > 0 ? 1e-3 + t : Infinity;
    };

    const table = [new Float32Array(COLS), new Float32Array(COLS)];
    const raw = [new Float32Array(COLS), new Float32Array(COLS)];
    for (let li = 0; li < 2; li++) {
      const sign = li === 0 ? 1 : -1;
      for (let i = 0; i < COLS; i++) {
        const u = (i / (COLS - 1)) * 2 - 1;
        const shp = (pw) => Math.pow(Math.max(1 - u * u, 0), pw);
        const lap = 0.022 * smoothstep01(0.78, 1.0, Math.abs(u));
        const ay = sign > 0 ? ap.up * shp(0.58) + ap.tilt * u - lap
          : -ap.dn * shp(0.72) + ap.tilt * u + lap;
        const ax = u * apW;
        const l = Math.hypot(ax, ay, 1);
        const th0 = Math.acos(clamp(1 / l, -1, 1));
        const rl = Math.hypot(ax, ay) || 1;
        const rx = ax / rl, ry = ay / rl;

        // March outward until the skin has closed over the globe, then BISECT.
        //
        // The march alone was the fix's own defect. Fourteen steps over
        // 1.05 rad quantises the answer to 4.3 degrees, and the table it
        // produced stepped 35.8 / 31.5 / 31.5 / 30.5 / 27.2 ... across
        // fifteen columns — so the band's outer boundary was a staircase with
        // 4-degree risers. Seen at the grazing angle the lower lid is always
        // viewed at, that staircase renders as a fan of hard black-and-pale
        // stripes radiating from the canthus: the exact artefact visible on
        // the lower-temporal quadrant of one eye at `frontal`, and the reason
        // that eye read as broken while its mirror image read as an eye.
        // Twelve bisections take the resolution to 0.015 degrees.
        const open = (th) => {
          const st = Math.sin(th), ct = Math.cos(th);
          return skinAt(rx * st, ry * st, ct) >= need;
        };
        let lo = 0, hi = -1;
        for (let k = 1; k <= 14; k++) {
          const th = (k / 14) * 1.05;
          if (open(th0 + th)) { lo = ((k - 1) / 14) * 1.05; hi = th; break; }
        }
        if (hi < 0) { raw[li][i] = LID_SPREAD; continue; }
        for (let k = 0; k < 12; k++) {
          const m = 0.5 * (lo + hi);
          if (open(th0 + m)) hi = m; else lo = m;
        }
        raw[li][i] = 0.5 * (lo + hi);
      }
    }

    // A lid is one continuous membrane, so its tuck line cannot step between
    // neighbouring columns however noisy the field is there. Three-tap
    // binomial smoothing, edges held — this is a statement about the lid, not
    // a filter chosen to make a number look better.
    for (let li = 0; li < 2; li++) {
      for (let i = 0; i < COLS; i++) {
        const a = raw[li][Math.max(0, i - 1)];
        const b = raw[li][i];
        const c2 = raw[li][Math.min(COLS - 1, i + 1)];
        table[li][i] = clamp((a + 2 * b + c2) * 0.25 + LID_SLACK,
          LID_SPREAD_MIN, LID_SPREAD_MAX);
      }
    }

    return (sign, u) => {
      const t = clamp((u + 1) * 0.5, 0, 1) * (COLS - 1);
      const i = Math.min(COLS - 2, Math.floor(t));
      const row = table[sign > 0 ? 0 : 1];
      return lerp(row[i], row[i + 1], t - i);
    };
  }

  /**
   * How far off the optical axis the socket lets the globe out of the skin,
   * along the four meridians of the eye's own frame. In radians, from the
   * SEATED globe centre — which is the frame the lid geometry lives in, and
   * 1.9 mm forward of `meta.centre`, which is the frame the raycasts start in.
   *
   * This is the number that decides the palpebral aperture: a canthus placed
   * past it is a lid margin buried inside the muzzle. Before this existed the
   * aperture was a constant, and that is exactly why the anatomy agent's eye
   * slot — which moved the nasal wall from 37.5 to 44.0 degrees — changed the
   * render by nothing at all.
   *
   * Returns null when the field is unavailable, and the caller then keeps the
   * fallback width rather than silently inventing one (AGENTS.md: an
   * unmeasurable probe must be a hard failure, not a quiet default).
   */
  _measureAperture(fox, meta, R, Rc, zc, k, seat) {
    const f = fox.field;
    if (!f?.raycast || !meta?.centre || !meta?.look) return null;

    // The globe's own surface radius along a direction `theta` off axis,
    // including the corneal cap — the same profile the lid vertex shader
    // solves, so the two agree on where the globe actually is.
    const prof = (rho) => {
      const zs = Math.sqrt(Math.max(R * R - rho * rho, 0));
      const ic = Rc * Rc - rho * rho;
      return ic <= 0 ? zs : smaxK(zs, zc + Math.sqrt(ic), k);
    };
    const globeR = (th) => {
      const dz = Math.max(Math.cos(th), 0.35), dxy = Math.abs(Math.sin(th));
      let t = R;
      for (let i = 0; i < 4; i++) t = prof(t * dxy) / dz;
      return t;
    };

    // The seated centre, and an orthonormal frame on it. `ex` is eye-local
    // +X carried into the field's space; `ey` is eye-local +Y.
    const n = new THREE.Vector3().fromArray(meta.look).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    const ex = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const ey = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const c = [meta.centre[0] + n.x * seat, meta.centre[1] + n.y * seat,
      meta.centre[2] + n.z * seat];
    const d = new THREE.Vector3();

    // Skin has closed over the globe along `th` when the surface is further
    // out than the globe plus a lid thickness.
    const LID_GAP = 0.0009;
    const closed = (ax, ay, th) => {
      const st = Math.sin(th), ct = Math.cos(th);
      d.set(ex.x * ax * st + ey.x * ay * st + n.x * ct,
        ex.y * ax * st + ey.y * ay * st + n.y * ct,
        ex.z * ax * st + ey.z * ay * st + n.z * ct).normalize();
      const t = f.raycast(c[0] + d.x * 1e-3, c[1] + d.y * 1e-3, c[2] + d.z * 1e-3,
        d.x, d.y, d.z, 0.09);
      const hit = t > 0 ? 1e-3 + t : Infinity;
      return hit >= globeR(th) + LID_GAP;
    };

    const LIM = 85 * Math.PI / 180;
    const reach = (ax, ay) => {
      let lo = 0, hi = -1;
      for (let deg = 2; deg <= 85; deg += 1) {
        const th = deg * Math.PI / 180;
        if (closed(ax, ay, th)) { lo = (deg - 1) * Math.PI / 180; hi = th; break; }
      }
      if (hi < 0) return LIM;                      // never closes: no wall there
      for (let i = 0; i < 18; i++) {
        const m = 0.5 * (lo + hi);
        if (closed(ax, ay, m)) hi = m; else lo = m;
      }
      return 0.5 * (lo + hi);
    };

    // TEMPORAL is away from the midline. The skinned mesh is symmetric about
    // x = 0, so the outward lateral direction is sign(centre.x) — derived, not
    // a per-side constant, because eye-local +X flips meaning between sides
    // (setFromUnitVectors picks the minimal rotation and the two `look`
    // vectors are mirrored).
    const outward = Math.sign(meta.centre[0]) || 1;
    const xIsTemporal = Math.sign(ex.x * outward) || 1;
    const thPosX = reach(1, 0), thNegX = reach(-1, 0);
    return {
      temporal: xIsTemporal > 0 ? thPosX : thNegX,
      nasal: xIsTemporal > 0 ? thNegX : thPosX,
      up: reach(0, 1),
      down: reach(0, -1),
      xIsTemporal,
    };
  }

  /**
   * Largest globe radius that the socket can swallow, measured from the
   * globe centre AS SEATED.
   *
   * Marches out on a cone at FIT_ANGLE and takes the nearest skin hit over
   * sixteen azimuths. Beyond the palpebral aperture the globe has to be
   * INSIDE the skin, or it bulges through the face; inside the aperture it is
   * the lids' job to cover it. Returns -1 if the field is not available, in
   * which case the caller keeps the nominal radius.
   *
   * THE SEAT ARGUMENT IS THE WHOLE BUG THIS ROUND, and it is worth the
   * paragraph because the check existed and read clean while the defect it
   * guards was the largest thing on the face. The fit was measured from
   * `meta.centre` — the socket centre — and the globe was then pushed
   * `seat` millimetres further out along the optical axis to clear the coat.
   * Every millimetre of that push spends a millimetre of the clearance the
   * fit had just certified, in the forward hemisphere, where the skin is
   * nearest. Measured on the live rig at `portrait` with the socket sampled
   * from the SEATED centre (16 azimuths, distances in mm):
   *
   *   off-axis    0     30      45      60      75      90
   *   nearest    6.3    6.7     7.7     9.9    14.1    19.5
   *   globe R   10.87  10.87   10.87   10.87   10.87   10.87
   *
   * — so the seated globe stood 2.2-4.2 mm OUTSIDE the skin from 30 to 60
   * degrees off axis, all the way round. On the near eye that is the pale
   * dome the review calls a googly doll eye; on the FAR eye, at `portrait`,
   * it is a hard blue polygon chip drawn past the head's own silhouette,
   * partly against the sky. Same 2.7 mm, two blockers.
   *
   * FIT_ANGLE is 60 rather than 50 degrees for the same reason: the fissure
   * itself reaches 42.5 degrees horizontally, so a cone at 50 degrees is
   * still partly inside the opening the lids are meant to cover and it
   * certifies skin that is not there.
   */
  _fitGlobeRadius(fox, meta, seat = 0) {
    const f = fox.field;
    if (!f?.raycast || !meta?.centre || !meta?.look) return -1;
    const c = meta.centre, n = meta.look;
    // An orthonormal basis about the optical axis.
    const up = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let t = [n[1] * up[2] - n[2] * up[1], n[2] * up[0] - n[0] * up[2],
      n[0] * up[1] - n[1] * up[0]];
    const tl = Math.hypot(t[0], t[1], t[2]) || 1;
    t = [t[0] / tl, t[1] / tl, t[2] / tl];
    const b = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2],
      n[0] * t[1] - n[1] * t[0]];
    const o = [c[0] + n[0] * seat, c[1] + n[1] * seat, c[2] + n[2] * seat];

    const ca = Math.cos(FIT_ANGLE), sa = Math.sin(FIT_ANGLE);
    let best = Infinity;
    for (let i = 0; i < 16; i++) {
      const az = (i / 16) * TAU, cb = Math.cos(az), sb = Math.sin(az);
      const d = [0, 1, 2].map((j) => n[j] * ca + (t[j] * cb + b[j] * sb) * sa);
      const hit = f.raycast(o[0] + d[0] * 1e-3, o[1] + d[1] * 1e-3, o[2] + d[2] * 1e-3,
        d[0], d[1], d[2], 0.06);
      if (hit > 0) best = Math.min(best, 1e-3 + hit);
    }
    return Number.isFinite(best) ? best * FIT_MARGIN : -1;
  }

  _measureSkin(fox, meta, R) {
    const f = fox.field;
    if (!f?.raycast || !meta?.centre || !meta?.look) return -1;
    const c = meta.centre, n = meta.look;
    // Start just inside the ball so we never begin outside the surface.
    const t0 = R * 0.55;
    const ox = c[0] + n[0] * t0, oy = c[1] + n[1] * t0, oz = c[2] + n[2] * t0;
    const t = f.raycast(ox, oy, oz, n[0], n[1], n[2], R * 2.6);
    return t > 0 ? t0 + t : -1;
  }

  /**
   * How deep is the coat right at the socket, in metres.
   *
   * `furLength` is a published cross-system attribute (AGENTS.md: `ctx.fox
   * .attributes -> { furLength, … }`), authored per skin vertex by the anatomy
   * agent and consumed by fur. We read it for the same reason fur does: the
   * eye has to be seated relative to the hair canopy, not relative to the bare
   * skin under it, and the canopy is theirs to author.
   *
   * MEDIAN, not max, over the vertices nearest the eyeball centre. The socket
   * rim carries the long cheek hair and one outlier there would eject the
   * eyeball; the median of the ring that actually overhangs the aperture is
   * the number that decides whether the cornea is visible. Returns 0 when the
   * attribute is absent, which reduces this to the old skin-only behaviour.
   */
  _measureCoat(fox, meta, R) {
    const geo = fox.skinnedMesh?.geometry;
    const len = fox.attributes?.furLength ?? geo?.attributes?.furLength;
    const pos = geo?.attributes?.position;
    if (!len || !pos || !meta?.centre) return 0;
    const c = meta.centre;
    // A RING, 0.95 R to 1.9 R from the eyeball centre — the orbital rim, not
    // the socket floor. The fur shader already shaves the floor (its own eye
    // mask ramps length in from ~0.45 of its clearance radius), so including
    // those vertices would measure hair that is never drawn and understate the
    // canopy that actually leans over the fissure.
    const r0 = R * 0.95, r1 = R * 1.90;
    const r02 = r0 * r0, r12 = r1 * r1;
    const vals = [];
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) - c[0], dy = pos.getY(i) - c[1], dz = pos.getZ(i) - c[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r02 && d2 <= r12) vals.push(len.getX(i));
    }
    if (!vals.length) return 0;
    vals.sort((a, b) => a - b);
    return vals[vals.length >> 1];
  }

  // -------------------------------------------------------------- uniforms --
  _makeUniforms(ctx, R, Rc, zc, k, irisZ, irisR, limbusR, apW, ap) {
    return {
      uR: { value: R }, uRc: { value: Rc }, uZc: { value: zc }, uK: { value: k },
      uCapDz: { value: Math.sqrt(Math.max(0, 1 - (Rc / R) * (Rc / R))) },
      uIrisZ: { value: irisZ }, uIrisR: { value: irisR }, uLimbusR: { value: limbusR },
      uPupilR: { value: 0.36 }, uEta: { value: 1.0 / 1.376 },
      uFibreN: { value: 118.0 }, uCollarette: { value: 0.41 },
      uCaustic: { value: 1.0 }, uWetness: { value: 1.0 },
      // Corneal tear-film roughness, and the cornea overlay's sky lobe. Both
      // are uniforms so they can be SWEPT in one page session at one sim
      // instant instead of by re-rendering the file -- the last three
      // constants in here that were tuned by re-rendering all cost a round.
      uCoatRough: { value: COAT_ROUGH },
      uSkyLobe: { value: SKY_LOBE },
      uSkyGain: { value: SKY_GAIN },
      uCoatIBL: { value: COAT_IBL },
      uClAim: { value: CL_AIM },
      uClSide: { value: CL_SIDE },

      // §4b: "amber / golden-brown, noticeably warm". These were authored a
      // stop and a half darker than that and the eye graded out to a brown
      // bead: the scene is a polar TWILIGHT with the key behind the animal,
      // so whatever the iris reflects is already being multiplied by a dim,
      // cold fill before tonemapping. An iris that is "correct" under a studio
      // key is a black hole here.
      uIrisInner: { value: new THREE.Color(0xf6c874) },
      uIrisMid: { value: new THREE.Color(0xd39a44) },
      uIrisOuter: { value: new THREE.Color(0x9c6f2e) },
      uLimbal: { value: new THREE.Color(0x1a1206) },
      // NEUTRAL, not navy. 0x05040a is B-R +5 before a single photon lands on
      // it, and §4b says the pupil is black. What blue survives should be the
      // sky reflected in the tear film, which is a real thing a wet eye does
      // -- not the albedo pre-loading it.
      uPupilCol: { value: new THREE.Color(0x050507) },
      // A fox's exposed sclera is pigmented, but "pigmented" is not "black".
      // The one primary description of a wild canid's (Cerdocyon thous,
      // PLOS ONE 2019) reports "minimal exposure of the SLIGHTLY pigmented
      // bulbar conjunctiva at the lateral canthus" — a brown-grey, not a
      // void. Near-black mattered less when the globe sat flush; now that it
      // is seated 2.2 mm proud, an oblique framing sees the globe's scleral
      // FLANK, and at 0x2a231d that read as a black cylinder around the iris.
      uSclera: { value: new THREE.Color(0x453c34) },

      uMarginCol: { value: new THREE.Color(0x0d0b0c) },
      uLidSkin: { value: new THREE.Color(0x8d8076) },
      uLidFur: { value: new THREE.Color(0xf2f4f8) },

      uCamL: { value: new THREE.Vector3(0, 0, 1) },
      uSunL: { value: new THREE.Vector3(0, 0, 1) },
      // WORLD UP, in this eye's local frame. The sky catchlight used to be
      // aimed at eye-local +Y, which is not up: the socket frame is rolled
      // and mirrored between the sides, so the two eyes reflected the sky
      // from two different directions. Measured at `frontal`: the left socket
      // box averaged (73.5, 69.1, 64.8) with a 249-level specular in it and
      // the right (45.3, 45.1, 44.4) with a peak of 130 and no highlight at
      // all — the whole of "the two eyes are grossly asymmetric", on eyes
      // whose geometry is identical to four decimal places.
      uUpL: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Color().copy(ctx.sunColor) },
      uSunInt: { value: ctx.sunIntensity },
      uSkyCol: { value: new THREE.Color().copy(ctx.skyColor) },
      uBounceCol: { value: new THREE.Color().copy(ctx.groundBounce) },
      // How much light short lid fur scatters back on top of what an ordinary
      // dielectric keeps. See the note at the lid's lights_fragment_end.
      uLidScatter: { value: LID_SCATTER },
      uLidSwell: { value: LID_SWELL },
      // WHICH SIGN OF vU IS THE NOSE. Eye-local +X flips meaning between the
      // sides, so a canthus authored on a fixed sign is the medial canthus on
      // one eye and the lateral one on the other -- which is how the previous
      // asymmetry bugs in this file all started. Set by the caller from the
      // same `restYawRaw` sign that decides the fissure's nasal follow.
      uNasalSign: { value: 1 },
      uLidAO: { value: LID_AO },
      uLidCrease: { value: LID_CREASE },
      uCanthus: { value: 1 },
      // Lacrimal caruncle. Not pink -- on a wild canid it is a dark, slightly
      // warm brown-grey, and a pink one is the single loudest way to make a
      // realistic eye look like a toy.
      uCaruncle: { value: new THREE.Color(0x4a3730) },

      uApW: { value: apW }, uApUp: { value: ap.up },
      uApDn: { value: ap.dn }, uApTilt: { value: ap.tilt },
      uBlinkU: { value: 0 }, uBlinkD: { value: 0 },
      uSpread: { value: LID_SPREAD },
      // Rotation of the LID frame relative to the GLOBE frame, so the globe's
      // contact shadow can be evaluated from the same aperture curves the lid
      // geometry uses. It was previously evaluated in the globe's own frame,
      // which silently assumed the two frames coincide — they never did (the
      // globe carries restPitch = -4.2 degrees of it) and now they differ by
      // the fissure's nasal follow as well. Written every frame by `update`.
      uLidYaw: { value: 0 }, uLidPitch: { value: 0 },
    };
  }

  // -------------------------------------------------------------- materials --
  /**
   * The globe rides MeshPhysicalMaterial so it inherits the scene's sun, sky
   * fill, snow bounce, env map and tonemapping exactly like every other
   * surface. Only the albedo and roughness are ours.
   */
  _globeMaterial(u, side) {
    const m = new THREE.MeshPhysicalMaterial({
      name: `eyeGlobe${side}`,
      color: 0xffffff,
      roughness: 0.45,
      metalness: 0.0,
      // The wet corneal layer is three's own clearcoat lobe, modulated per
      // pixel below. Doing it this way rather than with a hand-rolled
      // specular means the highlight is lit by the real env map and all four
      // of Environment.js's lights — which matters enormously here, because
      // the bible's key is BEHIND the animal: there is no sun catchlight on
      // a backlit eye, and what sells it is the twilight sky and the snow
      // bounce reflecting off the cornea.
      clearcoat: 1.0,
      clearcoatRoughness: 0.028,
      envMapIntensity: 0.85,
    });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = 'varying vec3 vLP; varying vec3 vLN;\n' + sh.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLP = transformed;')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vLN = objectNormal;');

      sh.fragmentShader = 'varying vec3 vLP; varying vec3 vLN;\n' +
        EYE_UNIFORMS + HASH + SIMPLEX3 + WORLEY3 + UTIL + APERTURE_GLSL + IRIS_GLSL +
        sh.fragmentShader
          .replace('#include <map_fragment>', /* glsl */ `
  // Everything here is prefixed ey* — three's own chunks own the short names
  // (normal, geometryNormal, diffuseColor, ...) and a collision only shows up
  // as a shader compile error buried in a console the harness swallows.
  vec3 eyP = vLP;
  vec3 eyN = normalize(vLN);
  vec3 eyV = normalize(uCamL - eyP);
  float eyRho = length(eyP.xy);

  // --- refractive iris parallax ----------------------------------------
  // Bend the view ray at the corneal surface and intersect it with the iris
  // plane. The iris therefore sits behind a lens: it shifts as the camera
  // moves and is magnified toward the limbus, which is exactly what stops an
  // eye reading as a painted bead.
  // Refraction goes unstable right at the limbus: the surface normal swings
  // through most of a right angle across a couple of vertices, so the
  // refracted hit point flies outward and the iris edge comes out crenulated.
  // Fade back to the straight view ray over the outer fifth of the cornea —
  // nothing is visible through there anyway, it is already limbal ring.
  float eyRel = eyRho / max(uLimbusR, 1e-6);
  vec3 eyRd = mix(refract(-eyV, eyN, uEta), -eyV, smoothstep(0.62, 1.0, eyRel));
  eyRd = normalize(vec3(eyRd.xy, min(eyRd.z, -1e-3)));
  float eyT = (uIrisZ - eyP.z) / eyRd.z;
  vec2 eyIp = eyP.xy + eyRd.xy * max(eyT, 0.0);
  float eyIr = min(length(eyIp) / max(uIrisR, 1e-6), 1.12);

  vec3 eyIris = feIris(eyIr, atan(eyIp.y, eyIp.x));

  // --- refractive caustic on the lower iris -----------------------------
  // The same bend applied to the SUN: the cornea throws a soft crescent of
  // focused light onto the iris opposite the light. Four instructions, and
  // it is what makes a lit eye look like it contains fluid.
  vec3 eySr = refract(-uSunL, vec3(0.0, 0.0, 1.0), uEta);
  vec2 eyCp = vec2(0.0);
  if (eySr.z < -1e-4) eyCp = eySr.xy * ((uIrisZ - uR * 1.075) / eySr.z);
  float eyCd = length(eyIp - eyCp) / max(uIrisR, 1e-6);
  float eyLit = feSat(uSunL.z) * feSat(1.0 - eyIr * 0.55);
  eyIris += uSunCol * exp(-pow(eyCd / 0.34, 2.0)) * uCaustic * 0.42 * eyLit;

  // --- sclera -----------------------------------------------------------
  // A fox's visible sclera is pigmented, not white. Keeping it dark means any
  // sliver that escapes the lid reads as shadow rather than as a googly eye,
  // and it deepens the dark ring §4b is asking for.
  vec3 eyScl = uSclera * mix(1.0, 0.52, smoothstep(0.55, 0.95, eyRho / max(uR, 1e-6)));
  float eyOnCornea = 1.0 - smoothstep(uLimbusR * 0.94, uLimbusR * 1.03, eyRho);
  vec3 eyCol = mix(eyScl, eyIris, eyOnCornea);

  // --- contact shadow under the lid margins ------------------------------
  // Evaluated from the same aperture curves the lid geometry uses, so the
  // shadow tracks a blink exactly.
  // Into the LID's frame first. v_lid = Ry(ballYaw - lidYaw) * v_globe, with
  // the pitch difference folded in the same way; both are packed into
  // uLidYaw / uLidPitch by update().
  vec3 eyD = normalize(eyP);
  float eyLc = cos(uLidYaw), eyLs = sin(uLidYaw);
  eyD = vec3(eyD.x * eyLc + eyD.z * eyLs, eyD.y, -eyD.x * eyLs + eyD.z * eyLc);
  float eyPc = cos(uLidPitch), eyPs = sin(uLidPitch);
  eyD = vec3(eyD.x, eyD.y * eyPc - eyD.z * eyPs, eyD.y * eyPs + eyD.z * eyPc);
  float eyDz = max(eyD.z, 1e-3);
  float eyGu = clamp((eyD.x / eyDz) / uApW, -1.0, 1.0);
  float eyGy = eyD.y / eyDz;
  // WIDTH IS THE DEFECT HERE, not depth. 0.30 in gnomonic y is 17 degrees of
  // arc, 3.2 mm on this globe and a quarter of the corneal diameter, so the
  // contact shadow was not a contact shadow: it was a soft black wash laid
  // over the top third of the iris, and at macro_eye it is most of the dark
  // crescent above the amber. A lid margin resting on a wet globe occludes
  // about a millimetre. 0.145 is 8.3 degrees, 1.6 mm.
  float eyShU = smoothstep(-0.145, 0.02, eyGy - feLidUpY(eyGu));
  float eyShD = smoothstep(-0.110, 0.02, feLidDnY(eyGu) - eyGy);
  eyCol *= mix(1.0, 0.55, max(eyShU, eyShD * 0.55));

  diffuseColor.rgb = eyCol;
`)
          .replace('#include <roughnessmap_fragment>', /* glsl */ `
  // OFF the cornea this was 0.16 — glossier than the cornea's own base, on a
  // surface whose whole job is to be dark. Combined with the clearcoat it
  // turned the scleral crescent at the medial canthus into a hard white
  // wedge, and because the two sockets face 72 degrees apart only one eye
  // ever caught it. The cornea does not need base gloss (its mirror is the
  // clearcoat lobe); the sclera needs a damp sheen and nothing more.
  float roughnessFactor = mix(0.66, 0.50, eyOnCornea);
`)
          // The tear film only exists over the cornea, and it dulls where the
          // lid margin presses on the globe.
          .replace('#include <lights_physical_fragment>', /* glsl */ `
#include <lights_physical_fragment>
  // THE SCLERA IS WET, NOT MIRRORED. At 0.55 clearcoat over roughness 0.16
  // the strip of bulbar conjunctiva at the medial canthus reflected the
  // twilight sky as a hard-edged 250-level white crescent — on ONE eye, since
  // the two sockets face 72 degrees apart, which is a second and independent
  // contributor to "the eyes are asymmetric". A tear film over pigmented
  // sclera is a damp sheen; the mirror belongs to the cornea alone.
  //
  // And 0.26 still blew out, because at any oblique framing the scleral flank
  // is seen at GRAZING incidence and Fresnel takes a smooth layer to 1.0
  // there whatever its strength. So the clearcoat is corneal only; the sclera
  // keeps its damp look from the base lobe, whose roughness is set above.
  material.clearcoat = eyOnCornea * (1.0 - max(eyShU, eyShD) * 0.7);
  // A real cornea is mirror-smooth, but our env map is a 256 px PMREM: at
  // mirror roughness it reflects the sky/ground horizon as a HARD LINE across
  // the eye, which reads as a rendering artifact rather than as a reflection.
  // Roughing the tear film slightly turns that into the soft vertical
  // gradient a photograph actually shows, and widens the catchlight enough to
  // survive the bloom downsample.
  material.clearcoatRoughness = mix(0.30, uCoatRough, eyOnCornea);
`)
          .replace('#include <lights_fragment_end>', /* glsl */ `
#include <lights_fragment_end>
  // SOCKET OCCLUSION on the scleral flank.
  //
  // Everything outside the limbus sits deep in an orbit ringed by 14 mm of
  // coat and sees very little of the sky, but it was being handed the whole
  // hemisphere — so the flank was both too bright for a pigmented sclera and
  // able to throw a 250-level grazing highlight. Because the two sockets face
  // 72 degrees apart, only ever one eye at a time, which is the second half
  // of the reported asymmetry.
  //
  // Ramped on radius rather than on the corneal mask: the mask's transition
  // is only 9 % of the limbal radius wide and an occlusion step that sharp
  // would draw a ring of its own.
  // Started at 0.86 of the limbal radius, which is INSIDE the cornea — the
  // occlusion was already at 0.79 by the limbus itself and 0.71 at the
  // canthus, on top of the contact shadow and the scleral falloff. Three
  // multiplicative darkeners stacked on a 0.058 albedo is how you get a
  // dead-matte annulus. Hold it off the cornea and stop it a shade higher.
  float eyAO = mix(1.0, 0.36,
    smoothstep(0.98, 1.40, eyRho / max(uLimbusR, 1e-6)));
  reflectedLight.directDiffuse *= eyAO;
  reflectedLight.indirectDiffuse *= eyAO;
  reflectedLight.directSpecular *= eyAO;
  // THE ENV REFLECTION COMES OFF THE CORNEA, AND ONLY THE CORNEA. See the
  // note at COAT_IBL: a 256 px PMREM with no ground in it cannot be a mirror,
  // and at the roughness a tear film needs it resolves its own sky/void
  // horizon as a hard line across the pupil. The sclera is not a mirror and
  // keeps its damp env sheen.
  float eyIBL = mix(1.0, uCoatIBL, eyOnCornea);
  reflectedLight.indirectSpecular *= eyAO * eyIBL;
  clearcoatSpecularDirect *= eyAO;
  clearcoatSpecularIndirect *= eyAO * eyIBL;
`);
    };
    m.customProgramCacheKey = () => 'foxEyeGlobe';
    return m;
  }

  /**
   * The cornea. A separate additive surface in front of the iris — that is
   * what puts the catchlight physically ahead of the iris instead of pasted
   * onto it, and it is the difference between "wet" and "plastic".
   */
  _corneaMaterial(u) {
    return new THREE.ShaderMaterial({
      name: 'eyeCornea',
      uniforms: u,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
      vertexShader: /* glsl */ `
varying vec3 vLP; varying vec3 vLN; varying vec3 vWN;
void main(){
  vLP = position;
  vLN = normal;
  vWN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
      fragmentShader: EYE_UNIFORMS + UTIL + APERTURE_GLSL + /* glsl */ `
varying vec3 vLP; varying vec3 vLN; varying vec3 vWN;

void main(){
  vec3 N = normalize(vLN);
  vec3 V = normalize(uCamL - vLP);
  float ndv = feSat(dot(N, V));
  float F = ${F0_TEAR.toFixed(4)} + (1.0 - ${F0_TEAR.toFixed(4)}) * pow(1.0 - ndv, 5.0);

  // Tight primary sun lobe — this is the catchlight.
  vec3 H = normalize(V + uSunL);
  float ndh = feSat(dot(N, H));
  float ndl = feSat(dot(N, uSunL));
  float a = 0.026;                       // tear film is very smooth
  float a2 = a * a;
  float dn = ndh * ndh * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159265 * dn * dn);
  vec3 spec = uSunCol * uSunInt * D * F * ndl * 0.02;

  // THE SKY CATCHLIGHT, AND IT IS AN IMAGE OF A LIGHT SOURCE, NOT A LOBE.
  //
  // UP HAS TO BE WORLD UP. This was eye-local +Y, and eye-local +Y is not up:
  // the socket frame is rolled and it is MIRRORED between the two sides, so
  // the left and right eyes reflected the sky from two different directions
  // and only one of them caught it. That is the reported "grossly asymmetric
  // eyes" -- 249 levels of specular on one and a peak of 130 with no
  // highlight at all on the other, on geometry that matches to four decimal
  // places. uUpL is world up carried into this eye's frame every frame, so
  // both eyes catch the same sky from the same place and the highlight stays
  // put when the head turns.
  //
  // WHY A PATCH AND NOT GGX. Review 6 asked for "a shaped sky reflection"
  // instead of one square dot. Two GGX attempts failed at that, for the same
  // structural reason both times: GGX is a peak with a 1/x^4 tail, so
  // widening it flattens the peak (D peaks at 1/(pi a^2), so 0.052 -> 0.15
  // loses 8.3x) and the result is a haze over the whole cornea with no edge
  // anywhere. Measured on the exposed-globe matte, the widened version still
  // produced a 6x6 px blob -- 1.3% of the 469 px fissure -- with a 66x114 px
  // wash around it.
  //
  // A catchlight is not a BRDF lobe. It is the mirror IMAGE of a light
  // source, so it has the source's shape and the source's edge. Model it as
  // one: reflect the view ray, measure its angular offset from the patch
  // centre in the patch's own frame, and fill an ellipse with a soft rim.
  // That gives a flat-topped, soft-edged, correctly-proportioned highlight
  // that a GGX lobe cannot produce at any roughness.
  vec3 upL = normalize(uUpL);
  vec3 Rv = reflect(-V, N);
  // WHERE THE HIGHLIGHT LANDS. skyDir is the direction of the reflected
  // patch; the highlight appears where the reflected view ray points at it,
  // so aiming skyDir at V puts it dead centre on the cornea and aiming it at
  // world up puts it at the top of the limbus. uClAim is the up weight
  // against a V weight of 1. At the inherited 2.39 the reflection sat high
  // on the IRIS, clear of the pupil, which reads as a blister on the eye
  // rather than as something the eye is reflecting.
  // uClSide slides it along the horizontal axis perpendicular to the view,
  // which is what lets the patch swallow the hard point the clearcoat throws
  // from Environment.js's key. Two highlights of different character on one
  // cornea read as two lights; one highlight with a hot core reads as a wet
  // eye.
  vec3 clSide = cross(upL, V);
  clSide = length(clSide) > 1e-4 ? normalize(clSide) : vec3(1.0, 0.0, 0.0);
  vec3 skyDir = normalize(upL * uClAim + V + clSide * uClSide);
  // Patch frame. cross(up, skyDir) degenerates when the two are parallel;
  // skyDir carries 0.36 of V by construction so it never is, but the
  // fallback costs nothing and a NaN here is a white eye.
  vec3 pRt = cross(upL, skyDir);
  pRt = length(pRt) > 1e-4 ? normalize(pRt) : normalize(cross(vec3(0.0, 0.0, 1.0), skyDir));
  vec3 pUp = normalize(cross(skyDir, pRt));
  float pz = max(dot(Rv, skyDir), 1e-3);
  // Angular offset of the reflected ray from the patch centre, in radians.
  vec2 pOff = vec2(atan(dot(Rv, pRt) / pz), atan(dot(Rv, pUp) / pz));
  // Wider than tall: the bright band above a polar horizon is.
  float pE = length(pOff / vec2(uSkyLobe, uSkyLobe * ${CL_ASPECT.toFixed(3)}));
  vec3 skyLit = mix(uBounceCol, uSkyCol, 0.7);
  // The body of the reflection.
  //
  // NOT A PLATEAU. The first version filled the ellipse flat out to a soft
  // rim, on the reasoning that a catchlight has the source's own edge -- and
  // it rendered as a uniform grey patch pasted on the iris, because a
  // constant is exactly what a piece of paint looks like. A real reflection
  // of a twilight sky is graded: the sky itself is brighter toward the
  // horizon and the corneal curvature compresses that gradient into the
  // highlight. So: a smooth falloff from the centre with a soft shoulder,
  // which still has an edge (it reaches zero at pE = 1) but no flat top.
  //
  // (clBody, and NOT the obvious name: that name is a GLSL RESERVED WORD
  // and the whole material silently failed to compile, which App.js turns
  // into an eye with no overlay at all. It cost one A/B run in which six
  // arms measured identical -- the null result that means nothing.)
  float clBody = pow(1.0 - smoothstep(${CL_SOFT.toFixed(3)}, 1.0, pE),
                     ${CL_FALLOFF.toFixed(3)});
  // ...and a hot core inside it, which is the discrete bloomable point. It
  // is pushed toward white: the body carries the sky's colour, and the core
  // is where a real highlight clips.
  float clCore = 1.0 - smoothstep(0.0, ${CL_CORE.toFixed(3)}, pE);
  spec += F * uSkyGain * (skyLit * clBody
          + mix(skyLit, vec3(1.0), ${CL_CORE_WHITE.toFixed(3)})
            * clCore * ${CL_CORE_GAIN.toFixed(3)});

  // AND A SECOND ONE, LOW ON THE CORNEA, FROM THE SNOW.
  //
  // One highlight is a bead with a dot on it; two at different depths is a
  // transparent shell over a coloured disc, and that is what reads as wet.
  // The lower one is the snowfield -- §6 gives it a high albedo and §3 puts
  // the bounce at #cfe2f7, so on a real animal it is always there and always
  // dimmer and cooler than the sky's.
  vec3 gndDir = normalize(-upL * (uClAim * 0.62 + 0.30) + V);
  vec3 gRt = cross(upL, gndDir);
  gRt = length(gRt) > 1e-4 ? normalize(gRt) : normalize(cross(vec3(0.0, 0.0, 1.0), gndDir));
  vec3 gUp = normalize(cross(gndDir, gRt));
  float gz = max(dot(Rv, gndDir), 1e-3);
  vec2 gOff = vec2(atan(dot(Rv, gRt) / gz), atan(dot(Rv, gUp) / gz));
  float gE = length(gOff / vec2(uSkyLobe * ${CL_GND_W.toFixed(3)},
                                uSkyLobe * ${(CL_GND_W * CL_ASPECT).toFixed(3)}));
  spec += uBounceCol * F * uSkyGain * ${CL_GND_GAIN.toFixed(3)}
          * (1.0 - smoothstep(${CL_SOFT.toFixed(3)}, 1.0, gE));

  // A second, wider lobe keeps the highlight alive after the bloom downsample
  // and stops it disappearing entirely at portrait framing.
  float a3 = 0.18, a32 = a3 * a3;
  float dn3 = ndh * ndh * (a32 - 1.0) + 1.0;
  spec += uSunCol * uSunInt * (a32 / (3.14159265 * dn3 * dn3)) * F * ndl * 0.012;

  // Fade the cap out at the limbus so its edge never draws a ring.
  float rho = length(vLP.xy);
  float edge = 1.0 - smoothstep(uLimbusR * 0.80, uLimbusR * 1.02, rho);
  gl_FragColor = vec4(spec * edge * uWetness, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    });
  }

  /**
   * The lids. Vertex positions are evaluated from (aU, aS) against the
   * aperture curves, so `uBlinkU/uBlinkD` closes the eye with no CPU cost and
   * the canthi stay pinned. The first slice of the band is the near-black lid
   * margin — §4b's "single most important detail on the face" — with the wet
   * meniscus sitting immediately inside it.
   */
  _lidMaterial(u) {
    const m = new THREE.MeshPhysicalMaterial({
      name: 'eyeLid',
      color: 0xffffff,
      roughness: 0.7,
      metalness: 0.0,
      envMapIntensity: 0.7,
    });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader =
        'attribute float aU; attribute float aS; attribute float aLid;\n' +
        'attribute float aSpread;\n' +
        'varying float vU; varying float vS; varying float vLid; varying vec3 vLP;\n' +
        'varying float vArc;\n' +
        EYE_UNIFORMS + APERTURE_GLSL + GLOBE_GLSL +
        sh.vertexShader
          // beginnormal_vertex runs first, so the direction is solved there
          // once and both hooks use the same vector — an approximated normal
          // that disagrees with the position is what makes a shell read as
          // faceted plastic.
          .replace('#include <beginnormal_vertex>', /* glsl */ `
  // The lid margin is authored in gnomonic tangent coordinates, which are
  // convenient for an almond but diverge at 90 degrees — and the band has to
  // wrap past the aperture to meet the skin. So place the margin gnomonically,
  // then sweep OUTWARD as an arc over the globe. At the canthi the outward
  // direction is horizontal, so the two lids splay sideways and meet there.
  //
  // aSpread is MEASURED per column against the real skin (see
  // _measureLidSpread) rather than being one constant. It has to be: the skin
  // closes over the globe about 27 degrees off axis above the eye but not
  // until 50 degrees below it, so a single spread either leaves bare sclera
  // under the eye or stands the upper lid out over the brow as a hard-edged
  // slab. Measuring makes the lid tuck under the coat in every direction, and
  // re-measures itself if the anatomy changes.
  // Build the band from the REST margin, then close it by ROTATING the whole
  // lid about the eye's X axis — which is what an eyelid physically does.
  //
  // Sweeping outward from the *blinked* margin instead looks equivalent and is
  // not: once the upper lid's margin crosses the optical axis, "radially away
  // from the axis" flips to point DOWNWARD, so the closing upper lid swept its
  // band below the eye and left the top of the aperture wide open. A blink
  // shut the bottom half only.
  float feYRest = aLid > 0.0 ? feApUpY(aU) : feApDnY(aU);
  vec3 feRest = normalize(vec3(aU * uApW, feYRest, 1.0));
  vec3 feRad = vec3(feRest.xy, 0.0);
  float feRl = length(feRad);
  feRad = feRl > 1e-5 ? feRad / feRl : vec3(0.0, aLid, 0.0);
  float feTh = acos(clamp(feRest.z, -1.0, 1.0)) + aSpread * aS;
  vec3 feDir = vec3(0.0, 0.0, cos(feTh)) + feRad * sin(feTh);

  // Rotation angle, tapered to zero at the canthi so the corners of the
  // fissure stay pinned exactly where a real one does.
  float feB = aLid > 0.0 ? uBlinkU : uBlinkD;
  float feRestA = aLid > 0.0 ? atan(uApUp) : -atan(uApDn);
  float feClosA = atan(-0.17 * uApDn);
  float feRot = (feRestA - feClosA) * feB * feApShape(aU, 0.5);
  float feCs = cos(feRot), feSn = sin(feRot);
  feDir = vec3(feDir.x, feDir.y * feCs - feDir.z * feSn,
                        feDir.y * feSn + feDir.z * feCs);
  vec3 objectNormal = feDir;
`)
          .replace('#include <begin_vertex>', /* glsl */ `
  vU = aU; vS = aS; vLid = aLid;
  // Distance from the free edge in METRES of arc, not in band fractions. The
  // band's angular length is measured per column against the live skin and
  // varies 3:1 around one socket, so a rim authored as "the first 5% of the
  // band" is three times wider under the brow than at the canthus — and it
  // rescales every time the anatomy agent changes the coat depth. §4b calls
  // this line the single most important detail on the face; it should be one
  // width, in millimetres, everywhere.
  vArc = aS * aSpread * uR;
  // Sit on the real globe surface — the corneal dome stands proud of the
  // scleral sphere and a closing lid sweeps straight across it — plus a lid
  // thickness that is proud enough at the margin to cast a real edge, swells
  // into the fold, then tucks back onto the globe so the outer boundary
  // vanishes under the skin instead of ending in a visible rim.
  // THE FOLD'S SWELL IS A UNIFORM because it is the pale ring. The middle
  // term stands the band 0.070 R = 0.76 mm off the globe at aS = 0.5 and
  // tucks it back to 0.11 mm at aS = 1, so the fold is a RIDGE with a lit
  // crest and a shaded far slope, and at macro that is a bright annulus and
  // a dark line running right round the eye. Measured along the up meridian
  // (see the sweep in the commit). Uniform so it can be swept in one page
  // session at one sim instant rather than by re-rendering the file.
  float feProud = uR * (0.010 + 0.048 * exp(-aS * 9.0) + uLidSwell * 4.0 * aS * (1.0 - aS));
  vec3 transformed = feDir * (feGlobeR(feDir) + feProud);
  vLP = transformed;
`);

      sh.fragmentShader =
        'varying float vU; varying float vS; varying float vLid; varying vec3 vLP;\n' +
        'varying float vArc;\n' +
        EYE_UNIFORMS + HASH + SIMPLEX3 + UTIL + sh.fragmentShader
          .replace('#include <map_fragment>', /* glsl */ `
  // vArc = 0 is the free edge of the lid. The dark rim §4b demands lives here,
  // and it is authored in METRES so it is the same line all the way round the
  // fissure and does not rescale when the coat does.
  //
  //   0.00 -> 0.70 mm   near-black tarsal margin (the line itself)
  //   0.70 -> 1.00 mm   dark periocular skin, which every reference photo
  //                     shows as a distinct ring darker than the coat
  //   0.75 -> 1.90 mm   short lid fur taking over
  //
  // The FUR breakpoints are the ones that set how wide the dark READS, not
  // the margin ones: feFurry also gates LID_SCATTER at lights_fragment_end,
  // so any arc the fur has not reached is shaded as a single dielectric
  // bounce under a sunless sky and comes out at a fifth of the coat whatever
  // colour it was authored. See the measurement at the top of the file.
  // (No backticks in this comment -- AGENTS.md, and it has now fired a
  // fourth time in this file.)
  //
  // Widths matter in both directions. A first pass at 1.05 / 2.60 / 6.20 mm
  // put a black donut as wide as the iris around the eye and the socket read
  // as a hole in the face — the exact failure the fraction-based version was
  // written to avoid, arrived at from the other side. On the real animal the
  // black is a LINE, and the periocular skin merely a shade darker than the
  // coat over it.
  //
  // The previous version authored these as fractions of the band (0.008-0.055
  // of vS) and the band is 1.8-10 mm long depending on the column, so the
  // "single most important detail on the face" was a 0.1 mm hairline at the
  // canthus and a 0.55 mm smudge under the brow. At frontal framing the whole
  // ring was sub-pixel and the eye reduced to a grey dot.
  //
  // Widths now live in one place at the top of the file, because the ramp and
  // the scatter mask below have to agree: any arc the scatter does not reach
  // renders as part of the black, whatever colour it was authored.
  //
  // THE MARGIN IS NOT ONE WIDTH. It is a line along the free edge that
  // broadens into a blunt triangle at each canthus, and further at the medial
  // one around the caruncle. A constant width is exactly the "uniform-width
  // dark annulus that does not thicken at the corners" the review names, and
  // it is also why the eye has no readable inner corner: with no landmark at
  // either end, an almond of black is a decal.
  //
  // uNasalSign carries which way the nose is, because eye-local +X flips
  // meaning between the sides.
  float feCanth = smoothstep(${CANTH_FROM.toFixed(3)}, 1.0, abs(vU)) * uCanthus;
  float feNasal = feCanth * smoothstep(-0.12, 0.12, vU * uNasalSign);
  float feWiden = 1.0 + (${(CANTH_WIDEN - 1).toFixed(2)}) * feCanth
                      + (${(CANTH_WIDEN_NASAL - CANTH_WIDEN).toFixed(2)}) * feNasal;

  float feMargin = 1.0 - smoothstep(${RIM_MARGIN_0.toFixed(5)} * feWiden,
                                    ${RIM_MARGIN_1.toFixed(5)} * feWiden, vArc);
  float feRing   = 1.0 - smoothstep(${RIM_MARGIN_1.toFixed(5)} * feWiden,
                                    ${RIM_RING_1.toFixed(5)} * feWiden, vArc);
  float feFurry  = smoothstep(${RIM_FUR_0.toFixed(5)} * feWiden,
                              ${RIM_FUR_1.toFixed(5)} * feWiden, vArc);

  // THE UPPER LID'S CREASE. The fold that gives the lid thickness. Upper lid
  // only -- a canid's lower lid has no crease -- and pushed outward at the
  // canthi, where the fold runs up onto the orbital rim.
  float feCreaseAmt = (vLid > 0.0 ? 1.0 : 0.0) * uLidCrease *
    exp(-pow((vArc - ${LID_CREASE_AT.toFixed(5)} * feWiden) /
             ${LID_CREASE_W.toFixed(5)}, 2.0)) * (1.0 - 0.55 * feCanth);

  // SOCKET OCCLUSION. See LID_AO at the top of the file: the band sits in the
  // bottom of the orbital recess and a band at parity with the coat ON the
  // rim is a band 25-35 percent too bright for where it is. Largest at the
  // free edge, gone by the outer boundary where the band is continuous with
  // the face.
  //
  // AND IT MUST REACH EXACTLY ZERO AT THE BAND'S OUTER EDGE. An exponential
  // alone still carries 12 percent of its depth at vArc = 5 mm, and because
  // the band ENDS there against untouched face, that residue renders as a
  // hard-edged darker wedge following the band's outline -- a visible seam
  // round the socket, which is the failure the LID_SPREAD_MIN floor was
  // originally added to avoid, arrived at from the shading side. vS is the
  // band fraction and vS = 1 IS the outer boundary on every column whatever
  // the measured spread, so windowing on vS is continuous by construction
  // where windowing on arc cannot be.
  float feAO = 1.0 - (uLidAO * exp(-vArc / ${LID_AO_LAMBDA.toFixed(5)})
                      + 0.34 * feCreaseAmt) * (1.0 - smoothstep(0.50, 1.0, vS));

  // Short, fine hairs over the lid fold so it does not read as a plastic cap.
  //
  // ONE OCTAVE AT +/-13 % WAS NOT ENOUGH TO BE HAIR. The coat immediately
  // outside the socket carries far more local value variation than that, so
  // a band at the right MEAN still read as a smooth collar of bare skin
  // against it — and §4f rule 3 allows bare skin at the rhinarium, the eyes
  // and the paw pads, not a 3.5 mm hairless ring around the fissure. Two
  // octaves, stretched along the band (hairs run outward across it, not
  // along it) and fine across it.
  //
  // ACROSS-BAND COORDINATE IN MILLIMETRES, NOT IN vS. aSpread varies about
  // 3:1 around one socket, so hair keyed on vS is three times coarser under
  // the brow than at the canthus -- the same scale bug the rim ramp had, in
  // the texture instead of in the colour. vArc is metres of arc, so 1.0/0.0012
  // is one hair period per 1.2 mm everywhere.
  float feAcross = vArc * 833.0;
  float feHair = snoise(vec3(vU * 46.0, feAcross * 0.9, 3.1)) * 0.5 + 0.5;
  float feHairF = snoise(vec3(vU * 137.0, feAcross * 2.1, 8.7)) * 0.5 + 0.5;
  float feHairM = feHair * 0.62 + feHairF * 0.38;
  vec3 feFur = uLidFur * mix(0.70, 1.13, feHairM);

  // The periocular ring is the margin colour lifted toward skin, NOT skin
  // darkened — keeping it on the same hue is what stops the ring reading as
  // a separate painted band with its own edge.
  vec3 feRingCol = mix(uLidSkin, uMarginCol, 0.38);
  vec3 feCol = mix(uLidSkin, feRingCol, feRing);
  feCol = mix(feCol, feFur, feFurry);
  // Keep the extreme margin genuinely dark — this is the line that makes the
  // eye read from across the frame.
  feCol = mix(feCol, uMarginCol, feMargin * 0.96);
  // The lacrimal caruncle: the small fleshy body in the medial canthus. It is
  // the landmark that tells a viewer which end of the eye is the nose end,
  // and without it the fissure is symmetric and reads as an almond decal.
  float feCar = feNasal * (1.0 - smoothstep(0.0, ${CARUNCLE_ARC.toFixed(5)} * feWiden, vArc))
                        * smoothstep(0.72, 0.94, abs(vU));
  feCol = mix(feCol, uCaruncle, feCar * 0.85);
  diffuseColor.rgb = feCol;
`)
          .replace('#include <roughnessmap_fragment>', /* glsl */ `
  // Wet meniscus: the tear strip where lid meets globe is the glossiest thing
  // on the face. It dries out quickly into ordinary skin and then into fur.
  //
  // AND IT IS WIDER ON THE LOWER LID. The tear film pools in the inferior
  // fornix and at the medial canthus (the lacrimal lake); on the upper margin
  // it is a hairline. Equal strips top and bottom is part of why the rim reads
  // as a drawn annulus rather than a wet edge: nothing about it is asymmetric,
  // and a real eye's wet is all in the bottom third and the inner corner.
  float feWetW = 0.00075 * (vLid > 0.0 ? 0.70 : 1.55) * (1.0 + 1.10 * feNasal);
  float feWet = 1.0 - smoothstep(0.00012, feWetW, vArc);
  float roughnessFactor = mix(mix(0.62, 0.86, smoothstep(0.0025, 0.0060, vArc)), 0.09, feWet);
  // The crease dulls: a groove packed with short hair scatters more than the
  // stretched skin either side of it.
  roughnessFactor = min(1.0, roughnessFactor + 0.10 * feCreaseAmt);
`)
          .replace('#include <lights_fragment_end>', /* glsl */ `
#include <lights_fragment_end>
  // MULTIPLE SCATTERING IN THE LID FUR.
  //
  // Everything outward of the rim is short white fur over skin — the same
  // coat as the face, 2 mm deep instead of 26 — and it was rendering 4.7x
  // darker than the coat it is supposed to disappear into. Albedo was not the
  // lever (0xf2f4f8 is already 0.88 and pure white buys 14%) and it is not a
  // shadow (the lid neither casts nor receives one). It is that the coat is a
  // deep scattering medium whose effective albedo approaches one, while this
  // band is one dielectric bounce under a hemisphere with no sun in it. The
  // sun is BEHIND the animal in every framing the bible specifies, so the
  // direct term contributes nothing here and the difference is the whole
  // image.
  //
  // Adding the missing scatter is physical rather than cosmetic: the same
  // hair, at the same density, over the same skin, should keep the same share
  // of the sky. It is masked off the tarsal margin so the black line — which
  // is bare pigmented lid edge, not fur, and legitimately keeps only one
  // bounce — stays black.
  //
  // Hemispherical rather than flat so the fold still models: fur pointing at
  // the sky takes the sky's colour, fur pointing at the snow takes the
  // bounce, which is also what keeps the lid from going blue when the coat
  // does not.
  vec3 feWN = inverseTransformDirection(normal, viewMatrix);
  vec3 feAmb = mix(uBounceCol, uSkyCol, feWN.y * 0.5 + 0.5);
  // Modulated by the SAME hair field that tints the band, so the breakup is
  // in the shading and not only in the albedo. A tint alone rides on top of
  // one smooth analytic shading gradient and still reads as a lacquered
  // collar; scattering that varies hair-to-hair is what short fur looks like.
  reflectedLight.indirectDiffuse +=
    feAmb * diffuseColor.rgb * (uLidScatter * feFurry * mix(0.70, 1.26, feHairM));
  // ...and then the whole band is occluded by the recess it sits in. Applied
  // to the TOTAL indirect rather than only to the scatter term, because the
  // cavity shadows the dielectric bounce and the env reflection just as much;
  // occluding only the fur term would leave the margin and the caruncle lit
  // by a sky they cannot see.
  reflectedLight.indirectDiffuse *= max(feAO, 0.12);
  reflectedLight.indirectSpecular *= max(feAO, 0.12);
`);
    };
    m.customProgramCacheKey = () => 'foxEyeLid';
    return m;
  }

  /**
   * Cilia. A ShaderMaterial rather than a patched MeshPhysicalMaterial: a
   * sub-pixel ribbon needs the screen-space width floor and the
   * energy-preserving tent, and neither fits inside three's lighting chunks.
   * The shading is deliberately the same two-term hemisphere the lid band
   * uses, so a lash and the skin it grows out of never disagree about where
   * the light is.
   */
  _lashMaterial(u) {
    const m = new THREE.ShaderMaterial({
      name: 'foxEyeLash',
      uniforms: Object.assign({
        uMinPx: { value: LASH_MIN_PX },
        uViewportH: { value: 800 },
        uLashRootArc: { value: LASH_ROOT_ARC },
        uLashCurlN: { value: LASH_CURL_N },
        uLashCurlR: { value: LASH_CURL_R },
        uLashCurlS: { value: LASH_CURL_S },
        // DARK, not white. An arctic fox's cilia are pale in the hand, but a
        // pale lash on a pale lid on a white animal is invisible at every
        // framing in `shots/` -- and "no eyelashes" is the review's
        // complaint, not "the lashes are the wrong colour". Dark at the
        // follicle where it leaves the tarsal margin, warm grey at the tip,
        // so one strand reads against BOTH the near-black rim it grows out
        // of and the pale band it crosses.
        uLashRoot: { value: new THREE.Color(0x100d0c) },
        uLashTip: { value: new THREE.Color(0x565049) },
      }, u),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      vertexShader:
        'attribute float aU, aT, aSide, aWidth, aLen, aCurl, aSkew, aSpread;\n' +
        'varying float vT, vAcross, vCov;\n' +
        'varying vec3 vWN;\n' +
        EYE_UNIFORMS + APERTURE_GLSL + GLOBE_GLSL + /* glsl */ `
uniform float uMinPx, uViewportH;
uniform float uLashRootArc;
uniform float uLashCurlN, uLashCurlR, uLashCurlS;

void main(){
  vT = aT; vAcross = aSide;

  // The margin, solved exactly as the lid solves it -- same curves, same
  // per-column aSpread, same blink rotation, same feProud. A lash that roots
  // on a static copy of the margin detaches from the lid the instant the eye
  // blinks; a lash that roots on a DIFFERENT RADIUS from the margin sinks
  // into the eyeball, which is what this used to do.
  float feYRest = feApUpY(aU);
  vec3 feRest = normalize(vec3(aU * uApW, feYRest, 1.0));
  vec3 feRad = vec3(feRest.xy, 0.0);
  float feRl = length(feRad);
  feRad = feRl > 1e-5 ? feRad / feRl : vec3(0.0, 1.0, 0.0);
  // Anterior of the free edge by a fixed ARC, converted to this column's own
  // band fraction so the follicle line is the same millimetre distance from
  // the lid edge at the canthus as it is under the brow.
  float feS = clamp(uLashRootArc / max(aSpread * uR, 1e-6), 0.0, 0.35);
  float feTh = acos(clamp(feRest.z, -1.0, 1.0)) + aSpread * feS;
  vec3 feDir = vec3(0.0, 0.0, cos(feTh)) + feRad * sin(feTh);

  float feRestA = atan(uApUp);
  float feClosA = atan(-0.17 * uApDn);
  float feRot = (feRestA - feClosA) * uBlinkU * feApShape(aU, 0.5);
  float cs = cos(feRot), sn = sin(feRot);
  feDir = vec3(feDir.x, feDir.y * cs - feDir.z * sn, feDir.y * sn + feDir.z * cs);
  feRad = vec3(feRad.x, feRad.y * cs - feRad.z * sn, feRad.y * sn + feRad.z * cs);

  // feProud, character for character as buildLids' begin_vertex writes it.
  float feProud = uR * (0.010 + 0.048 * exp(-feS * 9.0)
                        + uLidSwell * 4.0 * feS * (1.0 - feS));
  vec3 root = feDir * (feGlobeR(feDir) + feProud);

  // Out of the margin, then curling away from the globe. The lateral term is
  // the fan: lashes near a canthus lean toward it.
  vec3 side = normalize(cross(vec3(0.0, 0.0, 1.0), feRad) + vec3(1e-5));
  vec3 grow = normalize(feRad * 0.62 + feDir * 0.78 + side * aSkew * 0.42);
  // WHICH WAY THE STRAND BENDS, and it has to bend where the camera can see
  // it. This was normalize(feDir) -- purely along the lid's outward surface
  // normal -- and at the upper lid that normal points up and TOWARD the
  // camera, so the whole curl foreshortened away. Measured on the cilia
  // matte at macro_eye by fitting each strand's principal axis and taking
  // the quadratic sagitta (ribbon WIDTH is divided out, so a 3 px straight
  // strand does not score): 14 strands, median length 120.4 px, median
  // sagitta 0.90 px -- 0.75 % of its own length, which is the antialiasing
  // floor. Review 6's "dead-straight ... no curve" is exactly right.
  //
  // AND IT IS NOT feRad EITHER, which was the obvious candidate. Swept, curl aimed at
  // (feDir, feRad) = (1,0) / (0.6,1) / (0.2,1) / (-0.4,1) / (-1,1), the
  // median sagitta moves only 0.87 -> 1.67 px on a 120 px strand: at this
  // framing feDir and feRad BOTH project to roughly the same screen
  // direction as the growth axis itself, so a bend in either is a bend along
  // the strand, which is not a bend. The lateral axis is the lid's tangent,
  // across the screen, and the only one with anywhere to bend to. Scaled by
  // aSkew so each strand curves toward its own canthus, which is the way a
  // real lash line fans.
  vec3 curl = normalize(feDir * uLashCurlN + feRad * uLashCurlR
                        + side * aSkew * uLashCurlS);
  float t = aT;
  vec3 p = root + grow * (aLen * t) + curl * (aLen * aCurl * t * t);
  vec3 tang = normalize(grow * aLen + curl * (2.0 * aLen * aCurl * t));

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 tv = normalize((modelViewMatrix * vec4(tang, 0.0)).xyz);
  vec3 toEye = normalize(-mv.xyz);
  vec3 sideDir = cross(tv, toEye);
  float sl = length(sideDir);
  sideDir = sl > 1e-5 ? sideDir / sl : normalize(cross(tv, vec3(0.0, 1.0, 0.0)));

  // Sub-pixel width floor, paid back in alpha below so the strand's
  // integrated energy is its true width however far it was widened.
  float pxPerM = projectionMatrix[1][1] / max(-mv.z, 1e-4) * uViewportH * 0.5;
  float minW = uMinPx / max(pxPerM, 1e-4);
  float wUse = max(aWidth, minW);
  vCov = aWidth / wUse;
  mv.xyz += sideDir * (aSide * wUse);

  vWN = normalize(mat3(modelMatrix) * grow);
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader:
        'varying float vT, vAcross, vCov;\n' +
        'varying vec3 vWN;\n' +
        EYE_UNIFORMS + /* glsl */ `
uniform vec3 uLashRoot, uLashTip;

void main(){
  float shape = 1.0 - smoothstep(0.0, 1.0, abs(vAcross));
  float alpha = clamp(vCov * shape * 2.0, 0.0, 1.0);
  // Taper the last of the tip out rather than ending on a blunt cut.
  alpha *= 1.0 - smoothstep(0.80, 1.0, vT);
  if (alpha < 0.004) discard;

  // Dark at the follicle, where it emerges from the tarsal margin, pale at
  // the tip. That gradient is what lets one strand read against BOTH the
  // near-black rim it grows out of and the amber iris it crosses -- a
  // uniformly pale lash disappears into the first and a uniformly dark one
  // into the second.
  vec3 col = mix(uLashRoot, uLashTip, smoothstep(0.10, 0.85, vT));
  vec3 amb = mix(uBounceCol, uSkyCol, vWN.y * 0.5 + 0.5);
  col *= amb * 1.25;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    });
    m.customProgramCacheKey = () => 'foxEyeLash';
    return m;
  }

  // ---------------------------------------------------------------- public --
  /** 0 = open, 1 = closed. Pass null to hand control back to the rig. */
  setBlink(t, side = null) {
    const v = t == null ? null : saturate(t);
    if (side === 'L' || side === 'R') this._blinkOverride[side] = v;
    else { this._blinkOverride.L = v; this._blinkOverride.R = v; }
  }

  /** World-space gaze target, or null to follow the animation agent. */
  setLook(v) {
    if (!v) { this._lookTarget = null; return; }
    this._lookTarget = (this._lookTarget ?? new THREE.Vector3()).copy(v);
  }

  /** 0 = fully dilated, 1 = fully contracted. */
  setPupil(f) { this._pupil = saturate(f); }

  // ---------------------------------------------------------------- update --
  update(dt, ctx) {
    if (!this.enabled) return;
    const fox = ctx.fox;

    // Pupil responds to how much light is actually falling on the animal.
    // A pure function of ctx state, so the harness stays deterministic.
    const bright = saturate(ctx.sunIntensity * saturate(ctx.sunDirection.y * 3.0) / 6.0);
    const want = saturate(lerp(this._pupil, lerp(0.46, 0.27, bright), 0.85));
    this._pupilNow += (want - this._pupilNow) * (1 - Math.exp(-2.5 * dt));

    for (const e of this.eyes) {
      // --- blink --------------------------------------------------------
      const ov = this._blinkOverride[e.side];
      const rig = e.side === 'L' ? fox?.blinkL : fox?.blinkR;
      const b = saturate(ov ?? (typeof rig === 'number' ? rig : (fox?.blink ?? 0)));
      e.blink = b;
      // The upper lid leads and the lower trails; both land on the same curve
      // at b = 1 so the aperture shuts exactly.
      e.u.uBlinkU.value = Math.pow(b, 0.82);
      e.u.uBlinkD.value = Math.pow(b, 1.70);
      // Dilated / contracted, as a fraction of the iris radius. Narrower than
      // it was: the cornea magnifies the iris by ~1.25x and the outer edge is
      // then clipped at the limbus, so the pupil grows on screen while the
      // amber does not. 0.50 dilated measured out at nearly 60% of the
      // VISIBLE iris and ate the colour §4b is asking for.
      e.u.uPupilR.value = lerp(0.42, 0.22, this._pupilNow);

      // --- gaze ---------------------------------------------------------
      let yaw = 0, pitch = 0;
      if (this._lookTarget) {
        e.root.updateWorldMatrix(true, false);
        this._m.copy(e.root.matrixWorld).invert();
        this._v.copy(this._lookTarget).applyMatrix4(this._m).normalize();
        yaw = Math.atan2(this._v.x, Math.max(this._v.z, 1e-3));
        pitch = Math.asin(clamp(this._v.y, -1, 1));
      } else {
        yaw = typeof fox?.gazeYaw === 'number' ? fox.gazeYaw : 0;
        pitch = typeof fox?.gazePitch === 'number' ? fox.gazePitch : 0;
      }
      // Real eyes cannot rove far in the socket; the neck does the rest.
      yaw = clamp(yaw, -0.42, 0.42);
      pitch = clamp(pitch, -0.30, 0.30);
      e.gazeYaw += (yaw - e.gazeYaw) * (1 - Math.exp(-16 * dt));
      e.gazePitch += (pitch - e.gazePitch) * (1 - Math.exp(-16 * dt));
      e.ball.rotation.set(e.restPitch + e.gazePitch, e.restYaw + e.gazeYaw, 0, 'YXZ');

      // Lids follow the eye a little, as real lids do. rotation.y is the
      // fissure's nasal follow, set once at build; order is YXZ so this pitch
      // happens inside it.
      e.lids.rotation.x = e.gazePitch * 0.22;
      // Hand the globe the frame difference so its contact shadow lands under
      // the lid margin rather than under where the margin would be if the two
      // frames coincided.
      e.u.uLidYaw.value = (e.restYaw + e.gazeYaw) - (e.lidYaw ?? 0);
      e.u.uLidPitch.value = (e.restPitch + e.gazePitch) - e.lids.rotation.x;
    }
  }

  /** Camera and sun into each eye's local frame — last thing before the draw. */
  prerender(ctx) {
    if (this.enabled) this._syncUniforms(ctx);
  }

  _syncUniforms(ctx) {
    const cam = ctx.camera;
    for (const e of this.eyes) {
      e.ball.updateWorldMatrix(true, false);
      this._m.copy(e.ball.matrixWorld).invert();
      e.u.uCamL.value.copy(cam.position).applyMatrix4(this._m);
      e.u.uSunL.value.copy(ctx.sunDirection).transformDirection(this._m).normalize();
      this._v.set(0, 1, 0).transformDirection(this._m).normalize();
      e.u.uUpL.value.copy(this._v);
      e.u.uSunCol.value.copy(ctx.sunColor);
      e.u.uSunInt.value = ctx.sunIntensity;
      e.u.uSkyCol.value.copy(ctx.skyColor);
      e.u.uBounceCol.value.copy(ctx.groundBounce);
      // The lash ribbon's screen-space width floor needs the real backbuffer
      // height, not the CSS one: at renderScale != 1 they disagree and the
      // strands widen or vanish on a tier change. `bufferSize` is the actual
      // one (AGENTS.md's ctx table).
      const lm = e.lashes?.material;
      if (lm?.uniforms?.uViewportH) {
        lm.uniforms.uViewportH.value =
          (ctx.bufferSize?.height ?? ctx.bufferSize?.y ?? ctx.size?.height ?? 800);
      }
    }
  }

  onQuality() { /* geometry is built once; tier changes do not remesh */ }

  dispose() {
    for (const e of this.eyes) {
      e.globe.geometry.dispose(); e.globe.material.dispose();
      e.cornea.geometry.dispose(); e.cornea.material.dispose();
      e.lids.geometry.dispose(); e.lids.material.dispose();
      e.lashes?.geometry.dispose(); e.lashes?.material.dispose();
      e.root.parent?.remove(e.root);
    }
    this.eyes.length = 0;
  }
}
