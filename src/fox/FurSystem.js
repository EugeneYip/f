/**
 * FurSystem — the coat. OWNER: fur agent.
 *
 * Three cooperating layers, in draw order:
 *
 *   1. BASE   the anatomy agent's skin mesh, re-materialled as the dark cream
 *             floor of the coat. Opaque, depth-writing, shadow-casting.
 *   2. SHELLS `furShells` nested offset shells, drawn as ONE instanced draw
 *             call on a SkinnedMesh — `aShell` is the instance index and the
 *             offset happens in the vertex shader, so the coat costs one draw
 *             and deforms with the skeleton for free. Instance order is
 *             guaranteed inner-to-outer, which gives correct back-to-front
 *             alpha compositing through the coat with no sorting.
 *   3. CARDS  billboarded hair tufts that break the mesh outline into strands.
 *
 * Publishes `ctx.fur`. Everything is live-tweakable through `ctx.fur.set()`.
 */
import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../util/math.js';
import {
  buildFurUniforms, makeBaseMaterial, makeShellMaterial, makeCardMaterial,
  syncFurUniforms, FUR_DEFAULTS,
} from './FurMaterial.js';
import { buildFurCards } from './FurCards.js';
import { CARD_SHAPE } from '../shaders/fur.glsl.js';

/** Instance buffer is allocated for the largest tier so a tier change is free. */
const MAX_SHELLS = 26;

/**
 * Card budget lives in Quality.js as `furCards`, not here — one place for the
 * number. `furFins` remains the on/off gate; when it is on, the count comes
 * from the tier. The fallback only covers a tier that forgets to declare one.
 */
const CARD_COUNT_FALLBACK = 13000;

/**
 * How far past the eyeball's own surface the coat is cleared, and the bounds
 * that clearance is allowed to take.
 *
 * A canid is bald to the LID MARGIN, and the lid margin is a property of the
 * globe — it sits a millimetre or two outside it, whatever the animal's coat
 * is doing 30 mm away. The clearance used to be `base + perMetre * localCoat`,
 * which is self-defeating: the bare disc grows as fast as the distance from
 * the eye does, so on any region deep enough to need the coat parted, the
 * parting eats the region. That expression was measured clean at a 4 mm head
 * coat and shaved the entire face at 40 mm, with the two discs meeting across
 * a 58.3 mm interpupillary gap. Capping it was a workaround, twice.
 *
 * 1.30 x the globe radius puts the fully-coated boundary just outside the
 * lids; the bounds only guard against an eye measurement that has gone wrong.
 */
const EYE_CLEAR = 1.30;
const EYE_CLEAR_MIN = 0.009;
const EYE_CLEAR_MAX = 0.018;

/**
 * Radius of the measured eyeball, metres.
 *
 * Deliberately the SAME expression Eyes.js sizes the globe from — surface
 * distance from the socket centre plus the corneal proudness, clamped to the
 * same band — so the coat's parting and the eyeball it is parting for can
 * never disagree about how big the eye is. 11.6 mm is the rig's nominal ball
 * and is used only if the anatomy agent has published no metadata.
 */
function eyeGlobeRadius(eyes) {
  let sum = 0, n = 0;
  for (const side of ['L', 'R']) {
    const e = eyes?.[side];
    if (!e?.centre || !e?.surface) continue;
    const c = e.centre, s = e.surface;
    sum += Math.hypot(s[0] - c[0], s[1] - c[1], s[2] - c[2]) + (e.cornealProud ?? 0.003);
    n++;
  }
  return n ? clamp(sum / n, 0.006, 0.020) : 0.0116;
}

export class FurSystem {
  name = 'fur';
  order = 200;

  constructor() {
    this.enabled = true;
    this.autoStochastic = true;
    this.stochasticAmount = 0.55;
    this.lod = { near: 1.5, far: 3.2, cull: 7.0, minShells: 4 };
    this.stats = {};
    this._tmp = new THREE.Vector3();
  }

