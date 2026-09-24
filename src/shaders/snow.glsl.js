// OWNER: terrain agent.
//
// The snow shader library. Everything the snowfield needs lives here so that
// there is exactly ONE authoritative copy of the height field's constants:
// `SNOW` is injected into GLSL as `const float S_*` AND read directly by the
// JS port in `src/world/Terrain.js`. If you change a number here, both the GPU
// displacement and the CPU `heightAt()` move together.
//
// Noise: gradient ("Perlin") noise over a 256x256 permutation/gradient table
// that is uploaded as an RGBA8 texture and ALSO kept as the source Uint8Array.
// A table lookup is the one hash that is bit-identical on the GPU and in JS —
// `fract(p*0.1031)`-style hashes diverge between float32 and float64, which
// would make the fox float or sink. The lattice address arithmetic
// (`mod(i,256)+0.5)/256`) is exact in both precisions, so both sides read the
// same bytes and the only difference left is float32-vs-float64 rounding of the
// interpolation (~1e-7 m).

// ---------------------------------------------------------------------------
// Shared constants. Metres, radians, seconds.
// ---------------------------------------------------------------------------
export const SNOW = {
  TABLE: 256,

  // Broad drift topography — three elongated dune scales. Gives the field form
  // and keeps the horizon from reading as a ruled line.
  //
  // DUNE0 is the SWELL, and it exists for one reason: the terrain/sky boundary.
  // The clipmap rim sits at 210 m at `high` (283 m at ultra), and a rim on a
  // dead-flat plane is a circle — which draws a perfectly straight, featureless
  // line across every wide framing, which is precisely what a critic called
  // "the largest single reason the shots read as a demo". Relief only breaks
  // that line if it SURVIVES the band-limiter out at the rim: an octave of
  // wavelength w is gone once the local sample spacing exceeds w*LOD_HI, and
  // the outermost clipmap level samples every 5.25 m, so anything above ~48 m
  // survives. DUNE1 (58 m) does survive — it is simply too shallow to see at
  // that range: 0.78 m at 210 m subtends 0.21 degrees, 8 px in a 1800 px frame.
  // DUNE0 is 2.6 m over a ~190 m cell, which is +-0.7 degrees at the rim, ~28
  // px of skyline movement, and, more usefully, a couple of metres of rise and
  // fall across the 30-150 m midground so near drifts occlude far ones and the
  // eye finally has something to read recession from. Its slope is 1.5 deg, so
  // it costs foot IK nothing.
  //
  // The amplitudes are set by ONE number: the camera stands 1.05 m above the
  // snow in every wide framing, so a crest only occludes the far rim — only
  // breaks the horizon line — if it clears 1.05 m. At 0.78 m DUNE1 never did,
  // anywhere, at any azimuth, which is the whole reason the skyline measured
  // as a ruled line with 17 px of camber across 2800 px. At 1.9 m a crest at
  // 50 m sits 0.97 deg above eye level: 39 px of broken horizon in an 1800 px
  // frame, and near drifts start hiding far ones.
  // The wavelengths matter as much as the amplitudes, and for a reason that
  // is easy to miss: what breaks a horizon is relief that varies with
  // AZIMUTH. At 150 m a 10 degree slice of the frame is only 26 m of ground,
  // so a dune with a 141 m cell along the view axis contributes one smooth
  // ramp across the whole shot — measured: a monotone skyline from +19 px on
  // the left to -1 px on the right, with 2 px of ripple on it. Cells of
  // 36 m / 70 m put two or three crests inside the same slice, and those
  // crests clear the camera, so near ground starts hiding far ground.
  DUNE0_AC: 0.0075, DUNE0_AL: 0.0042, DUNE0_AMP: 3.00, DUNE0_SIZE: 133.0,
  DUNE1_AC: 0.0312, DUNE1_AL: 0.0161, DUNE1_AMP: 2.40, DUNE1_SIZE: 32.0,
  DUNE2_AC: 0.0525, DUNE2_AL: 0.0232, DUNE2_AMP: 0.55, DUNE2_SIZE: 18.0,


  // The calm pad the fox stands on. Radius is modulated by noise so the
  // boundary is not a circle.
  PAD_R0: 1.05, PAD_R1: 5.2, PAD_MIN: 0.22,
  PAD_WOBBLE: 0.46, PAD_WOB_F: 0.30, PAD_WOB_SIZE: 3.4,
  // Inside CORE_R0 of the pad centre the field is scaled to CORE_MIN of its
  // deviation, i.e. the snow is flat at exactly y=0 where the animal stands.
  // Without this, paws spread over half a metre sit on +-2 cm of relief and a
  // rig placed at y=0 visibly floats. The scaled radius carries the same noisy
  // wobble as the pad, so there is no circle to see — and there is nothing to
  // see anyway, since the deviation being removed is only a couple of cm.
  CORE_R0: 0.36, CORE_R1: 1.95, CORE_MIN: 0.05,

  // Sastrugi meander: the ridges are not straight, they snake downwind.
  MEAND_AC: 0.086, MEAND_AL: 0.037, MEAND_SIZE: 11.0, MEAND_AMP: 2.45,

  // Sastrugi proper: ridged noise, stretched ALONG the wind (polar sastrugi run
  // parallel to the wind, unlike dunes), with the crest sheared downwind so the
  // windward face steepens into a prow.
  SAST_ACROSS: 1.22, SAST_ALONG: 5.6, SAST_AMP: 0.215, SAST_SKEW: 1.85,
  SAST_L2: 2.07, SAST_L3: 4.28, SAST_G2: 0.47, SAST_G3: 0.22,

  // Medium ripples: small ridges running ACROSS the wind.
  RIP_LEN: 0.55, RIP_ACROSS: 2.1, RIP_AMP: 0.012,
  RIP_GATE0: 0.30, RIP_GATE1: 0.86,

  // Ridge crest sharpening, and the resulting mean of ridge(). The mean is
  // subtracted so every octave is zero-mean and fading one out with distance
  // loses detail without shifting the surface. Both are shared constants
  // precisely so the GLSL and the JS port cannot drift apart: RIDGE_MEAN is
  // measured numerically for the RIDGE_ROUND in force.
  RIDGE_ROUND: 0.20, RIDGE_MEAN: 0.71734,

  // Band-limiting. An octave of wavelength `w` is fully present while the local
  // sample spacing fw < w*LOD_LO and gone by fw > w*LOD_HI. Keeping LOD_HI well
  // under 1 leaves >6 samples per wavelength, which is what makes the clipmap
  // level joins sub-pixel and the far field alias-free.
  LOD_LO: 0.11, LOD_HI: 0.34,

  // Sparkle. SPK_R_M is the world size of a glinting facet cluster plus the
  // lens point-spread it is smeared by; it is what sets the ON-SCREEN size of
  // a glint at any distance. SPK_R_MIN/MAX bound that in pixels: a glint may
  // not be drawn under ~0.55 px (it would just alias) nor over ~2.6 px (it
  // would read as a blob rather than a spark), and the sub-pixel case is paid
  // for in brightness instead. SPK_CELL_MAX is the coarsest lattice, i.e. the
  // world spacing the glint field locks to once distance stops resolving it.
  SPK_R_M: 0.0048, SPK_R_MIN: 0.55, SPK_R_MAX: 2.6, SPK_CELL_MAX: 0.224,

  // WIND SLAB. Sastrugi are not one material and the renderer used to treat
  // them as one. The crest is erosional: wind-scoured, sintered, dense, with a
  // large effective grain. The trough is depositional and collects soft drift.
  // Broadband visible albedo of fresh dry snow is 0.85-0.90 and of wind slab
  // 0.75-0.82, so the two differ by about 10% RELATIVE -- and that difference
  // is in the MATERIAL, so unlike a grazing shadow it survives the sun going
  // up. §2 says the look has to hold at any sun; measured at `terrain`, sun
  // -6 deg gives the snow 0.835 of orientation coherence and sun 14,-30 only
  // 0.627, because at a high sun the only ridge-aligned cue left is shading
  // that is no longer there. This is the cue that does not need the sun.
  //
  // SLAB_K maps oSast onto 0..1: oSast measured over a 12 m square runs
  // -0.415 .. +0.263 with p05/p95 at -0.195/+0.179, so 0.5 + 2.4*oSast fills
  // 0.03 .. 0.93 across the ridge. Every term is written mean-preserving
  // (slab - 0.5) so this adds VARIATION without moving the field's level --
  // the palette in §3 stays where it was.
  SLAB_K: 2.4,
  SLAB_ALB: 0.095,        // full albedo swing, crest slab against trough powder
  SLAB_PACK: 0.50,        // slab is glossier: feeds the sheen roughness
  SLAB_DEEP: 0.38,        // denser snow, longer path, more red absorbed: bluer
  SLAB_SPK: 0.45,         // sintered slab has no loose facets left to glint
  // The 18 m wind-exposure field carries the same physics one scale up, and
  // it used to carry it with the SIGN REVERSED: (1 - 0.03*(1 - expo)) made the
  // EXPOSED, wind-packed snow the brighter of the two, against this file's own
  // account of compaction ("denser, so it scatters less and reads darker").
  EXPO_ALB: 0.05,

  // Wind alignment of the two finer detail layers. 1.0 is isotropic;
  // below 1 the tile is stretched ALONG the wind by 1/value.
  DET_GRN_ANISO: 0.42, DET_MIC_ANISO: 0.62,

  // Normal differencing epsilon (metres). Same on CPU and GPU.
  NRM_EPS: 0.035,

  // Footprint field.
  FP_SIZE: 24.0,          // metres covered by the deformation target
  FP_MAXDEPTH: 0.095,     // metres, when the depth channel is 1
  FP_MAXRIM: 0.016,       // metres, when the rim channel is 1
  // Profile widths, in units of the press() radius.
  //
  // These have to be read against the clipmap's BASE SPACING, and the old
  // numbers were not. A press radius is ~0.047 m and the base spacing was
  // 0.0205 m, so the rim — 0.27 radii = 1.27 cm — was 0.6 of a cell wide and
  // 2.6 cm tall. A lip narrower than the triangles carrying it is not a lip,
  // it is a vertex spike, and that is what review 3 found and called
  // "orphaned white geometry shards lying on the snow" in tail.png and
  // sun2/hero.png: hard-edged faceted V's with a clean silhouette, which an
  // A/B pins on the snowfield mesh and nothing else. The file already warned
  // about exactly this failure and then sat below its own threshold.
  //
  // The rim is now 0.62 radii = 2.9 cm, about 2.5 cells at the new base
  // spacing, and 1.6 cm tall rather than 2.6. The fine structure of the lip
  // is not lost: the fragment stage re-derives the footprint gradient at
  // render-target resolution, so the NORMAL still carries a crisp rim while
  // the geometry only carries what it can resolve.
  // The WALL widths are back where they were: widening them flattened the
  // floor of the print (measured: the deepest point of a depth-0.84 stamp
  // went from 35 mm to 24 mm), and the wall was never the part that spiked.
  // The floor exponents come down because the paw SDF only reaches d = -0.21
  // at the pad centre, so pow(0.53, 1.25) was throwing away a further 17% of
  // a depression that has to compete with +-25 mm of surrounding sastrugi to
  // be seen at all.
  FP_WALL0: 0.46, FP_WALL1: 0.28,   // soft..sharp depression wall
  FP_POW0: 1.00, FP_POW1: 0.78,     // soft..sharp floor shaping
  FP_RIM_D: 0.34, FP_RIM_W: 0.62,   // displaced rim: offset and width
  FP_TAU_DEPTH: 21.0,     // e-folding time (s); ~60 s to visually vanish
  FP_TAU_RIM: 10.0,       // rims blow away first
  FP_TAU_COMP: 26.0,      // the compacted (bluer, glossier) snow lingers

  // --- how shaded snow keeps its relief -------------------------------------
  //
  // Measured, one page session, one sim instant, the arms differing only by a
  // uniform, and a same-state control that came back bit-identical (HF sd to
  // three decimals) in every box:
  //
  //   hero, 300x90 boxes          HF sd   with detail normals off
  //   lit    (1450,930)          13.671            6.654
  //   shadow  (700,1090)          1.274            1.226
  //
  // The same detail normals carry 7.0 levels of high-frequency contrast in the
  // sun and 0.05 in shade. That is the whole of blocker 3, and it is not a
  // missing normal: it is that the sky term had no directional response worth
  // the name. skyVis was saturate(0.52 + 0.48 * N.y), which for a micro-facet
  // tilted 15 degrees off vertical moves by 1.6% -- correct for a UNIFORM
  // hemisphere, and a uniform hemisphere is not what is over this snow.
  //
  // Two things are added, both physical, both mean-preserving on a flat
  // surface so nothing in the far field or at the horizon moves:
  //
  // SKY_ANISO — the circumsolar and horizon glow. A twilight sky is several
  //   times brighter toward the sun and along the horizon than at the zenith,
  //   so a facet tilted sunward collects measurably more skylight than one
  //   tilted away. This is the dominant reason real snow shows its relief in
  //   shade, and it survives a cast shadow because the animal blocks the SUN,
  //   not the sky. (What the animal does block of the sky is snContactOcc,
  //   which is already in skyVis.) Normalised against what a flat surface
  //   collects, so a distant flat field is untouched.
  // SKY_GLOW_LIFT — how far above the sun the glow's centroid sits. The band
  //   is broad; a pure sun direction would make this a second sun.
  // SKY_CAV — micro cavity occlusion. The baked detail map has carried a
  //   height-proxy occlusion in its .w channel since it was written and
  //   sn_detail was returning a vec3, so .w had never once been read.
  // SPK_SHADE — a shaded facet still catches the bright part of the sky. Not
  //   a sun glint and nowhere near one, but the alternative measured 0.0
  //   glints per 10 000 px against 79 in the sun, which is a dead plane.
  SKY_ANISO: 1.15,
  SKY_GLOW_LIFT: 0.22,
  SKY_CAV: 1.30,
  SPK_SHADE: 0.10,
};

