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
 * Eyeball placement (RIGHT eye; mirrored for the left).
 *
 * `centre` is the eyeball centre and `look` the optical axis. Both are
 * authored, NOT derived from the field gradient: at the eye the nearest skin
 * is laterally outward, so a gradient-derived normal would aim the socket out
 * of the side of the skull instead of forward. A canid's eyes face forward
 * with roughly 35 degrees of divergence, which is what `look` encodes.
 *
 * Inter-pupil distance here is 45.6 mm — an arctic fox's eyes really are that
 * close together; the impression of width comes from the cheek ruff, not the
 * skull.
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
};

/** The ear pinna plane normal — the direction the concha faces (right ear). */
export const EAR_NORMAL = [0.7000, 0.0850, 0.7090];

/** World-space y of the pinna base and tip, for the ear coat taper. */
export const EAR_SPAN = { baseY: LANDMARKS.earR01[1], tipY: LANDMARKS.earR_tip[1] };

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
export const FUR = {
  [R.nose]: [0.0006, 1.00],
  [R.muzzle]: [0.0030, 0.90],
  [R.jawLower]: [0.0048, 0.72],
  [R.cheek]: [0.0320, 0.28],
  [R.forehead]: [0.0038, 0.82],
  [R.skull]: [0.0075, 0.74],
  [R.earOuter]: [0.0110, 0.70],
  [R.earInner]: [0.0100, 0.44],
  [R.throat]: [0.0300, 0.28],
  [R.neck]: [0.0455, 0.58],
  [R.ruff]: [0.0580, 0.50],
  [R.chest]: [0.0405, 0.46],
  [R.shoulder]: [0.0385, 0.66],
  [R.back]: [0.0425, 0.86],
  [R.flank]: [0.0480, 0.62],
  [R.belly]: [0.0490, 0.22],
  [R.croup]: [0.0450, 0.80],
  [R.haunch]: [0.0410, 0.66],
  [R.legFrontUpper]: [0.0340, 0.58],
  [R.legFrontLower]: [0.0145, 0.66],
  [R.pawFront]: [0.0038, 0.86],
  [R.legHindUpper]: [0.0380, 0.60],
  [R.hock]: [0.0120, 0.52],
  [R.pawHind]: [0.0038, 0.86],
  [R.tailBase]: [0.0480, 0.78],
  [R.tailMid]: [0.0540, 0.80],
  [R.tailTip]: [0.0420, 0.72],
};

const TINT_FUR = 0xffffff;      // neutral: base albedo lives on the material
const TINT_SKIN = 0x171a20;     // bible "skin / nose"
const TINT_PAW = 0xf0eeea;      // furred white; pad leather faces the ground

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mirrorX = (p) => [-p[0], p[1], p[2]];

/**
 * Cross-section chain for head-neck-torso-rump. Each entry is the CENTRE of
 * the cross-section (not the spine, which runs ~20 mm higher), its radius and
 * a per-axis squash. Consecutive entries are unioned as round cones, so the
 * trunk is watertight and gap-free by construction.
 *
 * Reading the resulting profile: level topline 0.264-0.269, deepest chest at
 * z = 0 (0.145 m deep), a slight belly tuck over the loin, then the neck crest
 * rising to the poll. That is a stocky canid, not a tube.
 */
// z, TOP, BOTTOM, sqx, region  — silhouette-first authoring; see below.
const TRUNK_PROFILE = [
  [-0.1880, 0.2270, 0.1930, 0.90, R.croup],
  [-0.1700, 0.2420, 0.1740, 0.92, R.croup],
  [-0.1420, 0.2620, 0.1340, 0.95, R.croup],
  [-0.1000, 0.2720, 0.1170, 0.95, R.flank],
  [-0.0520, 0.2690, 0.1050, 0.94, R.flank],
  [0.0000, 0.2600, 0.0995, 0.93, R.flank],
  [0.0500, 0.2605, 0.1020, 0.91, R.chest],
  [0.0860, 0.2720, 0.1210, 0.89, R.chest],
  [0.1110, 0.2790, 0.1510, 0.89, R.ruff],
  [0.1300, 0.2930, 0.1730, 0.91, R.neck],
  [0.1450, 0.3035, 0.1925, 0.93, R.neck],
];
// (z, centre-y, radius, squash-x, region) — what the field builder consumes.
const TRUNK = TRUNK_PROFILE.map(([z, top, bot, sx, reg]) =>
  [z, (top + bot) * 0.5, (top - bot) * 0.5, sx, reg]);