  async init(ctx) {
    const fox = ctx.fox;
    if (!fox?.skinnedMesh || !fox.geometry) {
      throw new Error('FurSystem: ctx.fox.skinnedMesh is missing — anatomy did not initialise');
    }
    const t0 = performance.now();
    this.ctx = ctx;
    this.fox = fox;

    const src = fox.geometry;
    const nv = src.getAttribute('position').count;

    // --------------------------------------------------- coat occlusion --
    // A cavity term baked from the mesh itself: smooth the surface, then ask
    // which way it moved along the normal. Concave (armpit, throat, between
    // the haunches, behind the ear) moves outward and goes dark; convex
    // (spine, brow, hock) moves inward and stays bright. This is what makes
    // the coat read as a thick layer sitting in the animal's form rather than
    // a uniform fuzz sprayed over it.
    this.occlusion = await bakeCoatOcclusion(
      src.getAttribute('position').array,
      src.getAttribute('normal').array,
      fox.adjacency, nv,
    );
    if (!src.getAttribute('aFurAO')) {
      src.setAttribute('aFurAO', new THREE.BufferAttribute(this.occlusion, 1));
    }

    // ------------------------------------------------------- uniforms ----
    this.uniforms = buildFurUniforms(ctx);
    this.uniforms.uAniso.value = ctx.quality.get('furAniso') ? 1 : 0;

    // The coat has to part around the eye. furLength knows nothing about the
    // socket, and 24 mm of cheek ruff 15 mm from the cornea buries the face.
    // Both eyeball centres were measured off the SDF during socket carving, in
    // the same bind space as `position`, so they drop straight into the shader.
    //
    // The clearance RADIUS comes from the same measurement — see
    // eyeClearRadius. It used to be a function of the local coat depth, which
    // is the one thing it must never be.
    const eyes = fox.eyes;
    if (eyes?.L?.centre && eyes?.R?.centre) {
      this.uniforms.uEyeL.value.fromArray(eyes.L.centre);
      this.uniforms.uEyeR.value.fromArray(eyes.R.centre);
      this.eyeGlobeR = eyeGlobeRadius(eyes);
      this.uniforms.uEyeFade.value.x =
        clamp(this.eyeGlobeR * EYE_CLEAR, EYE_CLEAR_MIN, EYE_CLEAR_MAX);
    }
    // Same for the rhinarium — measured off the SDF by the anatomy agent.
    const noseAnchor = fox.anchors?.nose;
    if (noseAnchor) {
      noseAnchor.updateWorldMatrix(true, false);
      this.uniforms.uNose.value.setFromMatrixPosition(noseAnchor.matrixWorld);
    }

    // ------------------------------------------------------------ base ---
    this.baseMaterial = makeBaseMaterial(this.uniforms);
    this.prevMaterial = fox.skinnedMesh.material;
    fox.skinnedMesh.material = this.baseMaterial;
    fox.skinnedMesh.castShadow = true;
    fox.skinnedMesh.receiveShadow = true;

    // ---------------------------------------------------------- shells ---
    this.shellMaterial = makeShellMaterial(this.uniforms);
    this.shellGeometry = buildShellGeometry(src);
    this.shellMesh = new THREE.SkinnedMesh(this.shellGeometry, this.shellMaterial);
    this.shellMesh.name = 'furShells';
    this.shellMesh.castShadow = false;
    this.shellMesh.receiveShadow = false;
    this.shellMesh.renderOrder = 4;
    fox.root.add(this.shellMesh);
    this.shellMesh.bind(fox.skeleton, fox.skinnedMesh.bindMatrix);

    // Decorrelate the stochastic dither ACROSS TAA SAMPLES.
    //
    // A dither that is identical on every accumulated sample carries no new
    // coverage information, so the resolve has nothing to integrate and
    // converges onto the underlying mesh edge — which is exactly the crisp
    // hard triangle the head silhouette was showing. This has to happen per
    // DRAW, not per update(): during accumulation the harness calls render()
    // repeatedly without stepping, so ctx.frame is constant and only the TAA
    // sample index advances.
    this.shellMesh.onBeforeRender = () => {
      const i = ctx.postfx?.taaSampleIndex;
      this.uniforms.uFrameSeed.value = (i != null ? i : ctx.frame) % 64;
    };

    // ----------------------------------------------------------- cards ---
    this.cardMaterial = makeCardMaterial(this.uniforms);
    this._buildCards(ctx);

    this.applyQuality(ctx);

    ctx.fur = this;
    this.initMs = performance.now() - t0;
    this.stats = {
      shells: this.shellCount,
      maxShells: MAX_SHELLS,
      shellTris: (src.getIndex().count / 3) * this.shellCount,
      cards: this.cardStats?.cards ?? 0,
      cardTris: this.cardStats?.triangles ?? 0,
      initMs: +this.initMs.toFixed(1),
    };
    console.info(
      `[fur] ${this.shellCount} shells (instanced, 1 draw) · ` +
      `${this.stats.cards} cards / ${this.stats.cardTris} tris · ` +
      `aniso ${this.uniforms.uAniso.value ? 'on' : 'off'} · ` +
      `eye globe ${((this.eyeGlobeR ?? 0) * 1000).toFixed(1)} mm → coat clears ` +
      `${(this.uniforms.uEyeFade.value.x * 1000).toFixed(1)} mm · ` +
      `init ${this.initMs.toFixed(0)} ms`,
    );
  }

