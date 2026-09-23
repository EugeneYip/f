/**
 * FoxAnatomy — the single source of truth for *Vulpes lagopus* proportions.
 * OWNER: anatomy agent.
 *
 * Everything downstream (skeleton rest transforms, SDF primitives, fur fields,
 * anchors) is derived from `LANDMARKS` below, so the bones are guaranteed to
 * sit inside the flesh.
 *
 * Frame: metres, Y-up, ground at y = 0, the fox faces **+Z**.
 * The fox's RIGHT side is +X (right = up x forward), so `*R` bones are at +X.
 *
 * ## Reference (art bible §4, real animal)
 *   head-body 0.55 m · shoulder height 0.28 m · tail 0.32 m · mass 3.5 kg
 *   winter coat up to 0.05 m on the flank, more on tail and ruff.
 *
 * These primitives model the **skin**, i.e. the animal shaved. The silhouette
 * is therefore deliberately ~25-45 mm inside the furred one: skin withers land
 * at ~0.266 m and the fur agent's shell offsets take it to ~0.28-0.30 m.
 * Anatomy that must read *now*: ribcage taper, scapular bulge, haunch mass,
 * the hock standing well behind the hip, a short blunt muzzle and small round
 * ears.
 *
 * ## Region id map  (also exposed as `ctx.fox.REGION`)
 *    0 nose          1 muzzle        2 jawLower      3 cheek
 *    4 forehead      5 skull         6 earOuter      7 earInner
 *    8 throat        9 neck         10 ruff         11 chest
 *   12 shoulder     13 back         14 flank        15 belly
 *   16 croup        17 haunch       18 legFrontUpper 19 legFrontLower
 *   20 pawFront     21 legHindUpper 22 hock         23 pawHind
 *   24 tailBase     25 tailMid      26 tailTip
 */
import { Field } from './AnatField.js';

/**
 * Skull placement.
 *
 * Everything in the head group is authored around `SKULL_REF` and then mapped
 * through (`SKULL_AT`, `SKULL_SCALE`), so the whole head moves and resizes
 * from one place. The first pass with fur on showed why that matters: the
 * skull rode 75 mm above the withers on a long upward-sweeping neck, which
 * reads as a marten. On a real arctic fox the head sits close to and slightly
 * in front of the shoulders, and in winter the ruff swallows the neck almost
 * entirely — with the coat on, the top of the head clears the withers by
 * barely a centimetre. The head is also proportionally LARGE, hence the 1.18.
 *
 * ART_DIRECTION §4b (reference photographs): the cranium is a BROAD DOME and
 * the widest part of the head is the CHEEKS, not the skull — so the braincase
 * is widened but the cheek mass is widened more, and the muzzle is shortened
 * until it is closer to cat-like than to any fox stereotype.
 */
export const SKULL_REF = [0, 0.3100, 0.2050];
export const SKULL_AT = [0, 0.2690, 0.1815];
export const SKULL_SCALE = 1.18;
export const skullXf = (p) => [
  SKULL_AT[0] + (p[0] - SKULL_REF[0]) * SKULL_SCALE,
  SKULL_AT[1] + (p[1] - SKULL_REF[1]) * SKULL_SCALE,
  SKULL_AT[2] + (p[2] - SKULL_REF[2]) * SKULL_SCALE,
];
const sr = (r) => r * SKULL_SCALE;

export const REGION = {
  nose: 0, muzzle: 1, jawLower: 2, cheek: 3,
  forehead: 4, skull: 5, earOuter: 6, earInner: 7,
  throat: 8, neck: 9, ruff: 10, chest: 11,
  shoulder: 12, back: 13, flank: 14, belly: 15,
  croup: 16, haunch: 17, legFrontUpper: 18, legFrontLower: 19,
  pawFront: 20, legHindUpper: 21, hock: 22, pawHind: 23,
  tailBase: 24, tailMid: 25, tailTip: 26,
};
export const REGION_NAME = Object.keys(REGION);
const R = REGION;

/** Regions whose fur fields get refined by the surface normal (dorsal/ventral). */
export const TORSO_REGIONS = new Set([
  R.chest, R.shoulder, R.back, R.flank, R.belly, R.croup, R.haunch, R.neck, R.ruff,
]);

// ---------------------------------------------------------------------------
// Bone rest positions (world space, bind pose = neutral stand)
// ---------------------------------------------------------------------------
// Hind limb reads femur -> tibia -> long metatarsus (the "hock", which is the
// backwards-bending joint people mistake for a knee) -> digits. Fore limb reads
// scapula -> humerus -> radius/ulna -> carpus -> digits. Both digitigrade.
export const LANDMARKS = {
  root: [0, 0, 0],

  hips: [0, 0.2375, -0.1450],
  spine01: [0, 0.2430, -0.0965],
  spine02: [0, 0.2455, -0.0505],
  spine03: [0, 0.2450, -0.0065],
  spine04: [0, 0.2465, 0.0395],
  chest: [0, 0.2510, 0.0815],
  neck01: [0, 0.2613, 0.1120],
  neck02: [0, 0.2705, 0.1400],
  head: [0, 0.3155, 0.1875],
  jaw: [0, 0.3005, 0.2085],

  earR01: [0.0300, 0.3330, 0.1934],
  earR02: [0.0362, 0.3459, 0.1928],
  earR03: [0.0423, 0.3589, 0.1921],
  earR_tip: [0.0485, 0.3718, 0.1915],

  // Tail: the animal's TRUE skeletal rest — carried low with a gentle
  // continuous curve, tip clear of the snow (§4b).
  //
  // Do NOT bake carriage compensation in here. Tail height is state-dependent
  // (idle / alert / run all differ), so the gait engine owns it: src/anim
  // applies a `tailLift` on top of this rest pose. A static offset here that
  // cancels a dynamic one there is invisible to both owners and breaks the
  // moment either side is retuned.
  tail01: [0, 0.2270, -0.2060],
  tail02: [0, 0.2130, -0.2390],
  tail03: [0, 0.1940, -0.2690],
  tail04: [0, 0.1710, -0.2950],
  tail05: [0, 0.1450, -0.3160],
  tail06: [0, 0.1175, -0.3320],
  tail07: [0, 0.0900, -0.3470],
  tail08: [0, 0.0700, -0.3580],
  tail09: [0, 0.0520, -0.3670],
  tail_tip: [0, 0.0370, -0.3740],

  shoulderR: [0.0430, 0.2330, 0.0590],
  upperArmR: [0.0478, 0.1841, 0.0843],
  lowerArmR: [0.0492, 0.1328, 0.0338],
  wristR: [0.0474, 0.0581, 0.0562],
  pawR: [0.0455, 0.0205, 0.0750],
  pawR_tip: [0.0452, 0.0110, 0.1120],

  thighR: [0.0400, 0.2280, -0.1380],
  shinR: [0.0465, 0.1550, -0.0880],
  hockR: [0.0462, 0.0905, -0.1790],
  footR: [0.0450, 0.0205, -0.1290],
  toeR: [0.0450, 0.0145, -0.1030],
  toeR_tip: [0.0448, 0.0105, -0.0850],
};

// Map the head group into place. Done before mirroring so the *L bones inherit
// the transformed positions.
for (const k of ['head', 'jaw', 'earR01', 'earR02', 'earR03', 'earR_tip']) {
  LANDMARKS[k] = skullXf(LANDMARKS[k]);
}

// Mirror every *R landmark to *L.
for (const key of Object.keys(LANDMARKS)) {
  if (!/R(\d\d)?(_tip)?$/.test(key)) continue;
  const p = LANDMARKS[key];
  LANDMARKS[key.replace(/R(?=(\d\d)?(_tip)?$)/, 'L')] = [-p[0], p[1], p[2]];
}

/**
 * ## Where the pinna is AIMED, as opposed to what shape it is
 *
 * 14cb891 measured the whole of §4b's outward lean onto the one axis a side
 * view collapses — 25.5 deg in the frontal projection, 2.8 deg in profile —
 * and the base sitting 8 mm caudal of the cranial apex, and left it alone
 * because §4c's visible-height rule had been tuned on the frontal read.
 * These are the two knobs that move it, in WORLD metres, applied after
 * `skullXf` so they are not silently scaled by SKULL_SCALE. Both the bone
 * chain (`FoxSkeleton` reads `LANDMARKS`) and the pinna geometry (`EAR`
 * reads the same landmarks through `earFrame`) follow from here, so there is
 * one source of truth for the pose.
 *
 * `caudal` slides the whole chain in -z and `lift` in +y. `pitch` adds +z at
 * the TIP only, so it tilts the blade forward in the (z, y) plane without
 * moving the root — which is the lean a side view can actually see, and the
 * one 14cb891 measured at 2.8 deg. Pricked forward also keeps the apex over
 * the skull's 34 mm coat instead of over the nape's 46-58 mm.
 */
/**
 * ## `lift` is no longer 0, and the frontal measurement that moved it
 *
 * Review 4 blocker 12 reads the frontal ear as "semicircular lobes ... 1.86:1
 * against §4c's 1:1". Measured on the true-coverage matte at 1400x900, with
 * runs merged across gaps <= 6 px so the outer fringe specks do not invent a
 * tip (they do: an unmerged scan puts the tip 6 rows and 40 px of width away
 * from the real one), the LEFT ear is:
 *
 *     tip y=221 · merges into the head outline y=310 · base width 149 px
 *     visible height 89 px = 31 mm · base 149 px = 52 mm · ratio 0.60 : 1
 *     proud over the midline dome 75 px = 26 mm
 *     width 6 px below the tip 60 px, i.e. a 60 % narrowing base-to-tip
 *
 * So the ratio is wrong in the OTHER direction -- the ear is a LOW WIDE lobe,
 * 52 mm across and 31 mm tall -- and the blade does taper: 0363d6a's
 * `power` 1.8 -> 1.0 did reach the frontal read, 60 % of narrowing is a
 * wedge, and the review's "34 % narrowing" does not reproduce at any tip row
 * this scan can find. §4c's own numeric target is "near 37 mm proud on a
 * 52 mm base"; the base is already exactly 52 and the proud height is 26.
 *
 * `lift` 0 -> 0.011 m buys the missing 11 mm at the only landmark that is
 * short. It is 11 mm of world y on the whole chain, applied after `skullXf`,
 * and it does not touch `rBase` -- so the base stays at §4c's 52 mm and only
 * the height moves. The ear root stays buried: earR01 sits 33 mm under the
 * skull's canopy today, 22 mm after.
 */
export const EAR_POSE = { caudal: 0.0180, pitch: 0.0060, lift: 0.0110 };
const EAR_CHAIN = ['earR01', 'earR02', 'earR03', 'earR_tip'];
const EAR_REST = EAR_CHAIN.map((k) => LANDMARKS[k].slice());
/** Re-derive the ear landmarks from `EAR_POSE`. Idempotent; see EAR.refresh. */
export function refreshEarPose() {
  EAR_CHAIN.forEach((k, i) => {
    const t = i / (EAR_CHAIN.length - 1), r = EAR_REST[i];
    const p = [r[0], r[1] + EAR_POSE.lift, r[2] - EAR_POSE.caudal + EAR_POSE.pitch * t];
    LANDMARKS[k] = p;
    LANDMARKS[k.replace('R', 'L')] = [-p[0], p[1], p[2]];
  });
}
refreshEarPose();

/**
 * Eyeball placement (RIGHT eye; mirrored for the left).
 *
 * `centre` is the eyeball centre and `look` the optical axis. Both are
 * authored, NOT derived from the field gradient: at the eye the nearest skin
 * is laterally outward, so a gradient-derived normal would aim the socket out
 * of the side of the skull instead of forward. A canid's eyes face forward
 * with roughly 35 degrees of divergence, which is what `look` encodes.
 *
 * Inter-pupil distance: MEASURE IT, do not trust a number written here. The
 * eye centre is raycast against the live field, so it moves whenever the
 * skull primitives move, and this docstring's old claim of 45.6 mm had been
 * wrong for at least two rounds — the rig measured 61.4 mm before the §4f
 * slimming and 54.3 mm after. src/core/Debug.js's landmark block carries the
 * same stale 46 mm. No published inter-pupillary figure exists for this
 * species either (REFERENCE-FOX.md §3d is a clean GAP), so there is nothing
 * to target; the impression of width comes from the cheek ruff, not the skull.
 */