const FIXED = new Set(['TABLE']);

/** Emit every SNOW value as a GLSL `const float S_NAME`. */
export function snowConstsGLSL() {
  let out = '';
  for (const [k, v] of Object.entries(SNOW)) {
    if (typeof v !== 'number') continue;
    const s = FIXED.has(k) ? v.toFixed(1) : String(Number(v.toPrecision(9)));
    out += `const float S_${k} = ${s.includes('.') || s.includes('e') ? s : s + '.0'};\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Noise + the height field. Used by the terrain vertex shader, the probe
// shader (CPU/GPU agreement self-check) and the tuft placement shader.
// ---------------------------------------------------------------------------
export const SNOW_FIELD_GLSL = /* glsl */ `
uniform sampler2D uPerm;
uniform vec2 uWindXZ;       // unit wind direction, world XZ
uniform vec2 uPadCenter;
uniform float uHeightBias;  // so the surface passes through y=0 at the pad

vec2 sn_grad(vec2 i){
  vec2 uv = (mod(i, S_TABLE) + 0.5) * (1.0 / S_TABLE);
  return texture2D(uPerm, uv).xy * 2.0 - 1.0;
}

// Gradient noise, ~[-1,1], zero mean.
float sn_gn(vec2 x){
  vec2 i = floor(x);
  vec2 f = x - i;
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  float a = dot(sn_grad(i),                  f);
  float b = dot(sn_grad(i + vec2(1.0,0.0)),  f - vec2(1.0,0.0));
  float c = dot(sn_grad(i + vec2(0.0,1.0)),  f - vec2(0.0,1.0));
  float d = dot(sn_grad(i + vec2(1.0,1.0)),  f - vec2(1.0,1.0));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y) * 1.44;
}

// Band-limit weight for an octave of wavelength w sampled every fw metres.
float sn_lod(float w, float fw){
  return 1.0 - smoothstep(w*S_LOD_LO, w*S_LOD_HI, fw);
}

// Sharp-crested ridge, zero mean: crests are creases, hollows are broad.
float sn_ridge(vec2 q){
  float n = sn_gn(q);
  float r = 1.0 - abs(n);
  return mix(r, r*r, S_RIDGE_ROUND) - S_RIDGE_MEAN;
}

/**
 * The snow surface.
 *   p   world XZ (metres)
 *   fw  local sample spacing (metres) — band-limits the octaves
 * Extra outputs feed the shading: crest proximity, wind exposure, calm-pad
 * factor and the ripple field.
 */
float sn_field(vec2 p, float fw, out float oSast, out float oExpo, out float oPad, out float oRip){
  vec2 W = uWindXZ;
  vec2 A = vec2(-W.y, W.x);
  float al = dot(p, W);
  float ac = dot(p, A);

  float h = 0.0;
  h += S_DUNE0_AMP * sn_gn(vec2(ac*S_DUNE0_AC, al*S_DUNE0_AL)) * sn_lod(S_DUNE0_SIZE, fw);
  h += S_DUNE1_AMP * sn_gn(vec2(ac*S_DUNE1_AC, al*S_DUNE1_AL)) * sn_lod(S_DUNE1_SIZE, fw);
  // The second dune scale doubles as the wind-exposure field: the surface is
  // scoured on the drift crests and collects soft snow in the hollows, so one
  // noise sample legitimately serves both. Every sample here costs four vertex
  // texture fetches and this function runs seven times per vertex.
  float d2 = sn_gn(vec2(ac*S_DUNE2_AC + 13.71, al*S_DUNE2_AL + 5.13)) * sn_lod(S_DUNE2_SIZE, fw);
  h += S_DUNE2_AMP * d2;
  oExpo = clamp(0.5 + 0.5 * d2, 0.0, 1.0);

  float wob = sn_gn(p*S_PAD_WOB_F + vec2(57.2, 23.8)) * sn_lod(S_PAD_WOB_SIZE, fw);
  float pr  = length(p - uPadCenter) * (1.0 + S_PAD_WOBBLE * wob);
  float pad = mix(S_PAD_MIN, 1.0, smoothstep(S_PAD_R0, S_PAD_R1, pr));
  float core = mix(S_CORE_MIN, 1.0, smoothstep(S_CORE_R0, S_CORE_R1, pr));
  // oPad carries pad * core: that product is what the shadow taps need, and
  // it is the only form the shading uses.
  oPad = pad * core;

  float mnd = sn_gn(vec2(ac*S_MEAND_AC + 31.13, al*S_MEAND_AL + 7.31)) * sn_lod(S_MEAND_SIZE, fw);
  float alw = al + S_MEAND_AMP * mnd;
  float acw = ac;

  // Shear the along-wind coordinate by the coarse ridge value: crests migrate
  // upwind, which compresses the windward face and stretches the lee slope.
  float s0 = sn_ridge(vec2(acw*(1.0/S_SAST_ACROSS), alw*(1.0/S_SAST_ALONG))) * sn_lod(S_SAST_ACROSS, fw);
  float alS = alw - S_SAST_SKEW * s0;

  float s = sn_ridge(vec2(acw*(1.0/S_SAST_ACROSS),           alS*(1.0/S_SAST_ALONG)))          * sn_lod(S_SAST_ACROSS, fw)
    + S_SAST_G2 * sn_ridge(vec2(acw*(S_SAST_L2/S_SAST_ACROSS) + 11.21, alS*(S_SAST_L2/S_SAST_ALONG) + 3.77)) * sn_lod(S_SAST_ACROSS/S_SAST_L2, fw)
    + S_SAST_G3 * sn_ridge(vec2(acw*(S_SAST_L3/S_SAST_ACROSS) + 27.53, alS*(S_SAST_L3/S_SAST_ALONG) + 8.19)) * sn_lod(S_SAST_ACROSS/S_SAST_L3, fw);
  s *= 1.0 / (1.0 + S_SAST_G2 + S_SAST_G3);
  oSast = s;
  h += S_SAST_AMP * pad * (0.55 + 0.8*oExpo) * s;

  float r = sn_ridge(vec2(alw*(1.0/S_RIP_LEN), acw*(1.0/S_RIP_ACROSS))) * sn_lod(S_RIP_LEN, fw);
  oRip = r;
  // Ripples only form where the wind actually works the surface, so gate
  // them hard on exposure instead of dressing the whole field in corduroy.
  h += S_RIP_AMP * smoothstep(S_RIP_GATE0, S_RIP_GATE1, oExpo) * r;

  return (h - uHeightBias) * core;
}

float sn_fieldH(vec2 p, float fw){
  float a, b, c, d;
  return sn_field(p, fw, a, b, c, d);
}

/**
 * Reduced height for the horizon-shadow taps: the two drift scales and the two
 * coarse sastrugi octaves, with the calm-pad factor passed in from the centre
 * sample rather than re-derived. Everything omitted is either slower-varying
 * than the tap spacing or shallower than the terminator's own softness — and
 * this runs once per tap per vertex, so it is worth halving.
 */
float sn_tapH(vec2 p, float fw, float padCore){
  vec2 W = uWindXZ;
  vec2 A = vec2(-W.y, W.x);
  float al = dot(p, W);
  float ac = dot(p, A);
  // DUNE0 is deliberately absent. The taps reach at most ~fw*38 and the swell
  // has a 190 m cell, so over the whole tap fan it is a straight ramp of at
  // most 0.026 rad — well under the terminator's own softness — and it is
  // omitted from h0 and hk alike, so it cannot bias the occlusion either way.
  float h = S_DUNE1_AMP * sn_gn(vec2(ac*S_DUNE1_AC, al*S_DUNE1_AL)) * sn_lod(S_DUNE1_SIZE, fw);
  float d2 = sn_gn(vec2(ac*S_DUNE2_AC + 13.71, al*S_DUNE2_AL + 5.13)) * sn_lod(S_DUNE2_SIZE, fw);
  h += S_DUNE2_AMP * d2;
  float expo = clamp(0.5 + 0.5 * d2, 0.0, 1.0);
  float s = sn_ridge(vec2(ac*(1.0/S_SAST_ACROSS), al*(1.0/S_SAST_ALONG))) * sn_lod(S_SAST_ACROSS, fw)
    + S_SAST_G2 * sn_ridge(vec2(ac*(S_SAST_L2/S_SAST_ACROSS) + 11.21, al*(S_SAST_L2/S_SAST_ALONG) + 3.77)) * sn_lod(S_SAST_ACROSS/S_SAST_L2, fw);
  s *= 1.0 / (1.0 + S_SAST_G2);
  h += S_SAST_AMP * padCore * (0.55 + 0.8 * expo) * s;
  return h * padCore;
}
`;

// ---------------------------------------------------------------------------
// Footprint deformation field, sampled from the scrolling render target.
// ---------------------------------------------------------------------------
export const SNOW_FOOTPRINT_GLSL = /* glsl */ `
uniform sampler2D uFoot;
uniform vec3 uFootOrigin;   // xy = world XZ of the target centre, z = 1/size

vec3 sn_footTexel(vec2 p){
  vec2 uv = (p - uFootOrigin.xy) * uFootOrigin.z + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
  return texture2D(uFoot, uv).xyz;
}

// Metres of vertical displacement. The rim is suppressed inside a depression so
// a later print destroys an earlier print's rim instead of standing on it.
float sn_footH(vec3 t){
  return t.y * S_FP_MAXRIM * (1.0 - t.x) - t.x * S_FP_MAXDEPTH;
}
float sn_footH(vec2 p){ return sn_footH(sn_footTexel(p)); }
`;

// ---------------------------------------------------------------------------
// Terrain vertex shader.
// ---------------------------------------------------------------------------
export const SNOW_VERT = /* glsl */ `
precision highp float;

attribute vec4 aMeta;       // x: sample spacing, y: skirt, zw: stitch offset

varying vec3 vWorld;
varying vec3 vNormal;
varying vec4 vFields;       // sastrugi, exposure, pad, ripple
varying float vSunOcc;      // horizon self-shadow along the sun direction
varying float vFw;          // sample spacing, for the debug views

uniform vec3 uSunDir;
uniform float uSkirtDrop;

#include <common>
#include <shadowmap_pars_vertex>

SNOW_CONSTS
SNOW_FIELD
SNOW_FOOTPRINT

void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 p = wp.xz;
  float fw = aMeta.x;

  float sast, expo, pad, rip;
  float h = sn_field(p, fw, sast, expo, pad, rip);
  vFields = vec4(sast, expo, pad, rip);
  vFw = fw;

  // Surface normal from forward differences of the same height function. The
  // footprint field is deliberately left out — the fragment stage adds it back
  // at full render-target resolution, which is finer than this tessellation.
  float e = max(S_NRM_EPS, fw * 0.5);
  float hx = sn_fieldH(p + vec2(e, 0.0), fw);
  float hz = sn_fieldH(p + vec2(0.0, e), fw);
  vec3 nrm = normalize(vec3(-(hx - h) / e, 1.0, -(hz - h) / e));

  // Long ridge shadows. The sun sits 4-8 degrees up, so a 12 cm crest throws a
  // metre of shade; the shadow map only covers ~1.5 m around the fox, so the
  // field needs its own horizon term or it reads dead flat.
  float occ = 0.0;
  #if SUN_TAPS > 0
  {
    vec2 sd = normalize(uSunDir.xz + vec2(1e-5, 0.0));
    float tanE = uSunDir.y / max(length(uSunDir.xz), 1e-4);
    // Tap distances scale with the local sample rate, so every clipmap level
    // shadows the features it can actually resolve: centimetre sastrugi near
    // the fox, fifty-metre dunes at the horizon.
    // Start just past the ripple scale so the near field is shaded by sastrugi
    // (0.3-2 m shadows at this sun angle) rather than dressed in corduroy.
    float d = max(0.15, fw * 2.4);
    // Compare like with like: the reduced tap height is also evaluated at the
    // centre, so the omitted terms cannot bias the occlusion.
    float padCore = vFields.z;
    float h0 = sn_tapH(p, fw, padCore);
    for (int i = 0; i < SUN_TAPS; i++) {
      float hk = sn_tapH(p + sd * d, fw, padCore);
      // The divisor is the sun's angular size in metres of height at that
      // distance: a real terminator this low is nearly hard.
      occ = max(occ, (hk - h0 - d * tanE) / (d * 0.022 + 0.010));
      d *= 2.0;
    }
  }
  #endif
  vSunOcc = clamp(occ, 0.0, 1.0);

  h += sn_footH(p);
  if (aMeta.z != 0.0 || aMeta.w != 0.0) {
    // Stitch vertex: sit exactly on the chord of the next coarser level so the
    // T-junction at a clipmap boundary cannot crack.
    vec2 o = aMeta.zw;
    float hA = sn_fieldH(p - o, fw) + sn_footH(p - o);
    float hB = sn_fieldH(p + o, fw) + sn_footH(p + o);
    h = 0.5 * (hA + hB);
  }
  h -= aMeta.y * uSkirtDrop;

  vec3 worldPos = vec3(wp.x, h, wp.z);
  vWorld = worldPos;
  vNormal = nrm;

  vec4 worldPosition = vec4(worldPos, 1.0);
  vec4 mvPosition = viewMatrix * worldPosition;
  vec3 transformedNormal = normalMatrix * nrm;
  gl_Position = projectionMatrix * mvPosition;


  // NO NORMAL-OFFSET BIAS ON THE SNOW.
  //
  // three's shadowmap_vertex chunk moves the receive point along the surface
  // normal by shadowNormalBias (22 mm, set in Environment) before projecting
  // into light space. That exists to stop a surface self-shadowing in its own
  // depth map. The snowfield is NOT IN THE SHADOW MAP -- only the fox body is
  // rendered into it -- so it cannot self-shadow and has nothing to gain.
  //
  // What it costs is peter-panning, and on a near-horizontal receiver the cost
  // is large: lifting the receiver b metres shortens every cast shadow by
  // b / tan(elevation).
  //     14 deg   0.022 / 0.249 =  88 mm
  //      6.6 deg 0.022 / 0.116 = 190 mm
  //      2 deg   0.022 / 0.035 = 630 mm     (the paw is 40 mm across)
  // So project the true surface point, and let snShadowMask own all of the
  // slack, where it can be made proportional to the depth gradient.
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
    vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * worldPosition;
  }
  #endif
}
`;

// ---------------------------------------------------------------------------
// Terrain fragment shader — the snow BRDF.
// ---------------------------------------------------------------------------
export const SNOW_FRAG = /* glsl */ `
precision highp float;