  _buildCards(ctx) {
    if (this.cardMesh) {
      this.cardMesh.parent?.remove(this.cardMesh);
      this.cardMesh.geometry.dispose();
      this.cardMesh = null;
      this.cardStats = null;
    }
    const wanted = ctx.quality.get('furFins')
      ? (ctx.quality.get('furCards') ?? CARD_COUNT_FALLBACK)
      : 0;
    if (wanted <= 0) { this._refreshStats(); return; }

    const built = buildFurCards(this.fox.geometry, this.occlusion, wanted, 0xfa17c0de);
    if (!built) { this._refreshStats(); return; }

    this.cardStats = built;
    this.cardMesh = new THREE.SkinnedMesh(built.geometry, this.cardMaterial);
    this.cardMesh.name = 'furCards';
    this.cardMesh.castShadow = false;
    this.cardMesh.receiveShadow = false;
    this.cardMesh.renderOrder = 6;
    this.fox.root.add(this.cardMesh);
    this.cardMesh.bind(this.fox.skeleton, this.fox.skinnedMesh.bindMatrix);
    this._cardIndexCount = built.triangles * 3;
    this._refreshStats();
  }

  /** Keep the published stats honest after a tier change, not just at init. */
  _refreshStats() {
    const tris = this.fox?.geometry?.getIndex()?.count ?? 0;
    this.stats.shells = this.shellCount;
    this.stats.shellTris = (tris / 3) * (this.shellCount ?? 0);
    this.stats.cards = this.cardStats?.cards ?? 0;
    this.stats.cardTris = this.cardStats?.triangles ?? 0;
  }

  applyQuality(ctx) {
    this.shellCount = clamp(ctx.quality.get('furShells') ?? 18, 1, MAX_SHELLS);
    const rich = !!ctx.quality.get('furAniso');
    this.uniforms.uAniso.value = rich ? 1 : 0;
    // Tiers that have given up anisotropic specular also give up the micro
    // strand octave — it only resolves at macro range and costs a full
    // cellular lookup per fragment per shell.
    this.uniforms.uMicroOn.value = rich ? 1 : 0;
    this.uniforms.uShellCount.value = this.shellCount;
    this.shellGeometry.instanceCount = this.shellCount;

    // Fewer shells means each one covers more depth, so widen the strands and
    // deepen the undercoat fill — otherwise `low` reads as a stack of nets.
    const thin = clamp(18 / this.shellCount, 0.6, 3.2);
    this.uniforms.uStrandRoot.value = FUR_DEFAULTS.strandRoot * lerp(1, 1.10, clamp(thin - 1, 0, 1));
    this.uniforms.uFill.value = clamp(FUR_DEFAULTS.fill, 0, 1);
    this._refreshStats();
  }

  onQuality(e, ctx) {
    if (e.type === 'tier') {
      this.applyQuality(ctx);
      this._buildCards(ctx);
    } else if (e.key === 'furShells' || e.key === 'furAniso'
               || e.key === 'furFins' || e.key === 'furCards') {
      this.applyQuality(ctx);
      if (e.key === 'furFins' || e.key === 'furCards') this._buildCards(ctx);
    }
  }

