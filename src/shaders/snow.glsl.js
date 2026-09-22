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
#include <fog_pars_vertex>
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

  #include <fog_vertex>
  #include <shadowmap_vertex>
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
// 0 off. 1 shadow mask, 2 ridge self-shadow, 3 clipmap level, 4 sparkle,
// 5 detail normal, 6 compaction. Debug only; costs one uniform compare.
uniform float uDebugView;
varying float vFw;

#include <common>
#include <packing>
#include <fog_pars_fragment>
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
vec4 gShadowDbg;   // c.xy, m.x, m.y — debug views 7/8

float snShadowMask(){
  gShadowDbg = vec4(0.0, 0.0, -1.0, -1.0);
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  vec4 sc = vDirectionalShadowCoord[ 0 ];
  vec3 c = sc.xyz / sc.w;
  gShadowDbg = vec4(c.xy, -2.0, c.z);
  c.z += directionalLightShadows[ 0 ].shadowBias;
  vec2 dd = abs(c.xy - 0.5);
  float edge = 1.0 - smoothstep(0.40, 0.495, max(dd.x, dd.y));
  if (edge <= 0.001 || c.z > 1.0 || c.z < 0.0) return 1.0;
  // The VSM target packs (mean depth, std deviation) as two halves per RGBA8.
  vec2 m = unpackRGBATo2Half(texture2D(directionalShadowMap[ 0 ], c.xy));
  gShadowDbg = vec4(c.xy, m.x, c.z);
  if (m.x <= uShadowEmpty) return 1.0;
  // Slope-scaled bias: at a six degree sun the depth races across the map, and
  // the VSM blur smears it far enough to self-shadow without this.
  c.z -= 0.014;
  float occ = 1.0;
  if (step(c.z, m.x) != 1.0) {
    float dist = c.z - m.x;
    float var = max(m.y * m.y, 2.5e-6);
    float p = var / (var + dist * dist);
    occ = clamp((p - 0.15) / 0.55, 0.0, 1.0);
  }
  return mix(1.0, mix(1.0, occ, directionalLightShadows[ 0 ].shadowIntensity), edge);
#else
  return 1.0;
#endif
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
vec3 sn_detail(vec2 uv, float scale){
  vec4 t = texture2D(uDetail, uv * scale);
  return vec3(t.xy * 2.0 - 1.0, t.z);
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

  vec3 dRip = vec3(0.0, 0.0, 0.5), dGrn = vec3(0.0, 0.0, 0.5), dMic = vec3(0.0, 0.0, 0.5);
  if (wRip > 0.01) dRip = sn_detail(vec2(wuv.x + wuv.y * 0.11, wuv.y * uDetailScale.w) / uDetailScale.z, 1.0);
  if (wGrn > 0.01) dGrn = sn_detail(wuv / uDetailScale.y + vec2(0.37, 0.61), 1.0);
  if (wMic > 0.01) dMic = sn_detail(wuv / uDetailScale.x + vec2(0.11, 0.83), 1.0);

  float packed = clamp(vFields.y * 0.85 + comp * 0.6, 0.0, 1.0);
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
  vec3 albedo = uAlbedo * (1.0 - 0.20 * comp) * (1.0 - 0.03 * (1.0 - vFields.y));
  // Ice barely absorbs in the visible, but what it absorbs is red — light that
  // takes a long path through snow comes back cyan. Together with the sky term
  // below, this is what makes shadowed snow BLUE rather than grey.
  vec3 deep = uDeepTint * mix(vec3(1.0), uDeepTint, comp);

  vec3 direct = uSunColor * (uSunInt * diff * sun);

  // Hollows between the ridges see less sky than the crests do.
  float hollow = 0.78 + 0.22 * saturate(vFields.x * 2.0 + 0.62);
  float skyVis = saturate(0.52 + 0.48 * N.y) * hollow * (1.0 - 0.45 * comp * comp);
  vec3 ambient = uSkyColor * (uSkyInt * skyVis) * deep;
  // Snow is surrounded by snow: a modest near-white interreflection that keeps
  // hollows from going black without washing the blue out of them.
  vec3 inter = uBounce * (uBounceInt * (0.45 + 0.55 * saturate(1.0 - N.y)));
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
  float fres = 1.0 - NdotV; fres = fres * fres * (fres * fres) * fres;
  col += uSkyColor * (uSkyInt * (0.035 + 0.55 * fres) * (0.35 + 0.65 * packed));

  // --- sparkle --------------------------------------------------------------
  // Glints are a near-field phenomenon: at the horizon a crystal facet
  // subtends far less than a pixel, and keeping them at full strength out
  // there makes the field read as a flat sheet of glitter.
  // Most of the distance falloff is now physical (see sn_sparkle): the peak
  // of a glint drops as 1/distance^2 once it goes sub-pixel. What is left
  // here is only the aerial-perspective share — the haze in front of distant
  // snow washes the contrast out on top of that.
  float sparkDist = 1.0 / (1.0 + dist * 0.014);
  float sparkGate = saturate(0.25 + NdotL * 2.5) * shadowMask * horizon
                  * (1.0 - comp * 0.85) * sparkDist;
  if (sparkGate > 0.004) {
    col += sn_sparkle(N, V, L, p, px, pxIso, crystal * sparkGate * (0.6 + 0.6 * vFields.y));
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
    else col = vec3(gShadowDbg.z, gShadowDbg.w, 0.0);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
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
export const FOOT_DECAY_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uShift;      // scroll, in whole TEXELS
uniform vec2 uRes;        // target resolution, and 1/resolution below
uniform vec2 uInvRes;
uniform vec3 uDecay;      // per-channel multiplier for this frame
void main(){
  // ADDRESS THE SOURCE TEXEL BY INDEX, NOT BY AN INTERPOLATED UV.
  //
  // This pass is a read-modify-write through a LinearFilter sampler, and the
  // file header warns that such a pass has to be exact or the CPU closed form
  // stops describing it. It was not exact. `vUv` came from a varying over a
  // triangle spanning 0..2, so at 2048 texels a rasteriser error of ~1e-6 in
  // UV is ~0.002 of a texel — which bilinear turns into a 0.2% bleed from the
  // neighbour, every frame, at 120 frames a second. That diffuses the field:
  // a footprint's peak erodes on its own, on top of the intended decay.
  //
  // Measured on the deepest stamp in the seeded trail, comparing the GPU
  // against `heightAt` at the same point and instant: the effective depth
  // e-folding time came out at 10-13 s against the 21 s the CPU model uses,
  // and the error grew with sim time (0.8 mm at t=0.2 s, 5.0 mm at 2.5 s,
  // 12.0 mm at 6.0 s) because it is a per-FRAME loss.
  //
  // gl_FragCoord.xy is at pixel centres, so floor() is the integer index and
  // +0.5 puts us back on the centre. uShift is an integer texel count, and
  // (i + 0.5 + k) / res is exact in float32 for a power-of-two res, so the
  // sampler's own (uv*res - 0.5) lands on an integer and the bilinear weights
  // are exactly 1 and 0. No filtering, no bleed, on every driver.
  vec2 st = floor(gl_FragCoord.xy) + vec2(0.5) + uShift;
  if (st.x < 0.0 || st.y < 0.0 || st.x > uRes.x || st.y > uRes.y) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec2 uv = st * uInvRes;
  // NO subtractive epsilon. There used to be a "- 1e-4" here to drive dead
  // stamps to exactly zero, and it was the single largest CPU/GPU height
  // disagreement in the build, because it is applied ONCE PER PASS while the
  // CPU model is a function of TIME. Instrumented at a walk: 304 passes by
  // t = 2.5 s, so 0.0304 had been subtracted from a depth channel whose full
  // scale is S_FP_MAXDEPTH = 95 mm - 2.9 mm of pure bookkeeping error, rising
  // to 17 mm by the 1800th frame and 29.9 mm in a gate.mjs run, and varying
  // run to run with nothing but how many frames the loading screen happened
  // to draw. The multiplicative decay is exact under the max-composite
  // identity in this file's header; a subtraction is not, and cannot be
  // mirrored in a closed form.
  //
  // Nothing accumulates without it: uDecay is < 1 whenever time advances, so
  // a dead stamp shrinks geometrically and half-float flushes it to zero.
  gl_FragColor = vec4(max(texture2D(uSrc, uv).xyz * uDecay, 0.0), 1.0);
}
`;

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
attribute vec2 iDepth;     // depth 0..1, sharpness 0..1
varying vec2 vQ;
varying vec2 vParam;
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
varying vec2 vParam;
FOOT_PAW
void main(){
  gl_FragColor = vec4(sn_pawProfile(vQ, vParam.x, vParam.y), 1.0);
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