varying vec3 vWorld;
varying vec3 vNormal;
varying vec4 vFields;
varying float vSunOcc;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunInt;
uniform vec3 uSkyColor;
uniform float uSkyInt;
uniform vec3 uBounce;
uniform float uBounceInt;
uniform vec3 uAlbedo;
uniform vec3 uDeepTint;
uniform sampler2D uDetail;
uniform vec4 uDetailScale;   // world tile sizes: micro, grain, ripple, (aniso)
uniform vec3 uSparkle;       // intensity, spread, threshold
uniform vec3 uAurora;        // radiance the aurora throws down (0 by day)
uniform vec3 uSheen;   // roughness fresh, roughness packed, specular scale         // roughness fresh, roughness packed
uniform float uSSS;
uniform vec3 uAerial;   // density, strength, hue-vs-grey
uniform vec3 uHaze;
// AIRLIGHT. The radiance a ray reaches once it has crossed enough air to
// forget what it started on -- i.e. the horizon haze band's own radiance,
// published by SnowMaterial from the SAME unit-luminance #aac4e0 and the same
// lit-snow level that src/world/Horizon.js gives the ice fog. x/y/z is that
// radiance, w is the exponential-squared density. See the note at the fog
// term at the end of main().
uniform vec4 uAirlight;
// 0 off. 1 shadow mask, 2 ridge self-shadow, 3 clipmap level, 4 sparkle,
// 5 detail normal, 6 compaction. Debug only; costs one uniform compare.
uniform float uDebugView;
varying float vFw;