  update(dt, ctx) {
    if (!this.uniforms) return;
    syncFurUniforms(this.uniforms, ctx);

    // ------------------------------------------------------------- LOD ---
    // Shells are pure fill rate, so spend them on the frames that show them.
    const subject = ctx.subjectPosition ?? this._tmp.set(0, 0.25, 0);
    const d = ctx.camera.position.distanceTo(subject);
    const l = this.lod;
    let n = this.shellCount;
    if (d > l.near) {
      const k = smoothstep(l.near, l.far, d);
      n = lerp(this.shellCount, Math.max(l.minShells, this.shellCount * 0.5), k);
      if (d > l.far) {
        const k2 = smoothstep(l.far, l.cull, d);
        n = lerp(n, l.minShells, k2);
      }
    }
    // Distance is only half the story: what actually costs is OVERDRAW, and
    // that scales with how much of the screen the animal covers. At the
    // portrait framing the fox fills the frame and every shell is a near
    // full-screen blended pass, which is where the budget goes. Trade shells
    // against coverage — at that range the coat on the head is only 5-10 mm,
    // so 9 shells are still well under a millimetre apart and read the same as 18.
    const fov = (ctx.camera.fov ?? 40) * Math.PI / 180;
    const subjectSpan = 0.38;   // fox height including coat, metres
    const coverage = subjectSpan / Math.max(2 * d * Math.tan(fov * 0.5), 1e-4);
    n *= lerp(1, 0.50, smoothstep(0.50, 1.25, coverage));

    n = clamp(Math.round(n), l.minShells, this.shellCount);
    if (n !== this.shellGeometry.instanceCount) {
      this.shellGeometry.instanceCount = n;
      this.uniforms.uShellCount.value = n;
      this.uniforms.uStrandRoot.value =
        FUR_DEFAULTS.strandRoot * lerp(1, 1.25, clamp(18 / n - 1, 0, 1));
    }

    // Cards are the silhouette, so they survive much further out than shells
    // do — but their screen size collapses, so thin the count instead.
    //
    // They also get thinned when the animal fills the frame, for the same
    // reason the shells do: a card that covers more pixels costs more, and the
    // fringe density that actually reads is per unit of OUTLINE, which does not
    // grow as you walk closer. Without this the cards, not the shells, become
    // the dominant cost at portrait range.
    if (this.cardMesh) {
      const near = lerp(1, 0.55, smoothstep(0.55, 1.25, coverage));
      const keep = (d < l.far ? 1 : lerp(1, 0.42, smoothstep(l.far, l.cull * 1.6, d))) * near;
      const count = Math.max(6, Math.floor((this._cardIndexCount * keep) / 6) * 6);
      this.cardMesh.geometry.setDrawRange(0, Math.min(count, this._cardIndexCount));
    }

    // --------------------------------------------------- stochastic alpha -
    // Dithered cut-out is only correct when something is actually resolving
    // it; unresolved, it is just speckle. Inferring that from "a postfx system
    // exists and declares renderFrame" is wrong in at least three ways — the
    // chain can be bypassed, renderFrame can have thrown and been dropped by
    // App while the system object lives on, or the chain can be perfectly
    // healthy with the `taa` gate simply off for the tier (which is what
    // speckled the coat at `low`). `ctx.postfx.taaActive` is the authoritative
    // answer to the question actually being asked, so key off that and nothing
    // else. It degrades safely: no postfx, no TAA, no dither.
    if (this.autoStochastic) {
      this.uniforms.uStochastic.value =
        ctx.postfx?.taaActive === true ? this.stochasticAmount : 0;
    } else {
      this.uniforms.uStochastic.value = 0;
    }
  }

