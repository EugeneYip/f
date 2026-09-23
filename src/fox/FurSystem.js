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
 * Where the coat's parting stops.
 *
 * THE CLEARANCE FOLLOWS THE APERTURE, NOT THE GLOBE. This is the third time
 * this quantity has been keyed to the wrong thing, and each time the symptom
 * was different:
 *
 *   base + perMetre * localCoat   the parting grew as fast as the coat it was
 *                                 parting, and shaved the whole face at 40 mm
 *   1.30 x the globe radius       sized off the BALL, ignoring the corneal
 *                                 dome and the seat; measured 7.8 mm of
 *                                 coverage clearance against 8.6 mm of
 *                                 nearest skin, so it cleared NOTHING and the
 *                                 coat ate 38-42% of the eye
 *   the LID MARGIN                mine, and also wrong: the globe is 22.5 mm
 *                                 across and the palpebral fissure only
 *                                 13.8 mm, so a globe-sized parting must shave
 *                                 past the lids. Anatomy measured the result
 *                                 at macro_eye -- flat-block fraction nasal
 *                                 0 -> 51%, temporal 0 -> 92% -- i.e. bare
 *                                 skin outside the aperture, a fresh 4f rule 3
 *                                 failure.
 *
 * What has to be BARE is the palpebral fissure, because that is the only part
 * of the eyeball the animal shows. Everywhere else the LIDS cover the globe,
 * and a lid needs no help from the coat. So the bare zone is the limbus plus
 * a margin, projected from the eyeball centre onto the skin, and the
 * anisotropy is the fissure's own aspect rather than a number picked to make
 * an aperture measurement move.
 *
 * Outside it the coat is present but SHORT, over a long ramp: coverage comes
 * back almost immediately (no bare skin, 4f rule 3) while full depth takes
 * three times the bare radius to return, so nothing near the eye is tall
 * enough to arch back over it. The long length ramp is what lets the bare
 * zone shrink to the fissure without the aperture closing again -- measured,
 * shortening it from 32 mm to 27 mm alone costs 4.4% of the aperture at
 * `portrait`.
 */
const FISSURE_MARGIN = 1.10;   // bare out to this x the corneal limbus
const FISSURE_ASPECT = 1.75;   // the slot is this much wider than it is tall
const COVER_SPAN = 1.12;       // coverage back by here: short fur, not skin
const LEN_SPAN = 3.07;         // full coat depth back by here
const EYE_CLEAR_MIN = 0.008;
const EYE_CLEAR_MAX = 0.016;

/**
 * Bare radius and slot anisotropy for the parting, from the eye Eyes.js built.
 *
 * `furSkinMask2` measures an anisotropic distance from the bind-space socket
 * centre, so a skin point sits at hypot(lateral, axial) from it and the axial
 * leg -- the socket depth -- is a floor under every distance. That is exactly
 * why the old 7.8 mm coverage radius cleared nothing: it was under the floor.
 * Solving for the radius that puts the boundary on the fissure's own edge:
 *
 *     aHalf = limbusR * FISSURE_MARGIN          half the fissure, plus margin
 *     k     = sqrt(FISSURE_ASPECT)              slot scales, 1/k along, k across
 *     bare  = hypot(aHalf / k, axialSkinDepth)
 *
 * With the current rig that is hypot(7.88/1.323, 8.56) = 10.43 mm, a bare zone
 * 15.8 x 9.0 mm on the skin against a 13.8 mm fissure.
 */
function eyeAperture(ctx, foxEyes) {
  const k = Math.sqrt(FISSURE_ASPECT);
  const out = { slotAlong: 1 / k, slotAcross: k, measured: false };

  // Axial depth of the skin below the socket centre, from anatomy's own
  // measurement -- the same pair of points eyeGlobeRadius reads.
  let axial = 0.00856, n = 0, sum = 0;
  for (const side of ['L', 'R']) {
    const e = foxEyes?.[side];
    if (!e?.centre || !e?.surface) continue;
    const c = e.centre, sf = e.surface;
    sum += Math.hypot(sf[0] - c[0], sf[1] - c[1], sf[2] - c[2]); n++;
  }
  if (n) axial = sum / n;

  // Half-width of the aperture, from the cornea Eyes.js actually drew.
  const built = (ctx.eyes?.eyes ?? []).filter((e) => e?.limbusR > 0);
  let limbus;
  if (built.length) {
    limbus = built.reduce((a, e) => a + e.limbusR, 0) / built.length;
    out.measured = true;
  } else {
    // No built eye yet. Half the globe is the cornea's rough share of it;
    // this UNDERSTATES the aperture, which fails toward too little parting
    // rather than a shaved brow, and the console line says so.
    limbus = 0.5 * eyeGlobeRadius(foxEyes);
  }
  out.limbus = limbus;
  out.axial = axial;
  out.bare = clamp(Math.hypot(limbus * FISSURE_MARGIN / k, axial),
                   EYE_CLEAR_MIN, EYE_CLEAR_MAX);
  return out;
}