export const EYE = {
  // A point well inside the skull that the eye's optical axis passes through.
  // The skin position is *measured* from here rather than authored, so the
  // eyeball always seats correctly no matter how the skull primitives blend.
  seed: skullXf([0.0090, 0.3140, 0.1980]),
  look: [0.5800, 0.1500, 0.8000],
  ballRadius: 0.0098 * SKULL_SCALE,
  socketDepth: 0.0026,     // depression carved into the skin
  cornealProud: 0.0030,    // how far the cornea stands out of the socket
  socketR: 0.0150,         // carving sphere radius
  socketK: 0.0165,         // smooth-subtract blend width

  /**
   * ## The socket is a SLOT, not a dish, and that is what sets the fissure
   *
   * Eyes.js draws the palpebral aperture as a band on the globe running from
   * `-AP_W` to `+AP_W` in gnomonic tangent units, so a canthus at AP_W sits
   * `atan(AP_W)` off the orbital axis. Wherever the SKIN stands further from
   * the eyeball centre than the seated globe's own surface does, it covers
   * the lid: authoring a canthus out there buys nothing, it just buries the
   * corner. The fissure length is therefore capped by this file, not by the
   * eye's, and the cap is the angle at which the skin closes over the globe.
   *
   * Measured on the built field (replica of Eyes.js's own fit + seat, agreeing
   * with its console line to 0.01 mm), before this slot existed:
   *
   *     visible to   TEMPORAL 54.9   UP 47.2   NASAL 37.5   DOWN 32.2 deg
   *     => AP_W max 0.768, and Eyes.js was authoring 0.780
   *
   * So the aperture was capped NASALLY, by 17 degrees against the temporal
   * side, and the eye agent's AP_W was already a hair past the cap. That is
   * the whole reason our fissure/cornea is 0.97 against a measured 1.28
   * (Cerdocyon thous, PLOS ONE 2019 e0224245): the cornea is the right size
   * and the lids cannot reach its corners.
   *
   * A round dish cannot fix it. Widening the sphere opens nasal and temporal
   * together, and the TEMPORAL rim at 50 degrees is what `_fitGlobeRadius`
   * measures the eyeball against — widening there shrinks the globe, and the
   * cornea with it. The carve has to be ANISOTROPIC: long on the fissure axis,
   * unchanged on the axis the fit probe rides.
   *
   * `socketSlot` is that length, in metres, applied as a segment through the
   * carving sphere along the fissure axis (`look` x world up), biased nasally
   * by `socketNasalBias` because the nasal end is the one that is short. It is
   * also what a real orbit looks like — the palpebral fissure of a canid is a
   * slot between the medial canthal ligament and the lateral raphe, not a
   * circular hole.
   */
  /**
   * ### VERIFIED, and corrected. The slot works; 0.62 / 0.0120 did not.
   *
   * The paragraph above is right about the mechanism and wrong about the
   * numbers it shipped. Re-measured on the built field with `socketSlot = 0`
   * as a positive control — which reproduces the pre-slot reading above to
   * 0.1 deg, so the instrument is reading the carve and not something else:
   *
   *     slot 0      (round dish)  T 54.9  U 47.2  N 37.5  D 32.2   AP_W max 0.768   cornea 13.9 mm
   *     slot .0120 bias 0.62      T 57.5  U 46.4  N 41.0  D 31.8   AP_W max 0.870   cornea 13.0 mm
   *     slot .0060 bias 1.00      T 54.9  U 47.2  N 42.0  D 32.2   AP_W max 0.900   cornea 13.9 mm
   *
   * `socketNasalBias` is the share of the slot spent NASALLY, so 0.62 spent
   * the other 38 % temporally — straight through the path `_fitGlobeRadius`
   * rides, which is the one thing the paragraph above says must not happen.
   * It cost 0.71 mm of globe radius and 0.9 mm of corneal diameter to buy
   * 3.5 deg of nasal reach. At bias 1.00 the temporal side is untouched
   * (T and cornea return to the control exactly) and the nasal side opens
   * further, so bias 1.00 dominates both earlier settings on every axis.
   *
   * The length saturates: 0.0040 already yields N 41.9 and 0.0260 only
   * 42.0, because the nasal wall is the muzzle rising away from the globe
   * (skin/globe along the nasal meridian runs 12.1/12.3 mm at 40 deg to
   * 16.3/11.6 at 55) and no plausible carve moves a wall that steep. Keep
   * the slot short — a long capsule trenches the nose bridge for nothing.
   *
   * WHAT THIS DOES NOT FIX. `AP_W` lives in Eyes.js and is still 0.780,
   * under both the old cap and the new one, so the RENDERED fissure/cornea
   * is 0.97 before and after — the slot buys headroom that nothing spends.
   * Even fully spent, AP_W 0.900 is fissure/cornea 1.05 against the measured
   * 1.28 (Cerdocyon thous, PLOS ONE 2019 e0224245); 1.28 needs AP_W ~ 1.39,
   * i.e. the lids visible to 54 deg nasally, and the muzzle closes at 42.
   * That last 12 deg is not available from this socket.
   */
  socketSlot: 0.0060,      // half-length of the carve along the fissure axis
  socketNasalBias: 1.00,   // share of the slot spent on the nasal side

  /**
   * ### Re-measured after the muzzle work, and it got better for free
   *
   * Slimming `whiskerPadR` by 2.8 mm pulled skin off the medial canthus, so
   * the cap moved again without touching this socket at all:
   *
   *     slot .0060 bias 1.00, before the muzzle edit   T 54.9  N 42.0  AP_W max 0.900  cornea 13.9
   *     ...after it                                    T 53.9  N 44.0  AP_W max 0.966  cornea 14.3
   *
   * Confirmed against the live `[eyes]` line at the same instant: globe r
   * 11.25 / 11.25, seat 1.88 / 1.87, cornea 14.3 / 14.3 mm. Fully spent,
   * AP_W 0.966 would be fissure/cornea 1.09 against the measured 1.28.
   *
   * FOR THE FUR AGENT, urgent and adjacent: 57f5742 widened uEyeFade, and
   * the coat is now shaved off a large oval AROUND the eye. Measured at
   * `macro_eye`, fraction of 9x9 blocks flatter than 1.0 luminance levels
   * (the brow 200 px away is the control):
   *
   *     nasal patch   0.0 % -> 51.4 %      temporal patch 0.0 % -> 91.9 %
   *     brow control  0.0 % ->  0.0 %
   *
   * That is bare skin outside the palpebral aperture, which §4f rule 3 does
   * not permit, and it is a new defect of the same kind the muzzle just had.
   * The clearance needs to follow the aperture, not the globe.
   */
};

/**
 * ## §4g — the rostrum's LENGTH, as one parameter
 *
 * The head is the right SIZE and the wrong DIVISION. Measured on the built
 * field (nose tip to the caudal pole of a head-only field; the divider is the
 * anterior orbit, i.e. where the optical axis leaves the skin — the same
 * landmark the 0.62:1 reading in §4g was taken with):
 *
 *     nose tip -> occiput 122.4 mm   rostrum 47.9 (39.1 %)   braincase 74.5
 *
 * against a real *Vulpes lagopus* CBL of 121.3 mm with a 74.1 mm rostrum
 * (Nanova & Prôa 2017, n=43, REFERENCE-FOX.md §3a). Total length is right to
 * 1 mm; the split is inverted.
 *
 * `stretch` scales every rostral feature's distance from `pivot` **along the
 * rostral axis only**. Radii are not touched by it, which is the point:
 * §4c's 1.4–1.6:1 figure is the muzzle cone's `ra:rb` WIDTH taper, a
 * different axis, and conflating the two is the §4b error that produced the
 * bear. Anything at or behind the pivot is untouched, so the stop, the brow,
 * the orbit, the cheek and the cranium do not move.
 *
 * MEASURE, DO NOT DERIVE: `t` below is an authored-space projection but the
 * rostrum is measured on the blended skin, so a given `stretch` does not move
 * the nose tip by a predictable amount. The step table, measured:
 *
 *              nose tip   rostrum | skin pole:        | occipital condyle:
 *   stretch      z mm       mm    |  total    frac    |  CBL-eq   frac
 *     1.00       253.3      48.3  |  122.5    39.4 %  |   92.4    52.3 %
 *     1.15       258.8      53.9  |  128.0    42.1 %  |   98.0    55.0 %
 *     1.30       264.6      59.6  |  133.8    44.6 %  |  103.7    57.5 %
 *     1.45       270.4      65.5  |  139.6    46.9 %  |  109.6    59.7 %
 *     1.60       276.3      71.3  |  145.5    49.0 %  |  115.4    61.8 %   <-
 *     1.75       282.1      77.2  |  151.3    51.0 %  |  121.3    63.6 %
 *     2.05       293.8      88.8  |  163.0    54.5 %  |  133.0    66.8 %
 *
 * Two caudal landmarks because they disagree and the disagreement is the
 * whole §4g story. The SKIN POLE is §4g's own ("nose-tip-to-occiput", the
 * landmark its ~40 % baseline came from): the caudal pole of a head-only
 * field. The CONDYLE is `LANDMARKS.head`, the atlanto-occipital pivot, which
 * is where CBL's caudal end sits and is therefore the only one comparable
 * with Nanova & Prôa's 121.3 mm CBL / 61.1 % rostrum.
 *
 * On the source's own landmark we are AT the sourced ratio at stretch 1.60,
 * and §4g asks to land deliberately short of it. On §4g's landmark 55 % needs
 * stretch 2.07 and a 164 mm head, 35 % over the sourced CBL and longer than a
 * red fox's skull. Stopped at 1.60; see the commit for the render judgement.
 *
 * `occipitalTuck` moves the occipital pole forward, in authored metres, and
 * is **measured dead — leave it at 0**. The idea was that it buys the
 * fraction from the caudal end "where the coat hides the change". It does not
 * hide the change; the NECK does, and that means there is no change. A 20 mm
 * tuck (23.6 mm world) moves the visible sagittal topline of the FULL field
 * by at most 0.70 mm between z = 200 and z = 85, and the caudal skin at every
 * height from y = 240 to y = 305 by at most 0.50 mm — because below y ~ 300
 * the back of the head is not the occiput primitive at all, it is the
 * trunk/neck chain standing outside it. The tuck moves a buried landmark and
 * nothing else, so using it to reach 55 % would be gaming the instrument.
 */
export const ROSTRUM = {
  /** Authored skull-space pivot — the muzzle cone's root, i.e. the stop. */
  pivot: [0, 0.3020, 0.2255],
  /** Unit rostral axis in authored space: muzzle root -> nose-pad centre. */
  axis: [0, -0.26312, 0.96477],
  stretch: 1.60,
  /** Measured dead — see above. Not a knob; 0 is the only supported value. */
  occipitalTuck: 0.0000,
};

/**
 * ## The stop, and why there was not one
 *
 * `shots/orch-w7/profile.png`: the forehead flows into the muzzle in one
 * unbroken curve. A fox has a visible stop where the nasal bones meet the
 * frontal, and without it the lengthened rostrum reads rodent-like.
 *
 * Measured on the built field, sagittal dorsum, "nearest primitive and how
 * far the blended skin stands off its own surface":
 *
 *     z (mm)   248   244   236   228   224   220   216   208   200
 *     owner    nasal muzzle muzzle muzzle muzzle forehd forehd forehd forehd
 *     lift      3.5   3.5   1.4   1.9   3.2   4.9   3.3   2.3   2.8
 *
 * so the rostrum/frontal crossing is at z ~ 221 and the smin lift there is
 * 4.9 mm — the largest anywhere on the dorsum, but not the main problem.
 * The main problem is the SLOPE of each segment (mm of rise per mm caudal):
 *
 *     nasal shaft  z 248–262   0.44
 *     muzzle cone  z 224–246   1.02   <- the steepest segment on the head
 *     frontal      z 196–220   0.67
 *     dome         z 188–196   0.44
 *
 * The muzzle cone's own dorsal line is doing the frontal's job, 25 mm too
 * far forward, and the junction at z = 221 is therefore CONVEX (the slope
 * falls 1.02 -> 0.67 going caudally). There is a concave break, but it is at
 * z ~ 246, the nasal/muzzle joint, in the middle of the rostrum.
 *
 * ## And the coat then erases what is left
 *
 * Canopy contour = the upper envelope of a disk of radius `coat` swept along
 * the skin, which is what a coat of uniform depth is. A dilation preserves
 * CONCAVE corners exactly and rounds convex ones at radius c — so the coat
 * cannot be blamed for a missing corner. What it can do, and does, is tilt:
 * the coat runs 9.0 mm at z = 264 to 18.3 mm at z = 228, a gradient of
 * 0.26 mm/mm in the same direction as the skin's rise, which adds to the
 * rostrum's slope and takes the skin's 10.4 mm hull defect to zero.
 *
 *     skin    nasal 0.675  frontal 0.829   stop angle  +5.6 deg   defect 10.4 mm
 *     canopy  nasal 1.272  frontal 1.159   stop angle  -2.6 deg   defect  0.0 mm
 *
 * ## The levers
 *
 * `nasalDrop` lowers the muzzle cone's ROOT — the primitive's `a`, not
 * `ROSTRUM.pivot`, so `rostral()` and the settled rostrum length are
 * untouched. The root is buried inside the frontal and the cheek, so this
 * flattens the caudal end of the nasal dorsum and almost nothing else; the
 * distal end is pinned by the `nasal` shaft, which does not move.
 *
 * `frontalLift` raises the frontal dome so it stands proud of the nasal
 * dorsum, which is the other half of the same corner.
 *
 * `blend` is the muzzle's own smin `k`, and it is the fillet that rounds the
 * corner off. It has to stay above the mesher's floor — 1.5 cells at the
 * 6 mm `high` grid is 9 mm — or the stop stair-steps, which is §4c's ear
 * failure on a different part of the head. §4d's "the stop is too abrupt and
 * angular" is the opposite failure and this is the knob that trades between
 * them, so change it in small steps and look at `portrait`.
 *
 * `notch` is a transverse dish smooth-SUBTRACTED from the dorsum at the
 * nasion. It is here because the two levers above move the skin and the
 * canopy does not follow: a dilation rounds convex corners at radius c but
 * reproduces concave ones, so the only thing that reaches the canopy through
 * 18 mm of coat is an actual concavity. `notch.k` is its fillet and is what
 * keeps it a dish rather than §4d's "abrupt and angular" crease.
 */
