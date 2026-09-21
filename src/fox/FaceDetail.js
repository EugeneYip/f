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
// A 2.4 mm tall band with 0.75 mm of recess is not a mouth, it is a scratch,
// and at the `chin` framing that is precisely how it read. A canid's lip
// margin is a rolled soft-tissue edge several millimetres deep that OVERHANGS
// the seam — the overhang is the whole point, because it is what casts the
// occlusion line that a viewer reads as "mouth" rather than "drawn on".
const LIP_HALF = 0.00215;   // half-height of the whole lip band
const LIP_DEPTH = 0.00110;  // how far the seam itself is recessed
const LIP_BULGE = 0.00060;  // how far the upper lip's roll stands proud

// The philtrum, on the midline between rhinarium and upper lip.
const PHILTRUM_HALF = 0.00150;    // half-width of the groove + its ridges
const PHILTRUM_GROOVE = 0.00060;  // depth of the groove itself
const PHILTRUM_RIDGE = 0.00035;   // how far the flanking ridges stand proud

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

const smoothstep01 = (a, b, x) => {
  const t = clamp((x - a) / (b - a || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
};

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

  // SMOOTH THE OUTLINE ACROSS ROWS. `edge()` binary-searches each row
  // independently against an SDF with a hit-rejection test, so a row whose
  // last probe happens to clip the plate's rolled margin comes back 40%
  // narrower than its neighbours. The shell's boundary then zig-zags row to
  // row, and with alpha carried out to the margin (which the rim roll needs)
  // that renders as a torn, saw-toothed edge across the concha — clearly
  // visible with the coat hidden, and nothing like a pinna. A real ear
  // outline is smooth; a 5-tap mean over the measurable rows costs nothing
  // and cannot widen the shell past what was measured, because it is bounded
  // by a running MIN against the row's own measurement.
  const smoothCol = (key) => {
    const src = band.map((b) => (b.ok ? b[key] : NaN));
    const out = src.slice();
    for (let j = 0; j < src.length; j++) {
      if (!Number.isFinite(src[j])) continue;
      let sum = 0, n = 0;
      for (let k = -2; k <= 2; k++) {
        const v = src[j + k];
        if (Number.isFinite(v)) { sum += v; n++; }
      }
      out[j] = Math.min(sum / n, src[j] * 1.12);
    }
    for (let j = 0; j < band.length; j++) if (Number.isFinite(out[j])) band[j][key] = out[j];
  };
  smoothCol('ep');
  smoothCol('en');

  // --- the helical rim ------------------------------------------------
  // A shell laid flush on the plate is a decal: it can shade a bowl but it
  // cannot BE one, because nothing on it ever occludes anything else. The
  // pinna's margin is a rolled edge standing proud of the concha floor, and
  // that roll is what casts the shadow that reads as depth. Lifting a band
  // just inside the measured outline gives a real rim with a real occlusion
  // edge inside it, at the cost of nothing.
  //
  // It peaks a little inside the silhouette and returns to zero AT it, so the
  // shell still cannot poke past the ear's own outline at any viewing angle —
  // which is the invariant the fitted construction exists to guarantee.
  const RIM = opts.rimLift ?? 0;
  const lift = opts.liftDir;
  const rimAt = (u) => {
    const a = Math.abs(u);
    const roll = Math.exp(-Math.pow((a - 0.78) / 0.17, 2));
    const die = 1 - smoothstep01(0.90, 1.0, a);
    return roll * die;
  };

  const pos = [], uvs = [], idx = [];
  for (let j = 0; j <= rows; j++) {
    const r = band[j];
    // The rim dies out at the tip, where the two margins have converged and
    // there is no concha left between them to be a bowl.
    const tj = j / rows;
    const rimJ = (1 - smoothstep01(0.62, 0.98, tj)) * smoothstep01(0.0, 0.18, tj);
    // Walk each half of the row OUTWARD from the axis, and when a probe
    // finally misses, hold the last point that hit for the rest of that half.
    //
    // The previous version fell back to the row's AXIS point for any column
    // whose probe missed — so a single failed column mid-row snapped to the
    // centre while its neighbours stayed at full width, and the shell's
    // boundary came out as a row of sharp teeth across the concha. (Alpha used
    // to start fading at |u| = 0.55 and hid them; widening alpha out to the
    // margin, which the rim roll needs, made them visible. Confirmed by
    // toggling the two concha meshes with the coat hidden: the teeth are ours,
    // and with the shell off the pinna is a blank plate.) Holding the last
    // good point instead keeps every row monotone, so the boundary is smooth
    // whatever the SDF does, and the held columns pile up into a degenerate
    // strip that draws nothing.
    const row = new Array(cols + 1);
    const held = new THREE.Vector3();
    const mid = cols / 2;
    // CONTINUITY. probe() accepts any hit within 20 mm of the ideal grid
    // point along the plate normal, which is wide enough to swallow the
    // SKULL behind the ear when a ray slips past the pinna's margin. Those
    // vertices land centimetres away from their neighbours and the shell
    // folds back on itself; as a transparent, depth-write-off overlay the
    // folds composite twice and render as a torn dark patch across the
    // concha. Walking outward from the axis and rejecting any hit that jumps
    // more than 4 mm from the last accepted one removes them without
    // tightening probe()'s window, which would shrink the shell.
    const JUMP = 0.004;
    const at = (i, have) => {
      const u = (i / cols) * 2 - 1;
      const s = u >= 0 ? u * r.ep : u * r.en;
      if (r.ok && probe(r.t, s, h) && (!have || h.distanceTo(held) < JUMP)) {
        held.copy(h); return [u, true];
      }
      return [u, false];
    };
    for (const dir of [1, -1]) {
      let have = false;
      const i0 = dir > 0 ? Math.ceil(mid) : Math.floor(mid);
      for (let i = i0; i >= 0 && i <= cols; i += dir) {
        const [u, ok] = at(i, have);
        if (ok) { have = true; } else if (have) { h.copy(held); }
        else if (!probe(r.t, 0, h)) probe(T0, 0, h);
        if (lift && RIM > 0) h.addScaledVector(lift, RIM * rimAt(u) * rimJ);
        row[i] = [h.x, h.y, h.z, u];
      }
    }
    for (let i = 0; i <= cols; i++) {
      const v = row[i];
      pos.push(v[0], v[1], v[2]);
      // A row that could not be measured at all is pushed outside the [-1,1]
      // v range, where the shader's own base/tip fades take it to zero alpha.
      uvs.push(v[3], r.ok ? (j / rows) * 2 - 1 : (j / rows < 0.5 ? -2.2 : 2.2));
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

  vec3 fdCol = uNoseCol * mix(0.88, 1.14, fdGrain);
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
  float roughnessFactor = mix(mix(0.30, 0.38, fdGrain), 0.85, max(fdCv.x, fdCv.y * 0.6));
`)
          // The tear-film clearcoat belongs on the PAD. Left at 1.0 inside the
          // nostril it lit the slit walls from the sky and drew two bright
          // crescents where the darkest part of the face should be.
          .replace('#include <lights_physical_fragment>', /* glsl */ `
#include <lights_physical_fragment>
  material.clearcoat *= 1.0 - 0.92 * max(fdCv.x, fdCv.y * 0.55);
`)
          .replace('#include <normal_fragment_maps>', /* glsl */ `
  // Perturb along the tubercle gradient. Cheap finite difference on the same
  // Worley field the albedo uses, so bumps and colour agree.
  vec3 fdIdA;
  float fdE = 0.012;
  float fdGx = worley3(vec3((vPadUv + vec2(fdE, 0.0)) * 34.0, 0.0), fdIdA).x - fdW1;
  float fdGy = worley3(vec3((vPadUv + vec2(0.0, fdE)) * 34.0, 0.0), fdIdA).x - fdW1;
  // x9 on a Worley finite difference swings the normal through most of a
  // right angle between adjacent cells. Against roughness 0.26 that turns
  // every tubercle edge into its own specular glint, and at the 'chin'
  // framing the nostril rims rendered as a string of white pebbles — the
  // brightest thing on a face whose whole palette is "no warm cast, nothing
  // brighter than the snow". Tubercles are a fraction of a millimetre proud
  // on a 13 mm pad; x2.6 is already generous. They also stop AT the nostril
  // margin — the inside of a nostril is smooth wet mucosa, not cobblestone.
  float fdBump = 1.6 * (1.0 - max(fdCv.x, fdCv.y * 0.5));
  normal = normalize(normal + vec3(-fdGx, -fdGy, 0.0) * fdBump);
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
    if (!anchor || !f?.raycast) return;

    const bone = anchor.parent;
    const bones = fox.skeleton?.bones;
    const bi = bones ? bones.indexOf(bone) : -1;
    if (bi < 0 || !fox.skeleton.boneInverses?.[bi]) return;
    const inv = fox.skeleton.boneInverses[bi];
    const bind = new THREE.Matrix4().copy(inv).invert();
    const start = anchor.position.clone().applyMatrix4(bind);   // field space

    const N = 30;
    const pos = [], vv = [], idx = [];
    const tmp = new THREE.Vector3();
    const nrm = [0, 0, 0];
    let wrote = 0;

    for (let side = 0; side < 2; side++) {
      const sx = side === 0 ? -1 : 1;

      // --- walk the mouth line and snap it onto the skin ------------------
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        // The seam leaves the midline LATERALLY and only then turns back. A
        // path that is linear in z at t = 0 gives the two halves a 60-degree
        // included angle, and the mouth renders as a sharp chevron scored
        // into the muzzle — §4d's complaint about the chin, in miniature.
        // Quadratic in z means dz/dt is small at the midline, so the margin
        // rounds under the philtrum the way a real upper lip does.
        const x = start.x + sx * LIP_LEN * 0.46 * Math.sin(t * 1.45);
        const y = start.y - LIP_LEN * 0.10 * t * t;
        const z = start.z - LIP_LEN * (0.30 * t + 0.70 * t * t);
        const dl = Math.hypot(sx * 0.55, -0.35);
        const d = [sx * 0.55 / dl, -0.35 / dl, 0];
        const ox = x + d[0] * 0.05, oy = y + d[1] * 0.05, oz = z + d[2] * 0.05;
        const hit = f.raycast(ox, oy, oz, -d[0], -d[1], -d[2], 0.10);
        pts.push(hit > 0
          ? new THREE.Vector3(ox - d[0] * hit, oy - d[1] * hit, oz - d[2] * hit)
          : new THREE.Vector3(x, y, z));
      }

      // --- build a LIP, not a groove, and certainly not a stroke ----------
      // The previous version was three rows — skin, recess, skin — which is a
      // groove. A groove is not a mouth. §4f's complaint about the chin is
      // that the whole region "reads chunky because a bare surface was
      // sculpted to look furry", and the mouth had the mirror-image problem:
      // a real form (two lips meeting) rendered as a line scored into flat
      // skin. At the `chin` framing it read as a thin floating black curve,
      // which is exactly what it was.
      //
      // Six rows, so the section is a LIP. Reading down the muzzle:
      //
      //   v = +1.00  flush with the skin, where the muzzle takes over
      //   v = +0.55  the upper lip's roll, standing proud — this is the row
      //              that catches a rim light and gives the mouth a form
      //   v = +0.14  the upper lip's free margin, pigmented
      //   v =  0.00  the seam itself, recessed: the occlusion edge
      //   v = -0.34  the lower lip's margin, just proud of the seam
      //   v = -1.00  flush again, dying into the chin
      //
      // `v` also travels to the shader, which pigments the margins and fades
      // alpha to nothing at v = +-1 so the ribbon can never draw a boundary
      // of its own on the muzzle.
      const SECTION = [
        [1.00, 0.00], [0.78, 0.34], [0.52, 0.85], [0.26, 1.00], [0.07, 0.55],
        [0.00, -1.00], [-0.16, 0.45], [-0.42, 0.55], [-1.00, 0.00],
      ];
      const ROWS = SECTION.length;
      const base = wrote;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const p = pts[i];
        // Tangent along the seam, surface normal from the SDF, and the
        // in-surface perpendicular: the exact frame a lip section needs.
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N, i + 1)];
        const tan = new THREE.Vector3().subVectors(b, a);
        if (tan.lengthSq() < 1e-12) tan.set(0, 0, -1);
        tan.normalize();
        f.normal(p.x, p.y, p.z, 3e-4, nrm);
        const nv = new THREE.Vector3().fromArray(nrm);
        if (nv.lengthSq() < 1e-10) nv.set(0, 1, 0);
        nv.normalize();
        const bin = new THREE.Vector3().crossVectors(tan, nv).normalize();

        // Taper to NOTHING at the commissure. The old strip stopped at 22% of
        // its width, which is what read as a "pen-cap" stopping mid-cheek.
        //
        // sin(pi*t) does taper at t = 1, but it ALSO tapers at t = 0 — and
        // t = 0 is the midline, the one part of the mouth the `chin` framing
        // actually looks at. The lip was therefore pinched to 35% of its
        // section exactly where it is photographed, which is most of why
        // deepening the section did nothing the first time. Full section from
        // the midline back, closing only over the last third.
        const ct = clamp((t - 1.02) / (0.58 - 1.02), 0, 1);
        const fade = (ct * ct * (3 - 2 * ct)) ** 0.8;
        const hh = LIP_HALF * (0.30 + 0.70 * fade);
        for (const [v, z] of SECTION) {
          const off = z < 0 ? z * LIP_DEPTH * fade
                            : 0.0002 + z * LIP_BULGE * fade;
          tmp.copy(p).addScaledVector(bin, v * hh).addScaledVector(nv, off).applyMatrix4(inv);
          pos.push(tmp.x, tmp.y, tmp.z);
          vv.push(v);
        }
        wrote += ROWS;
      }
      for (let i = 0; i < N; i++) {
        const a = base + i * ROWS;
        const b = a + ROWS;
        for (let k = 0; k < ROWS - 1; k++) {
          const p0 = a + k, p1 = a + k + 1, p2 = b + k, p3 = b + k + 1;
          if (side === 0) idx.push(p0, p2, p1, p1, p2, p3);
          else idx.push(p0, p1, p2, p1, p3, p2);
        }
      }
    }
    if (!pos.length) return;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aLipV', new THREE.Float32BufferAttribute(vv, 1));
    g.setIndex(idx);
    g.computeVertexNormals();

    const mesh = new THREE.Mesh(g, this._lipMaterial());
    mesh.name = 'foxLipLine';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = 6;
    bone.add(mesh);
    this.parts.push(mesh);
    this.lips = mesh;

    this._buildPhiltrum(ctx);
  }

  /**
   * The philtrum: the groove that runs from the rhinarium down to the upper
   * lip, flanked by two low ridges.
   *
   * It used to exist only as a dip pressed into the NOSE PAD, which stops at
   * the edge of the pad — so on the muzzle below it there was nothing, and
   * the feature read as a decal that had been cropped. This is the same
   * ribbon construction as the lip, snapped to the same SDF, and it is
   * parented to the HEAD rather than to the jaw: the philtrum belongs to the
   * upper lip and must not travel with an opening mouth.
   */
  _buildPhiltrum(ctx) {
    const fox = ctx.fox;
    const f = fox.field;
    const mouth = fox.anchors?.mouth;
    const nose = fox.anchors?.nose;
    const head = fox.bone?.('head');
    if (!mouth || !nose || !head || !f?.raycast || !f?.normal) return;

    const bones = fox.skeleton?.bones;
    const hi = bones ? bones.indexOf(head) : -1;
    const inv = hi >= 0 ? fox.skeleton.boneInverses?.[hi] : null;
    if (!inv) return;

    const a = this._bindPos(fox, mouth);       // lip apex, field space
    const b = this._bindPos(fox, nose);        // rhinarium centre, field space
    if (!a || !b) return;

    // Run from just above the lip apex to just below the nose pad, so the
    // groove meets the pad's own dip instead of ending in mid-air.
    const p0 = a.clone().lerp(b, 0.10);
    const p1 = a.clone().lerp(b, 0.84);
    const span = p0.distanceTo(p1);
    if (!(span > 0.002)) return;

    const N = 12;
    const SECTION = [[1.0, 0.0], [0.46, 0.75], [0.0, -1.0], [-0.46, 0.75], [-1.0, 0.0]];
    const ROWS = SECTION.length;
    const pos = [], vv = [], idx = [];
    const tmp = new THREE.Vector3(), q = new THREE.Vector3(), o = new THREE.Vector3();
    const nrm = [0, 0, 0];

    // March up the midline, snapping each station onto the skin from in front.
    const pts = [];
    const aim = new THREE.Vector3().subVectors(b, a).normalize();
    for (let i = 0; i <= N; i++) {
      q.copy(p0).lerp(p1, i / N);
      // Probe from outside along the local surface normal, which on the
      // midline of a muzzle points forward and slightly down.
      f.normal(q.x, q.y, q.z, 4e-4, nrm);
      const nv = new THREE.Vector3().fromArray(nrm);
      if (nv.lengthSq() < 1e-10) nv.copy(aim);
      nv.normalize();
      o.copy(q).addScaledVector(nv, 0.020);
      const hit = f.raycast(o.x, o.y, o.z, -nv.x, -nv.y, -nv.z, 0.045);
      pts.push(hit > 0 ? o.clone().addScaledVector(nv, -hit) : q.clone());
    }

    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = pts[i];
      const pa = pts[Math.max(0, i - 1)], pb = pts[Math.min(N, i + 1)];
      const tan = new THREE.Vector3().subVectors(pb, pa);
      if (tan.lengthSq() < 1e-12) tan.copy(aim);
      tan.normalize();
      f.normal(p.x, p.y, p.z, 3e-4, nrm);
      const nv = new THREE.Vector3().fromArray(nrm);
      if (nv.lengthSq() < 1e-10) nv.set(0, 0, 1);
      nv.normalize();
      const bin = new THREE.Vector3().crossVectors(tan, nv).normalize();
      // Widest in the middle, closing to nothing at both ends so it merges
      // into the pad above and the lip below with no terminating edge.
      const fade = Math.sin(Math.PI * t) ** 0.6;
      const hh = PHILTRUM_HALF * (0.25 + 0.75 * fade);
      for (const [v, z] of SECTION) {
        const off = z < 0 ? z * PHILTRUM_GROOVE * fade
                          : 0.00015 + z * PHILTRUM_RIDGE * fade;
        tmp.copy(p).addScaledVector(bin, v * hh).addScaledVector(nv, off).applyMatrix4(inv);
        pos.push(tmp.x, tmp.y, tmp.z);
        vv.push(v);
      }
    }
    for (let i = 0; i < N; i++) {
      const a0 = i * ROWS, b0 = a0 + ROWS;
      for (let k = 0; k < ROWS - 1; k++) {
        idx.push(a0 + k, b0 + k, a0 + k + 1, a0 + k + 1, b0 + k, b0 + k + 1);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aLipV', new THREE.Float32BufferAttribute(vv, 1));
    g.setIndex(idx);
    g.computeVertexNormals();

    const mesh = new THREE.Mesh(g, this._lipMaterial(0.55));
    mesh.name = 'foxPhiltrum';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = 6;
    head.add(mesh);
    this.parts.push(mesh);
    this.philtrum = mesh;
  }

  /**
   * Lip / philtrum shading, keyed to `aLipV` (the cross-section coordinate,
   * +1 above the seam, 0 at it, -1 below).
   *
   * Two things this has to do that a flat dark ribbon could not:
   *  - pigment only the MARGINS, so the black is on the lip and not smeared
   *    across the muzzle. §4b's dark line is a lip, not an outline.
   *  - fade alpha to zero at v = +-1, so however the anatomy agent reshapes
   *    the muzzle underneath, this ribbon never terminates in a visible edge.
   *    That edge is what made the old strip stop "like a pen cap" mid-cheek.
   */
  _lipMaterial(darkScale = 1.0) {
    const m = new THREE.MeshPhysicalMaterial({
      name: 'foxLipLine',
      color: 0xffffff,
      roughness: 0.42,
      metalness: 0.0,
      // §4b: "subtle darker skin at the lip margin" — damp, not wet.
      clearcoat: 0.55,
      clearcoatRoughness: 0.28,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
    });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.u);
      sh.uniforms.uLipDark = { value: darkScale };
      sh.vertexShader = 'attribute float aLipV;\nvarying float vLipV;\n' + sh.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLipV = aLipV;');
      sh.fragmentShader = 'varying float vLipV;\nuniform float uLipDark;\n' +
        FD_UNIFORMS + HASH + SIMPLEX3 + UTIL +
        sh.fragmentShader
          .replace('#include <map_fragment>', /* glsl */ `
  float fdAv = abs(vLipV);
  // The seam is the darkest thing; the two margins carry most of the pigment;
  // it is ordinary muzzle skin by the time the ribbon dies out.
  float fdSeam = 1.0 - smoothstep(0.02, 0.14, fdAv);
  float fdMarg = 1.0 - smoothstep(0.30, 0.62, fdAv);
  vec3 fdSkin = vec3(0.50, 0.54, 0.60);
  vec3 fdCol = mix(fdSkin, uLipCol, clamp((fdMarg * 0.92 + fdSeam * 0.40) * uLipDark, 0.0, 1.0));
  diffuseColor.rgb = fdCol;
  diffuseColor.a = smoothstep(1.0, 0.62, fdAv);
`)
          .replace('#include <roughnessmap_fragment>', /* glsl */ `
  // A lip margin is damp where it meets its opposite number and dry at the
  // roll, which is the gradient that says "soft tissue" rather than "decal".
  float roughnessFactor = mix(0.46, 0.20, 1.0 - smoothstep(0.02, 0.30, abs(vLipV)));
`);
    };
    m.customProgramCacheKey = () => `foxLip${darkScale.toFixed(2)}`;
    return m;
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
    const PROUD = 0.00020;      // how far the shell floats off the inner skin

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
        // The rolled margin. 1.1 mm on a pinna whose half-width measures out
        // around 15-20 mm: enough to catch a rim light and to shadow the
        // concha floor beside it, and far too little to change the ear's
        // silhouette even seen edge-on.
        liftDir: face, rimLift: 0.0011,
      });
      if (!g) continue;                       // ear not measurable; draw nothing

      // Bind space -> ear01's local frame, then ride the bone.
      const bones = fox.skeleton?.bones;
      const bi = bones ? bones.indexOf(b1) : -1;
      const inv = bi >= 0 ? fox.skeleton.boneInverses?.[bi] : null;
      if (!inv) { g.dispose(); continue; }
      g.applyMatrix4(inv);
      g.computeVertexNormals();
      // FACE-AVERAGED NORMALS ARE WRONG HERE. The shell is fitted by raycast,
      // so its rows are not evenly spaced and some quads are near-degenerate;
      // the cross products those produce swing wildly and the concha rendered
      // a torn, saw-toothed light/dark boundary across its middle that looked
      // for all the world like a geometry or shadow bug. It is neither: the
      // POSITIONS are fine (verified by holding columns and by a 4 mm
      // continuity test, neither of which changed the image) and so is the
      // uv (verified: 27 clean rows, v in [-1,1]). It is the normals.
      //
      // The pinna is a thin plate, so its true normal is `face` almost
      // everywhere. Blend the triangle normals most of the way onto it: the
      // rolled rim keeps its shading gradient, the garbage averages out.
      {
        const fn = face.clone().transformDirection(inv).normalize();
        const na = g.attributes.normal;
        const t = new THREE.Vector3();
        for (let i = 0; i < na.count; i++) {
          t.set(na.getX(i), na.getY(i), na.getZ(i)).multiplyScalar(0.25)
            .addScaledVector(fn, 0.75);
          if (t.lengthSq() < 1e-10) t.copy(fn);
          t.normalize();
          na.setXYZ(i, t.x, t.y, t.z);
        }
        na.needsUpdate = true;
      }

      const cup = new THREE.Mesh(g, this._earMaterial());
      cup.name = `foxConcha${side}`;
      cup.castShadow = false;
      // NOT receiveShadow. The shell floats a fifth of a millimetre off the
      // pinna it is fitted to, and the pinna casts. At that separation the
      // shadow-map comparison is inside its own bias and the shell samples
      // itself: it rendered a torn, saw-toothed dark patch across the middle
      // of the concha, which three passes of geometry work did not touch
      // because it was never geometry. The pinna underneath still receives
      // shadow correctly and shows through this shell's alpha, so nothing is
      // lost — a soft overlay does not need its own shadow term.
      cup.receiveShadow = false;
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
      // An OPAQUE shell draws its own silhouette, and at a grazing angle that
      // edge reads as a hard plate laid over the ear — which is exactly what
      // the far ear was doing. As a soft overlay whose alpha falls to zero at
      // its boundary it cannot draw an edge at any angle, and it composites
      // over whatever the fur agent puts on the pinna instead of replacing it.
      side: THREE.FrontSide,
      transparent: true,
      depthWrite: false,
      envMapIntensity: 0.8,
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
  // vEarUv.x runs across the pinna (-1..1), vEarUv.y from base (-1) to tip.
  // The bowl is deepest at the BASE and opens toward the tip, so the shading
  // runs along the ear. Keying it to length(uv) instead treated the pinna as
  // a disc and put an elliptical dark blob in the middle of a long triangle,
  // which is the "dark wedge" the far ear was showing.
  float fdAx = abs(vEarUv.x);
  float fdDeep = 1.0 - smoothstep(-0.55, 0.55, vEarUv.y);

  // The rolled margin, matching the geometry lift in buildConchaFitted
  // exactly — same centre, same width, same die-off — so the highlight sits
  // on the roll rather than beside it.
  float fdRim = exp(-pow((fdAx - 0.78) / 0.17, 2.0)) *
                (1.0 - smoothstep(0.90, 1.0, fdAx));
  // ...and the shadow the roll throws onto the concha floor just inside it.
  // This is the "distinct shadow" a bowl is supposed to catch; a smooth ramp
  // from tip to base, which is all this had, reads as a gradient, not a cup.
  float fdWell = exp(-pow((fdAx - 0.52) / 0.19, 2.0));

  // Fine hair running up out of the concha. The pinna interior is furred, not
  // bare skin, so the hair is what should dominate the read.
  float fdHair = snoise(vec3(vEarUv.x * 40.0, vEarUv.y * 9.0, 2.0)) * 0.5 + 0.5;
  float fdHair2 = snoise(vec3(vEarUv.x * 96.0, vEarUv.y * 21.0, 7.0)) * 0.5 + 0.5;

  vec3 fdCol = mix(uEarRim, uEarSkin, fdDeep * 0.55);
  fdCol *= mix(0.88, 1.08, fdHair * 0.65 + fdHair2 * 0.35);
  // Depth without saturation: rubric C is explicit that white fur in shade
  // goes BLUE, not merely darker, so the bowl reads as a furred cup while the
  // only warm value on the animal stays confined to transmitted light.
  fdCol = mix(fdCol, fdCol * vec3(0.70, 0.79, 0.96), max(fdDeep, fdWell * 0.8) * 0.85);
  fdCol *= mix(1.0, 0.62, fdDeep);
  fdCol *= mix(1.0, 0.58, fdWell * (0.35 + 0.65 * fdDeep));
  fdCol *= 1.0 + 0.16 * fdRim;
  diffuseColor.rgb = fdCol;
  // Fade to nothing AT the measured outline and at the tip so the shell never
  // draws a boundary of its own. This used to start fading at |x| = 0.55,
  // which is inboard of the margin — the pinna's whole outer third was being
  // composited away, so there was nothing there to be a rim.
  float fdEdge = 1.0 - smoothstep(0.55, 0.96, fdAx);
  diffuseColor.a = fdEdge * (0.34 + 0.52 * fdDeep + 0.40 * fdRim) *
    smoothstep(1.0, 0.72, vEarUv.y) * smoothstep(-1.0, -0.78, vEarUv.y);
`)
          .replace('#include <lights_fragment_end>', /* glsl */ `
#include <lights_fragment_end>
  // Wrapped transmission: light arriving from BEHIND the thin pinna leaks
  // through its edge. Strongest where the sheet is thinnest (the rim) and
  // where we are looking toward the sun.
  float fdBack = fdSat(dot(-vEarWN, normalize(uSunL)));
  float fdThin = smoothstep(0.30, 1.0, abs(vEarUv.x));
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
