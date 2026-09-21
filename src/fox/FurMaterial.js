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
  REGION_COUNT,
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
 * Card length relative to the local coat, per region (uRegionC.x).
 *
 * 1.0 everywhere the coat is thick enough that a coat-proportional fringe
 * already spans several pixels. Short-coat regions need a multiplier or their
 * outline cannot break up at all: the ear fringe was 4.7 mm against a 2.6 mm
 * pixel at the silhouette framing. Absolute lengths stay small — 4.2 mm ear
 * coat x 3.6 is still only a 15 mm fringe.
 */
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

export const CARD_LEN_SCALE = {
  0: 1.0, 1: 1.8, 2: 1.6, 3: 1.0, 4: 1.4, 5: 1.3, 6: 1.8, 7: 1.6,
  8: 1.0, 9: 1.0, 10: 1.0, 11: 1.0, 12: 1.0, 13: 1.0, 14: 1.0,
  15: 1.0, 16: 1.0, 17: 1.0, 18: 1.4, 19: 1.5, 20: 1.8,
  21: 1.4, 22: 1.4, 23: 1.8, 24: 1.0, 25: 1.0, 26: 1.0,
};

export const REGION_TABLE = [
  /* 0 nose          */ { a: [0.00, 0.30, 0.00, 0.00], b: [1.00, 2.40, 1.00, 0.00] },
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
  ambient: 2.45,
  ambientSat: 1.0,
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

  // cards
  cardWidth: 0.115,
  cardLength: 1.20,
  cardInner: 0.17,
  cardJitter: 1.05,
  cardOpacity: 1.0,
};

export function buildFurUniforms(ctx) {
  const d = FUR_DEFAULTS;
  const regionA = [];
  const regionB = [];
  const regionC = [];
  for (let i = 0; i < REGION_COUNT; i++) {
    const r = REGION_TABLE[i] ?? { a: [1, 1, 1, 0.3], b: [1, 1, 1, 0.8] };
    regionA.push(new THREE.Vector4(...r.a));
    regionB.push(new THREE.Vector4(...r.b));
    regionC.push(new THREE.Vector4(CARD_LEN_SCALE[i] ?? 1.0, CARD_INNER_FLOOR[i] ?? 0,
                                   SHELL_LEN_SCALE[i] ?? 1.0, TRANS_BOOST[i] ?? 1.0));
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
    uSunSat: { value: d.sunSat },
    uTransSat: { value: d.transSat },

    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector3().copy(ctx.wind) },
    uWindSpeed: { value: ctx.windSpeed ?? 2.4 },
    uWindGust: { value: 0 },
    uGravity: { value: new THREE.Vector3(0, -1, 0) },

    uEyeL: { value: new THREE.Vector3(-0.027, 0.318, 0.222) },
    uEyeR: { value: new THREE.Vector3(0.027, 0.318, 0.222) },
    // The coat parts around the eye over a radius sized by the EYEBALL.
    //
    //   x  lid-margin clearance radius, metres — overwritten at init from the
    //      measured globe (FurSystem.eyeClearRadius); this is only the value
    //      used if the anatomy agent has not published eye metadata yet
    //   y  inner radius as a fraction of x: fully bare inside it
    //   z  coverage clears over z x the radius that length clears over
    //
    // There is deliberately no "per metre of local coat" term any more. It was
    // self-defeating -- the clearance grew as fast as the thing it was meant to
    // clear -- and it went from harmless to fatal purely because the head coat
    // got deeper underneath it. See furSkinMask2 in fur.glsl.js.
    uEyeFade: { value: new THREE.Vector3(0.0150, 0.45, 0.52) },
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
    uShadowTint: { value: new THREE.Vector3(0.72, 0.845, 1.0) },
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
    uRim: { value: d.rim },

    uStochastic: { value: 0 },
    uFrameSeed: { value: 0 },

    uRegionA: { value: regionA },
    uRegionB: { value: regionB },
    uRegionC: { value: regionC },

    uCardWidth: { value: d.cardWidth },
    uCardLength: { value: d.cardLength },
    uCardInner: { value: d.cardInner },
    uCardJitter: { value: d.cardJitter },
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
export function syncFurUniforms(u, ctx) {
  u.uSunDir.value.copy(ctx.sunDirection);
  u.uSunColor.value.copy(ctx.sunColor);
  u.uSunIntensity.value = ctx.sunIntensity ?? 7;
  u.uSkyColor.value.copy(ctx.skyColor);
  u.uGroundBounce.value.copy(ctx.groundBounce);

  u.uTime.value = ctx.time;
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
