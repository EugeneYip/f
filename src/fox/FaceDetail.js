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

/**
 * Build the pinna interior as a thin shell fitted to the MEASURED inner
 * surface of the ear, rather than an ellipsoid authored to fixed dimensions.
 *
 * The previous version was a cup sized off the ear's length with a guessed
 * facing direction. When §4c reshaped the ears from semicircular paddles into
 * tapering triangles, the cup no longer fitted inside the new outline and its
 * 10 mm of depth pushed a flesh-coloured ellipsoid out through the BACK of the
 * far ear — a bald growth on the side of the head, and the first thing a
 * viewer's eye landed on.
 *
 * So nothing here is authored. Each row of the shell binary-searches outward
 * along the pinna until the ray stops hitting the plate, which recovers the
 * true silhouette whatever shape the ear currently is; the row is then inset
 * inside that edge and the vertex sits a third of a millimetre proud of the
 * skin it just measured. A shell that is by construction inside the outline
 * and flush to the surface cannot protrude at any viewing angle, and it
 * re-measures itself the next time the ear moves.
 *
 * `probe(t, s, out)` returns true and writes the surface point when (t, s)
 * lands on the pinna. Returns null when the ear could not be measured at all.
 */
function buildConchaFitted(probe, len, rows, cols, opts) {
  const T0 = opts.t0, T1 = opts.t1, INSET = opts.inset, PROUD = opts.proud;
  const h = new THREE.Vector3();

  // Widest offset either side of the bone axis that still lands on the plate.
  const edge = (t, dir) => {
    if (!probe(t, 0, h)) return 0;
    let lo = 0, hi = opts.maxHalf;
    for (let k = 1; k <= 10; k++) {              // expand
      const s = (k / 10) * opts.maxHalf;
      if (probe(t, s * dir, h)) lo = s; else { hi = s; break; }
    }
    for (let k = 0; k < 6; k++) {                // refine
      const m = 0.5 * (lo + hi);
      if (probe(t, m * dir, h)) lo = m; else hi = m;
    }
    return lo;
  };

  const band = [];
  let any = false;
  for (let j = 0; j <= rows; j++) {
    const t = lerp(T0, T1, j / rows);
    const ep = edge(t, 1) * INSET;
    const en = edge(t, -1) * INSET;
    const ok = ep + en > 0.003;
    if (ok) any = true;
    band.push({ t, ep, en, ok });
  }
  if (!any) return null;

  const pos = [], uvs = [], idx = [];
  for (let j = 0; j <= rows; j++) {
    const r = band[j];
    for (let i = 0; i <= cols; i++) {
      const u = (i / cols) * 2 - 1;
      const s = u >= 0 ? u * r.ep : u * r.en;
      // A row that missed collapses to zero width: its quads degenerate and
      // draw nothing, which is what we want at the rounded tip.
      if (r.ok && probe(r.t, s, h)) pos.push(h.x, h.y, h.z);
      else if (probe(r.t, 0, h)) pos.push(h.x, h.y, h.z);
      else { probe(T0, 0, h); pos.push(h.x, h.y, h.z); }
      uvs.push(u, (j / rows) * 2 - 1);
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i, b = a + 1, c = a + (cols + 1), e = c + 1;
      idx.push(a, b, c, b, e, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.userData.proud = PROUD;
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
      clearcoatRoughness: 0.045,
      envMapIntensity: 0.45,
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
    const f = fox.field;
    if (!f?.raycast) return;
    const PROUD = 0.00035;      // how far the shell floats off the inner skin

    for (const side of ['L', 'R']) {
      const b1 = fox.bone?.(`ear${side}01`);
      const tipA = fox.anchors?.[`earTip${side}`];
      if (!b1 || !tipA) continue;
      const base = this._bindPos(fox, b1);
      const tip = this._bindPos(fox, tipA);
      if (!base || !tip) continue;

      const up = new THREE.Vector3().subVectors(tip, base);
      const len = up.length();
      if (!(len > 1e-3)) continue;
      up.divideScalar(len);

      // --- which way does the concha face? Measured, not guessed ---------
      // Take a point INSIDE the upper pinna and read the SDF gradient there.
      // Inside a thin plate the gradient points at the nearest face, so it IS
      // the plate normal — no guessing, and it tracks any reshape for free.
      //
      // The previous attempt marched outward from mid-pinna and took the
      // normal where it exited. That failed silently after §4c: the ear bone's
      // origin sits INSIDE the cranium, so the lower half of the base->tip
      // axis is buried in the skull and the ray exited through the dome,
      // handing back the dome's normal. Every probe then hit the skull, every
      // row was rejected, and both conchas quietly built nothing.
      const inside = base.clone().addScaledVector(up, 0.70 * len);
      const arr = [0, 0, 0];
      if (!f.normal) continue;
      f.normal(inside.x, inside.y, inside.z, 3e-4, arr);
      const face = new THREE.Vector3().fromArray(arr);
      if (face.lengthSq() < 1e-10) continue;
      face.normalize();
      // The gradient gives the plate normal up to sign; the concha is the face
      // that looks forward and a little laterally outward.
      const outward = new THREE.Vector3(side === 'L' ? -0.30 : 0.30, 0.10, 1).normalize();
      if (face.dot(outward) < 0) face.negate();
      face.projectOnPlane(up);
      if (face.lengthSq() < 1e-8) continue;
      face.normalize();

      const sideV = new THREE.Vector3().crossVectors(up, face);
      if (sideV.lengthSq() < 1e-8) continue;
      sideV.normalize();
      const upO = new THREE.Vector3().crossVectors(face, sideV).normalize();

      // --- probe: does (t along the ear, s across it) land on the pinna? --
      const q = new THREE.Vector3(), o = new THREE.Vector3();
      const probe = (t, sOff, out) => {
        q.copy(base).addScaledVector(upO, t * len).addScaledVector(sideV, sOff);
        o.copy(q).addScaledVector(face, 0.040);
        const d = f.raycast(o.x, o.y, o.z, -face.x, -face.y, -face.z, 0.085);
        if (!(d > 0)) return false;
        out.copy(o).addScaledVector(face, -d);
        // Anything much further out than the plate's own half-thickness is a
        // different surface (the skull behind, or a miss past the rim).
        const off = out.clone().sub(q).dot(face);
        if (off < -0.002 || off > 0.020) return false;
        out.addScaledVector(face, PROUD);
        return true;
      };

      const g = buildConchaFitted(probe, len, segs, Math.max(6, segs - 4), {
        t0: 0.18, t1: 0.93, inset: 0.82, proud: PROUD, maxHalf: 0.045,
      });
      if (!g) continue;                       // ear not measurable; draw nothing

      // Bind space -> ear01's local frame, then ride the bone.
      const bones = fox.skeleton?.bones;
      const bi = bones ? bones.indexOf(b1) : -1;
      const inv = bi >= 0 ? fox.skeleton.boneInverses?.[bi] : null;
      if (!inv) { g.dispose(); continue; }
      g.applyMatrix4(inv);
      g.computeVertexNormals();

      const cup = new THREE.Mesh(g, this._earMaterial());
      cup.name = `foxConcha${side}`;
      cup.castShadow = false;
      cup.receiveShadow = true;
      b1.add(cup);
      this.parts.push(cup);
    }
  }

  /** Bind-pose position, in the skinned mesh's object space, of a bone or of
   *  an Object3D parented to one. */
  _bindPos(fox, obj) {
    const sk = fox.skeleton;
    const bones = sk?.bones;
    if (!bones) return null;
    const isBone = !!obj.isBone;
    const bone = isBone ? obj : obj.parent;
    const bi = bones.indexOf(bone);
    const inv = bi >= 0 ? sk.boneInverses?.[bi] : null;
    if (!inv) return null;
    const bind = new THREE.Matrix4().copy(inv).invert();
    const p = new THREE.Vector3();
    if (isBone) p.setFromMatrixPosition(bind);
    else p.copy(obj.position).applyMatrix4(bind);
    return p;
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
  // Fine hair running up out of the concha. The pinna interior is furred, not
  // bare skin, so the hair is what should dominate the read.
  float fdHair = snoise(vec3(vEarUv.x * 40.0, vEarUv.y * 9.0, 2.0)) * 0.5 + 0.5;
  float fdHair2 = snoise(vec3(vEarUv.x * 96.0, vEarUv.y * 21.0, 7.0)) * 0.5 + 0.5;
  // Faint warmth only in the bottom of the bowl; white fur everywhere else.
  vec3 fdCol = mix(uEarSkin, uEarRim, smoothstep(0.10, 0.62, fdRr));
  fdCol *= mix(0.88, 1.08, fdHair * 0.65 + fdHair2 * 0.35);
  // Depth without saturation. The bowl of the ear is in shade, and rubric C
  // is explicit that white fur in shade goes BLUE, not merely darker — so the
  // interior reads as a real furred cup rather than a flat cutout, while the
  // only warm value on the animal stays confined to transmitted light.
  float fdDeep = 1.0 - smoothstep(0.0, 0.80, fdRr);
  fdCol = mix(fdCol, fdCol * vec3(0.70, 0.79, 0.96), fdDeep * 0.88);
  fdCol *= mix(0.50, 1.0, smoothstep(0.0, 0.82, fdRr));
  diffuseColor.rgb = fdCol;
`)
          .replace('#include <lights_fragment_end>', /* glsl */ `
#include <lights_fragment_end>
  // Wrapped transmission: light arriving from BEHIND the thin pinna leaks
  // through its edge. Strongest where the sheet is thinnest (the rim) and
  // where we are looking toward the sun.
  float fdBack = fdSat(dot(-vEarWN, normalize(uSunL)));
  float fdThin = smoothstep(0.30, 1.0, length(vEarUv));
  // Transmitted light is the one place a warm tint is physically right: it
  // has passed through tissue. Keep it dim so it only shows when genuinely
  // backlit, and never tints the ear in ambient.
  reflectedLight.directDiffuse += mix(uEarRim, uEarSkin, 0.75) *
    pow(fdBack, 2.4) * fdThin * 1.15;
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
      // §4b forbids any warm cast on this animal, and the inner ear is the
      // one place a little is legitimate — but only a little. A real arctic
      // fox pinna is densely furred and reads nearly white, with faint warmth
      // only deep in the bowl. uEarSkin is that deep tint; uEarRim is the
      // furred outer field. The previous pair (#d9cfc4 -> #e8b48c) put the
      // SATURATED value on the rim, which rendered the ear as orange plastic.
      uEarSkin: { value: new THREE.Color(0xc9b8ae) },
      uEarRim: { value: new THREE.Color(0xeef1f5) },
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
