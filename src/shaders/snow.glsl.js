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

  // Broad drift topography — two elongated dune scales. Gives the field form
  // and keeps the horizon from reading as a ruled line.
  DUNE1_AC: 0.0168, DUNE1_AL: 0.0071, DUNE1_AMP: 0.78, DUNE1_SIZE: 58.0,
  DUNE2_AC: 0.0525, DUNE2_AL: 0.0232, DUNE2_AMP: 0.215, DUNE2_SIZE: 18.0,

  // Wind exposure field: scoured/packed on the windward crests, soft drift in
  // the lee hollows. Drives sastrugi amplitude, roughness and sparkle density.
  EXPO_AC: 0.0315, EXPO_AL: 0.0175, EXPO_SIZE: 30.0,

  // The calm pad the fox stands on. Radius is modulated by noise so the
  // boundary is not a circle.
  PAD_R0: 1.05, PAD_R1: 5.2, PAD_MIN: 0.22,
  PAD_WOBBLE: 0.46, PAD_WOB_F: 0.30, PAD_WOB_SIZE: 3.4,

  // Sastrugi meander: the ridges are not straight, they snake downwind.
  MEAND_AC: 0.086, MEAND_AL: 0.037, MEAND_SIZE: 11.0, MEAND_AMP: 2.45,
  MEAND2_AL: 0.062, MEAND2_AC: 0.078, MEAND2_SIZE: 13.0, MEAND_AMP2: 0.44,

  // Sastrugi proper: ridged noise, stretched ALONG the wind (polar sastrugi run
  // parallel to the wind, unlike dunes), with the crest sheared downwind so the
  // windward face steepens into a prow.
  SAST_ACROSS: 1.22, SAST_ALONG: 5.6, SAST_AMP: 0.185, SAST_SKEW: 1.85,
  SAST_L2: 2.07, SAST_L3: 4.28, SAST_G2: 0.47, SAST_G3: 0.22,

  // Medium ripples: small ridges running ACROSS the wind.
  RIP_LEN: 0.46, RIP_ACROSS: 3.2, RIP_AMP: 0.023, RIP_L2: 2.13, RIP_G2: 0.5,

  // Mean of ridge() — subtracted so every octave is zero-mean and fading one
  // out with distance loses detail without shifting the surface. Measured
  // numerically over the real table (tools note: see Terrain._measureRidgeMean).
  RIDGE_MEAN: 0.7143,

  // Band-limiting. An octave of wavelength `w` is fully present while the local
  // sample spacing fw < w*LOD_LO and gone by fw > w*LOD_HI. Keeping LOD_HI well
  // under 1 leaves >6 samples per wavelength, which is what makes the clipmap
  // level joins sub-pixel and the far field alias-free.
  LOD_LO: 0.11, LOD_HI: 0.34,

  // Normal differencing epsilon (metres). Same on CPU and GPU.
  NRM_EPS: 0.035,

  // Footprint field.
  FP_SIZE: 24.0,          // metres covered by the deformation target
  FP_MAXDEPTH: 0.145,     // metres, when the depth channel is 1
  FP_MAXRIM: 0.042,       // metres, when the rim channel is 1
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

// Band-limit weight for an octave of wavelength `w` sampled every `fw` metres.
float sn_lod(float w, float fw){
  return 1.0 - smoothstep(w*S_LOD_LO, w*S_LOD_HI, fw);
}

