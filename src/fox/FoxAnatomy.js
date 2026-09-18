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

  hips: [0, 0.2375, -0.1750],
  spine01: [0, 0.2430, -0.1225],
  spine02: [0, 0.2455, -0.0685],
  spine03: [0, 0.2450, -0.0145],
  spine04: [0, 0.2465, 0.0395],
  chest: [0, 0.2510, 0.0865],
  neck01: [0, 0.2720, 0.1275],
  neck02: [0, 0.2980, 0.1615],
  head: [0, 0.3155, 0.1875],
  jaw: [0, 0.3005, 0.2085],

  earR01: [0.0300, 0.3300, 0.1835],
  earR02: [0.0370, 0.3540, 0.1800],
  earR03: [0.0425, 0.3760, 0.1770],
  earR_tip: [0.0470, 0.3970, 0.1745],

  // tail: carried low with a gentle continuous curve, tip clear of the snow
  tail01: [0, 0.2300, -0.2560],
  tail02: [0, 0.2240, -0.2910],
  tail03: [0, 0.2145, -0.3250],
  tail04: [0, 0.2010, -0.3570],
  tail05: [0, 0.1840, -0.3870],
  tail06: [0, 0.1630, -0.4140],
  tail07: [0, 0.1395, -0.4380],
  tail08: [0, 0.1140, -0.4600],
  tail09: [0, 0.0880, -0.4790],
  tail_tip: [0, 0.0620, -0.4960],

  shoulderR: [0.0430, 0.2330, 0.0640],
  upperArmR: [0.0475, 0.1830, 0.0810],
  lowerArmR: [0.0490, 0.1180, 0.0605],
  wristR: [0.0470, 0.0470, 0.0750],
  pawR: [0.0455, 0.0205, 0.0800],
  pawR_tip: [0.0452, 0.0110, 0.1170],

  thighR: [0.0400, 0.2280, -0.1680],
  shinR: [0.0465, 0.1550, -0.1180],
  hockR: [0.0460, 0.0860, -0.1960],
  footR: [0.0450, 0.0205, -0.1590],
  toeR: [0.0450, 0.0145, -0.1330],
  toeR_tip: [0.0448, 0.0105, -0.1150],
};

// Mirror every *R landmark to *L.
for (const key of Object.keys(LANDMARKS)) {
  if (!/R(\d\d)?(_tip)?$/.test(key)) continue;
  const p = LANDMARKS[key];
  LANDMARKS[key.replace(/R(?=(\d\d)?(_tip)?$)/, 'L')] = [-p[0], p[1], p[2]];
}

/** Direction each eye looks / sits along, from inside the skull outward. */
export const EYE = {
  origin: [0, 0.3160, 0.1990],
  dir: [0.6200, 0.2050, 0.7570],   // right eye; mirrored for the left
  ballRadius: 0.0098,
};

/** The ear pinna plane normal — the direction the concha faces (right ear). */
export const EAR_NORMAL = [0.7000, 0.0850, 0.7090];

// ---------------------------------------------------------------------------
// fur field presets per region: [length (m), stiffness 0..1]
// ---------------------------------------------------------------------------
// Bible §5: 2-6 mm on muzzle/paws/forehead, 35-55 mm on ruff/flank, longest on
// the tail. Stiffness: guard hairs of the back and tail are stiff; belly,
// cheek and throat underfur is soft.
export const FUR = {
  [R.nose]: [0.0006, 1.00],
  [R.muzzle]: [0.0030, 0.90],
  [R.jawLower]: [0.0048, 0.72],
  [R.cheek]: [0.0280, 0.30],
  [R.forehead]: [0.0052, 0.82],
  [R.skull]: [0.0110, 0.74],
  [R.earOuter]: [0.0062, 0.70],
  [R.earInner]: [0.0075, 0.44],
  [R.throat]: [0.0300, 0.28],
  [R.neck]: [0.0455, 0.58],
  [R.ruff]: [0.0540, 0.52],
  [R.chest]: [0.0405, 0.46],
  [R.shoulder]: [0.0385, 0.66],
  [R.back]: [0.0425, 0.86],
  [R.flank]: [0.0480, 0.62],
  [R.belly]: [0.0440, 0.24],
  [R.croup]: [0.0450, 0.80],
  [R.haunch]: [0.0410, 0.66],
  [R.legFrontUpper]: [0.0250, 0.60],
  [R.legFrontLower]: [0.0115, 0.68],
  [R.pawFront]: [0.0046, 0.86],
  [R.legHindUpper]: [0.0300, 0.62],
  [R.hock]: [0.0165, 0.50],
  [R.pawHind]: [0.0046, 0.86],
  [R.tailBase]: [0.0520, 0.78],
  [R.tailMid]: [0.0620, 0.80],
  [R.tailTip]: [0.0480, 0.72],
};