  /**
   * Regression guard for card reach — call it, do not eyeball it.
   *
   * We have overshot the silhouette fringe in both directions three times now:
   * buried at 0.98x the coat (smooth outline, an automatic fail on a hard mesh
   * edge), then 1.70x (dorsal crest of separate spikes), and a dandelion before
   * that. Each time the error was invisible in a still until someone looked at
   * the right pose, and each time it was a parameter arithmetic mistake that a
   * number would have caught immediately.
   *
   * Perpendicular reach past the skin, as a multiple of LOCAL coat thickness,
   * is uCardLength * lenMul * rise, plus gravity on the downward-facing side.
   * It is region independent because the per-region length scale multiplies
   * the coat and the card equally — so one band covers the whole animal.
   *
   * Returns { ok, band, min, mean, max, worstDroop, detail[] }. `ok` false
   * means the coat will read as either spikes or a smooth edge.
   */
  reachReport() {
    const u = this.uniforms;
    if (!u) return { ok: false, reason: 'fur not initialised' };
    const { lenMulMin: lo, lenMulSpread: sp, rise, droopBoost, reachBand } = CARD_SHAPE;
    const cardLen = u.uCardLength.value;
    const droop = u.uDroop.value;

    // lenMul = lo + sp*r^2 with r uniform, so E[r^2] = 1/3.
    const reach = (lm) => cardLen * lm * rise;
    const min = reach(lo), mean = reach(lo + sp / 3), max = reach(lo + sp);

    // Gravity acts in world space and adds to reach wherever the surface faces
    // down — the belly and chest, which is where the "Afghan skirt" came from.
    const detail = [];
    let worstDroop = 0;
    for (const [name, stiffness] of [['belly', 0.24], ['chest', 0.46],
                                     ['flank', 0.62], ['back', 0.86]]) {
      const soft = 1 - stiffness;
      const extra = droop * (cardLen * (lo + sp / 3)) * (0.30 + soft) * droopBoost;
      const total = mean + extra;
      if (total > worstDroop) worstDroop = total;
      detail.push({ region: name, meanReach: +mean.toFixed(3),
                    droopExtra: +extra.toFixed(3), total: +total.toFixed(3) });
    }

    const ok = min >= reachBand[0] * 0.92 && max <= reachBand[1] * 1.02
             && worstDroop <= reachBand[1] * 1.05;
    return {
      ok, band: reachBand,
      min: +min.toFixed(3), mean: +mean.toFixed(3), max: +max.toFixed(3),
      worstDroop: +worstDroop.toFixed(3), detail,
    };
  }

  /** Live tuning: `ctx.fur.set('lay', 0.9)`. Accepts any uniform's short name. */
  set(key, value) {
    const u = this.uniforms;
    const name = 'u' + key.charAt(0).toUpperCase() + key.slice(1);
    const target = u[name] ?? u[key];
    if (!target) return false;
    if (target.value?.isColor) target.value.set(value);
    else if (typeof target.value?.fromArray === 'function') target.value.fromArray(value);
    else target.value = value;
    return true;
  }

  get(key) {
    const name = 'u' + key.charAt(0).toUpperCase() + key.slice(1);
    return (this.uniforms[name] ?? this.uniforms[key])?.value;
  }

  dispose() {
    if (this.prevMaterial && this.fox?.skinnedMesh) {
      this.fox.skinnedMesh.material = this.prevMaterial;
    }
    this.shellMesh?.parent?.remove(this.shellMesh);
    this.cardMesh?.parent?.remove(this.cardMesh);
    this.shellGeometry?.dispose();
    this.cardMesh?.geometry?.dispose();
    this.baseMaterial?.dispose();
    this.shellMaterial?.dispose();
    this.cardMaterial?.dispose();
  }
}

/* ------------------------------------------------------------------------ */

/**
 * An InstancedBufferGeometry that SHARES the body's attribute buffers — no
 * copy, no extra VRAM — plus one instanced float carrying the shell index.
 * three dispatches the instanced draw off `geometry.isInstancedBufferGeometry`,
 * not off the object type, so a SkinnedMesh works here unmodified.
 */
function buildShellGeometry(src) {
  const g = new THREE.InstancedBufferGeometry();
  for (const key of ['position', 'normal', 'furTangent', 'furFlow', 'furLength',
    'furStiffness', 'region', 'skinIndex', 'skinWeight', 'aFurAO']) {
    const a = src.getAttribute(key);
    if (a) g.setAttribute(key, a);
  }
  g.setIndex(src.getIndex());

  const shell = new Float32Array(MAX_SHELLS);
  for (let i = 0; i < MAX_SHELLS; i++) shell[i] = i;
  g.setAttribute('aShell', new THREE.InstancedBufferAttribute(shell, 1));
  g.instanceCount = 18;

  g.boundingSphere = src.boundingSphere
    ? src.boundingSphere.clone()
    : new THREE.Sphere(new THREE.Vector3(0, 0.2, 0), 1);
  g.boundingSphere.radius *= 1.2;
  g.boundingBox = src.boundingBox ? src.boundingBox.clone() : null;
  return g;
}