/*
 * ## The honest before/after, on ONE tree, which 20211cb could not give
 *
 * 20211cb's matte pair was two runs with 7df3911 landing between them, and it
 * said so. This is the same measurement with nothing else moving: knobs off
 * and knobs on, same commit, same tool, same session.
 *
 * `tools/matte.mjs --poses profile`, upper contour of the head from the nose
 * to the brow (x 350..430), deficiency below its own upper convex hull:
 *
 *                       defMax   at x   defMean   steepest step
 *   nasalDrop 0, notch off  12.1   383     5.90     2.00 px/px
 *   SHIPPED                 23.5   403     9.08     4.75 px/px
 *
 * Noise floor, taken from the same two runs over the untouched withers band:
 * defMax 30.5 / 30.9, defMean 13.49 / 13.68 — about +-0.4 px. So the stop is
 * a ~28-sigma feature, it is where the nasion is rather than halfway down the
 * muzzle, and the four separate 2 px/px breaks of the unbroken curve have
 * become one 4.75 px/px break. 20211cb's cross-run pair read 12.7 -> 34.7,
 * i.e. its AFTER was ~11 px optimistic. The stop is real and it is smaller
 * than that commit claimed.
 *
 * ## AND BOTH REMAINING KNOBS ARE SPOKEN FOR. Swept; do not re-sweep.
 *
 * `nasalDrop` 6 -> 20 mm, on the built SDF, sagittal dorsum, with the notch
 * ON (20211cb swept it with the notch off, where the muzzle cone's own slope
 * is still the whole story):
 *
 *     drop mm    6      9     12     16     20
 *     angle   26.8   27.8   28.6   29.4   29.9   deg, nasal-to-frontal
 *     defect  12.5   13.5   14.2   15.2   15.7   mm, skin hull defect
 *
 * so it still moves the SKIN, and on the canopy it does nothing at all.
 * Paired matte, two runs back to back, 6 mm against 12 mm: defMax 23.5 ->
 * 23.6, defMean 9.08 -> 8.77, against that +-0.4 px floor. 20211cb predicted
 * this from the dilation argument — "0 -> 16 mm takes the skin angle 5.6 ->
 * 19.1 deg and the canopy angle nowhere at all" — and this is it confirmed on
 * the render instead of argued. The notch has already taken what there was to
 * take; the two levers are not additive.
 *
 * `frontalLift` is the one knob in this block that had never been swept, and
 * it is the only one that still reaches the canopy, because it TRANSLATES the
 * dorsum rather than carving it:
 *
 *     lift mm    0      3      6      9     12     16
 *     angle   26.8   29.1   31.4   33.6   35.6   38.1   deg
 *     defect  12.5   13.8   15.5   17.3   19.3   22.1   mm
 *     dome    297.8  299.8  302.0  304.3  306.5  309.8  mm at z = 202
 *
 * IT IS LEFT AT 0 BECAUSE IT BUYS THE STOP FROM THE EAR. The dome rises with
 * the forehead, and §4c's visible-height rule is the ear's apex measured
 * against that dome. Measured on the same builds:
 *
 *     lift mm        0      3      6
 *     ear proud   45.0   44.0   42.0   mm
 *     proud/base  0.90   0.88   0.84   §4c asks for ~1:1
 *
 * 3 mm of lift gives back the whole of what 0363d6a's `rBase` widening just
 * bought, and 6 mm gives back three times it. Same class of trade as §4i's
 * withdrawal of the 55 % target: reaching a number by spending a landmark.
 *
 * What is left of the softness is the COAT RAMP, which is fur's and which
 * 20211cb measured: the coat runs 9.0 mm at z = 264 to 18.3 mm at z = 228, a
 * gradient of 0.26 mm/mm in the same direction as the rise, which tilts the
 * canopy even where it reproduces the concavity.
 */
export const STOP = {
  nasalDrop: 0.0060,
  frontalLift: 0.0000,
  blend: 0.0180,
  notch: {
    on: true,
    /**
     * A large, shallowly-seated ellipsoid, NOT a small deep one. Swept:
     * at a fixed floor the dish's RADIUS is what reaches the canopy and its
     * depth barely matters, because a dilation by c fills anything whose
     * clearance circle is smaller than c and the coat here is 18 mm.
     *
     *   r (mm)      30     45     60     80
     *   canopy ang  10.9   14.5   14.2    3.2      (80 also flattens the brow)
     */
    r: 0.0600,
    /** World y the dish's lowest point reaches. Dorsum there is 287 mm. */
    floor: 0.2760,
    /** Caudal offset of the centre from `ROSTRUM.pivot`, world metres. */
    dz: 0.0180,
    /**
     * Per-axis scale on `r`. `wide` 1.0 keeps the dish on the nasal bridge:
     * measured at z = 224 it takes 11.4 mm off the midline, 9.0 at x = 12 mm
     * and 3.0 at x = 24, and the temple half-width does not move at all.
     * `deep` (the z scale) is the one that has to stay small — at 0.55 the
     * dish reaches z = 187 and takes 5 mm off the brow above the eye; at
     * 0.35 with `dz` 18 it stops at z = 200 and the orbit moves 0.4 mm.
     */
    wide: 1.0,
    deep: 0.35,
    /** The fillet. §4d: a dish, not a crease. */
    k: 0.0110,
  },
};

/**
 * Stretch an authored skull-space point along the rostral axis. Points at or
 * behind the pivot come back unchanged, so this can be applied to any head
 * primitive without a per-primitive opt-in list drifting out of date.
 */
export function rostral(p) {
  const o = ROSTRUM.pivot, d = ROSTRUM.axis;
  const t = (p[0] - o[0]) * d[0] + (p[1] - o[1]) * d[1] + (p[2] - o[2]) * d[2];
  if (t <= 0) return p;
  const e = t * (ROSTRUM.stretch - 1);
  return [p[0] + d[0] * e, p[1] + d[1] * e, p[2] + d[2] * e];
}

/**
 * The cranium, as one place both the primitives and the region test read.
 *
 * `region` on a vertex is "whose primitive is nearest", and on the top of the
 * head that is not the braincase — it is the last NECK station of the trunk
 * chain, a 50 mm sphere whose surface passes closer to the blended skin than
 * the 25.5 mm braincase's does. Measured on the built mesh: `skull` owned
 * ONE vertex on the whole animal, and on the cranium itself `neck` owned 71.
 * Coat DEPTH was never affected — that is a softmax over every nearby
 * primitive and measures 27.7 mm there, correctly shallower than the flank —
 * but every per-region table the fur agent keys off the integer id was
 * reading the top of the head as neck: card length, card opacity floor,
 * shell length scale and transmission are all indexed by it.
 *
 * So FoxSurface relabels the dome by POSITION, and takes the position from
 * here rather than re-deriving it, so the test cannot drift off the shape.
 *
 * It does NOT make `skull` a large region, and should not be read as trying
 * to: after §4f halved the braincase to 25.5 mm half-width the primitive
 * barely reaches the skin anywhere, because the ear bases, the cheeks, the
 * forehead and the neck surround it. `skull` goes from 1 vertex to 24 and
 * that is the honest size of the exposed cranium. What the relabel is FOR is
 * the other direction: no vertex on the top of the head is labelled `neck`
 * any more, so the fur agent's 45 mm ruff character cannot be applied to the
 * poll by an accident of which sphere happened to be nearest.
 */
export const CRANIUM = {
  braincase: { c: skullXf([0, 0.3140, 0.1985]), r: sr(0.0216), s: [0.900, 0.880, 0.96] },
  occiput:   { c: skullXf([0, 0.3040, 0.1790]), r: sr(0.0205), s: [0.900, 0.880, 0.78] },
  /**
   * Re-derive from `ROSTRUM`. `contains()` runs once per vertex, so the tuck
   * is baked rather than read through a getter; `buildField` calls this first
   * so a probe that mutates `ROSTRUM` between builds sees the new pole.
   */
  refresh() {
    this.occiput.c = skullXf([0, 0.3040, 0.1790 + ROSTRUM.occipitalTuck]);
    return this;
  },
  /**
   * Multiple of the primitive radius the test reaches to. The blended skin
   * stands ~30 mm off the braincase centre where the primitive's own surface
   * is at 22 mm, because smin with the neck, forehead and ear bases pushes it
   * out; 1.42 only just reached it and 1.80 covers the poll strip without
   * reaching back onto the nape (measured: the relabelled vertices span
   * y 301-305 mm, z 150-174 mm, |x| < 18 mm, which is exactly the dome
   * between the ear bases).
   */
  grow: 1.80,
  /** Is this bind-space point on the cranium? */
  contains(x, y, z) {
    for (const p of [this.braincase, this.occiput]) {
      const dx = (x - p.c[0]) / p.s[0], dy = (y - p.c[1]) / p.s[1], dz = (z - p.c[2]) / p.s[2];
      if (dx * dx + dy * dy + dz * dz < (p.r * this.grow) ** 2) return true;
    }
    return false;
  },
};

/** The ear pinna plane normal — the direction the concha faces (right ear). */
export const EAR_NORMAL = [0.7000, 0.0850, 0.7090];

/** World-space y of the pinna base and tip, for the ear coat taper. */
export const EAR_SPAN = { baseY: LANDMARKS.earR01[1], tipY: LANDMARKS.earR_tip[1] };

/**
 * The pinna, as geometry the rest of the pipeline can interrogate.
 *
 * Hoisted out of `buildField` because FoxSurface has to know where the RIM is
 * and where the BOWL is, and it used to infer both from the surface normal
 * alone (rim = `|n . EAR_NORMAL| < 0.55`). That worked only while the concha
 * was a flat plane: the sole place on a flat pinna whose normal faces sideways
 * IS the outer edge. Carve a real bowl and its side walls face sideways too,
 * so the normal test would put the ear's heaviest fringe (x2.55 coat) INSIDE
 * the concha and fill the bowl straight back in. An explicit frame answers it
 * exactly instead: `u` along the pinna, `w` across the blade, `n` out of the
 * concha. Left ear: mirror the query point through x = 0 and use this frame.
 *
 * Profile shape and the reason it is a chain rather than one cone: see the
 * ears section of `buildField`.
 */
function earFrame() {
  const a = LANDMARKS.earR01, b = LANDMARKS.earR_tip;
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  const axis = [d[0] / len, d[1] / len, d[2] / len];
  const el = Math.hypot(EAR_NORMAL[0], EAR_NORMAL[1], EAR_NORMAL[2]);
  let n = [EAR_NORMAL[0] / el, EAR_NORMAL[1] / el, EAR_NORMAL[2] / el];
  // Gram-Schmidt against the axis, exactly as AnatField's 'axis' frame does,
  // so `w` is the same direction the `squash` widths were authored in.
  const dp = n[0] * axis[0] + n[1] * axis[1] + n[2] * axis[2];
  n = [n[0] - axis[0] * dp, n[1] - axis[1] * dp, n[2] - axis[2] * dp];
  const nl = Math.hypot(n[0], n[1], n[2]);
  n = [n[0] / nl, n[1] / nl, n[2] / nl];
  const w = [
    axis[1] * n[2] - axis[2] * n[1],
    axis[2] * n[0] - axis[0] * n[2],
    axis[0] * n[1] - axis[1] * n[0],
  ];
  return { a, axis, n, w, len };
}

/**
 * ## Why the ear all but vanishes at `profile` while reading strongly at
 * `frontal`. It is the POSE and the RUFF; the pinna itself is fine.
 *
 * The `profile` camera sits at (1.900, 0.205, -0.020) looking at
 * (0, 0.190, -0.020), so its view axis is -X to within half a degree and the
 * profile silhouette is simply the outline in the (z, y) plane. The pinna's
 * axis runs base (35.4, 296.1, 167.8) -> tip (57.2, 341.9, 165.6):
 *
 *     lean off vertical, FRONTAL projection (y,x)    25.5 deg
 *     lean off vertical, PROFILE projection (y,z)     2.8 deg
 *
 * The whole of §4b's outward lean is on the one axis a side view collapses,
 * and the base sits only 8 mm caudal of the cranial apex — so in profile the
 * ear rises straight out of the top of the skull with nothing in front of it
 * to read against.
 *
 * It is still 47 mm proud of the SKIN there, so this is not a shape problem.
 * The coat closes the rest. Profile-projected upper silhouette, max over x:
 *
 *                    z=145 (nape)   z=166 (apex)   z=187 (forehead)
 *     skin              303.8          351.2           311.2
 *     canopy            341.2          367.8           323.2
 *
 * 47.4 mm of relief against the nape on the skin, 26.6 mm on the canopy: the
 * nape carries 45.5–58 mm of coat against the pinna's 18 mm and fills the
 * notch from behind. On `shots/matte/profile.matte.png` — true coverage, so
 * this is not a backlighting artefact — the head's top contour is a single
 * convex arc from nose to nape with one apex and no ear notch at all.
 *
 * The fix is a POSE change: move the base caudal and put some of the lean
 * into -z so the pinna clears the dome in the (z, y) plane as well as in
 * (x, y). Not attempted here; §4c's visible-height rule was tuned on the
 * frontal read and re-posing the ear needs its own render loop.
 */