const TINT_FUR = 0xfdfcfa;      // bible "fur base (lit)"
const TINT_SKIN = 0x171a20;     // bible "skin / nose"
const TINT_PAW = 0x6a6a70;      // pad leather peeking between the toes

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
const TRUNK = [
  // z,       y,       r,      sqx,  region
  [-0.2470, 0.2135, 0.0555, 0.92, R.croup],
  [-0.1950, 0.1975, 0.0675, 0.93, R.croup],
  [-0.1300, 0.1990, 0.0665, 0.87, R.flank],
  [-0.0650, 0.1950, 0.0690, 0.86, R.flank],
  [0.0000, 0.1920, 0.0725, 0.85, R.flank],
  [0.0550, 0.1910, 0.0730, 0.83, R.chest],
  [0.0950, 0.2020, 0.0660, 0.82, R.chest],
  [0.1300, 0.2350, 0.0570, 0.85, R.ruff],
  [0.1650, 0.2750, 0.0500, 0.88, R.neck],
  [0.1880, 0.3010, 0.0470, 0.90, R.neck],
];

const TAIL_R = [0.0255, 0.0266, 0.0256, 0.0241, 0.0225, 0.0205, 0.0180, 0.0155, 0.0128, 0.0102];

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
  for (let i = 0; i < TRUNK.length - 1; i++) {
    const [z0, y0, r0, sx0, reg] = TRUNK[i];
    const [z1, y1, r1, sx1] = TRUNK[i + 1];
    const sx = (sx0 + sx1) * 0.5;
    // caudal tangent: hairs run nose -> tail along the body
    const dir = [0, y0 - y1, z0 - z1];
    f.add({
      name: `trunk${i}`, a: [0, y0, z0], b: [0, y1, z1], ra: r0, rb: r1,
      squash: [sx, 1, 1], k: 0.032, ...furOf(reg),
      flowDir: dir, flowRadial: 0.18, tint: TINT_FUR,
    });
  }

  // --------------------------------------------------------------- throat ---
  // Fills the jaw-to-brisket hollow so the ruff has something to sit on.
  f.add({
    name: 'throat', a: [0, 0.2830, 0.1900], b: [0, 0.2420, 0.1160], ra: 0.0305, rb: 0.0480,
    squash: [0.90, 0.92, 1], k: 0.026, ...furOf(R.throat),
    flowDir: [0, -0.55, -0.55], flowRadial: 0.60, tint: TINT_FUR,
  });
  // Prosternum — the chest points forward between the shoulders.
  f.add({
    name: 'prosternum', a: [0, 0.1860, 0.0960], ra: 0.0480,
    squash: [0.80, 0.94, 0.78], k: 0.030, ...furOf(R.chest),
    flowDir: [0, -0.35, -0.90], flowRadial: 0.35, tint: TINT_FUR,
  });

  // ----------------------------------------------------------------- head ---
  f.add({
    name: 'braincase', a: [0, 0.3140, 0.1940], ra: 0.0430,
    squash: [0.76, 0.90, 1.08], k: 0.020, ...furOf(R.skull),
    flowDir: [0, 0.16, -1], flowRadial: 0.22, tint: TINT_FUR,
  });
  f.add({
    name: 'occiput', a: [0, 0.3070, 0.1640], ra: 0.0390,
    squash: [0.80, 0.92, 0.92], k: 0.024, ...furOf(R.skull),
    flowDir: [0, 0.10, -1], flowRadial: 0.25, tint: TINT_FUR,
  });
  // Domed forehead with a gentle stop — arctic fox, not red fox.
  f.add({
    name: 'forehead', a: [0, 0.3195, 0.2105], ra: 0.0300,
    squash: [0.94, 0.86, 0.96], k: 0.018, ...furOf(R.forehead),
    flowDir: [0, 0.22, -1], flowRadial: 0.20, tint: TINT_FUR,
  });
  f.addMirrored({
    name: 'brow', a: [0.0275, 0.3300, 0.2145], ra: 0.0158,
    squash: [1.00, 0.60, 1.06], k: 0.014, ...furOf(R.forehead),
    flowDir: [0.15, 0.20, -1], flowRadial: 0.25, tint: TINT_FUR,
  });
  // Short, blunt muzzle. Whole thing is 65 mm from the stop to the nose pad.
  f.add({
    name: 'muzzle', a: [0, 0.3070, 0.2080], b: [0, 0.2980, 0.2630], ra: 0.0285, rb: 0.0150,
    squash: [1.0, 0.92, 1.0], k: 0.015, ...furOf(R.muzzle),
    flowDir: [0, 0.05, -1], flowRadial: 0.34, tint: TINT_FUR,
  });
  f.add({
    name: 'nosePad', a: [0, 0.2958, 0.2675], ra: 0.0142,
    squash: [1.0, 0.86, 0.82], k: 0.008, ...furOf(R.nose),
    flowDir: [0, -0.2, -1], flowRadial: 0.35, tint: TINT_SKIN,
  });
  f.add({
    name: 'mandible', a: [0, 0.2915, 0.2075], b: [0, 0.2885, 0.2545], ra: 0.0232, rb: 0.0126,
    squash: [0.95, 0.80, 1.0], k: 0.014, ...furOf(R.jawLower),
    flowDir: [0, -0.30, -1], flowRadial: 0.35, tint: TINT_FUR,
  });
  f.addMirrored({
    name: 'cheek', a: [0.0230, 0.2965, 0.1930], ra: 0.0262,
    squash: [0.58, 0.85, 1.06], k: 0.022, ...furOf(R.cheek),
    flowDir: [0.55, -0.25, -0.55], flowRadial: 0.90, tint: TINT_FUR,
  });

  // ------------------------------------------------------------------ ears ---
  // Small, rounded, heavily furred, set on the sides of the dome. 21 mm thick
  // at the base so the pinna never gets thinner than ~2 mesh cells.
  const earA = [L.earR01[0] - 0.003, L.earR01[1] + 0.002, L.earR01[2] - 0.001];
  const earB = L.earR_tip;
  f.addMirrored({
    name: 'earR', a: earA, b: earB, ra: 0.0272, rb: 0.0186,
    frame: 'axis', normal: EAR_NORMAL, squash: [0.40, 1.0, 1.0],
    k: 0.017, ...furOf(R.earOuter),
    flowDir: sub(earB, earA), flowRadial: 0.30, tint: TINT_FUR,
  });
  // Shallow concha bowl on the forward face. Kept to ~5 mm so the pinna keeps
  // 14 mm of thickness behind it.
  const earMid = lerp3(earA, earB, 0.46);
  const conchaC = [
    earMid[0] + EAR_NORMAL[0] * 0.0134,
    earMid[1] + EAR_NORMAL[1] * 0.0134,
    earMid[2] + EAR_NORMAL[2] * 0.0134,
  ];
  f.addMirrored({
    name: 'conchaR', a: conchaC, ra: 0.0215,
    frame: 'axis', normal: EAR_NORMAL, squash: [0.42, 0.96, 1.05],
    b: [conchaC[0] + 0.0001, conchaC[1] + 0.012, conchaC[2]],
    k: 0.011, op: 'subtract', ...furOf(R.earInner),
    flowDir: sub(earB, earA), flowRadial: 0.20, tint: TINT_FUR,
  });

  // -------------------------------------------------------------- forelimb ---
  // Scapula reads as a flat, fore-aft elongated bulge lying on the ribs.
  f.addMirrored({
    name: 'scapulaR', a: [0.0415, 0.2280, 0.0620], b: [0.0480, 0.1870, 0.0790],
    ra: 0.0232, rb: 0.0248, squash: [0.62, 1.0, 1.30], k: 0.030, ...furOf(R.shoulder),
    flowDir: [0.10, -0.45, -0.90], flowRadial: 0.25, tint: TINT_FUR,
  });
  f.addMirrored({
    name: 'humerusR', a: [0.0475, 0.1860, 0.0800], b: [0.0490, 0.1210, 0.0620],
    ra: 0.0228, rb: 0.0168, squash: [0.86, 1.0, 1.0], k: 0.024, ...furOf(R.legFrontUpper),
    flowDir: [0, -1, -0.10], flowRadial: 0.35, tint: TINT_FUR,
  });
  f.addMirrored({
    name: 'radiusR', a: [0.0490, 0.1225, 0.0620], b: [0.0474, 0.0505, 0.0745],
    ra: 0.0170, rb: 0.0119, squash: [0.90, 1.0, 1.0], k: 0.018, ...furOf(R.legFrontLower),
    flowDir: [0, -1, 0.05], flowRadial: 0.40, tint: TINT_FUR,
  });
  f.addMirrored({
    name: 'carpusR', a: [0.0474, 0.0495, 0.0745], b: [0.0458, 0.0235, 0.0795],
    ra: 0.0122, rb: 0.0138, squash: [1.0, 1.0, 0.92], k: 0.014, ...furOf(R.legFrontLower),
    flowDir: [0, -1, 0.12], flowRadial: 0.40, tint: TINT_FUR,
  });
  addPaw(f, furOf, 0.0455, 0.0790, +1, R.pawFront, 0.0182, 0.0158);

  // -------------------------------------------------------------- hindlimb ---
  // Haunch mass first: it is the widest point of the animal from behind.
  f.addMirrored({
    name: 'haunchR', a: [0.0410, 0.2140, -0.1720], b: [0.0465, 0.1600, -0.1230],
    ra: 0.0420, rb: 0.0262, squash: [0.64, 1.05, 1.10], k: 0.034, ...furOf(R.haunch),
    flowDir: [0.10, -0.75, -0.55], flowRadial: 0.30, tint: TINT_FUR,
  });
  // Tibia + gastrocnemius: thick at the stifle, thin at the hock.
  f.addMirrored({
    name: 'tibiaR', a: [0.0465, 0.1580, -0.1200], b: [0.0460, 0.0910, -0.1905],
    ra: 0.0246, rb: 0.0136, squash: [0.80, 1.0, 1.0], k: 0.024, ...furOf(R.legHindUpper),
    flowDir: [0, -1, -0.30], flowRadial: 0.35, tint: TINT_FUR,
  });
  // Long metatarsus — the "backwards knee" is the hock joint at its top.
  f.addMirrored({
    name: 'metatarsusR', a: [0.0460, 0.0880, -0.1935], b: [0.0452, 0.0255, -0.1615],
    ra: 0.0138, rb: 0.0126, squash: [0.86, 1.0, 1.0], k: 0.015, ...furOf(R.hock),
    flowDir: [0, -1, 0.35], flowRadial: 0.40, tint: TINT_FUR,
  });
  addPaw(f, furOf, 0.0450, -0.1585, +1, R.pawHind, 0.0168, 0.0146, -1);

  // ------------------------------------------------------------------ tail ---
  const tailKeys = ['tail01', 'tail02', 'tail03', 'tail04', 'tail05',
    'tail06', 'tail07', 'tail08', 'tail09', 'tail_tip'];
  for (let i = 0; i < tailKeys.length - 1; i++) {
    const a = L[tailKeys[i]], b = L[tailKeys[i + 1]];
    const reg = i < 2 ? R.tailBase : i < 7 ? R.tailMid : R.tailTip;
    f.add({
      name: `tail${i}`, a, b, ra: TAIL_R[i], rb: TAIL_R[i + 1],
      k: i === 0 ? 0.030 : 0.016, ...furOf(reg),
      // radially outward is the signature bottle-brush look
      flowDir: sub(b, a), flowRadial: 1.05, tint: TINT_FUR,
    });
  }

  f.compile(0.05);

  // ------------------------------------------------- eye sockets (phase 2) ---
  const eyes = {};
  for (const side of ['R', 'L']) {
    const dir = side === 'R' ? EYE.dir : mirrorX(EYE.dir);
    const dl = Math.hypot(dir[0], dir[1], dir[2]);
    const d = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
    const o = EYE.origin;
    const t = f.raycast(o[0], o[1], o[2], d[0], d[1], d[2], 0.12);
    const hit = t > 0
      ? [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]
      : [o[0] + d[0] * 0.042, o[1] + d[1] * 0.042, o[2] + d[2] * 0.042];
    const n = [0, 0, 0];
    f.normal(hit[0], hit[1], hit[2], 0.0015, n);

    // Shallow, wide depression: the sphere centre sits just outside the skin so
    // only its inner cap bites, giving ~3 mm of socket instead of a crater.
    f.add({
      name: `socket${side}`,
      a: [hit[0] + n[0] * 0.0124, hit[1] + n[1] * 0.0124, hit[2] + n[2] * 0.0124],
      ra: 0.0152, squash: [1.0, 0.86, 1.0], k: 0.0105, op: 'subtract',
      region: R.forehead, furLength: FUR[R.forehead][0], furStiffness: 0.5,
      flowDir: [0, 0.2, -1], flowRadial: 0.2, tint: 0x2a2a30,
    });
    eyes[side] = {
      surface: hit, normal: n,
      // eyeball centre: cornea pokes very slightly proud of the lid line
      centre: [hit[0] - n[0] * 0.0055, hit[1] - n[1] * 0.0055, hit[2] - n[2] * 0.0055],
      look: d,
    };
  }
  f.compile(0.05);

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
    ra: padR, rb: padR * 1.04, squash: [1.08, 0.62, 1.0], k: 0.012,
    ...fur, ...flow, tint: TINT_PAW,
  });

  // four toes: outer pair shorter and splayed, inner pair longer
  const offs = [-1.85, -0.62, 0.62, 1.85];
  const lens = [0.0215, 0.0282, 0.0282, 0.0215];
  const splay = [-0.0070, -0.0020, 0.0020, 0.0070];
  for (let i = 0; i < 4; i++) {
    const r0 = 0.0082, r1 = 0.0062;
    const x0 = x + offs[i] * toeSpread * 0.5;
    const z0 = zBack + sgn * (padLen + 0.0012);
    f.addMirrored({
      name: `toe${region}_${i}`,
      a: [x0, 0.0034 + r0 * 0.86, z0],
      b: [x0 + splay[i], 0.0034 + r1 * 0.86, z0 + sgn * lens[i]],
      ra: r0, rb: r1, squash: [1.0, 0.86, 1.0], k: 0.0062,
      ...fur, ...flow, tint: TINT_FUR,
    });
  }
}

/** Bounding box of the skin, for sanity checks and the mesher domain. */
export function anatomyExtents(field) {
  return field.bounds;
}