#include <common>
#include <packing>
#include <shadowmap_pars_fragment>

/**
 * Our own shadow lookup.
 *
 * three clears the shadow map with the renderer's clear colour rather than
 * white, so a texel no caster ever wrote holds a bogus near-plane depth and
 * three's VSMShadow() reports full occlusion for it — the entire shadow
 * frustum comes out black. uShadowEmpty carries the clear colour's linear red
 * so those texels can be recognised and treated as open sky. We also feather
 * the frustum edge, because the sun's shadow camera is a tight box around the
 * fox and a hard rectangle edge across the snow is worse than no shadow.
 */
uniform float uShadowEmpty;
uniform vec2  uShadowTexel;   // 1 / shadow map size
uniform vec2  uShadowBias;    // x: constant depth slack · y: slack in TEXELS
// A/B handle for the three terms that put relief back into shaded snow:
// x sky anisotropy · y micro cavity · z sparkle-in-shade. All 1.0 in the
// product. Zeroing all three reproduces the pre-REVIEW-6 shading exactly, so
// the effect can be measured against its own absence inside ONE page session
// at ONE instant, rather than across two trees with six other agents
// committing into them. See S_SKY_ANISO.
uniform vec3  uShade;
// Mean of the detail map's cavity channel, read back off the baked target at
// init. See the cavD block in main().
uniform float uDetailAoDC;
// DISTANCE-DEPENDENT PENUMBRA. See the block above the filter in
// snShadowMask() for the derivation; SnowMaterial._updatePenumbra() owns the
// numbers.
//   x  shadow-map UV filter RADIUS per metre of caster-to-receiver distance.
//      0 disables the filter entirely and restores the single-tap lookup
//      exactly, which is the null arm of every A/B below.
//   y  ceiling on that radius, UV.
//   z  height of the top of the animal above the snow, metres.
//   w  spare.
uniform vec4  uPenumbra;
uniform vec2  uCasterXZ;   // world x,z the animal stands on
vec4 gShadowDbg;   // c.xy, m.x, m.y — debug views 7/8

#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
/**
 * One variance-shadow lookup, Chebyshev-remapped. Split out of snShadowMask()
 * so the penumbra filter can call it per tap; mOut hands the raw moments
 * back for the debug views without paying a second fetch.
 */
float sn_vsmTap(vec2 uv, float z, out vec2 mOut){
  // The VSM target packs (mean depth, std deviation) as two halves per RGBA8.
  vec2 m = unpackRGBATo2Half(texture2D(directionalShadowMap[ 0 ], uv));
  mOut = m;
  if (m.x <= uShadowEmpty) return 1.0;
  if (step(z, m.x) == 1.0) return 1.0;
  float d = z - m.x;
  float v = max(m.y * m.y, 2.5e-6);
  float p = v / (v + d * d);
  return clamp((p - 0.15) / 0.55, 0.0, 1.0);
}
#endif

float snShadowMask(){
  gShadowDbg = vec4(0.0, 0.0, -1.0, -1.0);
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  vec4 sc = vDirectionalShadowCoord[ 0 ];
  vec3 c = sc.xyz / sc.w;
  gShadowDbg = vec4(c.xy, -2.0, c.z);
  // three's own constant shadowBias is deliberately NOT applied: see the note
  // in the vertex stage. All slack on this receiver is the measured
  // receiver-plane term below, and nothing else.

  // RECEIVER-PLANE DEPTH BIAS (Isidoro 2006), computed BEFORE any branch so
  // the derivatives are taken in uniform control flow.
  //
  // What was here was a flat 'c.z -= 0.014', labelled slope-scaled but
  // constant. Over this frustum's 9.5 m depth range that is 133 mm of depth,
  // and a depth offset displaces a shadow ALONG THE GROUND by offset/sin(sun
  // elevation): 1.16 m at the default 6.6 degree sun and 0.55 m at 14
  // degrees. The animal is 0.55 m long. That single line is why the shadow
  // detaches from the feet, why there is no contact darkening under a paw at
  // any angle, and why the detachment gets WORSE as the sun gets lower --
  // measured as a fully separated blob at --sun 14,-30 and reported twice.
  //
  // What the bias actually has to cover is the VSM blur: the map is blurred
  // over a few texels, so the stored mean depth near a silhouette is pulled
  // off the true surface by however much depth changes across that many
  // texels. That is a per-texel quantity, so measure it. dz/du and dz/dv come
  // from solving the 2x2 screen-to-shadow-UV Jacobian; multiply by the texel
  // size and by the blur width in texels and the slack is exactly as large as
  // it needs to be and no larger. On a surface facing the light it collapses
  // to nearly nothing, which is what puts the shadow back under the feet.
  vec3 sdx = dFdx(c), sdy = dFdy(c);
  float sdet = sdx.x * sdy.y - sdx.y * sdy.x;
  vec2 dzduv = abs(sdet) > 1e-12
    ? vec2(sdy.y * sdx.z - sdx.y * sdy.z, sdx.x * sdy.z - sdy.x * sdx.z) / sdet
    : vec2(0.0);
  float slack = uShadowBias.x + uShadowBias.y *
    (abs(dzduv.x) * uShadowTexel.x + abs(dzduv.y) * uShadowTexel.y);

  vec2 dd = abs(c.xy - 0.5);
  float edge = 1.0 - smoothstep(0.40, 0.495, max(dd.x, dd.y));
  if (edge <= 0.001 || c.z > 1.0 || c.z < 0.0) return 1.0;
  // The clamp is what remains of the peter-panning at a grazing sun. The
  // receiver-plane term is proportional to cot(elevation), so it runs away as
  // the sun drops: at 2 degrees six texels of slack is 0.026 of normalised
  // depth, and even the old 0.02 ceiling is 190 mm of depth, i.e. a 190 mm gap
  // between the paw and the start of its own shadow. Since this receiver is
  // not in the shadow map it cannot produce acne, so the ceiling is set by
  // what the VSM blur can leak, not by self-shadowing: 0.005 is 48 mm, about
  // one paw.
  c.z -= min(slack, 0.005);

  vec2 m;
  float occ = sn_vsmTap(c.xy, c.z, m);
  gShadowDbg = vec4(c.xy, m.x, c.z);

  // --- THE PENUMBRA HAS TO WIDEN WITH DISTANCE FROM THE CASTER -------------
  //
  // The sun is not a point: it subtends 0.533 degrees, so a straight edge
  // held D metres above a surface throws a penumbra D * tan(0.533) = 9.3 mm
  // per metre wide. At the default 6.6 degree rig the animal's shadow is
  // displaced downsun by height / tan(elev) = 8.64 x height, so ONE frame
  // holds caster distances from 0 at the paw to 4.5 m at the tip of the body
  // shadow -- 0 mm of penumbra under the foot and 42 mm at the far end.
  //
  // What we had instead was sun.shadow.radius = 4.5, a FIXED box blur of the
  // shadow map, and it does not even deliver a fixed penumbra: three's
  // Chebyshev remap collapses the blur's coverage ramp into the sliver
  // between 72% and 90% coverage, so the drawn edge measured 6.3 mm at every
  // caster distance from 0 to 4 m -- which is this probe's hard-edge floor.
  // 1.11x of variation where the sun's angular size demands 15x.
  //
  // So: PCSS, with the blocker search replaced by geometry.
  //
  // A blocker search is N more taps per pixel and the previous lighting agent
  // could not cost it. It is also not needed HERE, because this receiver is a
  // near-horizontal snowfield and the caster is one animal standing on it.
  // For a flat receiver the arithmetic is exact and closed-form: a caster
  // point h above the ground lands its shadow s = h / tan(e) downsun, and the
  // distance it travelled along the light ray to get there is h / sin(e) =
  // s / cos(e). So the caster distance at a shadow point is just its DOWNSUN
  // DISTANCE from the animal's own ground point, divided by cos(elevation) --
  // no taps, no depth readback, and exact at every sun elevation including
  // overhead.
  //
  // Two honest error terms, both bounded and both erring crisp:
  //   * the animal is 0.55 m long, so measuring s from its centroid is worth
  //     up to +-0.3 m of caster distance, i.e. +-2.8 mm of penumbra;
  //   * the receiver is sastrugi, not a plane, but its relief is centimetres
  //     against metres of s.
  // The uPenumbra.z / sin(e) ceiling is the physical one: nothing on this
  // animal is higher than the top of its head, so no part of its shadow can
  // have been cast from further away than that.
  //
  // The taps average the OCCLUSION, not the moments. Averaging moments over a
  // wide kernel is a wider VSM blur, and a wider VSM blur is exactly what
  // does not work here -- the variance grows with the kernel and Chebyshev
  // reads growing variance as light leaking. Averaging near-binary taps gives
  // a coverage ramp, which is what a penumbra is.
  float rad = 0.0;
  if (uPenumbra.x > 0.0) {
    float cosE = length(uSunDir.xz);
    float sinE = max(uSunDir.y, 1e-3);
    vec2  dsun = -uSunDir.xz / max(cosE, 1e-4);          // horizontal, downsun
    float s    = dot(vWorld.xz - uCasterXZ, dsun);
    float cd   = min(max(s, 0.0) / max(cosE, 0.10), uPenumbra.z / sinE);
    rad = min(cd * uPenumbra.x, uPenumbra.y);
  }
#if SN_PEN_TAPS > 0
  if (rad > uShadowTexel.x) {
    // Golden-angle spiral: area-uniform radii, and the whole pattern is
    // rotated per pixel by an interleaved-gradient hash so the ramp reads as
    // grain that TAA resolves rather than as N discrete steps. Deterministic
    // in gl_FragCoord, so rule 6 holds.
    float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy,
                                             vec2(0.06711056, 0.00583715))));
    float a = 6.2831853 * ign;
    vec2 dir = vec2(cos(a), sin(a));
    float sum = occ;
    for (int i = 0; i < SN_PEN_TAPS; i++) {
      vec2 o = dir * (sqrt((float(i) + 0.5) / float(SN_PEN_TAPS)) * rad);
      // Receiver-plane depth at the tap, from the Jacobian above. Without it
      // a tap offset 18 mm downsun compares against the CENTRE's depth, and
      // at 6.6 degrees 18 mm of depth is 157 mm of ground -- the filter would
      // smear the shadow along the sun instead of softening its edge.
      vec2 md;
      sum += sn_vsmTap(c.xy + o, c.z + clamp(dot(dzduv, o), -0.02, 0.02), md);
      dir = vec2(dir.x * -0.73736888 - dir.y * 0.67549029,
                 dir.x *  0.67549029 + dir.y * -0.73736888);
    }
    occ = sum / float(SN_PEN_TAPS + 1);
  }