// Sharp-crested ridge, zero mean: crests are creases, hollows are broad.
float sn_ridge(vec2 q){
  float n = sn_gn(q);
  float r = 1.0 - abs(n);
  return mix(r, r*r, 0.3) - S_RIDGE_MEAN;
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
  h += S_DUNE1_AMP * sn_gn(vec2(ac*S_DUNE1_AC,          al*S_DUNE1_AL))         * sn_lod(S_DUNE1_SIZE, fw);
  h += S_DUNE2_AMP * sn_gn(vec2(ac*S_DUNE2_AC + 13.71,  al*S_DUNE2_AL + 5.13))  * sn_lod(S_DUNE2_SIZE, fw);

  float expo = 0.5 + 0.5 * sn_gn(vec2(ac*S_EXPO_AC + 71.3, al*S_EXPO_AL + 41.7)) * sn_lod(S_EXPO_SIZE, fw);
  oExpo = clamp(expo, 0.0, 1.0);

  float wob = sn_gn(p*S_PAD_WOB_F + vec2(57.2, 23.8)) * sn_lod(S_PAD_WOB_SIZE, fw);
  float pr  = length(p - uPadCenter) * (1.0 + S_PAD_WOBBLE * wob);
  float pad = mix(S_PAD_MIN, 1.0, smoothstep(S_PAD_R0, S_PAD_R1, pr));
  oPad = pad;

  float mnd = sn_gn(vec2(ac*S_MEAND_AC + 31.13, al*S_MEAND_AL + 7.31)) * sn_lod(S_MEAND_SIZE, fw);
  float alw = al + S_MEAND_AMP * mnd;
  float acw = ac + S_MEAND_AMP2 * sn_gn(vec2(al*S_MEAND2_AL + 3.37, ac*S_MEAND2_AC + 19.41)) * sn_lod(S_MEAND2_SIZE, fw);

  // Shear the along-wind coordinate by the coarse ridge value: crests migrate
  // upwind, which compresses the windward face and stretches the lee slope.
  float s0 = sn_ridge(vec2(acw*(1.0/S_SAST_ACROSS), alw*(1.0/S_SAST_ALONG))) * sn_lod(S_SAST_ACROSS, fw);
  float alS = alw - S_SAST_SKEW * s0;

  float s = sn_ridge(vec2(acw*(1.0/S_SAST_ACROSS),           alS*(1.0/S_SAST_ALONG)))          * sn_lod(S_SAST_ACROSS, fw)
    + S_SAST_G2 * sn_ridge(vec2(acw*(S_SAST_L2/S_SAST_ACROSS) + 11.21, alS*(S_SAST_L2/S_SAST_ALONG) + 3.77)) * sn_lod(S_SAST_ACROSS/S_SAST_L2, fw)
    + S_SAST_G3 * sn_ridge(vec2(acw*(S_SAST_L3/S_SAST_ACROSS) + 27.53, alS*(S_SAST_L3/S_SAST_ALONG) + 8.19)) * sn_lod(S_SAST_ACROSS/S_SAST_L3, fw);
  s *= 1.0 / (1.0 + S_SAST_G2 + S_SAST_G3);
  oSast = s;
  h += S_SAST_AMP * oPad * (0.55 + 0.8*oExpo) * s;

  float r = sn_ridge(vec2(alw*(1.0/S_RIP_LEN), acw*(1.0/S_RIP_ACROSS))) * sn_lod(S_RIP_LEN, fw)
    + S_RIP_G2 * sn_ridge(vec2(alw*(S_RIP_L2/S_RIP_LEN) + 5.71, acw*(S_RIP_L2/S_RIP_ACROSS) + 13.33)) * sn_lod(S_RIP_LEN/S_RIP_L2, fw);
  r *= 1.0 / (1.0 + S_RIP_G2);
  oRip = r;
  h += S_RIP_AMP * (0.35 + 0.9*oExpo) * r;

  return h - uHeightBias;
}