export const EAR = {
  /**
   * ## The blade's OUTLINE, which is what §4c's "rounded triangle" is about
   *
   * `rAt(u) = rBase * (1 - (1 - tipRatio) * u^power)`, so `power` is the
   * shape of the two long sides and `tipRatio` is how wide the apex is.
   *
   * `power` was 1.8 and the comment on it read ">1 bulges the outline off the
   * chord: convex sides". That is true and it is also what made the paddle:
   * at 1.8 the blade holds ~95 % of `rBase` for the first third of its length
   * and then turns over, which is parallel sides with a dome on top — §4c's
   * "semicircular paddle", the exact thing that section supersedes §4b to
   * forbid. At 1.0 the radius is linear in u, which is a straight-sided
   * triangle, which is what §4c asks for in words.
   *
   * Swept on the built SDF. `profile` looks along -X (14cb891), so the
   * profile outline is the shadow on (z, y); `sN` is the width of that shadow
   * measured perpendicular to the projected pinna axis, N mm below the apex.
   * `proud` is §4c's own guard — frontal shadow top at the pinna's x minus
   * the same at the midline — over the frontal base width.
   *
   *   power tipRatio uEnd rBase | s10  s15  s20  s20/s10 | proud base ratio | apexR
   *    1.8   0.49    0.93 22.8  | 25.5 29.5 32.0  1.25   | 46.5  53.0 0.88  | 12.6  <- was
   *    1.4   0.49    0.93 22.8  | 24.5 28.0 31.0  1.27   | 46.0  52.0 0.88  | 12.3
   *    1.0   0.49    0.93 22.8  | 23.0 26.0 28.5  1.24   | 46.0  52.0 0.88  | 12.0
   *    1.0   0.32    0.97 22.8  | 18.5 21.5 24.5  1.32   | 43.5  49.0 0.89  |  7.8
   *    1.0   0.36    0.97 24.0  | 20.0 23.5 26.5  1.33   | 45.0  50.0 0.90  |  9.1  <- is
   *    0.8   0.32    0.97 22.8  | 17.5 20.5 22.5  1.29   | 43.5  49.0 0.89  |  7.7
   *
   * `apexR` is the floor on all of this and it is the MESHER's, not the
   * anatomy's: 13b46b6 measured stair-stepping below ~1.5 cells and the
   * `high` cell is 6 mm, so 9 mm of apex radius is the smallest blade that
   * can be meshed without reintroducing review blocker 5. 9.1 mm is 1.52
   * cells; the rows below it in the table are 1.28-1.46 and are listed so
   * nobody re-derives them, not because they are available.
   *
   * `rBase` 22.8 -> 24.0 is what pays for the narrower apex. Sharpening alone
   * drops the tip (the end cap is a sphere of radius `rAt(uEnd)`, so a
   * smaller cap sits lower) and takes §4c's proud-height 46.5 -> 43.5 mm on a
   * shrinking base. Widening the root puts the ratio back at 0.90 against
   * §4c's 1:1 — better than the 0.88 it was — for 1.5 mm of height.
   *
   * DO NOT "thicken the pinna slightly to compensate", which is what §4c
   * suggests for exactly this situation. Measured: `thickTip` 0.92 -> 1.10
   * takes s10 from 25.5 to 27.5 mm. The thickening axis is `EAR_NORMAL`,
   * [0.700, 0.085, 0.709], which is 71 % Z — and Z is IN the profile shadow
   * plane. On this pose thickening the blade blunts the profile outline
   * instead of protecting it.
   */
  rBase: 0.0240,      // world half-radius at the pinna root (x `wide` across)
  tipRatio: 0.36,     // r(apex) / r(root) — the §4c base-to-tip wedge
  power: 1.0,         // 1.0 = radius linear in u = straight sides = a wedge
  uEnd: 0.97,         // the chain stops here; the end cap forms the apex
  segs: 8,
  thickRoot: 0.70,    // squash along EAR_NORMAL at the root
  thickTip: 0.92,     //   ... and at the apex (near-circular cross-section)
  thickPower: 1.3,
  wide: 1.02,
  rim: 0.0112,        // blade left outside the concha on each side

  /**
   * ## The coat on the pinna, which `FoxSurface` applies and which is most
   * of why the ear does not read at `profile`.
   *
   * `tipTaper` shortens the coat toward the apex (`len *= 1 - tipTaper * t`)
   * and `fringe` then multiplies the RIM band — the edge-on strip that draws
   * the ear's outline — by `1 + fringe`. Constant, that put 33 mm of coat on
   * the pinna's own silhouette at mid-blade and 23 mm at the apex, against
   * 16.7 mm on its face: the outline is the deepest-coated line on the ear.
   *
   * Measured with that term in the canopy model (it was NOT in 14cb891's,
   * which is why that note has the pinna at "18 mm"), the ear's rostral
   * notch on the canopy is 4.0 mm and moving the pose only takes it to 6.2.
   * The fringe is the filler, not the pose and not the ruff.
   *
   * `fringeTip` is the share of `fringe` left at the apex, so the band can
   * stay heavy where a real fox's ear fringe is heavy — sweeping up the
   * leading edge out of the ruff — and thin out where it is blunting a
   * 12.8 mm blade into a 36 mm arc. It must not go to 0: the fringe is what
   * stops the rim rendering as the hardest line on the animal (the user's
   * 2x crop of a stair-stepped blue-grey cutout), and that is a §4f.3
   * failure worth more than a sharp tip.
   */
  // 0.46 -> 0.38 and fringeTip 0.45 -> 0.62 are the price of EAR_POSE.lift.
  // Lifting the pinna 11 mm exposes apex that used to be inside the skull's
  // canopy, and the apex is the shortest-coated point on the ear -- measured
  // on `tools/matte.mjs --poses profile,frontal`, the lift alone added
  // sub-1.15-tv contour scans at exactly the ear: left y 292-304, right
  // y 292-300, top x 494-514, all of them new. 0363d6a said this would
  // happen in advance ("the fringe is what stops the rim rendering as the
  // hardest line on the animal") and the remedy is the one it names: more
  // hair on the RIM at the tip, which is `fringeTip`, not a wider blade.
  tipTaper: 0.28,
  fringe: 1.55,
  fringeTip: 0.62,
  fringeSoften: 0.22,
  // Concha: a cone, not a sphere, sized FROM the blade profile so it can never
  // outgrow it however the pinna is retuned.
  bowlU0: 0.12, bowlU1: 0.80, bowlWide: 0.85, bowlThick: 0.50, bowlK: 0.0080,
  bowlFloor0: 0.0022, bowlFloor1: 0.0108,

  ...earFrame(),

  /**
   * Re-derive the pinna frame and the coat-taper span from `EAR_POSE`.
   * `buildField` calls this first, exactly as it does `CRANIUM.refresh`, so
   * a probe that mutates `EAR_POSE` between builds sees the new pose and
   * `FoxSurface` — which reads `EAR.project` and `EAR_SPAN` at mesh time,
   * after the field is built — sees it too.
   */
  refresh() {
    refreshEarPose();
    Object.assign(this, earFrame());
    EAR_SPAN.baseY = LANDMARKS.earR01[1];
    EAR_SPAN.tipY = LANDMARKS.earR_tip[1];
    return this;
  },

  /** Blade half-radius at u (0 = root, 1 = the `earR_tip` landmark). */
  rAt(u) { return this.rBase * (1 - (1 - this.tipRatio) * Math.pow(u, this.power)); },
  /** Squash along the concha normal at u — the blade thickens as it narrows. */
  thickAt(u) {
    return this.thickRoot + (this.thickTip - this.thickRoot) * Math.pow(u, this.thickPower);
  },
  /** Blade half-width across the pinna at u. */
  halfWidthAt(u) { return this.rAt(u) * this.wide; },
  /** Concha half-width at u — always `rim` inside the blade edge. */
  bowlHalfWidthAt(u) { return Math.max(0, this.halfWidthAt(u) - this.rim); },
  /** World point on the pinna axis at u. */
  at(u) {
    return [
      this.a[0] + this.axis[0] * this.len * u,
      this.a[1] + this.axis[1] * this.len * u,
      this.a[2] + this.axis[2] * this.len * u,
    ];
  },
  /**
   * Project a bind-space point into the pinna frame. Mirrors the left ear onto
   * the right so one frame serves both. Returns metres.
   */
  project(x, y, z, out) {
    const sx = x < 0 ? -1 : 1;
    const dx = x * sx - this.a[0], dy = y - this.a[1], dz = z - this.a[2];
    out.u = (dx * this.axis[0] + dy * this.axis[1] + dz * this.axis[2]) / this.len;
    out.w = dx * this.w[0] + dy * this.w[1] + dz * this.w[2];
    out.n = dx * this.n[0] + dy * this.n[1] + dz * this.n[2];
    out.side = sx;
    return out;
  },
};

// ---------------------------------------------------------------------------
// fur field presets per region: [length (m), stiffness 0..1]
// ---------------------------------------------------------------------------
// Bible §5: 2-6 mm on muzzle/paws/forehead, 35-55 mm on ruff/flank, longest on
// the tail. Stiffness: guard hairs of the back and tail are stiff; belly,
// cheek and throat underfur is soft.
// NOTE FOR THE FUR AGENT: `furLength` is the COAT THICKNESS, i.e. how far the
// outermost shell should sit off the skin along the normal — not the length of
// an individual guard hair. Tail: 46 mm skin diameter + 2x54 mm gives the
// bible's ~100 mm brush once the outer shells fade out.
//
// ## What is sourced here and what is not  (REFERENCE-FOX.md)
//
// Almost none of these millimetre figures have a literature source, and the
// research pass that went looking says so explicitly: §2c is a flat GAP for
// muzzle, forehead, skull, cheek, throat, ruff, shoulder, haunch, upper leg,
// paw and both ear surfaces. Do not add zoology-flavoured precision to them —
// that is the mechanism that produced the bear (§4b) and the rabbit (§4c).
//
// Three constraints ARE real, and this table is built to satisfy them:
//
//  1. ORDERING [MEASURED, Underwood & Reynolds 1980 via Prestrud 1991].
//     Deepest and most seasonal: foot pads, posterior-medial lower leg,
//     LATERAL TRUNK. Also deep: dorsal trunk. Shallowest in every season:
//     HEAD, distal legs, VENTRAL trunk. So `flank` is the deepest coat on the
//     body, every head region sits below it, and `belly` sits below `flank`
//     too — which is why belly is 39 mm and not the 49 mm it used to be. The
//     old table had the belly as the deepest region on the animal, which
//     inverts the one ranking anybody has actually measured.
//     (§4b's "belly fur hangs low enough to obscure the leg" is not in
//     conflict: the ASM #2 specimen measures 80-85 mm belly GUARD HAIRS lying
//     nearly flat, which is long hair at low standing depth. Length and loft
//     are different quantities and only loft belongs in this table.)
//  2. FLANK ABSOLUTE ~40-60 mm [INFERRED from Scholander et al. 1950 Fig. 1
//     clustering]. 48 mm sits mid-band. An earlier revision of §4f claimed
//     50-70 mm and this table briefly carried 61 mm on the strength of it;
//     that figure was withdrawn as unsourced. Do not deepen the flank again
//     without a source.
//  3. THE HEAD'S DEPTH IS A RENDERING REQUIREMENT, NOT AN ANATOMICAL ONE.
//     There is no mm datum for any head region and there probably never will
//     be. The binding constraint is §4f.3 — no bare skin visible, and a
//     silhouette that is hair everywhere — measured by the "silhouette is
//     hair, not a curve" check in tools/spec.mjs. Deep enough to pass that,
//     shallower than the flank, and no deeper. That is the whole rule.
export const FUR = {
  // 0.6 mm is a shaved region, and `nosePad` was 31 mm across -- so this
  // authored a bare disc 2.4x the width of the rhinarium it stands for, which
  // is what `chin` was showing. The rhinarium's bareness is owned twice over
  // by FaceDetail's own pad mesh and by fur.glsl's uNoseFade (bare to 4 mm,
  // full coat by 7 mm); this table does not need to shave it a third time.
  // Measured at `chin`, fraction of the muzzle core that changes when the
  // SKIN is hidden -- 11 % on the cheek is the covered control:
  //     0.6 mm 86.6 %   3.4 mm 80.6 %   8 mm 71.6 %   15 mm 62.3 %
  // so length alone never closes it; the pad had to shrink as well.
  [R.nose]: [0.0040, 1.00],
  /**
   * ### 8.0 mm, and this KNOWINGLY breaks §4f rule 2. Read before changing.
   *
   * Rule 2 holds the muzzle at 3-5 mm because the deep-skull / short-muzzle
   * contrast is what makes the face read pointy. Rule 3 says bare skin
   * anywhere but the rhinarium, eyes and pads "is a failure regardless of
   * what any other metric says". At `chin` the two cannot both hold, and
   * that is measured, not argued: with the coat swept and the nose pad left
   * alone, the fraction of the muzzle core that is skin-dominant runs
   * 86.6 % at 2.5 mm, 80.6 at 5.6, 71.6 at 10, 62.3 at 17 -- so NO length
   * inside rule 2's band satisfies rule 3, and the band itself was never
   * the binding thing.
   *
   * 3.4 -> 8.0 mm is paid for the way §4f pays for everything else: the
   * muzzle primitives lose 4.6 mm of radius (`muzzle` ra/rb, `whiskerPadR`)
   * and the coat gains it, so the animal is not fattened. Measured on the
   * sagittal canopy the muzzle silhouette moves by at most 3.4 mm, and the
   * tip is 4 mm FURTHER FORWARD than before because `nosePad` moved out as
   * it shrank. Contrast against the 26 mm skull is 3.3:1 rather than 7.6:1.
   *
   * The critic's own test, as a number: local 9x9 luminance std over the
   * muzzle at `chin`, rhinarium excluded, fraction flatter than 1.0 levels.
   * The cheek in the same frame is 0.2 %.
   *     shipped 37.9 %  ->  pad shrunk 16.9 %  ->  + this 11.8 %
   * The residue is the shell stack's own coverage boundary, which is fur's.
   */
  [R.muzzle]: [0.0080, 0.90],
  [R.jawLower]: [0.0190, 0.72],
  [R.cheek]: [0.0400, 0.28],
  [R.forehead]: [0.0175, 0.82],
  [R.skull]: [0.0260, 0.74],
  [R.earOuter]: [0.0180, 0.70],
  [R.earInner]: [0.0105, 0.44],
  [R.throat]: [0.0310, 0.28],
  [R.neck]: [0.0455, 0.58],
  [R.ruff]: [0.0580, 0.50],
  // NOT a region: the DORSAL strip of `neck` and `ruff` only, blended in by
  // FoxSurface's normal test (the cranium is excluded, so the crown band the
  // 124c41c check watches is untouched). 55a9475 measured that no value in
  // this table moves the profile topline, because shoulder and croup are
  // LATERAL regions that are barely on the profile outline, and concluded:
  // "If the coat is ever to carry the topline, the prerequisite is a dorsal
  // region split." This is that split, and it is the half of the §B-4 fix
  // that the skin cannot do: the ruff's 58 mm sits on the neck's dorsal
  // midline at z = 111 mm, 17 mm deeper than the chest's coat 25 mm behind
  // it, and it buried the withers under a coat step pointing the wrong way.
  // A real fox's ruff is the cheek-throat mane -- lateral and ventral. The
  // LATERAL ruff keeps its 58 mm; only the crest comes down.
  [R.chest]: [0.0410, 0.46],
  [R.shoulder]: [0.0395, 0.66],
  [R.back]: [0.0440, 0.86],
  [R.flank]: [0.0480, 0.62],
  // 39 mm was 81 % of the flank's 48 — a lateral-trunk depth authored on a
  // ventral surface. §4f's one sourced regional fact (Underwood & Reynolds
  // via Prestrud 1991) ranks the belly with the HEAD and the DISTAL LEGS as
  // shallowest in all seasons, and those are 17.5-26 and 12-26 mm here. It
  // also cost 43 mm of visible leg, which is most of critic blocker 10.
  // See the TRUNK_PROFILE docstring; that edit and this one are one change.
  [R.belly]: [0.0200, 0.22],
  [R.croup]: [0.0460, 0.80],
  [R.haunch]: [0.0415, 0.66],
  [R.legFrontUpper]: [0.0340, 0.58],
  [R.legFrontLower]: [0.0160, 0.68],
  /**
   * ### 22 -> 9.5 mm, and why f708e0d's reading of the source was right while
   * its number made the animal footless.
   *
   * f708e0d flipped pads 12 -> 22 mm on the Underwood & Reynolds ranking
   * (foot pads DEEPEST, distal legs SHALLOWEST) and verified it on the
   * canopy: the foot stood 26 % proud of the pastern. That measurement was
   * of the canopy's WIDTH and it was correct. What it never measured is the
   * canopy's BOTTOM, and that is where 22 mm goes:
   *
   *   `paws`, true-coverage matte, 1400x900. Each paw's own ground point is
   *   projected from the bone and the terrain height under it:
   *
   *       paw      ground y   coat bottom y   coat BELOW the snow
   *       pawL        562          641            79 px  (~48 mm)
   *       pawR        571          632            61 px
   *       footL       543          603            60 px
   *       footR       549          593            44 px
   *
   *   and the four legs stop being separate runs at y = 540 -- ABOVE every
   *   one of those ground lines -- so no leg is ever individually visible at
   *   the height where it meets the snow. The bottom of the animal is one
   *   486 px skirt.
   *
   * 22 mm of coat is 20.5 mm of shell plus roughly as much again of card
   * reach and droop, all of it below a sole that already sits ~9 mm under the
   * snow surface (Locomotion plants the METACARPAL BONE on the ground and
   * that bone rides 17.1 mm above the sole -- its own comment says 20.5 and
   * says the 22 mm audit threshold is why). So every millimetre of paw coat
   * is buried by construction, and the foot cannot be anything but a fringe
   * that ends somewhere in the snow.
   *
   * STATE THE COST PLAINLY: at 9.5 mm the pad coat is now shallower than the
   * lower leg's 14.0, which inverts the ranking f708e0d restored. The
   * defence is that the ranking describes hair on a foot standing ON snow
   * and ours stands IN it -- a depth that is entirely subterranean is not a
   * depth, it is fill cost. What the ranking actually buys the picture, a
   * foot broader than the ankle above it, is bought back in GEOMETRY in
   * `addPaw` and measured there: flare over the pastern goes 1.32 -> 1.62.
   * That is §4f's own move ("radius moves from geometry into coat") run in
   * the direction this scale demands, because a 6 mm mesher cell can hold a
   * 52 mm pad's shape and 22 mm of isotropic coat over a 9.6 mm toe cannot
   * hold anything's.
   */
  [R.pawFront]: [0.0095, 0.88],
  [R.legHindUpper]: [0.0380, 0.60],
  [R.hock]: [0.0170, 0.54],
  [R.pawHind]: [0.0095, 0.88],
  [R.tailBase]: [0.0480, 0.78],
  [R.tailMid]: [0.0540, 0.80],
  [R.tailTip]: [0.0420, 0.72],
};