const TAIL_R = [0.0266, 0.0278, 0.0274, 0.0262, 0.0246, 0.0224, 0.0196, 0.0160, 0.0118, 0.0050];


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
      flowDir: dir, flowRadial: 0.18, tint: TINT_FUR,
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
    name: 'prosternum', a: [0, 0.1730, 0.1010], ra: 0.0525,
    squash: [0.80, 0.94, 0.78], k: 0.021, ...furOf(R.chest),
    flowDir: [0, -0.35, -0.90], flowRadial: 0.35, tint: TINT_FUR,
  });

  // ----------------------------------------------------------------- head ---
  // Authored around SKULL_REF, mapped by skullXf()/sr() — see the block at the
  // top of this file for why the head moves as a unit.
  const H = skullXf;
  f.add({
    name: 'braincase', a: H([0, 0.3140, 0.1985]), ra: sr(0.0412),
    squash: [0.780, 0.880, 0.96], k: 0.017, ...furOf(R.skull),
    flowDir: [0, 0.16, -1], flowRadial: 0.22, tint: TINT_FUR,
  });
  f.add({
    name: 'occiput', a: H([0, 0.3040, 0.1790]), ra: sr(0.0378),
    squash: [0.780, 0.880, 0.78], k: 0.018, ...furOf(R.skull),
    flowDir: [0, 0.10, -1], flowRadial: 0.25, tint: TINT_FUR,
  });
  // Domed forehead with a gentle stop — arctic fox, not red fox.
  f.add({
    name: 'forehead', a: H([0, 0.3175, 0.2145]), ra: sr(0.0288),
    squash: [0.90, 0.84, 0.94], k: 0.017, ...furOf(R.forehead),
    flowDir: [0, 0.22, -1], flowRadial: 0.20, tint: TINT_FUR,
  });
  f.addMirrored({
    name: 'brow', a: H([0.0252, 0.3318, 0.2160]), ra: sr(0.0118),
    squash: [0.90, 0.74, 0.96], k: 0.016, ...furOf(R.forehead),
    flowDir: [0.15, 0.20, -1], flowRadial: 0.25, tint: TINT_FUR,
  });
  // Short and BLUNT: 2:1 taper read as a point once fur was on it, so the
  // muzzle now barely narrows and stops well short of the old nose position.
  f.add({
    name: 'muzzle', a: H([0, 0.3020, 0.2255]), b: H([0, 0.2952, 0.2380]),
    ra: sr(0.0264), rb: sr(0.0170),
    squash: [1.0, 0.92, 1.0], k: 0.018, ...furOf(R.muzzle),
    flowDir: [0, 0.05, -1], flowRadial: 0.34, tint: TINT_FUR,
  });
  f.add({
    name: 'nosePad', a: H([0, 0.2930, 0.2510]), ra: sr(0.0130),
    squash: [1.0, 0.86, 0.78], k: 0.006, ...furOf(R.nose),
    flowDir: [0, -0.2, -1], flowRadial: 0.35, tint: TINT_SKIN,
  });
  f.add({
    name: 'mandible', a: H([0, 0.2925, 0.2205]), b: H([0, 0.2895, 0.2385]),
    ra: sr(0.0212), rb: sr(0.0126),
    squash: [0.95, 0.86, 1.0], k: 0.016, ...furOf(R.jawLower),
    flowDir: [0, -0.30, -1], flowRadial: 0.35, tint: TINT_FUR,
  });
  // Whisker pads — the paired swellings at the muzzle root. Small, but they
  // are most of what stops a canid muzzle reading as a plain cone.
  f.addMirrored({
    name: 'whiskerPadR', a: H([0.0160, 0.2950, 0.2258]), ra: sr(0.0132),
    squash: [0.88, 0.84, 1.05], k: 0.015, ...furOf(R.muzzle),
    flowDir: [0.18, -0.25, -0.95], flowRadial: 0.35, tint: TINT_FUR,
  });
  f.addMirrored({
    name: 'cheek', a: H([0.0228, 0.2990, 0.2120]), b: H([0.0246, 0.2958, 0.1940]),
    ra: sr(0.0238), rb: sr(0.0236),
    squash: [0.87, 0.90, 1.02], k: 0.021, ...furOf(R.cheek),
    flowDir: [0.55, -0.25, -0.55], flowRadial: 0.90, tint: TINT_FUR,
  });

  // ------------------------------------------------------------------ ears ---
  // §4b: small, WIDE APART and LOW on the skull, thickly furred, and rounded
  // almost to a semicircle — so the pinna is a short wide paddle (60 mm across
  // by ~27 mm proud of the dome), not the tall tapering blade it was. Most of
  // its length is buried inside the cranium, which is what anchors it.
  const earA = L.earR01;
  const earB = L.earR_tip;
  f.addMirrored({
    name: 'earR', a: earA, b: earB, ra: sr(0.0224), rb: sr(0.0083),
    frame: 'axis', normal: EAR_NORMAL, squash: [0.60, 1.02, 1.0],
    k: 0.015, ...furOf(R.earOuter),
    flowDir: sub(earB, earA), flowRadial: 0.30, tint: TINT_FUR,
  });
  // Shallow concha bowl on the forward face.
  const earMid = lerp3(earA, earB, 0.34);
  const earAxis = sub(earB, earA);
  const eal = Math.hypot(earAxis[0], earAxis[1], earAxis[2]);
  const conchaC = [
    earMid[0] + EAR_NORMAL[0] * sr(0.0165),
    earMid[1] + EAR_NORMAL[1] * sr(0.0165),
    earMid[2] + EAR_NORMAL[2] * sr(0.0165),
  ];
  f.addMirrored({
    name: 'conchaR', a: conchaC,
    b: [conchaC[0] + earAxis[0] / eal * 0.010,
        conchaC[1] + earAxis[1] / eal * 0.010,
        conchaC[2] + earAxis[2] / eal * 0.010],
    ra: sr(0.0165),
    frame: 'axis', normal: EAR_NORMAL, squash: [0.42, 0.96, 1.05],
    k: 0.008, op: 'subtract', ...furOf(R.earInner),
    flowDir: sub(earB, earA), flowRadial: 0.20, tint: TINT_FUR,
  });

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
    ra: 0.0156, rb: 0.0178, squash: [1.0, 1.0, 0.92], k: 0.009, ...furOf(R.legFrontLower),
    flowDir: [0, -1, 0.12], flowRadial: 0.40, tint: TINT_FUR,
  });
  addPaw(f, furOf, 0.0455, 0.0722, +1, R.pawFront, 0.0192, 0.0206);

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
    ra: 0.0140, rb: 0.0164, squash: [0.88, 1.0, 1.0], k: 0.009, ...furOf(R.hock),
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

  addPaw(f, furOf, 0.0450, -0.1300, +1, R.pawHind, 0.0180, 0.0190);

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
      k: i === 0 ? 0.014 : 0.0055, ...furOf(tail[i][4]),
      // radially outward is the signature bottle-brush look
      flowDir: sub(b, a), flowRadial: 1.05, tint: TINT_FUR,
    });
  }

  f.compile();

  // ------------------------------------------------- eye sockets (phase 2) ---
  const eyes = {};
  const SOCKET_R = 0.0150, SOCKET_K = 0.0165;
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
    f.add({
      name: `socket${side}`,
      a: [hit[0] + n[0] * off, hit[1] + n[1] * off, hit[2] + n[2] * off],
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
  const padLen = 0.0140;
  const padY = 0.0034 + padR * 0.62;

  f.addMirrored({
    name: `pad${region}`, a: [x, padY, zBack], b: [x, padY, zBack + sgn * padLen],
    ra: padR, rb: padR * 1.04, squash: [1.08, 0.62, 1.0], k: 0.010,
    ...fur, ...flow, tint: TINT_PAW,
  });

  // four toes: outer pair shorter and splayed, inner pair longer
  const offs = [-1.85, -0.62, 0.62, 1.85];
  const lens = [0.0206, 0.0268, 0.0268, 0.0206];
  const splay = [-0.0070, -0.0020, 0.0020, 0.0070];
  for (let i = 0; i < 4; i++) {
    const r0 = 0.0096, r1 = 0.0082;
    const x0 = x + offs[i] * toeSpread * 0.5;
    const z0 = zBack + sgn * (padLen + 0.0012);
    f.addMirrored({
      name: `toe${region}_${i}`,
      a: [x0, 0.0034 + r0 * 0.86, z0],
      b: [x0 + splay[i], 0.0034 + r1 * 0.86, z0 + sgn * lens[i]],
      ra: r0, rb: r1, squash: [1.0, 0.86, 1.0], k: 0.0080,
      ...fur, ...flow, tint: TINT_FUR,
    });
  }
}

/** Bounding box of the skin, for sanity checks and the mesher domain. */
export function anatomyExtents(field) {
  return field.bounds;
}
