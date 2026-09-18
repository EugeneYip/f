// Shared GLSL noise library. Import the chunks you need and inject them into
// your shader source. Everything here is deterministic and object-space stable.

export const HASH = /* glsl */ `
float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
float hash13(vec3 p3){ p3 = fract(p3*0.1031); p3 += dot(p3, p3.zyx+31.32); return fract((p3.x+p3.y)*p3.z); }
vec2  hash23(vec3 p3){ p3 = fract(p3*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3,p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
vec3  hash33(vec3 p3){ p3 = fract(p3*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3,p3.yxz+33.33); return fract((p3.xxy+p3.yxx)*p3.zyx); }
vec2  hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3,p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
`;

/** Ashima-style simplex noise, 3D. ~1.0 amplitude, zero mean. */
export const SIMPLEX3 = /* glsl */ `
vec3 mod289(vec3 x){ return x - floor(x*(1.0/289.0))*289.0; }
vec4 mod289(vec4 x){ return x - floor(x*(1.0/289.0))*289.0; }
vec4 permute289(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314*r; }

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute289(permute289(permute289(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

/** Requires SIMPLEX3. Ridged + standard fbm. */
export const FBM3 = /* glsl */ `
float fbm3(vec3 p, int oct, float lac, float gain){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++){
    if (i >= oct) break;
    s += a * snoise(p);
    n += a; a *= gain; p *= lac;
  }
  return s / max(n, 1e-4);
}
float ridged3(vec3 p, int oct, float lac, float gain){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++){
    if (i >= oct) break;
    float r = 1.0 - abs(snoise(p));
    s += a * r * r;
    n += a; a *= gain; p *= lac;
  }
  return s / max(n, 1e-4);
}
`;

/** Requires HASH. Worley / cellular — the basis of fur clumping and snow grain. */
export const WORLEY3 = /* glsl */ `
// returns vec2(F1, F2) distances and writes the winning cell id to cellId.
vec2 worley3(vec3 p, out vec3 cellId){
  vec3 ip = floor(p); vec3 fp = p - ip;
  float f1 = 8.0, f2 = 8.0; cellId = ip;
  for (int k=-1;k<=1;k++) for (int j=-1;j<=1;j++) for (int i=-1;i<=1;i++){
    vec3 o = vec3(float(i), float(j), float(k));
    vec3 h = hash33(ip + o);
    vec3 d = o + h - fp;
    float dd = dot(d,d);
    if (dd < f1){ f2 = f1; f1 = dd; cellId = ip + o; }
    else if (dd < f2){ f2 = dd; }
  }
  return vec2(sqrt(f1), sqrt(f2));
}
float worleyF1(vec3 p){ vec3 id; return worley3(p, id).x; }
`;

/** Requires SIMPLEX3. Divergence-free curl field — drives blowing snow. */
export const CURL3 = /* glsl */ `
vec3 curlNoise(vec3 p){
  const float e = 0.08;
  float n1, n2;
  n1 = snoise(vec3(p.x, p.y+e, p.z)); n2 = snoise(vec3(p.x, p.y-e, p.z));
  float a = (n1-n2)/(2.0*e);
  n1 = snoise(vec3(p.x, p.y, p.z+e)); n2 = snoise(vec3(p.x, p.y, p.z-e));
  float b = (n1-n2)/(2.0*e);
  float x = a - b;
  n1 = snoise(vec3(p.x, p.y, p.z+e)); n2 = snoise(vec3(p.x, p.y, p.z-e));
  a = (n1-n2)/(2.0*e);
  n1 = snoise(vec3(p.x+e, p.y, p.z)); n2 = snoise(vec3(p.x-e, p.y, p.z));
  b = (n1-n2)/(2.0*e);
  float y = a - b;
  n1 = snoise(vec3(p.x+e, p.y, p.z)); n2 = snoise(vec3(p.x-e, p.y, p.z));
  a = (n1-n2)/(2.0*e);
  n1 = snoise(vec3(p.x, p.y+e, p.z)); n2 = snoise(vec3(p.x, p.y-e, p.z));
  b = (n1-n2)/(2.0*e);
  float z = a - b;
  return vec3(x, y, z);
}
`;

/** Interleaved-gradient noise — the correct dither for TAA-friendly stochastic alpha. */
export const IGN = /* glsl */ `
float ign(vec2 px){ return fract(52.9829189 * fract(0.06711056*px.x + 0.00583715*px.y)); }
float bayer4(vec2 px){
  ivec2 p = ivec2(mod(px, 4.0));
  int idx = p.y*4 + p.x;
  const float m[16] = float[16](0.,8.,2.,10., 12.,4.,14.,6., 3.,11.,1.,9., 15.,7.,13.,5.);
  return m[idx] / 16.0;
}
`;

/** Common utility glue used across our materials. */
export const UTIL = /* glsl */ `
float sq(float x){ return x*x; }
float remap01(float x, float a, float b){ return clamp((x-a)/max(b-a,1e-6), 0.0, 1.0); }
float smoothMin(float a, float b, float k){ float h = clamp(0.5+0.5*(b-a)/k, 0.0, 1.0); return mix(b,a,h)-k*h*(1.0-h); }
vec3  safeNormalize(vec3 v){ float l = length(v); return l > 1e-8 ? v/l : vec3(0.0,1.0,0.0); }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
mat3  basisFromNormal(vec3 n){
  vec3 up = abs(n.y) < 0.999 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0);
  vec3 t = normalize(cross(up, n));
  return mat3(t, cross(n, t), n);
}
`;

/** Everything, for when you just want the whole toolbox. */
export const NOISE_LIB = HASH + SIMPLEX3 + FBM3 + WORLEY3 + CURL3 + IGN + UTIL;