/**
 * Dorsal coat depth on the neck crest — see the note inside `FUR` and the
 * TRUNK_PROFILE docstring. 43 mm sits between the back's 44 and the distal
 * regions; it is a crest, not a shaved strip.
 */
export const NECK_CREST = 0.0430;

const TINT_FUR = 0xffffff;      // neutral: base albedo lives on the material
const TINT_SKIN = 0x171a20;     // bible "skin / nose"
const TINT_PAW = 0xf0eeea;      // furred white; pad leather faces the ground

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mirrorX = (p) => [-p[0], p[1], p[2]];

/**
 * Cross-section chain for head-neck-torso-rump. Each entry is the CENTRE of
 * the cross-section (not the spine, which runs ~20 mm higher), its radius and
 * a per-axis squash. Consecutive entries are unioned as round cones, so the
 * trunk is watertight and gap-free by construction.
 *
 * Reading the resulting profile: level topline 0.256-0.269, deepest chest at
 * z = 0 (0.134 m deep), a slight belly tuck over the loin, then the neck crest
 * rising to the poll. That is a lean canid, not a tube and not a barrel.
 *
 * ## §4f — the bulk belongs in the COAT, not the body
 *
 * This table used to describe a *fat animal with a thin coat*: 80 mm of skin
 * radius at mid-torso under 48 mm of coat, so the coat carried 37 % of the
 * silhouette where a real winter fox carries ~48 %. Every symptom of that is
 * the same symptom — solid geometry reads as inert mass, and a mesh edge with
 * only 48 mm of coat behind it still shows as a hard line.
 *
 * So radius moved OUT of here and INTO `FUR` below, in equal measure. The
 * rules that constrain the edit:
 *   - the furred silhouette must not shrink (§4f.4) — every millimetre taken
 *     off a station is put back on that station's coat;
 *   - the BELLY comes up, the TOPLINE barely moves. Slimming is ventral on a
 *     real animal, and the spine bones sit ~10 mm under the topline: dropping
 *     TOP by the full 13 mm would have pushed spine03/spine04 out through the
 *     skin. TOP falls ~4 mm, BOTTOM rises ~22 mm, so the radius still drops
 *     13 mm while the section centre rises 9 mm.
 */
/**
 * ## §4f left the animal a BOX, and here is the number for it
 *
 * Measured on the field, sagittal, canopy = skin + furLength * uCoatScale
 * along the outward normal (the offline twin of fur.glsl's furCoatLength):
 *
 *     SKIN     topline 271.9  belly 117.8   chest:leg  1.31 : 1
 *     CANOPY   topline 316.3  belly  75.1   chest:leg  3.21 : 1
 *
 * The skin under this table is very nearly a fox. The COAT is what turns it
 * into a bear, and it does it twice over: 44 mm added on top and 43 mm taken
 * off the bottom, so a 118 mm leg becomes a 75 mm leg while the trunk gets
 * half as deep again. The critic read 2.9:1 off `paws.png` by pixel count,
 * which is the same finding from an instrument that shares nothing with
 * this one. §4f predicted exactly this failure mode in its own words —
 * "constant coat depth over a straight-sided trunk cannot" read as a light
 * layer over a slight core — and then shipped a constant coat depth.
 *
 * Two things change here, and both of them follow §4f's own sourced text
 * rather than fighting it:
 *
 * 1. THE BELLY COMES UP AGAIN. §4f's one properly sourced regional fact
 *    (Underwood & Reynolds via Prestrud 1991) ranks the BELLY with the head
 *    and the distal legs as shallowest in all seasons. We authored it at
 *    39 mm, 81 % of the flank's 48 — a lateral-trunk depth on a ventral
 *    surface, which contradicts the only ranking we actually have. It goes
 *    to 20 mm, next to the head's 17.5-26 and the distal leg's 12-26. See
 *    `FUR` below; that change and this one are one edit.
 *
 * 2. THE BOTTOM LINE GETS A SHAPE. It had none: the deepest point of the
 *    belly sat at z = 0, mid-torso, with the brisket 19 mm HIGHER than it.
 *    That is a sag, not a tuck-up, and it is why the critic could fit a
 *    straight line to y ~ 600-640 across the whole frame. The brisket
 *    (z = 0.050-0.086) now holds its depth and the loin lifts 17 mm behind
 *    it, which is the direction §4f already argued for ("slimming is
 *    ventral on a real animal") and drops mid-torso diameter from 134 mm to
 *    123, further under the 150 mm obese-outlier hip that §4f rule 1 cites.
 *
 * The topline gets the smaller half of the same treatment. It peaked over
 * the LOIN (z = -0.100) and dipped at the shoulder, i.e. a roach; a canid's
 * highest trunk point is the withers. The loin drops ~4 mm and the withers
 * rise ~4, which is inside the margin §4f left over the spine bones
 * (spine03 sits 11 mm under TOP at z = 0, and still does).
 *
 * ## And why the trunk cannot give the last 0.8 of chest:leg
 *
 * Re-measured with the same canopy instrument, which reproduces the two
 * landmarks above to 0.1 mm (trunk topline 318.7, belly 102.5):
 *
 *     SKIN     H 297.6   L 121.1    1.46 : 1     <- already a fox
 *     CANOPY   H 338.1   L 102.5    2.30 : 1     (2.17 : 1 if H is taken at
 *                                                 the withers, z = 100, and
 *                                                 not at the neck crest)
 *     the coat adds 40.5 mm on top and takes 18.6 mm off the bottom
 *
 * The skin is right and the rest is arithmetic that §4f closes from both
 * sides. chest:leg on the canopy is a function of the CANOPY alone, and
 * §4f.4 pins the canopy: "total silhouette stays where it is; radius moves
 * from geometry into coat". On a VENTRAL surface geometry and coat are
 * interchangeable for the silhouette, so moving radius between them cannot
 * move this ratio at all — every millimetre the belly skin rises has to come
 * back as belly coat, which puts the canopy back where it was. Only two
 * things actually move it, and both are already spoken for:
 *
 *   target   raise belly CANOPY   brisket skin depth left   or lift the whole
 *                                 (137.5 mm today)          animal by
 *   2.00:1        10.2 mm              127.3 mm              15.3 mm
 *   1.75:1        20.4 mm              117.1 mm              32.1 mm
 *   1.50:1        32.7 mm              104.8 mm              54.6 mm
 *   1.00:1        66.5 mm               71.0 mm             133.1 mm
 *
 * Column 2 shrinks the furred silhouette by exactly what it raises, with
 * nowhere sourced to put it back — §4f.1 forbids deepening the flank coat
 * and the Underwood & Reynolds ranking forbids deepening the belly's — which
 * is §4f.4 verbatim. Column 4 keeps the silhouette but takes shoulder height
 * from 278 mm to 293 / 310 / 333 / 411 mm, and 0.28 m is the single body
 * measurement every source in REFERENCE-FOX §4b agrees on.
 *
 * So: NO FURTHER FROM THE TRUNK. The 1.47:1 "floor" is reached only with
 * zero belly coat, i.e. by breaking §4f.3. And "a fox is ~1:1" is a
 * SHORT-COATED figure: a constant coat of depth c adds 2c to the canopy
 * depth and takes c off the clearance, so a 1.46:1 skin under the sourced
 * 40–60 mm flank coat cannot present below about 2:1 whatever is done to it.
 * The one honest millimetre left is not the trunk — it is the 0.13 of the
 * ratio that is RUFF, H being 338.1 at the neck crest against 324.9 at the
 * withers.
 */