/**
 * Radius of the measured eyeball, metres.
 *
 * Deliberately the SAME expression Eyes.js sizes the globe from — surface
 * distance from the socket centre plus the corneal proudness, clamped to the
 * same band — so the coat's parting and the eyeball it is parting for can
 * never disagree about how big the eye is. 11.6 mm is the rig's nominal ball
 * and is used only if the anatomy agent has published no metadata.
 */
/**
 * Bind-space centroid of every vertex carrying `region`, or null if there are
 * none. Bind space by construction — it is read straight off `position` — so
 * it drops into furSkinMask2 without a frame conversion to get wrong.
 */
function regionCentroid(geometry, region) {
  const pos = geometry.getAttribute('position');
  const reg = geometry.getAttribute('region');
  if (!pos || !reg) return null;
  let x = 0, y = 0, z = 0, n = 0;
  for (let i = 0; i < pos.count; i++) {
    if (Math.round(reg.getX(i)) !== region) continue;
    x += pos.getX(i); y += pos.getY(i); z += pos.getZ(i); n++;
  }
  return n ? [x / n, y / n, z / n] : null;
}

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
      // The fissure axis. Both `look` vectors are bind space -- they are the
      // rays the socket was carved along -- so they need no conversion, which
      // is the same reason uEyeL/uEyeR drop straight in. (uNose, below, is the
      // cautionary tale about getting this wrong.)
      if (eyes.L.look) this.uniforms.uEyeAxisL.value.fromArray(eyes.L.look).normalize();
      if (eyes.R.look) this.uniforms.uEyeAxisR.value.fromArray(eyes.R.look).normalize();
      const ap = eyeAperture(ctx, eyes);
      this.eyeApertureFit = ap;
      this.uniforms.uEyeSlot.value.set(ap.slotAlong, ap.slotAcross);
      this.uniforms.uEyeFade.value.set(ap.bare, ap.bare * COVER_SPAN, ap.bare * LEN_SPAN);
    }
    // Same for the rhinarium — but it has to be in the SAME SPACE.
    //
    // furSkinMask2 is evaluated at `position`, i.e. BIND space, and uEyeL/uEyeR
    // are bind space because the socket carving measured them there. uNose was
    // being written from the nose anchor's WORLD matrix, which is a different
    // space: measured, 22.8 mm apart on the live rig, almost all of it in Y. So
    // the 4-7 mm bare pad the uNoseFade comment describes was being carved in
    // the wrong place, and had been for as long as it has existed.
    //
    // The centroid of the `nose` region's own vertices is bind space by
    // construction and needs no frame conversion, so it cannot drift out of
    // sync again. The anchor stays as a fallback, flagged as approximate.
    const nose = regionCentroid(src, 0);
    if (nose) {
      this.uniforms.uNose.value.fromArray(nose);
    } else {
      const noseAnchor = fox.anchors?.nose;
      if (noseAnchor) {
        noseAnchor.updateWorldMatrix(true, false);
        this.uniforms.uNose.value.setFromMatrixPosition(noseAnchor.matrixWorld);
      }
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
      `${this.cardStats?.locks ?? 0} locks (${this.cardStats?.cardsPerLock ?? 0} cards each) · ` +
      `aniso ${this.uniforms.uAniso.value ? 'on' : 'off'} · ` +
      `eye limbus ${(((this.eyeApertureFit?.limbus) ?? 0) * 1000).toFixed(1)} mm` +
      `${this.eyeApertureFit?.measured ? '' : ' (APPROX: no built eye)'} → coat bare ` +
      `${(this.uniforms.uEyeFade.value.x * 1000).toFixed(1)} mm, covered by ` +
      `${(this.uniforms.uEyeFade.value.y * 1000).toFixed(1)} mm, full depth by ` +
      `${(this.uniforms.uEyeFade.value.z * 1000).toFixed(1)} mm ` +
      `(slot ${(1 / this.uniforms.uEyeSlot.value.x).toFixed(2)}x wide, ` +
      `${(1 / this.uniforms.uEyeSlot.value.y).toFixed(2)}x tall) · ` +
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
   * is uRegionC.x * uCardLength * lenMul * rise, plus gravity on the
   * downward-facing side.
   *
   * IT IS NOT REGION INDEPENDENT, and this guard used to assert that it was.
   * The old text read "the per-region length scale multiplies the coat and the
   * card equally". That is true of uRegionA.y, which scales the coat; it is
   * false of uRegionC.x (CARD_LEN_SCALE), which scales only the card. So the
   * guard reported `ok: true, mean 1.117` while the muzzle, both ears and both
   * paws sat at 2.011 — nearly double the band ceiling — and the render was an
   * unmistakable sea urchin around the head. A guard blind to the one table
   * that is actually authored per region is worse than no guard: it was cited
   * as evidence the cards were fine.
   *
   * It now walks all 27 regions and also reports reach against the SHELL
   * surface (uRegionC.z feathers the shells out early on the head and legs),
   * which is what the eye actually judges: a card tip is a spike when it
   * stands over open sky, and what puts sky behind it is the distance to the
   * outermost opaque shell, not to the skin.
   *
   * THE RATIO IS NOT THE WHOLE INVARIANT — see uCardFloor in the card vertex
   * shader. A reach expressed as a multiple of the local coat delivers 0.4 mm
   * of fringe on a 4 mm muzzle coat and 4.8 mm on a 48 mm flank, so the ratio
   * held while the thing it stands for — how much hair is visible against the
   * sky — varied twelvefold, and the short-coat regions lost their outline.
   * uCardFloor puts a floor under the millimetres; this guard has to bound
   * it, and a ratio cannot.
   *
   * So there are two clauses, and they are kept apart on purpose:
   *
   *   A  the PROPORTIONAL ratio (uRegionC.x x uCardLength x lenMul x rise,
   *      the floor excluded) stays inside reachBand. Unchanged, and still
   *      what catches a CARD_LEN_SCALE or uCardLength mistake. `min`, `mean`,
   *      `max` and `worstDroop` are this quantity — the one `band` refers to.
   *   B  uCardFloor <= CARD_SHAPE.standFloorMax. An absolute floor may add no
   *      more stand-off than the proportional rule already grants the one
   *      coat depth 4f sources. Without B the floor is an unbounded knob.
   *
   * The per-region ABSOLUTE stand-off in millimetres — which is what the eye
   * actually judges and what A alone cannot see — is reported as `standMm`
   * per region and `maxStandMm` overall, alongside the measured coat depth it
   * grows out of. A first version of this asserted on that number directly,
   * against the deepest coat's own band ceiling; it failed at `tailMid`
   * (21.16 mm against 16.77) for the uninteresting reason that the cap and
   * the quantity both scale with the deepest coat, so the bound was really
   * "the floor adds nothing". Bounding the floor itself is the honest form.
   *
   * Coat depth per region is MEASURED off the built geometry (furLength x
   * uCoatScale x uRegionA.y), not assumed: a guard that reasons about
   * millimetres from uniforms alone would be blind to the one attribute that
   * actually sets them. Measured now, for the record, in mm:
   *
   *   nose 1.6 · muzzle 14.6 · jaw 14.1 · cheek 33.2 · forehead 16.6
   *   skull 38.3 · earOuter 17.4 · earInner 11.0 · throat 33.0 · neck 43.7
   *   ruff 45.0 · chest 42.2 · shoulder 41.5 · back 43.0 · flank 47.4
   *   belly 22.2 · croup 43.8 · haunch 42.9 · legFU 37.6 · legFL 21.2
   *   pawF 23.2 · legHU 36.8 · hock 16.8 · pawH 22.8 · tailBase 51.4
   *   tailMid 67.1 · tailTip 48.0
   *
   * The flank reads 47.4 against 4f's 48 mm, which is the one number in that
   * list with a source — so the measurement is landing where it should.
   *
   * Returns { ok, band, min, mean, max, worstDroop, worst, maxStandMm,
   *           floorMm, floorCapMm, detail[] }.
   */
  /**
   * Mean coat depth per region, in METRES, measured off the geometry the
   * shader actually reads: furLength (anatomy's per-vertex coat thickness)
   * x uCoatScale x uRegionA.y. Returns null rather than a guess if either
   * attribute is missing — an unmeasurable probe is a hard failure, not a
   * silently-dropped check.
   */
  regionCoatDepth() {
    const g = this.fox?.geometry;
    const fl = g?.getAttribute('furLength');
    const rg = g?.getAttribute('region');
    const ra = this.uniforms?.uRegionA?.value;
    if (!fl || !rg || !ra) return null;
    const n = ra.length;
    const sum = new Float64Array(n), cnt = new Uint32Array(n);
    for (let v = 0; v < fl.count; v++) {
      const i = Math.min(n - 1, Math.max(0, Math.round(rg.getX(v))));
      sum[i] += fl.getX(v); cnt[i]++;
    }
    const scale = this.uniforms.uCoatScale.value;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = cnt[i] ? (sum[i] / cnt[i]) * scale * (ra[i].y || 1) : 0;
    }
    return out;
  }

  reachReport() {
    const u = this.uniforms;
    if (!u) return { ok: false, reason: 'fur not initialised' };
    const { lenMulMin: lo, lenMulSpread: sp, lenMulMean: mid,
            rise, droopBoost, reachBand } = CARD_SHAPE;
    const cardLen = u.uCardLength.value;
    const droop = u.uDroop.value;
    const rc = u.uRegionC.value;
    // uCardFloor is the PEAK stand-off: each lock draws uCardFloorLow..1 of it
    // (see the card vertex shader). standOf() therefore measures the LONGEST
    // lock, which is the quantity standFloorMax was derived as a ceiling on --
    // reachBand's own ceiling, 0.25 x the 48 mm flank coat. Clause B is
    // unchanged and now bounds the right thing; before this it bounded a
    // constant that every lock in the coat received.
    const floor = u.uCardFloor?.value ?? 0;
    const floorLow = u.uCardFloorLow?.value ?? 1;
    const floorMean = floor * (floorLow + (1 - floorLow) * CARD_SHAPE.floorDrawMean);
    const coat = this.regionCoatDepth();
    if (!coat) {
      return { ok: false, reason: 'no furLength/region attribute: card reach is '
                                  + 'unmeasurable, not unbounded' };
    }

    // The proportional stand-off the reach band already delivers. Read off the
    // band so the shader's `stand` term and this guard cannot drift apart.
    const PROP = reachBand[0] - 1;
    let deepest = 0;
    for (let i = 0; i < coat.length; i++) deepest = Math.max(deepest, coat[i]);

    // lenMul = lo + sp * rClump * rCard, a product of two uniforms, so E = 1/4.
    // CARD_SHAPE.lenMulMean carries that so the builder and the guard cannot
    // disagree; the old `lo + sp/3` here assumed E[r^2] for a single uniform.
    //
    // TWO QUANTITIES, and keeping them apart is the whole point:
    //   reach()  the PROPORTIONAL ratio, floor excluded — the only thing the
    //            reachBand can meaningfully bound, and still the check that
    //            catches CARD_LEN_SCALE and uCardLength drift.
    //   stand()  the ABSOLUTE stand-off in metres, floor included — what the
    //            eye actually judges, bounded by CARD_SHAPE.standFloorMax.
    const reach = (lm, s) => s * cardLen * lm * rise;
    const standOf = (lm, s, c) => {
      const st = Math.max(0, floor - c * PROP);
      return Math.max(0, (c + st) * s * cardLen * lm * rise - c);
    };

    // Gravity acts in world space and adds to reach wherever the surface faces
    // down — the belly and chest, which is where the "Afghan skirt" came from.
    //
    // uCardDroop is a SECOND gravity term, applied to cards only and NOT
    // routed through droopBoost (see the card vertex shader). It is reported
    // and deliberately NOT added to `extra`, and the reason is a property of
    // the shader rather than an opinion about the threshold: the card vertex
    // shader projects the OUTWARD-normal component out of that sag, so it
    // cannot add perpendicular reach on any surface, which is the only thing
    // this clause bounds.
    //
    // It was added raw first, and this guard is what caught it — with the
    // term in `extra`, the belly (region 15, the shallowest trunk coat at
    // 22.2 mm, so the worst region for any ratio-of-coat rule) went 1.228 ->
    // 1.903 against a 1.3125 ceiling, and every value above 0.07 failed. The
    // fix went into the shader. Nothing here was widened to admit it; if the
    // projection is ever removed, put `cardDroop` back into `extra` on the
    // same line and expect it to fail.
    const cardDroop = u.uCardDroop?.value ?? 0;
    const STIFF = { 11: 0.46, 13: 0.86, 14: 0.62, 15: 0.24 };
    const detail = [];
    let min = Infinity, max = -Infinity, meanSum = 0;
    let worstDroop = 0, worst = null, worstOver = 0, maxStandMm = 0;
    for (let i = 0; i < rc.length; i++) {
      const s = rc[i].x > 0 ? rc[i].x : 1;
      const shell = rc[i].z > 0 ? rc[i].z : 1;
      const c = coat[i];
      const rMin = reach(lo, s), rMean = reach(mid, s), rMax = reach(lo + sp, s);
      const soft = 1 - (STIFF[i] ?? 0.62);
      const extra = droop * (s * cardLen * mid) * (0.30 + soft) * droopBoost;
      // What uCardDroop WOULD add if the shader did not project it out. Kept
      // in the per-region detail so the number stays visible and a future
      // reader can check the projection is still there.
      const cardSag = cardDroop * (s * cardLen * mid) * (0.30 + soft);
      min = Math.min(min, rMin); max = Math.max(max, rMax);
      meanSum += rMean;
      worstDroop = Math.max(worstDroop, rMean + extra);
      const standM = standOf(lo + sp, s, c);
      maxStandMm = Math.max(maxStandMm, standM * 1000);
      // How far outside the band this region sits, in either direction.
      const over = Math.max(rMax - reachBand[1] * 1.02, reachBand[0] * 0.92 - rMin,
                            (rMean + extra) - reachBand[1] * 1.05);
      if (over > worstOver) { worstOver = over; worst = i; }
      detail.push({ region: i, scale: +s.toFixed(3), coatMm: +(c * 1000).toFixed(2),
                    min: +rMin.toFixed(3), mean: +rMean.toFixed(3), max: +rMax.toFixed(3),
                    standMm: +(standM * 1000).toFixed(2),
                    totalRatio: c > 0 ? +(1 + standM / c).toFixed(3) : null,
                    floorBinds: floor > c * PROP,
                    vsShell: +(rMean / shell).toFixed(3),
                    droopTotal: +(rMean + extra).toFixed(3),
                    cardSagUnprojected: +cardSag.toFixed(3),
                    cardSagMm: +(cardSag * c * 1000).toFixed(2) });
    }

    // Clause B: the absolute floor may add no more stand-off than the
    // proportional rule already grants the one coat depth 4f sources.
    const floorOver = floor - CARD_SHAPE.standFloorMax;
    const ok = worstOver <= 0 && floorOver <= 0;
    return {
      ok, band: reachBand, worst, worstOver: +worstOver.toFixed(3),
      floorMm: +(floor * 1000).toFixed(2),
      floorLow, floorMeanMm: +(floorMean * 1000).toFixed(2),
      floorCapMm: +(CARD_SHAPE.standFloorMax * 1000).toFixed(2),
      floorOverMm: +(floorOver * 1000).toFixed(2),
      maxStandMm: +maxStandMm.toFixed(2),
      deepestCoatMm: +(deepest * 1000).toFixed(2),
      min: +min.toFixed(3), mean: +(meanSum / rc.length).toFixed(3), max: +max.toFixed(3),
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
 *
 * `furFlow` IS BOUND BUT NO SHADER READS IT, and that is on purpose. The comb
 * separates two things: the attribute says which WAY the hair lies across the
 * surface, and `lay` says how FLAT it lies —
 *
 *     hdir = normalize(normal + furTangent * 2 * lay * t)
 *
 * so the fur system wants a purely tangential direction and builds the rise
 * itself. furTangent is exactly that: FoxSurface derives it by projecting the
 * normal component straight out of furFlow.
 *
 * The consequence is worth writing down, because it has already cost a round.
 * FoxSurface also clamps furFlow to a minimum rise off the skin (0.04 -> 0.13,
 * "~7.5 degrees, still a combed coat, but every hair now has a component
 * pointing out of the surface"). That clamp is applied to furFlow and is then
 * removed again, in full, by the projection that produces furTangent. It
 * cannot reach the render. Measured on the built mesh, dot(furTangent, normal)
 * is 0.000 in all 27 regions — as it must be, it is a tangent — while the hair
 * direction the shader actually combs with stands 38-65 degrees off the skin
 * (belly 38, throat 43, cheek 47, ruff 50, chest 52, flank 57, back 65). The
 * "13% of the animal has hair lying within 3 degrees of the skin" measurement
 * was taken on furFlow, not on the combed direction, and the trunk is not
 * flat-coated. If anything the risk now runs the other way; see 4c on urchins.
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