float sn_fieldH(vec2 p, float fw){
  float a, b, c, d;
  return sn_field(p, fw, a, b, c, d);
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
    float d = 0.3;
    for (int i = 0; i < SUN_TAPS; i++) {
      float hk = sn_fieldH(p + sd * d, fw);
      occ = max(occ, (hk - h - d * tanE) / (d * 0.55 + 0.05));
      d *= 2.15;
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
uniform vec2 uSheen;         // roughness fresh, roughness packed
uniform float uSSS;
uniform bool receiveShadow;

#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>

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
vec3 sn_sparkle(vec3 N, vec3 V, vec3 L, vec2 p, float px, float density){
  vec3 Hv = normalize(L + V);
  vec3 T = normalize(cross(N, vec3(1.0, 0.0, 0.0)));
  vec3 B = cross(N, T);
  float acc = 0.0;
  float cell = 0.010;
  for (int k = 0; k < 3; k++) {
    // Triangular window in log2(px): the lattice is shown only while its cells
    // are ~2-6 px across.
    float w = 1.0 - abs(log2(max(px, 1e-5) / (cell * 0.30))) * 0.72;
    w = clamp(w, 0.0, 1.0);
    if (w > 0.004) {
      vec2 q = p / cell;
      vec2 ip = floor(q);
      vec2 fp = q - ip;
      for (int j = 0; j < 2; j++) {
        for (int i = 0; i < 2; i++) {
          vec2 o = vec2(float(i), float(j)) - step(0.5, fp);
          vec2 id = ip + o;
          vec3 r = sn_hash23(id + vec2(cell * 131.0));
          vec2 fpt = o + vec2(r.x, r.y) * 0.72 + 0.14 - fp;
          float dd = dot(fpt, fpt);
          if (dd < 0.10) {
            float dot0 = 1.0 - smoothstep(0.02, 0.09, dd);
            float a = r.z * 6.2831853;
            float m = sn_hash21(id * 1.7 + 4.3);
            vec2 tilt = vec2(cos(a), sin(a)) * (0.18 + uSparkle.y * m);
            vec3 fn = normalize(N + T * tilt.x + B * tilt.y);
            float al = dot(fn, Hv);
            float g = exp2(-(1.0 - al) * uSparkle.z);
            acc += g * dot0 * w;
          }
        }
      }
    }
    cell *= 4.0;
  }
  return acc * density * uSparkle.x * mix(uSunColor, vec3(0.86, 0.94, 1.0), 0.25);
}

void main(){
  vec3 N = normalize(vNormal);
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);
  vec3 L = uSunDir;
  vec2 p = vWorld.xz;

  float px = max(length(dFdx(vWorld)), length(dFdy(vWorld)));

  // --- footprint: displacement gradient + compaction ------------------------
  float fe = max(px, S_FP_SIZE / 1024.0);
  vec3 ft = sn_footTexel(p);
  float f0 = sn_footH(ft);
  float fx = sn_footH(p + vec2(fe, 0.0));
  float fz = sn_footH(p + vec2(0.0, fe));
  float comp = clamp(ft.z, 0.0, 1.0);
  N = normalize(N + vec3(-(fx - f0) / fe, 0.0, -(fz - f0) / fe));

  // --- detail normals -------------------------------------------------------
  vec2 W = uWindXZ;
  vec2 A = vec2(-W.y, W.x);
  vec2 wuv = vec2(dot(p, A), dot(p, W));       // wind-aligned UV
  float wRip = 1.0 - smoothstep(uDetailScale.z * 0.9, uDetailScale.z * 5.0, px);
  float wGrn = 1.0 - smoothstep(uDetailScale.y * 0.9, uDetailScale.y * 5.0, px);
  float wMic = 1.0 - smoothstep(uDetailScale.x * 0.9, uDetailScale.x * 5.0, px);

  vec3 dRip = sn_detail(vec2(wuv.x, wuv.y * uDetailScale.w) / uDetailScale.z, 1.0);
  vec3 dGrn = sn_detail(wuv / uDetailScale.y + vec2(0.37, 0.61), 1.0);
  vec3 dMic = sn_detail(wuv / uDetailScale.x + vec2(0.11, 0.83), 1.0);

  float packed = clamp(vFields.y * 0.85 + comp * 0.6, 0.0, 1.0);
  float soft = 1.0 - packed;
  vec2 dn = dRip.xy * (wRip * (0.55 + 0.55 * vFields.y))
          + dGrn.xy * (wGrn * (0.42 + 0.5 * soft))
          + dMic.xy * (wMic * 0.34 * soft);
  dn *= (1.0 - 0.75 * comp);   // compacted snow is smooth
  vec3 T = normalize(cross(N, vec3(1.0, 0.0, 0.0)));
  vec3 Bt = cross(N, T);
  N = normalize(N + T * dn.x + Bt * dn.y);

  float grain = dGrn.z * wGrn + 0.5 * (1.0 - wGrn);
  float crystal = clamp(0.35 + 1.1 * dMic.z * wMic + 0.5 * (1.0 - wMic), 0.0, 1.4);

  // --- light terms ----------------------------------------------------------
  float NdotL = dot(N, L);
  float NdotV = saturate(dot(N, V));
  float shadowMask = getShadowMask();
  float horizon = 1.0 - vSunOcc * 0.94;
  // Micro-shadowing from the grain, tightened at grazing sun.
  float micro = mix(1.0, saturate(0.45 + grain * 1.1), 0.5 * wGrn);
  float sun = shadowMask * horizon * micro;

  // Multiple scattering inside a high-albedo medium flattens the terminator:
  // a wrapped diffuse with a wide wrap is the cheap stand-in.
  float wrapT = saturate((NdotL + 0.42) / 1.42);
  float diff = wrapT * wrapT * (0.55 + 0.45 * wrapT);

  vec3 albedo = uAlbedo * (1.0 - 0.10 * comp) * (1.0 - 0.03 * (1.0 - vFields.y));
  // Ice barely absorbs in the visible, but what it absorbs is red — light that
  // takes a long path through snow comes back cyan. This is why shadowed snow
  // is blue, together with the sky term below.
  vec3 deep = mix(vec3(1.0), uDeepTint, saturate(0.55 + 0.45 * comp));

  vec3 direct = uSunColor * (uSunInt * diff * sun);

  float skyVis = saturate(0.52 + 0.48 * N.y) * (1.0 - 0.45 * comp * comp);
  vec3 ambient = uSkyColor * (uSkyInt * skyVis) * deep;
  // Snow is surrounded by snow: a large near-white interreflection term that
  // keeps hollows from going black without washing out the blue.
  vec3 inter = uBounce * (uBounceInt * (0.35 + 0.65 * saturate(1.0 - N.y)) * (0.4 + 0.6 * horizon));

  vec3 col = albedo * (direct + ambient + inter);

  // --- forward subsurface scattering ---------------------------------------
  // Crest proximity stands in for thickness: a knife-edge of a drift is a few
  // millimetres of snow and lights up like wax when the sun is behind it.
  float thin = saturate(vFields.x * 2.1 + 0.18) * (1.0 - comp) * saturate(0.35 + 0.65 * vFields.y);
  float fwdPhase = pow(saturate(dot(V, -L)), 5.0);
  float back = saturate(0.55 - NdotL);
  vec3 sss = uSunColor * (uSunInt * uSSS * thin * fwdPhase * back * mix(0.35, 1.0, shadowMask));
  col += sss * vec3(1.0, 0.94, 0.86);

  // --- specular sheen + grazing fresnel ------------------------------------
  float rough = mix(uSheen.x, uSheen.y, packed);
  rough = clamp(rough * (1.0 - 0.45 * comp), 0.04, 1.0);
  float a2 = rough * rough * rough * rough;
  vec3 Hv = normalize(L + V);
  float NoH = saturate(dot(N, Hv));
  float NoL = saturate(NdotL);
  float VoH = saturate(dot(V, Hv));
  float dnm = NoH * NoH * (a2 - 1.0) + 1.0;
  float D = a2 / max(PI * dnm * dnm, 1e-6);
  float k = rough * rough * 0.5;
  float Vis = 0.5 / max(mix(2.0 * NoL * NdotV, NoL + NdotV, k), 1e-4);
  float F = 0.021 + 0.979 * pow(1.0 - VoH, 5.0);
  col += uSunColor * (uSunInt * D * Vis * F * NoL * sun * (0.55 + 0.8 * packed));

  // Grazing-angle brightening: at a metre above the snow you see the sky in it.
  float fres = pow(1.0 - NdotV, 5.0);
  col += uSkyColor * (uSkyInt * (0.035 + 0.55 * fres) * (0.35 + 0.65 * packed));

  // --- sparkle --------------------------------------------------------------
  float sparkGate = saturate(NdotL * 3.0) * shadowMask * horizon * (1.0 - comp * 0.85);
  if (sparkGate > 0.01) {
    col += sn_sparkle(N, V, L, p, px, crystal * sparkGate * (0.6 + 0.6 * vFields.y));
  }

  // --- aerial perspective ---------------------------------------------------
  // Sun-ward in-scatter keeps the field from going flat grey with distance.
  float fogT = 1.0 - exp(-dist * dist * 2.4e-5);
  col += uSunColor * (uSunInt * 0.028 * fogT * pow(saturate(dot(V, -L)) * 0.5 + 0.5, 4.0));

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
  vec2 n = clamp(g * 0.035, vec2(-1.0), vec2(1.0));

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
varying vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uShift;      // texel-exact scroll, in UV
uniform vec3 uDecay;      // per-channel multiplier for this frame
void main(){
  vec2 uv = vUv + uShift;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec3 s = texture2D(uSrc, uv).xyz * uDecay;
  gl_FragColor = vec4(max(s - 1e-4, 0.0), 1.0);
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
  float w = mix(0.30, 0.13, sharp);
  float prof = 1.0 - smoothstep(-w, 0.02, d);
  prof = pow(prof, mix(1.45, 0.75, sharp));
  float rim = exp(-pow((d - 0.085) / 0.105, 2.0)) * (0.35 + 0.65 * sharp);
  return vec3(prof * depth, rim * depth * 0.85, prof);
}
`;

export const FOOT_STAMP_VERT = /* glsl */ `
precision highp float;
attribute vec2 position;
attribute vec4 iXform;     // world x, z, radius, rotation
attribute vec2 iDepth;     // depth 0..1, sharpness 0..1
varying vec2 vQ;
varying vec2 vParam;
uniform vec3 uFootOrigin;  // xy centre, z = 1/size
void main(){
  float c = cos(iXform.w), s = sin(iXform.w);
  vec2 q = position * 1.55;
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

void main(){
  vec2 p = uProbe.xy + (vUv - 0.5) * (2.0 * uProbe.z);
  float h = sn_fieldH(p, uProbeFw) + sn_footH(p);
  gl_FragColor = vec4(h, 0.0, 0.0, 1.0);
}
`;

export const FULLSCREEN_VERT = /* glsl */ `
precision highp float;
attribute vec2 position;
varying vec2 vUv;
void main(){
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

/** Expand the SNOW_* placeholders in a shader source. */
export function snowResolve(src) {
  return src
    .replace('SNOW_CONSTS', snowConstsGLSL())
    .replace('SNOW_FIELD', SNOW_FIELD_GLSL)
    .replace('SNOW_FOOTPRINT', SNOW_FOOTPRINT_GLSL)
    .replace('FOOT_PAW', FOOT_PAW_GLSL);
}