/**
 * ## §B-4: the back was a ruler, and the TOP column is why
 *
 * Review 4: "ear tip y=258, then a monotonic descent to y=331 at x=608, then
 * y = 317 +- 6 across the whole 177 px from x=616 to x=793." 55a9475 then
 * measured the same contour on the BARE MESH and found no withers there
 * either -- "in every arm the highest point inside the withers window lands
 * exactly on the window's LEFT EDGE, which is what a window maximum does when
 * the curve through it is still descending" -- and closed with the routing
 * note that a region table cannot carve a withers, only this table can.
 *
 * Here is the flat curve, as the canopy this table actually produces
 * (TOP + dorsal coat x uCoatScale 0.93, the dorsal depth being what
 * FoxSurface's normal blend lands on: neck 45.5, ruff 58, chest 41,
 * flank->back 44, croup 46):
 *
 *     z (mm)    145   130   111    86    50     0   -52  -100  -142  -170
 *     BEFORE  343.3 331.8 329.3 310.1 300.1 297.9 303.4 304.9 300.8 282.3
 *     AFTER   340.5 326.0 310.0 321.1 304.1 295.0 298.0 301.0 312.8 287.8
 *
 * BEFORE is monotone from the poll to z = 0 and then flat: one 7 mm rise over
 * the loin is the whole of the back's relief, which is the ruler. AFTER has
 * the four turning points a canid profile is made of -- poll 340, cervico-
 * thoracic DIP 310, WITHERS 321, saddle 295, CROUP 313, tail drop -- with a
 * 26 mm withers-to-saddle fall and an 18 mm saddle-to-croup rise.
 *
 * TWO THINGS PAY FOR IT AND BOTH ARE NAMED:
 *
 *  1. The dip at z = 111 is 17 mm below where it was, which is §4f.4's "the
 *     furred silhouette must not shrink" broken at one station. It is broken
 *     deliberately: a dip IS a place where the silhouette has to come in, and
 *     there is nowhere else to put the poll dip the review asks for. 13 mm of
 *     the 17 is coat, not skin, and it comes from NECK_CREST -- see FUR.
 *  2. The withers rises 11 mm of skin, so shoulder height over the coat goes
 *     310 -> 321 mm against §4b's sourced 0.28 m. It was already 30 mm over;
 *     this makes it 41. The alternative was to cut the saddle by the same
 *     11 mm, and spine03 sits 12 mm under TOP at z = 0 -- so that door is
 *     3 mm wide, not 11. Clearance after this edit: spine03 9 mm, spine02
 *     11.5 mm, spine01 17 mm, hips 32.5 mm; all still inside the flesh.
 *
 * The BOTTOM column is untouched. 072e93d shaped it (brisket holds, loin
 * lifts 17 mm) and nothing here needs the belly.
 */
// z, TOP, BOTTOM, sqx, region  — silhouette-first authoring; see below.
const TRUNK_PROFILE = [
  [-0.1880, 0.2270, 0.1960, 0.90, R.croup],
  [-0.1700, 0.2450, 0.1860, 0.92, R.croup],
  [-0.1420, 0.2700, 0.1630, 0.95, R.croup],   // croup crest, over the hip
  [-0.1000, 0.2600, 0.1560, 0.95, R.flank],
  [-0.0520, 0.2570, 0.1440, 0.94, R.flank],
  [0.0000, 0.2540, 0.1330, 0.93, R.flank],    // saddle, the back's low point
  [0.0500, 0.2660, 0.1245, 0.91, R.chest],
  [0.0860, 0.2830, 0.1405, 0.89, R.chest],    // WITHERS, the trunk's high point
  [0.1110, 0.2710, 0.1650, 0.89, R.ruff],     // cervicothoracic dip
  [0.1300, 0.2860, 0.1835, 0.91, R.neck],
  [0.1450, 0.3005, 0.2005, 0.93, R.neck],
];
// (z, centre-y, radius, squash-x, region) — what the field builder consumes.
const TRUNK = TRUNK_PROFILE.map(([z, top, bot, sx, reg]) =>
  [z, (top + bot) * 0.5, (top - bot) * 0.5, sx, reg]);

// The last station was 5.0 mm, which is 0.83 of a 6 mm voxel: below the
// mesher's ~1.5-cell watertightness floor, never mind its ability to round
// anything. 9.5 mm is 1.6 cells and still tapers, and it is invisible in the
// silhouette because the tail tip carries 42 mm of coat over it.
//
// ## Does the SKIN constrict where the tail leaves the croup? Measured.
//
// Asked because the coat cannot reveal a root that is not there. Lateral
// half-width, marched along +x from the tail's own centre line (the ONLY
// honest axis here: a vertical ray at z = -272 is 49 deg off the chain, so
// it reads 37 mm where the true radius is 29.5, and that is not a taller
// cross-section, it is a longer chord):
//
//     z (mm)   -176  -182  -188  -194  -200  -206  -224  -242  -260  -296
//     skin      59.0  53.5  44.5  29.5  27.5  27.5  29.5  30.0  30.0  28.5
//     canopy   101.0  95.7  87.6  75.5  44.7  45.0  47.4  48.5  65.0  65.2
//
// Two separate answers, and they point at different owners:
//
//  1. THE CROUP STEP IS REAL AND SHARP. The skin loses 53 % of its width in
//     the 24 mm from z = -176 to -200. The SDF does not run the croup
//     smoothly into the tail, and the coat does reveal it: the canopy drops
//     87.6 -> 44.7 mm across one 6 mm station.
//  2. THE TAIL ITSELF HAS NO WAIST. Behind that step the skin is a plain
//     cylinder — 27.5 mm at the root against a 30.0 mm maximum at z = -242,
//     i.e. 9 % of swell over the whole brush. `TAIL_R` authors 26.6 / 27.8 /
//     27.4 and then only ever tapers, so there is no root-to-brush
//     narrowing for a coat to sit in.
//
// Which means the tail-base notch is 32.5 of its 35.0 mm the COAT's: root
// coat 17.2 mm against 35.0 at mid-tail. And its POSITION is not geometry
// at all — the canopy steps 48.9 -> 65.0 mm in the single station between
// z = -254 and -260, which is where `tailBase` becomes `tailMid` and where
// `uRegionA.y` goes 0.40 -> 0.73 (FurMaterial, 7df3911). So the notch sits
// 55 mm down the tail because a region boundary is there, not because the
// animal narrows there.
//
// ## The waist, added. Sweep and the ruler that chose it.
//
// The fur agent has since finished the coat side (FurMaterial REGION_TABLE
// 24-26: root coat 18 mm against mid-tail's 36) and reports that the croup's
// coat is NOT the lever — only the tail's own. So the remaining half of the
// notch is this array, and it had no waist to give: 27.7 mm at the root
// against a 30.1 mm maximum, 9 % of swell over the whole brush, with the
// minimum nowhere in particular.
//
// Same ruler as the table above, re-run on this tree (it reproduces the
// numbers above to 0.2 mm, which is what says it is the same ruler).
// Lateral half-width, mm, by root radius r0/r1 in mm:
//
//     z (mm)          -194  -200  -206  -212  -224  -242  -272  swell
//     26.6 / 27.8     29.7  27.7  27.7  28.5  29.5  30.1  29.7    9 %
//     22.0 / 27.8     26.6  23.6  24.0  25.7  28.0  30.2  29.7   26 %
//     19.5 / 25.0     25.4  21.2  21.2  22.8  25.0  27.8  29.7   40 %
//     17.0 / 24.0     24.6  19.1  19.0  20.8  23.5  27.0  29.7   56 %   <-
//     14.0 / 21.0     24.4  16.8  15.7  17.5  20.1  24.7  30.3   92 %
//
// 17.0 / 24.0 is the last row whose minimum is still a waist rather than a
// pinch: 19.0 mm of half-width is 3.2 cells at the 6 mm `high` grid (the
// mesher's watertightness floor is ~1.5) and the shipped tail08 is already
// 16.2, so it is inside ground the mesher has held before. 14.0 puts the
// root at 2.6 cells AND makes the croup-to-root drop 44.6 -> 15.7 across two
// stations, which is a step the surface nets cannot fillet.
//
// The minimum lands at z = -200..-206, which is the anatomical root — not at
// z = -254, where the canopy's step was and where a `tailBase`/`tailMid`
// region boundary still is. That is the point of doing it in the skin: the
// rise from root to brush is now carried by geometry across 70 mm instead of
// by one shader region boundary in one 6 mm station.
//
// ## HOW MUCH OF IT REACHES THE VIEWER: not much, and here is the number.
//
// Measured on `tools/matte.mjs --poses profile`, the upper contour over the
// croup-to-tail run (x 800..1080), deficiency below its own upper convex
// hull, px. Noise floor from the SAME three runs on the withers-to-croup
// band, which no arm touched: defMax 36.1 / 34.8 / 36.0, i.e. +-1.3 px.
//
//     arm (r0/r1, mm)      defMax   at x    defMean
//     26.6 / 27.8 shipped    21.6   1031      9.60
//     17.0 / 24.0 this       25.2    834     10.16
//      8.0 / 11.0 control    37.6    851     11.99
//
// So the skin is a REAL lever on the tail-root notch and a WEAK one: monotone
// with the arm, but only ~0.4 px of contour per mm of skin removed, and my
// 8.7 mm buys 3.6 px against a 1.3 px floor. It is not `occipitalTuck` — it
// moves — but anyone hoping to build the notch out of the skin should read
// the control row first: severing the root to 8 mm, which is past what the
// mesher can hold, still only trebles a 21 px feature.
//
// What DID change qualitatively is WHERE the deepest dip is. It was at
// x = 1031, mid-tail, which is e70ddc2's region boundary; it is now at
// x = 834-851, the croup/tail junction. The notch is at the root now even
// though it is barely deeper.
//
// And the animal did not shrink (4f rule 4): matte coverage 127009 -> 126907
// px total, -0.08 %, and the tail band 20472 -> 20515, +0.21 %, both inside
// the +-0.3 % the untouched head band scatters by between runs.
export const TAIL_R = [0.0170, 0.0240, 0.0274, 0.0262, 0.0246, 0.0224, 0.0196, 0.0162, 0.0126, 0.0095];


/**
 * Catmull-Rom resample of a cross-section chain.
 *
 * Chaining round cones directly leaves a slope discontinuity at every shared
 * endpoint. Blend them hard and smooth-min bulges each joint by k/4 (the
 * "string of beads" the tail had); blend them softly and each joint shows as a
 * transverse ripple (what the nape shot showed along the back). Neither is
 * fixable by tuning k — the chain itself has to be C1. Resampling 3x makes the
 * per-joint direction and taper change small enough that a modest k hides it
 * completely.
 */
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function resampleChain(pts, sub, nInterp) {
  const n = pts.length;
  const at = (i) => pts[i < 0 ? 0 : i > n - 1 ? n - 1 : i];
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      const e = [];
      for (let c = 0; c < nInterp; c++) e.push(catmullRom(p0[c], p1[c], p2[c], p3[c], t));
      for (let c = nInterp; c < p1.length; c++) e.push(t < 0.5 ? p1[c] : p2[c]);
      out.push(e);
    }
  }
  out.push(pts[n - 1].slice());
  return out;
}

/**
 * Build the complete fox-skin field.
 * Two phases: the body is assembled first, then the eye sockets are carved at
 * the *measured* skin surface (raycast from inside the skull) so the socket
 * depth and the eyeball centre are correct regardless of how the head blends.
 *
 * @returns {{field: Field, eyes: {L: object, R: object}}}
 */
