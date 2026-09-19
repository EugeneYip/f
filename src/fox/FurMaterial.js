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
export const REGION_TABLE = [
  /* 0 nose          */ { a: [0.00, 0.30, 0.00, 0.00], b: [1.00, 2.40, 1.00, 0.00] },
  /* 1 muzzle        */ { a: [0.95, 0.92, 0.60, 0.10], b: [1.55, 1.40, 0.90, 0.55] },
  /* 2 jawLower      */ { a: [0.98, 1.00, 0.80, 0.18], b: [1.40, 1.30, 0.90, 0.75] },
  /* 3 cheek         */ { a: [1.05, 1.34, 1.35, 0.50], b: [0.80, 1.00, 1.00, 1.70] },
  /* 4 forehead      */ { a: [1.00, 0.95, 0.90, 0.10], b: [1.40, 1.20, 0.90, 1.05] },
  /* 5 skull         */ { a: [1.00, 0.84, 0.95, 0.16], b: [1.20, 1.10, 1.00, 1.30] },
  /* 6 earOuter      */ { a: [1.00, 0.72, 0.80, 0.26], b: [1.45, 1.55, 0.90, 0.55] },
  /* 7 earInner      */ { a: [0.90, 0.74, 1.20, 0.55], b: [1.30, 1.40, 0.80, 0.60] },
  /* 8 throat        */ { a: [1.00, 1.10, 1.20, 0.45], b: [0.95, 1.10, 1.00, 0.85] },
  /* 9 neck          */ { a: [1.00, 1.08, 1.05, 0.35], b: [0.90, 1.00, 1.00, 0.90] },
  /* 10 ruff          */ { a: [1.05, 1.16, 1.15, 0.55], b: [0.72, 0.95, 1.00, 1.60] },
  /* 11 chest         */ { a: [1.00, 1.04, 1.10, 0.38], b: [0.92, 1.00, 1.00, 0.72] },
  /* 12 shoulder      */ { a: [1.00, 1.08, 1.15, 0.30], b: [0.95, 1.00, 1.00, 0.50] },
  /* 13 back          */ { a: [1.00, 1.04, 1.20, 0.26], b: [0.95, 1.00, 1.00, 0.42] },
  /* 14 flank         */ { a: [1.00, 1.10, 1.05, 0.30], b: [0.90, 1.00, 1.00, 0.82] },
  /* 15 belly         */ { a: [1.00, 1.12, 1.30, 0.42], b: [0.95, 1.05, 0.90, 0.80] },
  /* 16 croup         */ { a: [1.00, 1.04, 1.25, 0.28], b: [0.92, 1.00, 1.00, 0.52] },
  /* 17 haunch        */ { a: [1.00, 1.08, 1.05, 0.30], b: [0.92, 1.00, 1.00, 0.82] },
  /* 18 legFrontUpper */ { a: [1.00, 1.10, 1.00, 0.24], b: [1.10, 1.25, 0.25, 0.65] },
  /* 19 legFrontLower */ { a: [1.00, 1.15, 0.85, 0.24], b: [1.20, 1.45, 0.16, 0.55] },
  /* 20 pawFront      */ { a: [1.00, 1.15, 0.60, 0.16], b: [1.55, 1.95, 0.14, 0.50] },
  /* 21 legHindUpper  */ { a: [1.00, 1.10, 1.05, 0.28], b: [1.05, 1.20, 0.25, 0.65] },
  /* 22 hock          */ { a: [1.00, 1.10, 0.95, 0.32], b: [1.15, 1.35, 0.16, 0.85] },
  /* 23 pawHind       */ { a: [1.00, 1.15, 0.60, 0.16], b: [1.55, 1.95, 0.14, 0.50] },
  /* 24 tailBase      */ { a: [1.04, 1.14, 0.45, 0.34], b: [0.85, 0.95, 1.00, 1.25] },
  /* 25 tailMid       */ { a: [1.06, 1.36, 0.30, 0.42], b: [0.78, 0.92, 1.00, 1.55] },
  /* 26 tailTip       */ { a: [1.04, 1.18, 0.34, 0.36], b: [0.82, 0.95, 1.00, 1.35] },
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
  microFreq: 3400,    // ~0.29 mm hairs, only resolved at macro range
  clumpPull: 0.74,
  strandRoot: 0.58,
  strandTip: 0.15,
  hairLenMin: 0.52,
  density: 1.0,
  fill: 1.0,
  coatVarFreq: 15,

  // shading
  ambient: 2.45,
  ambientSat: 1.0,
  sunSat: 0.30,
  transSat: 0.16,     // scattered light keeps almost none of the sun's hue       // how much of the sun's chromaticity survives scattering
  wrap: 0.40,
  trans: 15.0,        // divided by PI in the shader
  transPow: 3.4,
  aoInner: 0.66,
  aoPow: 0.90,
  aoFloor: 0.54,
  shellJitter: 1.15,
  tuftAmt: 1.0,
  clumpAO: 0.75,
  aoBake: 0.22,
  rim: 0.30,
  strandRound: 0.60,
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
  cardLength: 1.42,
  cardInner: 0.17,
  cardJitter: 1.05,
  cardOpacity: 1.0,
};

export function buildFurUniforms(ctx) {
  const d = FUR_DEFAULTS;
  const regionA = [];
  const regionB = [];
  for (let i = 0; i < REGION_COUNT; i++) {
    const r = REGION_TABLE[i] ?? { a: [1, 1, 1, 0.3], b: [1, 1, 1, 0.8] };
    regionA.push(new THREE.Vector4(...r.a));
    regionB.push(new THREE.Vector4(...r.b));
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
    uEyeFade: { value: new THREE.Vector2(0.0092, 0.0190) },
    uNose: { value: new THREE.Vector3(0.001, 0.293, 0.274) },
    uNoseFade: { value: new THREE.Vector2(0.0085, 0.0180) },
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
    uRim: { value: d.rim },

    uStochastic: { value: 0 },
    uFrameSeed: { value: 0 },

    uRegionA: { value: regionA },
    uRegionB: { value: regionB },

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
export function makeShellMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    name: 'furShell',
    uniforms,
    vertexShader: furVertexShader('shell'),
    fragmentShader: furFragmentShader('shell'),
    fog: true,
    lights: false,
    transparent: true,
    depthWrite: false,
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
    depthWrite: false,
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
  u.uFrameSeed.value = ctx.frame % 64;
}
