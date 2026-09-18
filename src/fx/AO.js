// OWNER: postfx. Ground-Truth Ambient Occlusion (Jimenez et al. 2016) driven
// purely by the depth buffer.
//
// WHY NOT GTAOPass: the addon renders a full scene normal+depth prepass with
// `MeshNormalMaterial` as an override. That (a) costs a second pass over every
// draw call in the scene, which alone would eat the 3.5 ms post budget, and
// (b) silently ignores custom vertex shaders — the fur shells displace in their
// own vertex stage, so their normals would come back at the base-mesh
// positions and the AO would sit misaligned under the fur silhouette. That
// mismatch is exactly what produces the dark-halo / white-outline tell.
// Reconstructing view normals from depth costs four taps, is automatically
// consistent with whatever actually got rasterised (shells, fins, particles),
// and leaves the budget intact.
//
// Radius is authored in METRES, not pixels: the subject is a 0.55 m animal, so
// contact occlusion lives at ~0.10 m. The addon defaults are sized for
// architecture and read as a smudge at this scale.
import * as THREE from 'three';
import { FxPass, makeRT, disposeRT } from './Pass.js';

const GTAO_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2  uTexel;        // 1 / half-res
uniform mat4  uInvProj;
uniform float uNear;
uniform float uFar;
uniform float uRadius;       // world metres
uniform float uProjScale;    // half-res pixels per metre at 1 m depth
uniform float uMaxPx;
uniform float uMinPx;
uniform float uNoiseOffset;  // decorrelates the dither across TAA samples
varying vec2 vUv;

vec3 viewPosAt(vec2 uv) {
  return fxViewPos(uv, texture2D(tDepth, uv).x, uInvProj);
}

void main() {
  float d = texture2D(tDepth, vUv).x;

  // Sky is never occluded. Leaving it at 1.0 also stops the denoise and the
  // bilateral upsample from dragging occlusion out over the silhouette.
  if (d >= 0.999998) { gl_FragColor = vec4(1.0, uFar, 0.0, 1.0); return; }

  vec3 p = fxViewPos(vUv, d, uInvProj);
  float viewDist = -p.z;
  vec3 V = normalize(-p);

  // Edge-aware normal: take the closer neighbour on each axis so a depth
  // discontinuity bends the basis instead of averaging across it.
  vec3 pl = viewPosAt(vUv - vec2(uTexel.x, 0.0));
  vec3 pr = viewPosAt(vUv + vec2(uTexel.x, 0.0));
  vec3 pd = viewPosAt(vUv - vec2(0.0, uTexel.y));
  vec3 pu = viewPosAt(vUv + vec2(0.0, uTexel.y));
  vec3 dx = (abs(pl.z - p.z) < abs(pr.z - p.z)) ? (p - pl) : (pr - p);
  vec3 dy = (abs(pd.z - p.z) < abs(pu.z - p.z)) ? (p - pd) : (pu - p);
  vec3 n = cross(dx, dy);
  float nl = length(n);
  n = nl > 1e-12 ? n / nl : V;
  if (n.z < 0.0) n = -n;

  float pxRadius = clamp(uRadius * uProjScale / max(viewDist, 1e-3), uMinPx, uMaxPx);
  float stepPx = pxRadius / float(AO_STEPS);

  float noise  = fxIGN(gl_FragCoord.xy + uNoiseOffset * 7.0);
  float noise2 = fxIGN(gl_FragCoord.yx * 1.371 + uNoiseOffset * 3.17 + 11.0);

  float invR = 1.0 / max(uRadius, 1e-4);
  float visibility = 0.0;

  for (int s = 0; s < AO_SLICES; s++) {
    float phi = (float(s) + noise) * (FX_PI / float(AO_SLICES));
    vec2 dir = vec2(cos(phi), sin(phi));
    vec3 sliceDir = vec3(dir, 0.0);

    vec3 orthoDir = sliceDir - dot(sliceDir, V) * V;
    vec3 axis = cross(sliceDir, V);
    vec3 projN = n - axis * dot(n, axis);
    float lenProjN = max(length(projN), 1e-5);
    float cosN = clamp(dot(projN, V) / lenProjN, -1.0, 1.0);
    float nAngle = sign(dot(orthoDir, projN)) * acos(cosN);

    float h1 = -1.0;   // horizon cosine toward -dir
    float h2 = -1.0;   // horizon cosine toward +dir

    for (int k = 0; k < AO_STEPS; k++) {
      // +1 px so we never sample ourselves; dithered so TAA can average the
      // step pattern away instead of banding.
      float off = (float(k) + noise2) * stepPx + 1.0;
      vec2 o = dir * off * uTexel;

      vec3 ds = viewPosAt(vUv + o) - p;
      float l = length(ds);
      float c = l > 1e-6 ? dot(ds, V) / l : -1.0;
      // Range falloff is the whole anti-halo story: a sample further away than
      // the radius must decay to "no occlusion" (-1) smoothly, otherwise a
      // near object throws occlusion onto the distant background behind it and
      // you get the classic dark rim around the silhouette.
      float f = fxSat(1.0 - l * invR);
      f = f * f * (3.0 - 2.0 * f);
      h2 = max(h2, mix(-1.0, c, f));

      ds = viewPosAt(vUv - o) - p;
      l = length(ds);
      c = l > 1e-6 ? dot(ds, V) / l : -1.0;
      f = fxSat(1.0 - l * invR);
      f = f * f * (3.0 - 2.0 * f);
      h1 = max(h1, mix(-1.0, c, f));
    }

    float hAngle1 = -acos(clamp(h1, -1.0, 1.0));
    float hAngle2 =  acos(clamp(h2, -1.0, 1.0));
    hAngle1 = nAngle + max(hAngle1 - nAngle, -FX_HALF_PI);
    hAngle2 = nAngle + min(hAngle2 - nAngle,  FX_HALF_PI);

    float sinN = sin(nAngle);
    float cosNa = cos(nAngle);
    float arc1 = -cos(2.0 * hAngle1 - nAngle) + cosNa + 2.0 * hAngle1 * sinN;
    float arc2 = -cos(2.0 * hAngle2 - nAngle) + cosNa + 2.0 * hAngle2 * sinN;
    visibility += lenProjN * 0.25 * (arc1 + arc2);
  }

  visibility /= float(AO_SLICES);
  gl_FragColor = vec4(fxSat(visibility), viewDist, 0.0, 1.0);
}
`;

const DENOISE_FRAG = /* glsl */ `
uniform sampler2D tAO;
uniform vec2  uTexel;
uniform float uRadiusPx;
uniform float uDepthSigma;
varying vec2 vUv;

