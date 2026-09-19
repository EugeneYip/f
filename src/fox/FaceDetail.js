/**
 * FaceDetail — rhinarium, inner ear and lip margin.
 * OWNER: face agent.  (ART_DIRECTION.md §4b · REVIEW.md category C)
 *
 * §4b, binding: "Nose: small, BLACK, wet and specular, with defined nostril
 * slits." §3 gives skin/nose as #171a20, "near-black, wet specular, never
 * matte". REVIEW.md C scores a matte nose exactly as harshly as a matte eye.
 *
 * Three pieces, in order of how much they are worth:
 *
 *   nose   A rhinarium sitting on the muzzle at `anchors.nose`. Nostril slits
 *          and the philtrum are cut as REAL geometry (the vertices move), not
 *          just shaded, so they survive at the macro framing and break the
 *          silhouette. Shaded near-black with a clearcoat wet layer and a
 *          cobblestone micro-normal, which is what a rhinarium actually looks
 *          like close up.
 *   ears   A shallow concha cup inside each pinna plus a thin translucent rim
 *          shell, so a backlit ear glows at the edge instead of going opaque.
 *   lips   A dark, slightly glossy margin strip along the mouth line.
 *
 * ---------------------------------------------------------------------------
 * EVERYTHING IS PLACED BY MEASUREMENT. The nose pad, the lip strip and the ear
 * pieces are all fitted by raycasting `ctx.fox.field` (the anatomy agent's own
 * SDF) and parented to the bone the corresponding anchor hangs off. No world
 * positions appear in this file, so a skull that moves, rescales or is
 * remeshed underneath us needs no change here.
 * ---------------------------------------------------------------------------
 */
import * as THREE from 'three';
import { clamp, saturate, lerp, TAU } from '../util/math.js';
import { HASH, SIMPLEX3, WORLEY3, UTIL } from '../shaders/noise.glsl.js';

// --- rhinarium, in metres on a 0.55 m animal -------------------------------
// An arctic fox's nose pad is small: roughly 13 mm across on this skull.
const NOSE_W = 0.0130;      // full width
const NOSE_H = 0.0098;      // full height
const NOSE_D = 0.0072;      // how far it stands off the muzzle
const NOSTRIL_DEPTH = 0.0036;
const PHILTRUM_DEPTH = 0.0016;

const LIP_LEN = 0.052;      // how far back along the jaw the mouth line runs
const LIP_HALF = 0.00085;   // half-height of the margin strip

/**
 * Shared GLSL. Prefixed `fd` for the same reason Eyes.js prefixes `fe`: these
 * are spliced into three's meshphysical program at a scope we do not own, and
 * an unprefixed collision surfaces only as a compile error that App.js turns
 * into a silently missing system.
 *
 * As in Eyes.js, ALL uniforms are declared in one unconditional block. Every
 * stage gets the whole block; splitting them per chunk is what produced the
 * intermittent "undeclared identifier" failure on the eye material.
 */
const FD_UNIFORMS = /* glsl */ `
uniform vec3 uNoseCol, uNostrilCol, uEarSkin, uEarRim, uLipCol;
uniform vec3 uSunL, uCamL;
uniform float uWet, uNoseW, uNoseH, uTime;
`;

const FD_COMMON = /* glsl */ `
float fdSat(float x){ return clamp(x, 0.0, 1.0); }
/** Signed distance to a 2D capsule — the nostril slits are drawn with it. */
float fdCapsule(vec2 p, vec2 a, vec2 b, float r){
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
/**
 * Nostril + philtrum mask in nose-pad UV space, u,v in [-1,1].
 * Returns (nostril, philtrum) as 0..1 carve amounts. The SAME function runs on
 * the CPU when the pad is built, so the displaced geometry and the shading
 * agree exactly — a slit that is shaded in one place and modelled in another
 * reads as a smear.
 */
vec2 fdNoseCarve(vec2 uv){
  // Comma-shaped slit: a curved capsule opening down and out.
  vec2 m = vec2(abs(uv.x), uv.y);
  float d = fdCapsule(m, vec2(0.32, 0.22), vec2(0.64, -0.32), 0.125);
  float nostril = 1.0 - smoothstep(-0.03, 0.08, d);
  // Philtrum: the vertical groove from the bottom of the pad to the lip.
  float ph = (1.0 - smoothstep(0.0, 0.16, abs(uv.x))) *
             smoothstep(0.62, -0.25, uv.y);
  return vec2(nostril, ph);
}
`;

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------