/**
 * Multi-scale cavity occlusion from mesh adjacency.
 *
 * Laplacian-smooth the surface at three scales; at each one, measure how far
 * the smoothed position moved ALONG the vertex normal. Outward means the
 * neighbourhood sits above this point — a crevice, so occluded. Inward means a
 * ridge, which stays open. Laplacian smoothing shrinks a convex body overall,
 * but that bias is negative everywhere and clamps away harmlessly.
 *
 * Returns occlusion in [0,1]: 0 = open sky, 1 = buried. Zero is the safe
 * default, so an unbound attribute degrades to "no occlusion" rather than to
 * a black fox.
 */
async function bakeCoatOcclusion(positions, normals, adjacency, nv) {
  const occ = new Float32Array(nv);
  if (!adjacency?.start || !adjacency?.nb) return occ;
  const { start, nb } = adjacency;

  let a = Float32Array.from(positions);
  let b = new Float32Array(nv * 3);
  // NOTE: the finest scale is deliberately gone. Surface Nets leaves a little
  // vertex-scale bumpiness, and a 5 mm probe reads that as cavities — which
  // showed up on the flank and shoulder as ~20 mm grey patches that looked
  // exactly like a dirty, moulting coat. Only anatomical cavities (armpit,
  // throat, between the haunches) should darken the fur.
  const stages = [
    { iters: 22, weight: 0.42, scale: 0.0180 },
    { iters: 52, weight: 0.58, scale: 0.0380 },
  ];

  let done = 0;
  for (const st of stages) {
    for (; done < st.iters; done++) {
      for (let v = 0; v < nv; v++) {
        const s = start[v], e = start[v + 1], o = v * 3;
        const n = e - s;
        if (n === 0) { b[o] = a[o]; b[o + 1] = a[o + 1]; b[o + 2] = a[o + 2]; continue; }
        let x = 0, y = 0, z = 0;
        for (let k = s; k < e; k++) {
          const j = nb[k] * 3;
          x += a[j]; y += a[j + 1]; z += a[j + 2];
        }
        const inv = 0.62 / n;
        b[o] = a[o] * 0.38 + x * inv;
        b[o + 1] = a[o + 1] * 0.38 + y * inv;
        b[o + 2] = a[o + 2] * 0.38 + z * inv;
      }
      const t = a; a = b; b = t;
    }
    for (let v = 0; v < nv; v++) {
      const o = v * 3;
      const d = (a[o] - positions[o]) * normals[o]
              + (a[o + 1] - positions[o + 1]) * normals[o + 1]
              + (a[o + 2] - positions[o + 2]) * normals[o + 2];
      const k = d / st.scale;
      occ[v] += st.weight * (k < 0 ? 0 : k > 1 ? 1 : k);
    }
    // Never block a frame: the bible's perf contract applies to load too.
    await new Promise((r) => setTimeout(r, 0));
  }

  // Blur the result over the surface. Whatever vertex-scale structure survived
  // the coarse probes gets averaged away here, leaving a field that only varies
  // over anatomical distances — which is the only thing a 45 mm coat could
  // plausibly respond to anyway.
  let s0 = occ, s1 = new Float32Array(nv);
  for (let it = 0; it < 10; it++) {
    for (let v = 0; v < nv; v++) {
      const s = start[v], e = start[v + 1];
      if (e === s) { s1[v] = s0[v]; continue; }
      let acc = 0;
      for (let k = s; k < e; k++) acc += s0[nb[k]];
      s1[v] = s0[v] * 0.3 + (acc / (e - s)) * 0.7;
    }
    const t = s0; s0 = s1; s1 = t;
  }
  // Cap it: fur never goes black, it goes deep blue.
  const out = occ;
  for (let v = 0; v < nv; v++) out[v] = Math.min(0.82, s0[v]);
  return out;
}