#endif
  return mix(1.0, mix(1.0, occ, directionalLightShadows[ 0 ].shadowIntensity), edge);
#else
  return 1.0;
#endif
}

/**
 * SUBJECT CONTACT OCCLUSION.
 *
 * A cast shadow is DIRECT light removed, and it therefore carries a factor of
 * sin(sun elevation): at 2 degrees the beam delivers 3.5% of its normal
 * irradiance to a horizontal surface, so even a geometrically perfect shadow
 * is invisible. What tells the eye that a body is TOUCHING the ground is the
 * other half -- the sky and the snow bounce that the body blocks -- and that
 * has no elevation term at all. It is the same at noon and at 2 degrees, and
 * we were rendering none of it: snow under a paw measured within a level of
 * snow 400 px away at every angle.
 *
 * Analytic, from a handful of spheres fitted to the live skeleton
 * (SnowMaterial._occluders), not from the depth buffer: screen-space AO at
 * this scale is the thing that produced the picket-fence lattice, and a
 * 0.085 m kernel cannot see a 0.25 m belly anyway.
 *
 * Per sphere this is the standard far-field solid-angle term
 * cos(theta) * r^2 / d^2, saturated inside the sphere, combined as a
 * visibility product so several overlapping spheres cannot exceed 1. Unused
 * slots carry w = 0, which makes their term exactly 0 with no branch.
 */
uniform vec4 uOccl[ SN_OCCL ];   // world xyz, radius. w = 0 disables a slot.
uniform vec4 uOcclBound;         // world xyz of the subject, w = cull radius
uniform vec2 uOcclMix;           // x: sky attenuation · y: bounce attenuation

float snContactOcc(vec3 p, vec3 n){
  vec3 db = p - uOcclBound.xyz;
  float d2 = dot(db, db);
  float R = uOcclBound.w;
  // One rejection for the whole frame outside a 1.4 m ball around the animal,
  // which is all but a few percent of the snow pixels in a wide shot.
  if (R <= 0.0 || d2 > R * R) return 0.0;
  float vis = 1.0;
  for (int i = 0; i < SN_OCCL; i++) {
    vec4 s = uOccl[ i ];
    vec3 d = s.xyz - p;
    float l2 = max(dot(d, d), 1e-6);
    float r2 = s.w * s.w;
    float nl = clamp(dot(n, d) * inversesqrt(l2), 0.0, 1.0);
    vis *= 1.0 - min(nl * r2 / max(l2, r2), 0.97);
  }
  // Feather the cull boundary so the ball has no edge of its own.
  return (1.0 - vis) * (1.0 - smoothstep(R * 0.62, R, sqrt(d2)));
}

SNOW_CONSTS
SNOW_FIELD
SNOW_FOOTPRINT