const vec2 POISSON[8] = vec2[8](
  vec2( 0.8528,  0.0000), vec2( 0.4535,  0.6404), vec2(-0.1856,  0.8010),
  vec2(-0.7274,  0.3835), vec2(-0.7274, -0.3835), vec2(-0.1856, -0.8010),
  vec2( 0.4535, -0.6404), vec2( 0.2100,  0.2100)
);

void main() {
  vec2 c = texture2D(tAO, vUv).xy;
  float z = c.y;
  float sum = c.x;
  float wsum = 1.0;

  float rot = fxIGN(gl_FragCoord.xy) * 6.28318531;
  float cs = cos(rot), sn = sin(rot);
  mat2 R = mat2(cs, sn, -sn, cs);

  for (int i = 0; i < 8; i++) {
    vec2 o = (R * POISSON[i]) * uRadiusPx * uTexel;
    vec2 s = texture2D(tAO, vUv + o).xy;
    // Depth-relative bilateral weight: keeps the filter inside one surface so
    // occlusion cannot leak across the fox/snow boundary.
    float w = exp(-abs(s.y - z) / max(z * uDepthSigma, 1e-4));
    sum += s.x * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum / wsum, z, 0.0, 1.0);
}
`;

export class AO {
  constructor(renderer, w, h, tune) {
    this.renderer = renderer;
    this.slices = tune.slices;
    this.steps = tune.steps;

    this.rtA = makeRT(w, h, { format: THREE.RGFormat, name: 'ao' });
    this.rtB = makeRT(w, h, { format: THREE.RGFormat, name: 'aoDenoised' });

    this.gtao = new FxPass('gtao', GTAO_FRAG, {
      tDepth: { value: null },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uInvProj: { value: new THREE.Matrix4() },
      uNear: { value: 0.05 },
      uFar: { value: 900 },
      uRadius: { value: 0.11 },
      uProjScale: { value: 500 },
      uMaxPx: { value: 42 },
      uMinPx: { value: 2.5 },
      uNoiseOffset: { value: 0 },
    }, { AO_SLICES: this.slices, AO_STEPS: this.steps });

    this.denoise = new FxPass('aoDenoise', DENOISE_FRAG, {
      tAO: { value: this.rtA.texture },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uRadiusPx: { value: 2.2 },
      uDepthSigma: { value: 0.035 },
    });
  }

  get texture() { return this.rtB.texture; }

  setSize(w, h) {
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    this.gtao.u.uTexel.value.set(1 / w, 1 / h);
    this.denoise.u.uTexel.value.set(1 / w, 1 / h);
    this.denoise.u.tAO.value = this.rtA.texture;
  }

  /** @param p {{depth, invProj, near, far, height, tanHalfFov, noiseOffset, cfg}} */
  render(p) {
    const g = this.gtao.u;
    g.tDepth.value = p.depth;
    g.uInvProj.value.copy(p.invProj);
    g.uNear.value = p.near;
    g.uFar.value = p.far;
    g.uRadius.value = p.cfg.radius;
    // half-res pixels per metre of world radius at 1 m view depth
    g.uProjScale.value = (0.5 * p.height) / Math.max(p.tanHalfFov, 1e-4);
    g.uMaxPx.value = p.cfg.maxScreenRadius;
    g.uMinPx.value = p.cfg.minScreenRadius;
    g.uNoiseOffset.value = p.noiseOffset;

    this.denoise.u.uRadiusPx.value = p.cfg.denoiseRadius;
    this.denoise.u.uDepthSigma.value = p.cfg.denoiseDepthSigma;

    this.gtao.render(this.renderer, this.rtA);
    this.denoise.render(this.renderer, this.rtB);
  }

  dispose() {
    disposeRT(this.rtA); disposeRT(this.rtB);
    this.gtao.dispose(); this.denoise.dispose();
  }
}