export function buildField() {
  CRANIUM.refresh();
  EAR.refresh();
  const f = new Field();
  const L = LANDMARKS;

  const furOf = (region) => ({ region, furLength: FUR[region][0], furStiffness: FUR[region][1] });

  // ---------------------------------------------------------------- trunk ---
  const trunk = resampleChain(TRUNK, 2, 4);
  for (let i = 0; i < trunk.length - 1; i++) {
    const [z0, y0, r0, sx0, reg] = trunk[i];
    const [z1, y1, r1, sx1] = trunk[i + 1];
    const sx = (sx0 + sx1) * 0.5;
    // caudal tangent: hairs run nose -> tail along the body
    const dir = [0, y0 - y1, z0 - z1];
    f.add({
      name: `trunk${i}`, a: [0, y0, z0], b: [0, y1, z1], ra: r0, rb: r1,
      squash: [sx, 1, 1], k: 0.011, ...furOf(reg),
      // flowRadial was 0.18, and measured on the built mesh that put the mean
      // hair-to-normal dot at 0.09-0.19 across chest, shoulder, ruff, neck,
      // flank and back — 28 % of the whole mesh had hair lying within 3
      // degrees of the skin. A hair combed that flat adds nothing to the
      // OUTLINE however long it is, which is why the trunk kept failing the
      // silhouette-hardness gate while carrying 48 mm of coat. A winter
      // arctic fox's trunk coat is plush and stands off the body; a sleek
      // lie-flat coat is a summer animal.
      flowDir: dir, flowRadial: 0.50, tint: TINT_FUR,
    });
  }

  // --------------------------------------------------------------- throat ---
  // Fills the jaw-to-brisket hollow so the ruff has something to sit on.
  f.add({
    name: 'throat', a: [0, 0.2430, 0.1620], b: [0, 0.2060, 0.1120], ra: 0.0310, rb: 0.0465,
    squash: [0.92, 0.92, 1], k: 0.016, ...furOf(R.throat),
    flowDir: [0, -0.55, -0.55], flowRadial: 0.60, tint: TINT_FUR,
  });
  // Prosternum — the chest points forward between the shoulders.
  f.add({
    name: 'prosternum', a: [0, 0.1870, 0.1010], ra: 0.0425,
    squash: [0.80, 0.94, 0.78], k: 0.021, ...furOf(R.chest),
    flowDir: [0, -0.35, -0.90], flowRadial: 0.35, tint: TINT_FUR,
  });

  // ----------------------------------------------------------------- head ---
  // Authored around SKULL_REF, mapped by skullXf()/sr() — see the block at the
  // top of this file for why the head moves as a unit.
  const H = skullXf;
  f.add({
    name: 'braincase', a: CRANIUM.braincase.c, ra: CRANIUM.braincase.r,
    squash: CRANIUM.braincase.s, k: 0.026, ...furOf(R.skull),
    flowDir: [0, 0.16, -1], flowRadial: 0.22, tint: TINT_FUR,
  });
  f.add({
    name: 'occiput', a: CRANIUM.occiput.c, ra: CRANIUM.occiput.r,
    squash: CRANIUM.occiput.s, k: 0.026, ...furOf(R.skull),
    flowDir: [0, 0.10, -1], flowRadial: 0.25, tint: TINT_FUR,
  });
  // Domed forehead with a gentle stop — arctic fox, not red fox.
  const foreheadC = H([0, 0.3175, 0.2145]);
  foreheadC[1] += STOP.frontalLift;
  f.add({
    name: 'forehead', a: foreheadC, ra: sr(0.0210),
    squash: [0.90, 0.84, 0.94], k: 0.024, ...furOf(R.forehead),
    flowDir: [0, 0.22, -1], flowRadial: 0.20, tint: TINT_FUR,
  });
  f.addMirrored({
    // ra is 10.9 mm world = 1.8 voxels, so the brow itself cannot be rounded
    // by the mesher; only its FILLET can be, and k is that fillet's radius.
    // §4d wants the supraorbital ridge "subtle and rounded, never a ledge",
    // which points the same way as the sampling does.
    name: 'brow', a: H([0.0252, 0.3318, 0.2160]), ra: sr(0.0092),
    squash: [0.90, 0.74, 0.96], k: 0.021, ...furOf(R.forehead),
    flowDir: [0.15, 0.20, -1], flowRadial: 0.25, tint: TINT_FUR,
  });
  // Short and BLUNT: 2:1 taper read as a point once fur was on it, so the
  // muzzle now barely narrows and stops well short of the old nose position.
  // `a` is ROSTRUM.pivot lowered by STOP.nasalDrop in WORLD metres, applied
  // after skullXf so the knob is not silently scaled by SKULL_SCALE, and to
  // the primitive only so `rostral()` keeps its pivot and the rostrum keeps
  // its settled length.
  const muzzleA = H(ROSTRUM.pivot);
  muzzleA[1] -= STOP.nasalDrop;
  f.add({
    name: 'muzzle', a: muzzleA, b: H(rostral([0, 0.2952, 0.2380])),
    ra: sr(0.0225), rb: sr(0.0131),
    squash: [1.0, 0.92, 1.0], k: STOP.blend, ...furOf(R.muzzle),
    flowDir: [0, 0.05, -1], flowRadial: 0.34, tint: TINT_FUR,
  });
  /**
   * ## The distal half of the rostrum was a smin FILLET, not geometry
   *
   * Measured on the sagittal midline at `stretch = 1`: the muzzle cone and
   * the mandible both end at z = 221 mm and the nose pad sits at z = 245, so
   * everything from u = 0.33 of the rostrum forward was a 24 mm smooth-min
   * bridge between a cone tip and a 21 mm sphere. Widths at fixed fractions
   * of the rostrum, with only the layout stretched:
   *
   *     u =        0    .15    .30    .45    .60    .75    .90
   *     s = 1.0  95.0   87.5   76.2   59.0   34.8   25.7   20.7
   *     s = 1.6  94.9   82.8   62.9   38.5   19.5    3.7   21.0   <- necked
   *
   * A fillet's scale is `k`, which is absolute, so stretching the layout
   * pulls the bridge apart while the proximal cone (which does preserve its
   * widths at fixed fractions, being a true cone) holds. At s = 1.6 the
   * rostrum necks to 3.7 mm and the pad becomes a knob on a thread; Fox.js's
   * nose-anchor raycast lands on the thread and the anchor z collapses
   * 276 -> 251.
   *
   * So the rostrum gets an actual shaft. `ra` is the muzzle's own `rb`, so
   * the two cones are continuous and no width changes at s = 1; §4g's
   * length change stays a length change.
   */
  f.add({
    name: 'nasal', a: H(rostral([0, 0.2952, 0.2380])), b: H(rostral([0, 0.29138, 0.2520])),
    ra: sr(0.0110), rb: sr(0.0072),
    squash: [1.0, 0.92, 1.0], k: 0.0095, ...furOf(R.muzzle),
    flowDir: [0, 0.02, -1], flowRadial: 0.34, tint: TINT_FUR,
  });
  /**
   * ## The nose pad was a 31 mm bare disc standing in for a 13 mm rhinarium
   *
   * `ra` was sr(0.0130) = 15.3 mm, i.e. 30.7 mm across in x and 23.9 mm in z,
   * carrying `R.nose` fur at 0.6 mm and TINT_SKIN. FaceDetail's own comment
   * already says so from the other side -- "the anatomy agent's nose region
   * is considerably wider than the rhinarium it represents" -- and it clamps
   * its drawn pad to 10-14.2 mm to survive it. Nothing clamped the SDF, so
   * the field kept a bare, skin-tinted dome three times the area of the nose
   * across the front of the muzzle. At `chin` that is ~600 px of untextured
   * plane and it is the single worst frame in the review set.
   *
   * Measured at `chin`, fraction of the muzzle core that changes when the
   * skin is hidden (the covered control, cheek, reads 11 %):
   *
   *     nose fur 0.6 mm  86.6 %      <- shipped
   *     nose fur  15 mm  62.3 %      <- length alone, pad unchanged
   *
   * So the pad itself had to go. sr(0.0090) = 10.6 mm is 1.77 mesher cells at
   * the 6 mm `high` grid -- the same sampling the ear apex was rebuilt to in
   * 13b46b6, which is the floor for anything that has to round over -- and
   * the centre moves forward so the apex lands 6 mm further out instead of
   * shorter. §4c: "The nose pad sits at a defined apex, not on a blunt dome."
   * k rises 6 -> 9 mm because a smaller primitive needs a wider fillet to
   * reach the muzzle cone behind it without a step.
   */
  f.add({
    name: 'nosePad', a: H(rostral([0, 0.2930, 0.2585])), ra: sr(0.0090),
    squash: [1.0, 0.86, 0.78], k: 0.009, ...furOf(R.nose),
    flowDir: [0, -0.2, -1], flowRadial: 0.35, tint: TINT_SKIN,
  });
  f.add({
    name: 'mandible', a: H(rostral([0, 0.2925, 0.2205])), b: H(rostral([0, 0.2895, 0.2385])),
    ra: sr(0.0178), rb: sr(0.0110),
    squash: [0.95, 0.86, 1.0], k: 0.021, ...furOf(R.jawLower),
    flowDir: [0, -0.30, -1], flowRadial: 0.35, tint: TINT_FUR,
  });
  // Whisker pads — the paired swellings at the muzzle root. Small, but they
  // are most of what stops a canid muzzle reading as a plain cone.
  //
  // Shrunk 15.6 -> 12.3 mm and moved 3 mm forward. At the old size it was the
  // nearest primitive over most of the JAW LINE, and it carries `muzzle` fur,
  // so it dragged the coat there down to 14.8 mm where the cheek authors 38.
  // The user's 3x crop of that exact band shows the result: a stair-stepped
  // skin edge with ruff fur visible beyond it. §4f.2 keeps the muzzle short —
  // it does not ask for the jaw to be short too.
  f.addMirrored({
    name: 'whiskerPadR', a: H(rostral([0.0158, 0.2948, 0.2288])), ra: sr(0.0080),
    squash: [0.88, 0.84, 1.05], k: 0.015, ...furOf(R.muzzle),
    flowDir: [0.18, -0.25, -0.95], flowRadial: 0.35, tint: TINT_FUR,
  });
  f.addMirrored({
    name: 'cheek', a: H([0.0228, 0.2990, 0.2120]), b: H([0.0246, 0.2958, 0.1940]),
    ra: sr(0.0208), rb: sr(0.0206),
    squash: [0.87, 0.90, 1.02], k: 0.028, ...furOf(R.cheek),
    flowDir: [0.55, -0.25, -0.55], flowRadial: 0.90, tint: TINT_FUR,
  });
  // The stop. See STOP for the measurement that says why it is a carve and
  // not a reshaping of the two primitives that meet here.
  if (STOP.notch.on) {
    const n = STOP.notch, p = H(ROSTRUM.pivot);
    f.add({
      name: 'nasion', a: [0, n.floor + n.r, p[2] + n.dz], ra: n.r,
      squash: [n.wide, 1.0, n.deep], k: n.k, op: 'subtract', ...furOf(R.forehead),
      flowDir: [0, 0.22, -1], flowRadial: 0.20, tint: TINT_FUR,
    });
  }

  // ------------------------------------------------------------------ ears ---
  // §4b: small, WIDE APART and LOW on the skull, thickly furred. §4c corrects
  // "semicircular paddle" to ROUNDED TRIANGLE — clearly wider at the base,
  // tapering to a soft point, judged by VISIBLE SILHOUETTE height rather than
  // height above the dome. Most of the pinna's length is buried inside the
  // cranium, which is what anchors it.
  //
  // ## Why the pinna is a CHAIN and not one cone
  //
  // One round cone has three properties the render shows as defects, and all
  // three are properties of the primitive rather than of the mesher:
  //
  //   - its silhouette sides are DEAD STRAIGHT by construction. Measured at
  //     `frontal` the pinna's outer edge was a 45 mm straight line. A real
  //     pinna's edges are convex; `EAR.power > 1` bulges the profile off the
  //     chord, which is the whole difference between a triangle and a wedge.
  //   - its apex is the end sphere, radius 8.5 mm = 1.4 voxels at the 6 mm
  //     `high` cell. Surface Nets cannot describe a curve at 1.4 cells, so it
  //     returned a straight chamfer. §4c predicted exactly this ("a sharper
  //     apex on a thin pinna has sub-cell rim curvature") and prescribed the
  //     fix: thicken the pinna. The apex radius is now 11 mm and the apex
  //     cross-section is near-circular (thickness squash rises to 0.98 at the
  //     tip), so the rim rolls over 3.7 cells instead of 1.4.
  //   - one cone has one squash, so thinning the tip in width thins it in
  //     THICKNESS by the same ratio. Measured: 10 mm through the pinna near
  //     the apex, against the mesher's own ~1.5-cell (9 mm) watertightness
  //     floor. The chain lets thickness and width taper at different rates,
  //     which is also what a real ear does — the rim rolls thicker as the
  //     blade narrows.
  //
  // The chain is collinear and its radii match at every joint, so the only
  // discontinuity is in taper RATE, and `k` here has to be SMALL. Every smin
  // inflates the union by up to k/4, and a chain pays that at every joint: at
  // k = 8 mm the 5-segment pinna measured 26.0 mm half-width where 22.8 was
  // authored, i.e. the blending alone had fattened the ear by 14 %. 8 shorter
  // segments cut the per-joint slope change to ~3 degrees, which 3 mm hides.
  for (let i = 0; i < EAR.segs; i++) {
    const u0 = EAR.uEnd * i / EAR.segs, u1 = EAR.uEnd * (i + 1) / EAR.segs;
    const p0 = EAR.at(u0), p1 = EAR.at(u1);
    f.addMirrored({
      name: `earR${i}`, a: p0, b: p1, ra: EAR.rAt(u0), rb: EAR.rAt(u1),
      frame: 'axis', normal: EAR_NORMAL,
      squash: [EAR.thickAt((u0 + u1) * 0.5), EAR.wide, 1.0],
      // The root segment has to melt into the cranium; the rest only has to
      // hide its own taper joints, and a large k there erodes the profile.
      k: i === 0 ? 0.014 : 0.003,
      ...furOf(R.earOuter),
      flowDir: sub(p1, p0), flowRadial: 0.30, tint: TINT_FUR,
    });
  }

  // ------------------------------------------------------------ concha bowl --
  //
  // ## The concha's torn light/dark boundary is NOT this surface. Measured.
  //
  // 245e47c ruled out, by render, the rim lift, the vertex positions, the
  // fitted outline, the uv, the normals, the shell's own shadow term, both
  // alpha falloffs and backface culling, and handed on one live candidate:
  // "shadow-map acne on a thin marching-cubes plate, which is anatomy's
  // surface." It is not. At `nape`, over a 180 x 180 px box that is solid
  // ear, mean |difference| against the base frame out of 255 levels, with
  // the fraction of pixels moving more than 4 levels:
  //
  //     shadow casting OFF   0.73   2.5 %     <- the handed-down candidate
  //     aFurAO zeroed        0.02   0.0 %
  //     SKIN hidden          0.74   2.5 %     <- this surface, entirely
  //     fur CARDS hidden     4.89  29.5 %
  //     fur SHELLS hidden    9.59  59.5 %
  //
  // Killing every shadow the scene casts moves the ear by three quarters of
  // one level, and hiding the marching-cubes plate outright moves it by the
  // same amount, because at this framing the pinna is 90 % shell. Whatever
  // the patches are, they are drawn by the shell stack. (The same holds on
  // the face: with the shells hidden at `chin` the skin renders as one
  // smooth unbroken surface with no patches on it at all.)
  //
  // Also worth someone's time: `aFurAO` moved the ear by 0.02 levels. The
  // coat-occlusion bake is currently a no-op there.
  // The old bowl was a sphere 18.7 mm wide carved into a pinna 16 mm wide, so
  // it did not cut a bowl — it PLANED THE WHOLE FRONT FACE OFF. That is the
  // "flat blue-grey plate with no interior form" in the user's frontal crop,
  // and it is why the fur agent's coat-occlusion bake found nothing to darken
  // there: a flat face has no cavity term, so it can never catch a shadow. A
  // bowl needs to be NARROWER than the blade it sits in, at every height, or
  // there is no rim and therefore no bowl.
  //
  // Depth is set by how far the carve axis is offset along EAR_NORMAL, since
  // floor = offset - halfThickness; `bowlFloor0/1` author the floor directly
  // and it is deepest at the root, which is where a canid concha actually is.
  //
  // k = 9 mm, not a crisper 3 or even 6: measured against the SDF's own
  // curvature, the first cut of this bowl at k = 6 made `earInner` the most
  // under-sampled region on the whole animal (5th-percentile radius 0.92 of a
  // voxel, 67 % of its vertices under 3). A fillet's radius IS its k, so k has
  // to clear the cell -- 1.5 cells here -- and the rim has to be wide enough
  // that the fillet does not eat it, hence 12 mm. Measured after the first
  // cut: the rim crest stands 8.5 mm proud of the bowl floor at mid-pinna and
  // 9.9 mm at the root, against 0.0 mm before, so the bowl is now a bowl.
  {
    const station = (u) => {
      const rc = EAR.bowlHalfWidthAt(u) / EAR.bowlWide;
      const floor = EAR.bowlFloor0 + (EAR.bowlFloor1 - EAR.bowlFloor0) *
        (u - EAR.bowlU0) / (EAR.bowlU1 - EAR.bowlU0);
      const off = floor + EAR.bowlThick * rc;
      const p = EAR.at(u);
      return { rc, p: [
        p[0] + EAR.n[0] * off, p[1] + EAR.n[1] * off, p[2] + EAR.n[2] * off,
      ] };
    };
    const s0 = station(EAR.bowlU0), s1 = station(EAR.bowlU1);
    f.addMirrored({
      name: 'conchaR', a: s0.p, b: s1.p, ra: s0.rc, rb: s1.rc,
      frame: 'axis', normal: EAR_NORMAL,
      // 0.42 along the axis keeps the end caps short: a full-length cap on a
      // 20 mm radius would reach 20 mm below the bowl and eat the ear root.
      squash: [EAR.bowlThick, EAR.bowlWide, 0.42],
      k: EAR.bowlK, op: 'subtract', ...furOf(R.earInner),
      flowDir: sub(EAR.at(1), EAR.at(0)), flowRadial: 0.20, tint: TINT_FUR,
    });
  }

  // -------------------------------------------------------------- forelimb ---
  // Scapula reads as a flat, fore-aft elongated bulge lying on the ribs.
  f.addMirrored({
    name: 'scapulaR', a: [0.0428, 0.2288, 0.0612], b: [0.0478, 0.1852, 0.0836],
    ra: 0.0232, rb: 0.0256, squash: [0.64, 1.0, 1.26], k: 0.016, ...furOf(R.shoulder),
    flowDir: [0.10, -0.45, -0.90], flowRadial: 0.25, tint: TINT_FUR,
  });
  f.addMirrored({
    name: 'humerusR', a: [0.0478, 0.1850, 0.0830], b: [0.0492, 0.1355, 0.0355],
    ra: 0.0252, rb: 0.0190, squash: [0.88, 1.0, 1.0], k: 0.013, ...furOf(R.legFrontUpper),
    flowDir: [0, -1, -0.10], flowRadial: 0.35, tint: TINT_FUR,
  });
  f.addMirrored({
    name: 'radiusR', a: [0.0492, 0.1340, 0.0345], b: [0.0475, 0.0620, 0.0545],
    ra: 0.0198, rb: 0.0150, squash: [0.92, 1.0, 1.0], k: 0.010, ...furOf(R.legFrontLower),
    flowDir: [0, -1, 0.05], flowRadial: 0.40, tint: TINT_FUR,
  });
  f.addMirrored({
    name: 'carpusR', a: [0.0474, 0.0605, 0.0552], b: [0.0458, 0.0250, 0.0730],
    ra: 0.0156, rb: 0.0178, squash: [1.0, 1.0, 0.92], k: 0.012, ...furOf(R.legFrontLower),
    flowDir: [0, -1, 0.12], flowRadial: 0.40, tint: TINT_FUR,
  });
  addPaw(f, furOf, 0.0455, 0.0722, +1, R.pawFront, 0.0232, 0.0250);

  // -------------------------------------------------------------- hindlimb ---
  // Haunch mass first: it is the widest point of the animal from behind.
  f.addMirrored({
    name: 'haunchR', a: [0.0400, 0.2060, -0.1360], b: [0.0468, 0.1560, -0.0900],
    ra: 0.0492, rb: 0.0300, squash: [0.62, 1.00, 1.06], k: 0.018, ...furOf(R.haunch),
    flowDir: [0.10, -0.75, -0.55], flowRadial: 0.30, tint: TINT_FUR,
  });
  // Tibia + gastrocnemius: thick at the stifle, thin at the hock.
  f.addMirrored({
    name: 'tibiaR', a: [0.0465, 0.1580, -0.0880], b: [0.0461, 0.0940, -0.1735],
    ra: 0.0312, rb: 0.0118, squash: [0.80, 1.0, 1.0], k: 0.013, ...furOf(R.legHindUpper),
    flowDir: [0, -1, -0.30], flowRadial: 0.35, tint: TINT_FUR,
  });
  // Long metatarsus — the "backwards knee" is the hock joint at its top.
  f.addMirrored({
    name: 'metatarsusR', a: [0.0461, 0.0900, -0.1755], b: [0.0452, 0.0255, -0.1315],
    ra: 0.0140, rb: 0.0164, squash: [0.88, 1.0, 1.0], k: 0.012, ...furOf(R.hock),
    flowDir: [0, -1, 0.35], flowRadial: 0.40, tint: TINT_FUR,
  });
  // Calcaneal tuber: the heel bone projects caudally as the Achilles lever and
  // is what makes a hock read on a live canid. Without it the joint is just a
  // bend in a tube and the fur fills it in.
  f.addMirrored({
    name: 'calcaneusR', a: [0.0461, 0.0935, -0.1735], b: [0.0461, 0.0975, -0.1885],
    ra: 0.0125, rb: 0.0092, squash: [0.84, 1.0, 1.0], k: 0.010, ...furOf(R.hock),
    flowDir: [0, -0.55, -0.84], flowRadial: 0.45, tint: TINT_FUR,
  });

  addPaw(f, furOf, 0.0450, -0.1300, +1, R.pawHind, 0.0216, 0.0230);

  // ------------------------------------------------------------------ tail ---
  const tailKeys = ['tail01', 'tail02', 'tail03', 'tail04', 'tail05',
    'tail06', 'tail07', 'tail08', 'tail09', 'tail_tip'];
  const tailPts = tailKeys.map((k2, i) => {
    const q = L[k2];
    return [q[0], q[1], q[2], TAIL_R[i], i < 2 ? R.tailBase : i < 7 ? R.tailMid : R.tailTip];
  });
  const tail = resampleChain(tailPts, 2, 4);
  for (let i = 0; i < tail.length - 1; i++) {
    const a = [tail[i][0], tail[i][1], tail[i][2]];
    const b = [tail[i + 1][0], tail[i + 1][1], tail[i + 1][2]];
    f.add({
      name: `tail${i}`, a, b, ra: tail[i][3], rb: tail[i + 1][3],
      k: i === 0 ? 0.014 : 0.0085, ...furOf(tail[i][4]),
      // radially outward is the signature bottle-brush look
      flowDir: sub(b, a), flowRadial: 1.05, tint: TINT_FUR,
    });
  }

  f.compile();

  // ------------------------------------------------- eye sockets (phase 2) ---
  const eyes = {};
  const SOCKET_R = EYE.socketR, SOCKET_K = EYE.socketK;
  for (const side of ['R', 'L']) {
    const seed = side === 'R' ? EYE.seed : mirrorX(EYE.seed);
    const lk = side === 'R' ? EYE.look : mirrorX(EYE.look);
    const ll = Math.hypot(lk[0], lk[1], lk[2]);
    const n = [lk[0] / ll, lk[1] / ll, lk[2] / ll];

    const t0 = f.raycast(seed[0], seed[1], seed[2], n[0], n[1], n[2], 0.08);
    const uncarved = t0 > 0 ? t0 : 0.030;

    // Only the inner cap of the sphere bites, so this is a shallow wide
    // depression, not a crater. The k/4 that smooth-subtract eats is folded in.
    const off = SOCKET_R - EYE.socketDepth + SOCKET_K * 0.25;
    const hit = [seed[0] + n[0] * uncarved, seed[1] + n[1] * uncarved, seed[2] + n[2] * uncarved];
    const c = [hit[0] + n[0] * off, hit[1] + n[1] * off, hit[2] + n[2] * off];

    // The fissure axis: perpendicular to the optical axis and to world up,
    // signed so it points TEMPORALLY (out to the side of the head) on both
    // sides. See EYE.socketSlot for why the carve is a slot along it.
    const tl = Math.hypot(n[2], n[0]) || 1;
    const sgn = side === 'R' ? 1 : -1;
    const tang = [sgn * n[2] / tl, 0, -sgn * n[0] / tl];
    const sN = 2 * EYE.socketSlot * EYE.socketNasalBias;
    const sT = 2 * EYE.socketSlot * (1 - EYE.socketNasalBias);
    f.add({
      name: `socket${side}`,
      a: [c[0] - tang[0] * sN, c[1] - tang[1] * sN, c[2] - tang[2] * sN],
      b: [c[0] + tang[0] * sT, c[1] + tang[1] * sT, c[2] + tang[2] * sT],
      ra: SOCKET_R, squash: [1.0, 0.88, 1.0], k: SOCKET_K, op: 'subtract',
      region: R.forehead, furLength: FUR[R.forehead][0], furStiffness: 0.5,
      flowDir: [0, 0.2, -1], flowRadial: 0.2, tint: 0x2a2a30,
    });
    eyes[side] = { seed, look: n, normal: n, uncarvedT: uncarved };
  }
  f.compile();

  // Seat the eyeball against the carved socket floor.
  for (const side of ['R', 'L']) {
    const e = eyes[side];
    const { seed, look: n } = e;
    const t2 = f.raycast(seed[0], seed[1], seed[2], n[0], n[1], n[2], 0.08);
    const out = t2 > 0 ? t2 : e.uncarvedT;
    e.surface = [seed[0] + n[0] * out, seed[1] + n[1] * out, seed[2] + n[2] * out];
    e.socketDepth = e.uncarvedT - out;
    const back = EYE.ballRadius - EYE.cornealProud;
    e.centre = [
      e.surface[0] - n[0] * back,
      e.surface[1] - n[1] * back,
      e.surface[2] - n[2] * back,
    ];
    e.cornealProud = EYE.cornealProud;
  }

  return { field: f, eyes };
}