/** JS mirror of fdNoseCarve — see the note in the GLSL above. */
function noseCarve(ux, uy) {
  const ax = Math.abs(ux);
  const a = [0.32, 0.22], b = [0.64, -0.32];
  const pax = ax - a[0], pay = uy - a[1];
  const bax = b[0] - a[0], bay = b[1] - a[1];
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  const d = Math.hypot(pax - bax * h, pay - bay * h) - 0.125;
  const ss = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1); return t * t * (3 - 2 * t); };
  const nostril = 1 - ss(-0.03, 0.08, d);
  const ph = (1 - ss(0, 0.16, ax)) * ss(0.62, -0.25, uy);
  return [nostril, ph];
}

/**
 * The nose pad: a dome over an elliptical footprint, with the nostrils and
 * philtrum pressed in. Built as a grid in (u,v) so the carve can move real
 * vertices; normals come out of the displaced surface.
 */
function buildNose(w, h, d, n, baseAt) {
  const pos = [], uvs = [], idx = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      // Disc-warped grid: a square mapped onto a circle keeps the quads even
      // and avoids the pinched pole a lathe would give at the tip.
      const sx = (i / n) * 2 - 1, sy = (j / n) * 2 - 1;
      const ux = sx * Math.sqrt(Math.max(0, 1 - 0.5 * sy * sy));
      const uy = sy * Math.sqrt(Math.max(0, 1 - 0.5 * sx * sx));
      const r2 = clamp(ux * ux + uy * uy, 0, 1);
      // The pad's BASE follows the measured muzzle surface rather than a flat
      // plane. A flat-based disc on a curved muzzle either floats at the rim
      // or gets clipped by the skin — the critic saw both.
      const base = baseAt(ux, uy);
      // Dome, fading to nothing at the rim so the pad dies into the muzzle.
      const dome = d * Math.pow(Math.max(0, 1 - r2), 0.60) *
        (1.0 - Math.pow(r2, 6.0));
      let z = base + dome;
      const [nostril, phil] = noseCarve(ux, uy);
      z -= NOSTRIL_DEPTH * nostril;
      z -= PHILTRUM_DEPTH * phil;
      pos.push(ux * w * 0.5, uy * h * 0.5, z);
      uvs.push(ux, uy);
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + (n + 1), e = c + 1;
      idx.push(a, b, c, b, e, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A shallow dished cup for the pinna interior. */
function buildConcha(rx, ry, depth, n = 26) {
  const pos = [], uvs = [], idx = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const sx = (i / n) * 2 - 1, sy = (j / n) * 2 - 1;
      const ux = sx * Math.sqrt(Math.max(0, 1 - 0.5 * sy * sy));
      const uy = sy * Math.sqrt(Math.max(0, 1 - 0.5 * sx * sx));
      const r2 = clamp(ux * ux + uy * uy, 0, 1);
      // Concave: deepest at the base of the cup, opening toward the tip.
      const z = -depth * Math.pow(Math.max(0, 1 - r2), 0.85) *
        (0.55 + 0.45 * saturate(0.5 - uy * 0.5));
      pos.push(ux * rx, uy * ry, z);
      uvs.push(ux, uy);
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + (n + 1), e = c + 1;
      idx.push(a, b, c, b, e, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------

export class FaceDetail {
  name = 'faceDetail';
  order = 152;

  constructor() {
    this.parts = [];
    this.enabled = true;
    this._m = new THREE.Matrix4();
  }

  async init(ctx) {
    const fox = ctx.fox;
    if (!fox?.anchors) throw new Error('FaceDetail: ctx.fox.anchors missing');
    const tier = ctx.quality.tier;
    const seg = tier === 'low' ? 0 : tier === 'medium' ? 1 : 2;
    this.u = this._makeUniforms(ctx);

    this._buildNose(ctx, [28, 42, 56][seg]);
    this._buildLipLine(ctx);
    this._buildEars(ctx, [14, 20, 26][seg]);

    ctx.faceDetail = this;
    const ns = this.noseSize;
    console.info(`[faceDetail] ${this.parts.length} parts · nose ` +
      (ns ? `${(ns.w * 1000).toFixed(1)}x${(ns.h * 1000).toFixed(1)} mm, ` +
            `${(ns.d * 1000).toFixed(1)} mm proud` : 'MISSING'));
  }

  // ------------------------------------------------------------------ nose --
  _buildNose(ctx, segs) {
    const fox = ctx.fox;
    const anchor = fox.anchors.nose;
    if (!anchor) return;
    const f = fox.field;

    // --- work in FIELD space, where the SDF lives ------------------------
    const bone = anchor.parent;
    const bones = fox.skeleton?.bones;
    const bi = bones ? bones.indexOf(bone) : -1;
    const inv = bi >= 0 ? fox.skeleton.boneInverses?.[bi] : null;
    if (!inv) return;
    const bindMat = new THREE.Matrix4().copy(inv).invert();
    const rotToBone = new THREE.Matrix4().extractRotation(inv);
    const pA = anchor.position.clone().applyMatrix4(bindMat);

    // Outward normal, straight off the anatomy agent's own SDF gradient.
    const out = new THREE.Vector3(0, 0, 1);
    if (f?.normal) {
      const o = [0, 0, 0];
      f.normal(pA.x, pA.y, pA.z, 4e-4, o);
      if (Math.hypot(o[0], o[1], o[2]) > 1e-6) out.fromArray(o).normalize();
    }
    // Tangent basis, keeping +Y as close to world up as the normal allows.
    const ty = new THREE.Vector3(0, 1, 0).projectOnPlane(out);
    if (ty.lengthSq() < 1e-6) ty.set(0, 0, 1).projectOnPlane(out);
    ty.normalize();
    const tx = new THREE.Vector3().crossVectors(ty, out).normalize();

    // --- size the pad to the real nose region -----------------------------
    const fit = this._measureNoseFootprint(fox, pA, tx, ty);
    // §4b is explicit that the nose is SMALL. The anatomy agent's nose region
    // is considerably wider than the rhinarium it represents, so the measured
    // footprint is an upper bound to be clamped, not a target: 17.5 mm across
    // and 9.5 mm proud read as a bulbous snout knob on a 102 mm head.
    const w = fit ? clamp(fit.w * 0.80, 0.0100, 0.0142) : NOSE_W;
    const h = fit ? clamp(fit.h * 0.80, 0.0078, 0.0112) : NOSE_H;
    const d = clamp(NOSE_D * (w / NOSE_W), 0.0038, 0.0058);

    // --- measure the muzzle surface under the pad -------------------------
    // A coarse grid of raycasts, bilinearly interpolated: the muzzle is smooth
    // enough that 15x15 is indistinguishable from per-vertex and it costs a
    // couple of hundred rays instead of a few thousand.
    const M = 15;
    const table = new Float32Array(M * M);
    const q = new THREE.Vector3();
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < M; i++) {
        const ux = (i / (M - 1)) * 2 - 1, uy = (j / (M - 1)) * 2 - 1;
        let z = -0.0020;
        if (f?.raycast) {
          q.copy(pA).addScaledVector(tx, ux * w * 0.5).addScaledVector(ty, uy * h * 0.5)
            .addScaledVector(out, 0.030);
          const t = f.raycast(q.x, q.y, q.z, -out.x, -out.y, -out.z, 0.060);
          if (t > 0) z = 0.030 - t;        // signed offset along `out` from pA
        }
        table[j * M + i] = z;
      }
    }
    const baseAt = (ux, uy) => {
      const fx = clamp((ux + 1) * 0.5, 0, 1) * (M - 1);
      const fy = clamp((uy + 1) * 0.5, 0, 1) * (M - 1);
      const i0 = Math.min(M - 2, Math.floor(fx)), j0 = Math.min(M - 2, Math.floor(fy));
      const sx = fx - i0, sy = fy - j0;
      const a = table[j0 * M + i0], b = table[j0 * M + i0 + 1];
      const c = table[(j0 + 1) * M + i0], e = table[(j0 + 1) * M + i0 + 1];
      return lerp(lerp(a, b, sx), lerp(c, e, sx), sy);
    };

    const g = buildNose(w, h, d, segs, baseAt);
    const mesh = new THREE.Mesh(g, this._noseMaterial());
    mesh.name = 'foxNose';
    mesh.castShadow = false;
    mesh.receiveShadow = true;

    // Pad axes -> bone space. The mesh is a child of the anchor, so its origin
    // is already at pA and only the rotation is needed.
    const bx = tx.clone().transformDirection(rotToBone).normalize();
    const by = ty.clone().transformDirection(rotToBone).normalize();
    const bz = out.clone().transformDirection(rotToBone).normalize();
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(bx, by, bz));
    anchor.add(mesh);
    this.parts.push(mesh);
    this.nose = mesh;
    this.noseSize = { w, h, d };
  }

  /**
   * Extent of the anatomy agent's own nose region, projected onto the pad
   * plane. Sizing the pad off this means it covers the dark region tint
   * exactly instead of floating inside it (leaving a bright ring) or spilling
   * past the muzzle silhouette. A 95th percentile rather than a max, so one
   * stray vertex cannot inflate the whole pad.
   */
  _measureNoseFootprint(fox, pA, tx, ty) {
    const reg = fox.attributes?.region;
    const pos = fox.bindPositions;
    const id = fox.REGION?.nose;
    if (!reg || !pos || id === undefined) return null;
    const xs = [], ys = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < reg.count; i++) {
      if (Math.round(reg.getX(i)) !== id) continue;
      v.set(pos[i * 3] - pA.x, pos[i * 3 + 1] - pA.y, pos[i * 3 + 2] - pA.z);
      xs.push(Math.abs(v.dot(tx)));
      ys.push(Math.abs(v.dot(ty)));
    }
    if (xs.length < 8) return null;
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
    const pct = (arr) => arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))];
    return { w: pct(xs) * 2 * 1.10, h: pct(ys) * 2 * 1.10, n: xs.length };
  }

  /**
   * Outward surface normal at an anchor, in the anchor's parent (bone) frame.
   * Falls back to the anchor's own offset direction from its bone when the SDF
   * is unavailable.
   */
  _surfaceNormalAt(fox, anchor) {
    const v = new THREE.Vector3();
    const f = fox.field;
    // The anchor's world position at BIND is what the field knows about, so go
    // through the bind inverse rather than the live matrix.
    const bone = anchor.parent;
    const bones = fox.skeleton?.bones;
    const bi = bones ? bones.indexOf(bone) : -1;
    if (f?.normal && bi >= 0 && fox.skeleton.boneInverses?.[bi]) {
      const bind = new THREE.Matrix4().copy(fox.skeleton.boneInverses[bi]).invert();
      const p = anchor.position.clone().applyMatrix4(bind);
      const outArr = [0, 0, 0];
      f.normal(p.x, p.y, p.z, 4e-4, outArr);
      v.fromArray(outArr);
      if (v.lengthSq() > 1e-8) {
        // field space -> bone space
        const rot = new THREE.Matrix4().extractRotation(fox.skeleton.boneInverses[bi]);
        return v.transformDirection(rot).normalize();
      }
    }
    v.copy(anchor.position);
    return v.lengthSq() > 1e-9 ? v.normalize() : new THREE.Vector3(0, 0, 1);
  }

  _noseMaterial() {
    const m = new THREE.MeshPhysicalMaterial({
      name: 'foxNose',
      color: 0xffffff,
      roughness: 0.34,
      metalness: 0.0,
      // §3: "near-black, WET SPECULAR, never matte". The wet film is a real
      // clearcoat lobe so it picks up the env map and every scene light —
      // with the key behind the animal, the sky and the snow bounce are what
      // actually make a nose look wet.
      clearcoat: 1.0,
      clearcoatRoughness: 0.09,
      envMapIntensity: 1.0,
    });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.u);
      sh.vertexShader = 'varying vec2 vPadUv; varying vec3 vFdN;\n' + sh.vertexShader
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vPadUv = uv;')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vFdN = objectNormal;');

      sh.fragmentShader = 'varying vec2 vPadUv; varying vec3 vFdN;\n' +
        FD_UNIFORMS + HASH + SIMPLEX3 + WORLEY3 + UTIL + FD_COMMON +
        sh.fragmentShader
          .replace('#include <map_fragment>', /* glsl */ `
  vec2 fdCv = fdNoseCarve(vPadUv);
  float fdR = length(vPadUv);

  // Rhinarium micro-texture: the pad is covered in fine polygonal tubercles.
  // Worley at two scales gives the cobblestone; it drives BOTH the albedo and
  // the normal below, which is what stops the nose reading as a plastic bead.
  vec3 fdId;
  float fdW1 = worley3(vec3(vPadUv * 34.0, 0.0), fdId).x;
  float fdW2 = worley3(vec3(vPadUv * 74.0, 5.0), fdId).x;
  float fdGrain = fdW1 * 0.68 + fdW2 * 0.32;

  vec3 fdCol = uNoseCol * mix(0.80, 1.22, fdGrain);
  // Inside the nostrils there is no light at all.
  fdCol = mix(fdCol, uNostrilCol, fdCv.x * 0.97);
  fdCol = mix(fdCol, uNostrilCol, fdCv.y * 0.35);
  // The rim of the pad darkens into the fur rather than ending on an edge.
  fdCol *= mix(1.0, 0.70, smoothstep(0.72, 1.0, fdR));
  diffuseColor.rgb = fdCol;
`)
          .replace('#include <roughnessmap_fragment>', /* glsl */ `
  // Wet on the pad, dry and matte inside the nostrils — the contrast between
  // the two is most of what says "wet".
  float roughnessFactor = mix(mix(0.26, 0.40, fdGrain), 0.85, max(fdCv.x, fdCv.y * 0.6));
`)
          .replace('#include <normal_fragment_maps>', /* glsl */ `
  // Perturb along the tubercle gradient. Cheap finite difference on the same
  // Worley field the albedo uses, so bumps and colour agree.
  vec3 fdIdA;
  float fdE = 0.012;
  float fdGx = worley3(vec3((vPadUv + vec2(fdE, 0.0)) * 34.0, 0.0), fdIdA).x - fdW1;
  float fdGy = worley3(vec3((vPadUv + vec2(0.0, fdE)) * 34.0, 0.0), fdIdA).x - fdW1;
  normal = normalize(normal + vec3(-fdGx, -fdGy, 0.0) * 9.0);
`);
    };
    m.customProgramCacheKey = () => 'foxNosePad';
    return m;
  }

  // -------------------------------------------------------------- lip line --
  /**
   * The mouth line. Sampled back along the jaw from the mouth anchor and
   * snapped onto the skin with the SDF, so it hugs whatever muzzle shape the
   * anatomy agent has arrived at.
   */
  _buildLipLine(ctx) {
    const fox = ctx.fox;
    const anchor = fox.anchors.mouth;
    const f = fox.field;
    if (!anchor) return;

    const bone = anchor.parent;
    const bones = fox.skeleton?.bones;
    const bi = bones ? bones.indexOf(bone) : -1;
    if (bi < 0 || !fox.skeleton.boneInverses?.[bi]) return;
    const inv = fox.skeleton.boneInverses[bi];
    const bind = new THREE.Matrix4().copy(inv).invert();
    const rotToBone = new THREE.Matrix4().extractRotation(inv);

    const start = anchor.position.clone().applyMatrix4(bind);   // field space
    const N = 26;
    const pos = [], idx = [];
    const tmp = new THREE.Vector3();
    let wrote = 0;

    for (let side = 0; side < 2; side++) {
      const sx = side === 0 ? -1 : 1;
      const ring = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        // Sweep back and slightly out along the jaw, dropping a little.
        const x = start.x + sx * LIP_LEN * 0.42 * Math.sin(t * 1.35);
        const y = start.y - LIP_LEN * 0.10 * t * t;
        const z = start.z - LIP_LEN * t;
        // Pull onto the skin: march inward from outside the muzzle.
        const dir = [sx * 0.55, -0.35, 0.0];
        const dl = Math.hypot(dir[0], dir[1], dir[2]);
        const d = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
        const ox = x + d[0] * 0.05, oy = y + d[1] * 0.05, oz = z + d[2] * 0.05;
        const hit = f?.raycast ? f.raycast(ox, oy, oz, -d[0], -d[1], -d[2], 0.10) : -1;
        let px = x, py = y, pz = z;
        if (hit > 0) {
          px = ox - d[0] * hit; py = oy - d[1] * hit; pz = oz - d[2] * hit;
          // Sit a hair proud so we are never inside the skin.
          px -= d[0] * 0.0004; py -= d[1] * 0.0004; pz -= d[2] * 0.0004;
        }
        ring.push([px, py, pz]);
      }
      const base = wrote;
      for (let i = 0; i <= N; i++) {
        const p = ring[i];
        // Taper the strip away toward the commissure. A constant-width black
        // ribbon ending on a square cut reads as a drawn-on hook, not as a
        // lip margin; §4b only asks for "subtle darker skin at the lip".
        const t = i / N;
        const ss = clamp((t - 0.45) / 0.55, 0, 1);
        const hh = LIP_HALF * (1 - 0.78 * ss * ss * (3 - 2 * ss));
        for (const s of [-1, 1]) {
          tmp.set(p[0], p[1] + s * hh, p[2]).applyMatrix4(inv);
          pos.push(tmp.x, tmp.y, tmp.z);
          wrote++;
        }
      }
      for (let i = 0; i < N; i++) {
        const a = base + i * 2, b = a + 1, c = a + 2, e = a + 3;
        if (side === 0) idx.push(a, b, c, b, e, c);
        else idx.push(a, c, b, b, c, e);
      }
    }
    if (!pos.length) return;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();

    const m = new THREE.MeshPhysicalMaterial({
      name: 'foxLipLine',
      color: 0x1d181a,
      roughness: 0.48,
      metalness: 0.0,
      clearcoat: 0.7,
      clearcoatRoughness: 0.20,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.name = 'foxLipLine';
    mesh.castShadow = false;
    bone.add(mesh);
    this.parts.push(mesh);
    this.lips = mesh;
  }

  // ------------------------------------------------------------------ ears --
  /**
   * Pinna interior. The axis and the size are derived from the live ear bone
   * chain and the ear-tip anchor, so the anatomy agent's wide-set paddles are
   * picked up automatically.
   */
  _buildEars(ctx, segs) {
    const fox = ctx.fox;
    for (const side of ['L', 'R']) {
      const tip = fox.anchors?.[`earTip${side}`];
      const b1 = fox.bone?.(`ear${side}01`);
      const b3 = fox.bone?.(`ear${side}03`);
      if (!tip || !b1 || !b3) continue;

      b1.updateWorldMatrix(true, false);
      b3.updateWorldMatrix(true, false);
      tip.updateWorldMatrix(true, false);
      const pBase = new THREE.Vector3().setFromMatrixPosition(b1.matrixWorld);
      const pTip = new THREE.Vector3().setFromMatrixPosition(tip.matrixWorld);
      const len = pBase.distanceTo(pTip);
      if (!(len > 1e-4)) continue;

      // The pinna opens forward and inward; take "up the ear" from the bone
      // chain and "out of the concha" as the component facing the midline.
      const upEar = new THREE.Vector3().subVectors(pTip, pBase).normalize();
      const inward = new THREE.Vector3(side === 'L' ? 1 : -1, 0, 0.62).normalize();
      const faceDir = inward.projectOnPlane(upEar).normalize();
      if (!Number.isFinite(faceDir.x) || faceDir.lengthSq() < 1e-6) continue;

      const cup = new THREE.Mesh(
        buildConcha(len * 0.34, len * 0.46, len * 0.20, segs),
        this._earMaterial(),
      );
      cup.name = `foxConcha${side}`;
      cup.castShadow = false;

      // Place it in the middle of the pinna, in b3's local frame.
      const mid = new THREE.Vector3().copy(pBase).addScaledVector(upEar, len * 0.52);
      mid.addScaledVector(faceDir, len * 0.055);
      b3.worldToLocal(mid);
      cup.position.copy(mid);

      const rot = new THREE.Matrix4().extractRotation(b3.matrixWorld).invert();
      const zAxis = faceDir.clone().transformDirection(rot).normalize();
      const yAxis = upEar.clone().transformDirection(rot).normalize();
      const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
      yAxis.crossVectors(zAxis, xAxis).normalize();
      cup.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));

      b3.add(cup);
      this.parts.push(cup);
    }
  }

  /**
   * Pinna interior: short fur over skin, plus a wrapped transmissive term so
   * the thin edge of the ear GLOWS when the sun is behind it. §4b calls the
   * ears thin; an opaque pinna against a low sun is the tell that they are
   * being treated as cardboard.
   */
  _earMaterial() {
    const m = new THREE.MeshPhysicalMaterial({
      name: 'foxConcha',
      color: 0xffffff,
      roughness: 0.78,
      metalness: 0.0,
      side: THREE.DoubleSide,
      envMapIntensity: 0.8,
      transmission: 0.0,
    });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.u);
      sh.vertexShader = 'varying vec2 vEarUv; varying vec3 vEarWN;\n' + sh.vertexShader
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vEarUv = uv;')
        .replace('#include <worldpos_vertex>',
          '#include <worldpos_vertex>\n  vEarWN = normalize(mat3(modelMatrix) * objectNormal);');

      sh.fragmentShader = 'varying vec2 vEarUv; varying vec3 vEarWN;\n' +
        FD_UNIFORMS + HASH + SIMPLEX3 + UTIL + FD_COMMON +
        sh.fragmentShader
          .replace('#include <map_fragment>', /* glsl */ `
  float fdRr = length(vEarUv);
  // Fine hair running up out of the concha.
  float fdHair = snoise(vec3(vEarUv.x * 40.0, vEarUv.y * 9.0, 2.0)) * 0.5 + 0.5;
  vec3 fdCol = mix(uEarSkin, uEarRim, smoothstep(0.35, 1.0, fdRr));
  fdCol *= mix(0.86, 1.10, fdHair);
  // Deep in the cup it is shadowed; that depth is what reads as an ear.
  fdCol *= mix(0.42, 1.0, smoothstep(0.0, 0.75, fdRr));
  diffuseColor.rgb = fdCol;
`)
          .replace('#include <lights_fragment_end>', /* glsl */ `
#include <lights_fragment_end>
  // Wrapped transmission: light arriving from BEHIND the thin pinna leaks
  // through its edge. Strongest where the sheet is thinnest (the rim) and
  // where we are looking toward the sun.
  float fdBack = fdSat(dot(-vEarWN, normalize(uSunL)));
  float fdThin = smoothstep(0.30, 1.0, length(vEarUv));
  reflectedLight.directDiffuse += uEarRim * pow(fdBack, 2.2) * fdThin * 1.9;
`);
    };
    m.customProgramCacheKey = () => 'foxConchaMat';
    return m;
  }

  // -------------------------------------------------------------- uniforms --
  _makeUniforms(ctx) {
    return {
      // §3 palette: skin/nose #171a20. Kept just off pure black so it still
      // takes a shadow and never crushes (non-negotiable #3).
      uNoseCol: { value: new THREE.Color(0x1f232b) },
      uNostrilCol: { value: new THREE.Color(0x05060a) },
      uEarSkin: { value: new THREE.Color(0xd9cfc4) },
      uEarRim: { value: new THREE.Color(0xe8b48c) },
      uLipCol: { value: new THREE.Color(0x100d0e) },
      uSunL: { value: new THREE.Vector3().copy(ctx.sunDirection) },
      uCamL: { value: new THREE.Vector3() },
      uWet: { value: 1.0 },
      uNoseW: { value: NOSE_W },
      uNoseH: { value: NOSE_H },
      uTime: { value: 0 },
    };
  }

  update(dt, ctx) {
    if (!this.enabled) return;
    this.u.uSunL.value.copy(ctx.sunDirection);
    this.u.uTime.value = ctx.time;
  }

  onQuality() { /* built once */ }

  dispose() {
    for (const p of this.parts) {
      p.geometry?.dispose();
      p.material?.dispose();
      p.parent?.remove(p);
    }
    this.parts.length = 0;
  }
}