float sn_hash21(vec2 c){
  // Cell hash for sparkle seeding. Not shared with the CPU, so a float hash is
  // fine here; it only has to be stable frame to frame.
  vec3 p3 = fract(vec3(c.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 sn_hash23(vec2 c){
  vec3 p3 = fract(vec3(c.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

// Detail normal, tangent space, from the baked tileable map.
//
// xy is the tangent-space normal, z the crystal density, w the height-proxy
// cavity occlusion (DETAIL_BAKE_FRAG writes 0.5 + h * 0.7 there). This used
// to return a vec3 and drop w on the floor, so the one channel in the map
// that says which micro-facets can see the sky was baked every run and never
// read. See S_SKY_CAV.
vec4 sn_detail(vec2 uv, float scale){
  vec4 t = texture2D(uDetail, uv * scale);
  return vec4(t.xy * 2.0 - 1.0, t.zw);
}

/**
 * Discrete crystal glints.
 *
 * Three world-locked lattices with power-of-four cell sizes; each cell carries
 * one jittered feature point and one random micro-facet normal, and lights up
 * only when that facet nearly bisects the view and sun vectors. Cross-fading
 * the lattices by the pixel footprint keeps every visible glint 2-4 px wide, so
 * they twinkle instead of aliasing into white noise.
 */
/**
 * Discrete crystal glints.
 *
 * The returned values are deliberately far above the exposed range of
 * everything else in frame (the lit coat sits around 1.0-1.3). A bloom pass
 * needs an absolute threshold that catches glints and nothing else, so a
 * facet that fires has to land in the tens, not at 1.2. On the direct path
 * these clip to white anyway — which is exactly what a glint looks like.
 *
 * PERSPECTIVE. This used to lock the ACTIVE lattice to a fixed screen cell
 * size and the dot to a fixed quarter of a cell, so a glint was ~3 px wide
 * everywhere: the same size at the horizon as at your feet. Scaled to a
 * 390 px phone that is confetti, and it was the single most artificial thing
 * on the snow. Two changes fix it and neither costs an instruction in the
 * inner loop:
 *
 *  1. The dot's screen radius is now computed from a real world size
 *     (S_SPK_R_M, a facet cluster plus the lens PSF) and the ACROSS-view
 *     pixel footprint. px is max(|dFdx|,|dFdy|) and on a grazing ground
 *     plane |dFdy| carries a 1/sin(grazing) stretch that reaches 100x — it
 *     is the right Nyquist limit but a useless distance proxy. |dFdx| is
 *     just distance * pixel-angle, which is exactly what perspective needs.
 *     A glint is ~2.6 px at 3 m, 1 px at 10 m and sub-pixel past ~25 m.
 *
 *  2. Below one pixel a glint cannot be drawn smaller, so it is drawn at
 *     S_SPK_R_MIN and dimmed by the area ratio instead. The hit probability
 *     rises as distance^2 (the world-locked lattice puts more cells in a
 *     pixel) while the per-glint peak falls as distance^-2, so the MEAN
 *     radiance is preserved and only the contrast drops: discrete glints
 *     near, a smooth shimmer far. That is what snow does.
 *
 * The octave weights are also a proper partition of unity now. Neighbouring
 * cells are 4x apart (2 in log2) and the old half-width of 1/0.72 = 1.39
 * meant the weights summed to 1.0 on an octave centre and 0.56 midway
 * between two — a 1.8x density ripple every two stops of distance, which is
 * the horizontal band in the sparkle a critic measured at y=250-300 in
 * terrain.png. A half-width of exactly 2 sums to 1 at every distance.
 */
vec3 sn_sparkle(vec3 N, vec3 V, vec3 L, vec2 p, float px, float pxIso, float density){
  vec3 Hv = normalize(L + V);
  vec3 T = normalize(cross(N, vec3(1.0, 0.0, 0.0)));
  vec3 B = cross(N, T);
  float acc = 0.0;
  // The ladder always ENDS at S_SPK_CELL_MAX, so dropping octaves at a lower
  // tier drops the finest crystals rather than the coarse world-locked ones
  // the far field depends on.
  float cell = S_SPK_CELL_MAX / pow(4.0, float(SPARKLE_OCT - 1));
  // Near the camera, track the pixel footprint so glints stay separated and
  // resolvable; past that, world-lock, and let statistics take over.
  float target = clamp(px * 5.88, cell, S_SPK_CELL_MAX);
  // Screen radius this glint should have, and the energy correction for
  // having to draw it at S_SPK_R_MIN when it is smaller than that.
  float rPix = S_SPK_R_M / max(pxIso, 1e-6);
  float rUse = clamp(rPix, S_SPK_R_MIN, S_SPK_R_MAX);
  float sub = min(1.0, rPix / S_SPK_R_MIN);
  float amp = sub * sub;
  float rWorld = rUse * pxIso;
  for (int k = 0; k < SPARKLE_OCT; k++) {
    float w = clamp(1.0 - abs(log2(cell / target)) * 0.5, 0.0, 1.0);
    if (w > 0.004) {
      vec2 q = p / cell;
      vec2 ip = floor(q);
      vec2 fp = q - ip;
      // The feature point is confined to the middle half of its cell and the
      // dot radius is capped at a quarter of a cell, so no dot can ever cross
      // a cell border: one lookup is exact where a 2x2 neighbourhood would
      // normally be needed, and the whole term costs a quarter as much.
      vec3 r = sn_hash23(ip + vec2(cell * 131.0));
      vec2 fpt = r.xy * 0.5 + 0.25 - fp;
      float dd = dot(fpt, fpt);
      float rc = min(rWorld / cell, 0.25);
      float r2 = rc * rc;
      if (dd < r2) {
        // Tight core: the energy belongs in one or two pixels, not spread
        // over five, or the peak never clears the bloom threshold.
        float dot0 = 1.0 - smoothstep(r2 * 0.13, r2, dd);
        // Facet orientation is parameterised by ANGLE, not by a tangent
        // offset: with a 6 degree sun and a low camera the half-vector sits
        // ~60 degrees off the surface normal, and a tilt vector added to N can
        // never swing that far. Ice crystals sit at every angle.
        vec2 az = vec2(r.z, fract(r.z * 91.73)) * 2.0 - 1.0;
        az *= inversesqrt(max(dot(az, az), 1e-4));
        float th = 0.04 + uSparkle.y * fract(r.z * 37.13);
        float ct = cos(th), st = sin(th);
        // N, T, B are orthonormal, so this is already unit length.
        float al = dot(N * ct + (T * az.x + B * az.y) * st, Hv);
        acc += exp2(-(1.0 - al) * uSparkle.z) * dot0 * w;
      }
    }
    cell *= 4.0;   // one octave of glint scale per two stops of distance
  }
  return acc * amp * density * uSparkle.x * mix(uSunColor, vec3(0.86, 0.94, 1.0), 0.25);
}

void main(){
  vec3 N = normalize(vNormal);
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);
  vec3 L = uSunDir;
  vec2 p = vWorld.xz;

  float px = max(length(dFdx(vWorld)), length(dFdy(vWorld)));
  // Across-view footprint. On a ground plane seen from a metre up, dFdy is
  // stretched by 1/sin(grazing) — up to ~100x at the horizon — so it is the
  // right band-limit but the wrong distance measure. dFdx is distance times
  // the pixel angle, which is what perspective scaling needs.
  float pxIso = length(dFdx(vWorld));

  // --- footprint: displacement gradient + compaction ------------------------
  float fe = max(px, S_FP_SIZE / 1024.0);
  vec3 ft = sn_footTexel(p);
  float comp = clamp(ft.z, 0.0, 1.0);
  if (dot(ft, ft) > 1e-8) {
    float f0 = sn_footH(ft);
    float fx = sn_footH(p + vec2(fe, 0.0));
    float fz = sn_footH(p + vec2(0.0, fe));
    N = normalize(N + vec3(-(fx - f0) / fe, 0.0, -(fz - f0) / fe));
  }

  // --- detail normals -------------------------------------------------------
  vec2 W = uWindXZ;
  vec2 A = vec2(-W.y, W.x);
  vec2 wuv = vec2(dot(p, A), dot(p, W));       // wind-aligned UV
  float wRip = 1.0 - smoothstep(uDetailScale.z * 0.9, uDetailScale.z * 5.0, px);
  float wGrn = 1.0 - smoothstep(uDetailScale.y * 0.9, uDetailScale.y * 5.0, px);
  float wMic = 1.0 - smoothstep(uDetailScale.x * 0.9, uDetailScale.x * 5.0, px);

  vec4 dRip = vec4(0.0, 0.0, 0.5, 0.5), dGrn = vec4(0.0, 0.0, 0.5, 0.5), dMic = vec4(0.0, 0.0, 0.5, 0.5);
  if (wRip > 0.01) dRip = sn_detail(vec2(wuv.x + wuv.y * 0.11, wuv.y * uDetailScale.w) / uDetailScale.z, 1.0);
  // The grain and micro layers used to be ISOTROPIC, and nothing on a polar
  // snow surface is. The wind works the surface at every scale, so both are
  // stretched along it the way the ripple layer already was. It matters for
  // more than plausibility: the medium layer tiles at 0.32 m, which at the
  // terrain framing is ~150 screen px, i.e. squarely inside the band the eye
  // reads relief in -- so isotropic grain is mottle competing with the
  // ridges, and stretched grain is streaks agreeing with them. wuv.y is the
  // ALONG-wind coordinate, so scaling it below 1 lengthens the features.
  if (wGrn > 0.01) dGrn = sn_detail(vec2(wuv.x, wuv.y * S_DET_GRN_ANISO) / uDetailScale.y + vec2(0.37, 0.61), 1.0);
  if (wMic > 0.01) dMic = sn_detail(vec2(wuv.x, wuv.y * S_DET_MIC_ANISO) / uDetailScale.x + vec2(0.11, 0.83), 1.0);

  // Wind slab on the crest, soft catch in the trough. See S_SLAB_* in
  // snow.glsl.js. Everything downstream uses (slab - 0.5) so the mean of the
  // field is untouched and only its VARIATION grows.
  float slab = saturate(0.5 + vFields.x * S_SLAB_K);
  float slabD = slab - 0.5;
  float packed = clamp(vFields.y * 0.85 + comp * 0.6 + S_SLAB_PACK * slabD, 0.0, 1.0);
  float soft = 1.0 - packed;
  vec2 dn = dRip.xy * (wRip * (0.30 + 0.34 * vFields.y))
          + dGrn.xy * (wGrn * (0.34 + 0.34 * soft))
          + dMic.xy * (wMic * (0.26 + 0.20 * soft));
  dn *= (1.0 - 0.75 * comp);   // compacted snow is smooth
  vec3 T = normalize(cross(N, vec3(1.0, 0.0, 0.0)));
  vec3 Bt = cross(N, T);
  N = normalize(N + T * dn.x + Bt * dn.y);

  float grain = dGrn.z * wGrn + 0.5 * (1.0 - wGrn);
  float crystal = clamp(0.35 + 1.1 * dMic.z * wMic + 0.5 * (1.0 - wMic), 0.0, 1.4);

  // Micro cavity occlusion, from the .w channel sn_detail used to discard.
  //
  // Centred on the map's OWN mean, not on 0.5, and that distinction is the
  // whole term. DETAIL_BAKE_FRAG writes clamp(0.5 + h * 0.7, 0, 1), and h is
  // not zero-mean -- its ridged granular octave only ever adds -- so the
  // channel measures 0.615 +- 0.115 over the baked map, not 0.5. Centred on
  // 0.5 the modulation came out at 1.30 +- 0.175, i.e. above one nearly
  // everywhere, and a saturate() then flattened 96% of it to exactly 1.0.
  // Measured: the term moved the frame by 0.000 HF sd, which is how it was
  // caught. SnowMaterial reads the DC back off the baked target once at init
  // and publishes it, so it cannot go stale if the bake changes.
  //
  // Weighted exactly like dn, so the MEAN is untouched at every distance and
  // only the variation appears. A layer that has faded out contributes
  // through a weight <= 0.01, so its unfetched 0.5 placeholder is worth at
  // most 0.002 of cavD. Compacted snow has no micro relief left to occlude
  // with, same as dn.
  float cavD = ((dRip.w - uDetailAoDC) * (wRip * 0.34)
              + (dGrn.w - uDetailAoDC) * (wGrn * 0.40)
              + (dMic.w - uDetailAoDC) * (wMic * 0.26)) * (1.0 - 0.75 * comp);
  float microOpen = clamp(1.0 + uShade.y * S_SKY_CAV * 2.0 * cavD, 0.25, 1.75);

  // --- light terms ----------------------------------------------------------
  float NdotL = dot(N, L);
  float NdotV = saturate(dot(N, V));
  float shadowMask = snShadowMask();
  float horizon = 1.0 - vSunOcc * 0.97;
  // Micro-shadowing from the grain, tightened at grazing sun.
  float micro = mix(1.0, saturate(0.45 + grain * 1.1), 0.5 * wGrn);
  float sun = shadowMask * horizon * micro;

  // Multiple scattering inside a high-albedo medium flattens the terminator:
  // a wrapped diffuse with a wide wrap is the cheap stand-in.
  float wrapT = saturate((NdotL + 0.42) / 1.42);
  float diff = wrapT * wrapT * (0.55 + 0.45 * wrapT);

  // Compacted snow is denser, so it scatters less and reads darker and bluer
  // than the powder around it. At 10% that was not enough for a print to be
  // legible as a hole rather than as a bright lip; the depression has to have
  // a visibly different SURFACE, not just a different shape.
  vec3 albedo = uAlbedo * (1.0 - 0.20 * comp)
              * (1.0 - S_SLAB_ALB * slabD - S_EXPO_ALB * (vFields.y - 0.55));
  // Ice barely absorbs in the visible, but what it absorbs is red — light that
  // takes a long path through snow comes back cyan. Together with the sky term
  // below, this is what makes shadowed snow BLUE rather than grey. Slab is
  // denser than the powder beside it and takes the same tint for the same
  // reason the footprint compaction channel does, one notch weaker.
  vec3 deep = uDeepTint * mix(vec3(1.0), uDeepTint,
                              max(comp, S_SLAB_DEEP * saturate(slabD * 2.0)));

  vec3 direct = uSunColor * (uSunInt * diff * sun);

  // Hollows between the ridges see less sky than the crests do.
  float hollow = 0.78 + 0.22 * saturate(vFields.x * 2.0 + 0.62);
  // ... and so does snow with an animal standing on it. This is the term the
  // cast shadow cannot supply at a low sun; see snContactOcc().
  float contact = snContactOcc(vWorld, N);

  // THE SKY IS NOT A UNIFORM DOME, and treating it as one is why snow in
  // shadow was a flat blue cut-out. saturate(0.52 + 0.48 * N.y) is the
  // visibility of a uniform hemisphere, and it is nearly constant for any
  // near-up normal: a facet tilted 15 degrees moves it 1.6%. So every bit of
  // legible relief was being carried by the sun term, and removing the sun
  // removed the surface with it. See S_SKY_ANISO.
  //
  // The glow direction is the sun's azimuth lifted toward the zenith, which
  // is where a twilight sky actually puts its brightest radiance -- a broad
  // band above the sun, not a second disc at it. Normalised by what a FLAT
  // surface collects from that direction, so the term is exactly 1.0 on
  // undisturbed ground at any sun elevation: the far field, the horizon
  // match and the overall exposure cannot move, only the relief appears.
  vec3 Lsky = normalize(vec3(L.x, max(L.y, 0.0) + S_SKY_GLOW_LIFT, L.z));
  float skyAniso = 1.0 + uShade.x * S_SKY_ANISO
                 * (saturate(dot(N, Lsky)) - saturate(Lsky.y));

  float skyVis = saturate(0.52 + 0.48 * N.y) * hollow * (1.0 - 0.45 * comp * comp)
               * skyAniso * microOpen
               * (1.0 - uOcclMix.x * contact);
  vec3 ambient = uSkyColor * (uSkyInt * skyVis) * deep;
  // Snow is surrounded by snow: a modest near-white interreflection that keeps
  // hollows from going black without washing the blue out of them. The body
  // blocks less of this than of the sky -- it arrives from all round, not from
  // straight up -- so it takes a weaker share of the contact term.
  //
  // It takes the cavity term but NOT the sunward anisotropy: the bounce
  // arrives from the whole ring of lit snow round the horizon, so it has no
  // preferred azimuth, but a facet down inside a hollow is just as hidden
  // from it as from the sky.
  vec3 inter = uBounce * (uBounceInt * (0.45 + 0.55 * saturate(1.0 - N.y)))
             * mix(1.0, microOpen, 0.6)
             * (1.0 - uOcclMix.y * contact);
  // The aurora is a wide, dim source directly overhead, so on snow it is a
  // broad wash on upward faces with almost no shape to it -- and it only
  // exists at all once the sun is far enough down for the curtains to be
  // there, which is what uAurora already encodes. Shares the sky's own
  // visibility term so hollows and compacted snow take it the same way.
  ambient += uAurora * (skyVis * (0.55 + 0.45 * N.y));

  vec3 col = albedo * (direct + ambient + inter);

  // --- forward subsurface scattering ---------------------------------------
  // Crest proximity stands in for thickness: a knife-edge of a drift is a few
  // millimetres of snow and lights up like wax when the sun is behind it.
  float thin = saturate(vFields.x * 2.8 - 0.10) * (1.0 - comp) * saturate(0.35 + 0.65 * vFields.y);
  float fwd0 = saturate(dot(V, -L));
  float fwdPhase = fwd0 * fwd0 * (fwd0 * fwd0) * fwd0;
  float back = saturate(0.55 - NdotL);
  vec3 sss = uSunColor * (uSunInt * uSSS * thin * fwdPhase * back * mix(0.35, 1.0, shadowMask));
  col += sss * vec3(1.0, 0.94, 0.86);

  // --- specular sheen + grazing fresnel ------------------------------------
  float rough = mix(uSheen.x, uSheen.y, packed);
  rough = clamp(rough * (1.0 - 0.35 * comp), 0.06, 1.0);
  float a2 = rough * rough * rough * rough;
  vec3 Hv = normalize(L + V);
  float NoH = saturate(dot(N, Hv));
  float NoL = saturate(NdotL);
  float VoH = saturate(dot(V, Hv));
  float dnm = NoH * NoH * (a2 - 1.0) + 1.0;
  float D = a2 / max(PI * dnm * dnm, 1e-6);
  // Height-correlated Smith. The cheap 0.5/mix(...) approximation blows up
  // when both the sun and the camera are near the horizon — which is the whole
  // scene — and turns the foreground into a white sheet.
  float gv = NoL * sqrt(NdotV * NdotV * (1.0 - a2) + a2);
  float gl = NdotV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  float Vis = 0.5 / max(gv + gl, 1e-4);
  // A rough dielectric does not become a perfect mirror at grazing angles;
  // pulling f90 down with roughness is what keeps the sun path believable.
  float f90 = clamp(1.0 - rough * 0.85, 0.12, 1.0);
  float v5 = 1.0 - VoH; v5 = v5 * v5 * (v5 * v5) * v5;
  float F = 0.021 + (f90 - 0.021) * v5;
  col += uSunColor * (uSunInt * uSheen.z * D * Vis * F * NoL * sun * (0.55 + 0.8 * packed));

  // Grazing-angle brightening: at a metre above the snow you see the sky in it.
  //
  // The aurora belongs in THIS term and was only in the diffuse one. §7 asks
  // for a reflection in the snow and a reflection has SHAPE -- it is brightest
  // where the surface turns toward grazing, it follows the drifts, and it is
  // stronger on packed snow than on powder. A uniform green lift on the
  // ambient is not a reflection, it is a tint, and it is invisible by
  // construction however far you turn it up. uAurora is published in the same
  // units as uSkyColor * uSkyInt (a fraction of the radiance of a white
  // lambertian surface under this rig), so it goes in at weight 1 and no new
  // gain is invented: what was already there is put where the eye reads it.
  //
  // This term is SKY LIGHT and it was the one sky term the body did not
  // block. It matters more than its size suggests: it is largest exactly
  // where NdotV is smallest, i.e. at the grazing framings -- paws, hero,
  // silhouette -- which are the framings the critic measured the missing
  // contact darkening in. Leaving it unoccluded put a floor under the
  // contact term that no amount of uOcclMix could get below.
  //
  // It takes the interreflection's weaker share rather than the sky
  // ambient's: a grazing reflection is dominated by directions near the
  // horizon, and a body standing on the snow blocks the zenith far harder
  // than it blocks the ring around it.
  float fres = 1.0 - NdotV; fres = fres * fres * (fres * fres) * fres;
  col += (uSkyColor * uSkyInt + uAurora)
       * ((0.035 + 0.55 * fres) * (0.35 + 0.65 * packed))
       * (1.0 - uOcclMix.y * contact);

  // --- sparkle --------------------------------------------------------------
  // Glints are a near-field phenomenon: at the horizon a crystal facet
  // subtends far less than a pixel, and keeping them at full strength out
  // there makes the field read as a flat sheet of glitter.
  // Most of the distance falloff is now physical (see sn_sparkle): the peak
  // of a glint drops as 1/distance^2 once it goes sub-pixel. What is left
  // here is only the aerial-perspective share — the haze in front of distant
  // snow washes the contrast out on top of that.
  float sparkDist = 1.0 / (1.0 + dist * 0.014);
  // A facet in shade is not dark, it is lit by the sky, and the brightest
  // part of that sky sits where the sun is -- so the same facets keep firing
  // and only their peak collapses. Gating on shadowMask alone measured 0.0
  // glints per 10 000 px inside the body shadow against 79 in the sun beside
  // it, which is not restraint, it is a dead plane. The sun and the ridge
  // horizon both keep a floor; comp and distance do not, because a sintered
  // slab really has no loose facets and a sub-pixel glint really is gone.
  float sparkLit = mix(S_SPK_SHADE * uShade.z, 1.0, shadowMask * horizon);
  float sparkGate = saturate(0.25 + NdotL * 2.5) * sparkLit
                  * (1.0 - comp * 0.85) * sparkDist;
  if (sparkGate > 0.004) {
    // Glints come from loose, unsintered facets, and a wind slab has none
    // left — so the sparkle collects in the troughs. That is both what snow
    // does and, measurably, what stops the sparkle from erasing the ridges:
    // at the terrain pose the sparkle costs 0.216 of the field's orientation
    // coherence (0.835 -> 0.619), because an isotropic glitter is exactly the
    // signal the structure tensor reads as "no preferred direction".
    col += sn_sparkle(N, V, L, p, px, pxIso,
                      crystal * sparkGate * (0.6 + 0.6 * vFields.y)
                      * (1.0 - S_SLAB_SPK * saturate(slabD * 2.0)));
  }

  // --- aerial perspective ---------------------------------------------------
  // The scene fog alone leaves the horizon snow at the same value and
  // saturation as the snow at your feet, which reads as a flat painted plane.
  // Bleed contrast and saturation out with distance before the fog term.
  float ap = (1.0 - exp(-dist * uAerial.x)) * uAerial.y;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, mix(vec3(lum), uHaze * (0.30 + 0.70 * lum), uAerial.z), ap);

  // Sun-ward in-scatter keeps the field from going flat grey with distance.
  float fogT = 1.0 - exp(-dist * dist * 2.4e-5);
  col += uSunColor * (uSunInt * 0.028 * fogT * pow(saturate(dot(V, -L)) * 0.5 + 0.5, 4.0));

  if (uDebugView > 0.5) {
    if (uDebugView < 1.5) col = vec3(shadowMask);
    else if (uDebugView < 2.5) col = vec3(1.0 - vSunOcc);
    else if (uDebugView < 3.5) col = vec3(fract(log2(max(vFw, 1e-4)) * 0.5 + 0.5));
    else if (uDebugView < 4.5) col = sn_sparkle(N, V, L, p, px, pxIso, crystal) * 0.25;
    else if (uDebugView < 5.5) col = vec3(dn * 2.0 + 0.5, 0.5);
    else if (uDebugView < 6.5) col = vec3(comp, ft.x, ft.y);
    else if (uDebugView < 7.5) col = vec3(gShadowDbg.xy, 0.0);
    else if (uDebugView < 8.5) col = vec3(gShadowDbg.z, gShadowDbg.w, 0.0);
    else col = vec3(1.0 - contact);
  }
  // OUR OWN FOG, not three's.
  //
  // scene.fog is FogExp2(0x9fbcdc) and lives in src/core/Environment.js; the
  // horizon haze band is bible section 3's #aac4e0 scaled by lit-snow
  // radiance and lives in src/world/Horizon.js. Two aerial-perspective
  // targets in two files, and the far snow converged on the darker one while
  // the sky above it converged on the brighter -- which is the flat band with
  // a hard top edge at the low tier, and most of why the terrain rim's
  // silhouette (a SQUARE clipmap seen edge-on) is legible at all. A rim with
  // nothing to contrast against has no polyline in it.
  //
  // Same exp-squared law and the same density, so the near field is
  // unchanged; only the colour the distance converges ON moves, and it moves
  // onto the band the snow is standing under.
  float air = 1.0 - exp(-dist * dist * uAirlight.w * uAirlight.w);
  col = mix(col, uAirlight.xyz, air);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Baked tileable detail map. RGB = normal.xy + crystal density, A = grain AO.
// Periodic gradient noise (the lattice wraps on a divisor of the table size),
// so the tile is seamless.
// ---------------------------------------------------------------------------
export const DETAIL_BAKE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uPerm;
uniform float uPeriod;

SNOW_CONSTS

vec2 pg(vec2 i, float per){
  vec2 w = mod(mod(i, per) + per, per);
  vec2 uv = (mod(w, S_TABLE) + 0.5) * (1.0 / S_TABLE);
  return texture2D(uPerm, uv).xy * 2.0 - 1.0;
}
float pgn(vec2 x, float per){
  vec2 i = floor(x);
  vec2 f = x - i;
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  float a = dot(pg(i, per), f);
  float b = dot(pg(i + vec2(1.0,0.0), per), f - vec2(1.0,0.0));
  float c = dot(pg(i + vec2(0.0,1.0), per), f - vec2(0.0,1.0));
  float d = dot(pg(i + vec2(1.0,1.0), per), f - vec2(1.0,1.0));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y) * 1.44;
}

// Height of the micro surface: wind-combed ripples + granular clumps + facets.
float mh(vec2 uv){
  float p0 = uPeriod;
  float h = 0.0;
  h += 0.40 * pgn(uv * p0, p0);
  h += 0.26 * pgn(uv * p0 * 2.0 + 7.3, p0 * 2.0);
  h += 0.15 * pgn(uv * p0 * 4.0 + 3.1, p0 * 4.0);
  h += 0.09 * pgn(uv * p0 * 8.0 + 11.7, p0 * 8.0);
  // Granular clumping: ridged noise makes discrete grain edges rather than a
  // smooth haze, which is what reads as snow rather than sand.
  float g = 1.0 - abs(pgn(uv * p0 * 3.0 + 19.0, p0 * 3.0));
  h += 0.22 * g * g;
  return h;
}

void main(){
  float e = 1.0 / 512.0;
  float h0 = mh(vUv);
  float hx = mh(vUv + vec2(e, 0.0));
  float hy = mh(vUv + vec2(0.0, e));
  vec2 g = vec2(hx - h0, hy - h0) / e;
  // 0.012, not 0.035: at 0.035 this map pins to +-1 almost everywhere and the
  // surface reads as stamped corduroy instead of snow grain.
  vec2 n = clamp(g * 0.012, vec2(-1.0), vec2(1.0));

  // Crystal density: sparse clusters, so sparkle is not uniform glitter.
  float c = 1.0 - abs(pgn(vUv * uPeriod * 6.0 + 41.0, uPeriod * 6.0));
  c = pow(clamp(c, 0.0, 1.0), 2.2);
  float ao = clamp(0.5 + h0 * 0.7, 0.0, 1.0);

  gl_FragColor = vec4(n * 0.5 + 0.5, c, ao);
}
`;

// ---------------------------------------------------------------------------
// Footprint target: decay + scroll pass, then instanced paw stamps.
// ---------------------------------------------------------------------------
/** Shared by the GPU stamp and the CPU `heightAt` footprint evaluation. */
export const FOOT_PAW_GLSL = /* glsl */ `
float sn_smin(float a, float b, float k){
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
// Signed distance to an arctic fox pad: broad heel pad, four furred toes.
// Local units: 1 = the radius passed to press().
float sn_paw(vec2 q){
  float d = (length((q - vec2(0.0, -0.30)) / vec2(0.62, 0.50)) - 1.0) * 0.50;
  d = sn_smin(d, length(q - vec2(-0.13, 0.52)) - 0.235, 0.15);
  d = sn_smin(d, length(q - vec2( 0.21, 0.50)) - 0.225, 0.15);
  d = sn_smin(d, length(q - vec2(-0.50, 0.28)) - 0.215, 0.15);
  d = sn_smin(d, length(q - vec2( 0.55, 0.24)) - 0.205, 0.15);
  return d;
}
// x: depression 0..1, y: displaced rim 0..1, z: compaction 0..1
vec3 sn_pawProfile(vec2 q, float depth, float sharp){
  float d = sn_paw(q);
  float w = mix(S_FP_WALL0, S_FP_WALL1, sharp);
  float prof = 1.0 - smoothstep(-w, 0.03, d);
  prof = pow(prof, mix(S_FP_POW0, S_FP_POW1, sharp));
  float rim = exp(-pow((d - S_FP_RIM_D) / S_FP_RIM_W, 2.0)) * (0.35 + 0.65 * sharp);
  return vec3(prof * depth, rim * depth * 0.85, prof);
}
`;

export const FOOT_STAMP_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec4 iXform;     // world x, z, radius, rotation
attribute vec3 iDepth;     // depth 0..1, sharpness 0..1, age in seconds
varying vec2 vQ;
varying vec3 vParam;
uniform vec3 uFootOrigin;  // xy centre, z = 1/size
void main(){
  float c = cos(iXform.w), s = sin(iXform.w);
  vec2 q = position.xy * 1.85;
  vQ = q;
  vParam = iDepth;
  vec2 local = vec2(q.x * c - q.y * s, q.x * s + q.y * c) * iXform.z;
  vec2 uv = (iXform.xy + local - uFootOrigin.xy) * uFootOrigin.z + 0.5;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FOOT_STAMP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vQ;
varying vec3 vParam;
FOOT_PAW
void main(){
  // THE STAMP CARRIES ITS OWN AGE. The target is rebuilt from the live stamp
  // list every frame (see Footprints.prerender) instead of being decayed in
  // place, so each stamp is drawn already aged and the texture is the CPU
  // closed form by construction rather than by an inductive argument about a
  // read-modify-write pass. The three channels age at their own rates, which
  // is what the old per-channel uDecay multiplier did.
  vec3 p = sn_pawProfile(vQ, vParam.x, vParam.y);
  gl_FragColor = vec4(
    p.x * exp(-vParam.z / S_FP_TAU_DEPTH),
    p.y * exp(-vParam.z / S_FP_TAU_RIM),
    p.z * exp(-vParam.z / S_FP_TAU_COMP),
    1.0);
}
`;

// ---------------------------------------------------------------------------
// CPU/GPU agreement probe: evaluates the height field on a grid around the
// subject so JS can read it back and compare against heightAt().
// ---------------------------------------------------------------------------
export const PROBE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 uProbe;       // centre xz, half extent
uniform float uProbeFw;

SNOW_CONSTS
SNOW_FIELD
SNOW_FOOTPRINT

// 32-bit fixed point into RGBA8 — no float readback, so no driver-dependent
// console noise from readRenderTargetPixels.
vec4 sn_pack(float v){
  vec4 enc = fract(vec4(1.0, 255.0, 65025.0, 16581375.0) * v);
  enc -= enc.yzww * vec4(1.0/255.0, 1.0/255.0, 1.0/255.0, 0.0);
  return enc;
}

void main(){
  vec2 p = uProbe.xy + (vUv - 0.5) * (2.0 * uProbe.z);
  float h = sn_fieldH(p, uProbeFw) + sn_footH(p);
  gl_FragColor = sn_pack(clamp((h + 4.0) / 8.0, 0.0, 0.999999));
}
`;

export const FULLSCREEN_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
varying vec2 vUv;
void main(){
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Expand the SNOW_* placeholders in a shader source. */
export function snowResolve(src) {
  // FOOT_PAW needs the S_* constants; pull them in unless the shader already
  // asked for them itself, so the stamp shader cannot compile without them.
  const paw = src.includes('SNOW_CONSTS') ? FOOT_PAW_GLSL : snowConstsGLSL() + FOOT_PAW_GLSL;
  return src
    .replace('SNOW_CONSTS', snowConstsGLSL())
    .replace('SNOW_FIELD', SNOW_FIELD_GLSL)
    .replace('SNOW_FOOTPRINT', SNOW_FOOTPRINT_GLSL)
    .replace('FOOT_PAW', paw);
}