/**
 * A broad snowshoe paw: one metacarpal/metatarsal pad plus four toe lobes
 * unioned with a small blend radius so the toes read as separate masses
 * without ever thinning the mesh below the grid resolution.
 *
 * @param sgn   +1 toes point +Z
 * @param zBack z of the back of the pad
 */
function addPaw(f, furOf, x, zBack, sgn, region, padR, toeSpread) {
  const fur = furOf(region);
  const flow = { flowDir: [0, -0.35, sgn * 1.0], flowRadial: 0.30 };
  const padLen = 0.0152;
  // The underside is a PLANE, and every part of the foot shares it. It used
  // to be 3.4 mm, which was below the carpus end-cap's own lowest point
  // (0.0250 - 0.0178 = 7.2 mm), so the round ankle cap -- not the pad --
  // was the bottom of the foot on its caudal half and there was no sole to
  // read. SOLE_Y is that cap's height, so the pad and the toes now form the
  // whole of the ground-facing surface and it is flat.
  //
  // Raising it also recovers 3.8 mm of the 9.2 mm by which the skin foot
  // sits UNDER the snow at `paws` (bone 7.9 mm proud of the terrain, sole
  // 17.1 mm below the bone). The remaining 5.4 mm is Locomotion's stance
  // target and is reported, not worked around: moving the `pawR`/`footR`
  // landmarks down to the sole would fix it at the cost of re-baselining 76
  // bone-space audit checks, and those belong to another owner.
  const SOLE_Y = 0.0072;
  const padSqY = 0.50;
  const padY = SOLE_Y + padR * padSqY;

  f.addMirrored({
    name: `pad${region}`, a: [x, padY, zBack], b: [x, padY, zBack + sgn * padLen],
    ra: padR, rb: padR * 1.04, squash: [1.12, padSqY, 1.02], k: 0.013,
    ...fur, ...flow, tint: TINT_PAW,
  });

  // four toes: outer pair shorter and splayed, inner pair longer.
  //
  // k 8.0 -> 13.0 mm. A 9.6 mm toe radius is 1.6 voxels at the 6 mm `high`
  // cell and the pads are 1.2, so measured against the SDF's own curvature
  // the paw was the second most under-sampled thing on the animal after the
  // ear (53-59 % of paw vertices on a feature under 3 cells). Surface Nets
  // cannot round a 1.6-cell sphere, so four faceted sausages is the best it
  // could do. Blending them into one soft mass with dimples is both what the
  // mesh can represent and what §4b describes -- a winter fox's foot is a
  // furred mitten, not four visible digits.
  const offs = [-1.85, -0.62, 0.62, 1.85];
  const lens = [0.0230, 0.0300, 0.0300, 0.0230];
  const splay = [-0.0078, -0.0022, 0.0022, 0.0078];
  const toeSqY = 0.66;
  for (let i = 0; i < 4; i++) {
    const r0 = 0.0112, r1 = 0.0096;
    const x0 = x + offs[i] * toeSpread * 0.5;
    const z0 = zBack + sgn * (padLen + 0.0012);
    f.addMirrored({
      name: `toe${region}_${i}`,
      a: [x0, SOLE_Y + r0 * toeSqY, z0],
      b: [x0 + splay[i], SOLE_Y + r1 * toeSqY, z0 + sgn * lens[i]],
      ra: r0, rb: r1, squash: [1.0, toeSqY, 1.0], k: 0.0130,
      ...fur, ...flow, tint: TINT_FUR,
    });
  }
}

/** Bounding box of the skin, for sanity checks and the mesher domain. */
export function anatomyExtents(field) {
  return field.bounds;
}
