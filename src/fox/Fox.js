/**
 * Fox — the anatomy system. Builds the skeleton, the procedural skin mesh and
 * the per-vertex fur data, publishes everything on `ctx.fox`, and runs a
 * placeholder idle so the animal is never dead-still before the animation
 * agent lands.
 * OWNER: anatomy agent.
 *
 * Public surface (see AGENTS.md "Cross-system contracts"):
 *   ctx.fox.skinnedMesh   THREE.SkinnedMesh — watertight body, 4-influence skin
 *   ctx.fox.skeleton      THREE.Skeleton — canonical bone names
 *   ctx.fox.bone(name)    bone lookup · ctx.fox.bones is the plain map
 *   ctx.fox.root          THREE.Group — world transform of the animal
 *   ctx.fox.attributes    { furLength, furStiffness, furFlow, furTangent, region }
 *   ctx.fox.anchors       bone-parented Object3Ds (nose, eyeL/R, mouth,
 *                         earTipL/R, chest, tailTip, pawFL/FR/RL/RR)
 *   ctx.fox.REGION        region name -> integer id
 *   ctx.fox.field         the SDF, for anyone who wants to resample the skin
 *   ctx.fox.setPose(n)    'stand' | 'sit' | 'alert'
 *   ctx.fox.useBuiltInIdle = false   <-- animation agent: turn me off here
 *   ctx.fox.velocity      Vector3, for the animation agent to write
 *
 * Quality note: the body is meshed ONCE, at the tier present during init. A
 * later tier change does not remesh — the fur agent derives shell geometry
 * from this exact vertex set, and re-topologising under it at runtime would
 * invalidate everything downstream.
 */
import * as THREE from 'three';
import { TAU, clamp, damp, fbm1 } from '../util/math.js';
import { FoxSkeleton, POSE_PRESETS } from './FoxSkeleton.js';
import { buildFoxSurface, CELL } from './FoxSurface.js';
import { REGION, REGION_NAME, LANDMARKS, skullXf, rostral } from './FoxAnatomy.js';

const PAW_ANCHORS = ['pawFL', 'pawFR', 'pawRL', 'pawRR'];
const PRESS_HZ = 8;                 // stamps per simulated second
const PRESS_RADIUS = 0.045;         // furred paw spreads a little wider than the skin
const PRESS_DEPTH = 0.10;           // 0..1 of max compression. Terrain writes the
                                    // contact/compaction channel at full strength
                                    // regardless, so this only needs to dish the
                                    // surface a few mm; 0.28 dug a visible hole
                                    // under a paw the rig holds at fixed height.
const PRESS_SHARPNESS = 0.52;       // furry paw -> soft rim
const PRESS_CONTACT_BAND = 0.020;   // above this the paw counts as lifted

export class Fox {
  name = 'fox';
  order = 0;

  /** Animation agent: set false to take over the bones completely. */
  useBuiltInIdle = true;

  /** Animation agent: set false once real gait contacts drive terrain.press(). */
  pressFootprints = true;

  /** Animation agent: set false once IK puts the paws on the snow itself. */
  autoGround = true;

  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'fox';
    this.velocity = new THREE.Vector3();
    this.REGION = REGION;
    this.REGION_NAME = REGION_NAME;
    this.anchors = {};
    this.bones = {};
    this._idleBones = null;
    this._tmpQ = new THREE.Quaternion();
    this._tmpE = new THREE.Euler();
    this._tmpV = new THREE.Vector3();
    this._lastPressTick = -1;
    this._grounded = false;
  }

  async init(ctx) {
    const t0 = performance.now();

    // ------------------------------------------------------------- skeleton --
    this.rig = new FoxSkeleton().build();
    this.skeleton = this.rig.skeleton;
    this.bones = this.rig.bones;
    this.boneList = this.rig.boneList;

    // -------------------------------------------------------------- surface --
    const tier = ctx.quality.tier;
    const cell = ctx.quality.get('foxVoxelCell') ?? CELL[tier] ?? CELL.high;

    // Yield roughly every 12 ms of work so we never block a frame for long.
    let lastYield = performance.now();
    const onYield = async () => {
      if (performance.now() - lastYield < 12) return;
      await new Promise((r) => setTimeout(r, 0));
      lastYield = performance.now();
    };

    // MEASUREMENT HOOK, not a product knob. The head refinement changes the
    // vertex COUNT, so it cannot be toggled in-page the way ab.mjs toggles a
    // material — the arms have to be separate page loads. A harness sets this
    // with `addInitScript` before load; nothing in the product ever writes it,
    // and an absent global leaves the refinement on. See FoxSurface's
    // SKULL_ZONE_R block for what it controls.
    //
    // The LEVEL COUNT and THRESHOLD read from quality first, the same way
    // `foxVoxelCell` does, so the orchestrator can price this from Quality.js
    // without editing an anatomy file. Both are absent today and fall through
    // to the defaults; see the trade table in FoxSurface for what each setting
    // costs and buys.
    const refine = (typeof window !== 'undefined' && window.__FOX_REFINE !== undefined)
      ? window.__FOX_REFINE
      : (ctx.quality.get('foxRefineLevels') ?? true);
    const built = await buildFoxSurface(this.rig, {
      cell, onYield, refine,
      refineThresholdDeg: ctx.quality.get('foxRefineThresholdDeg') ?? 12,
    });
    this.geometry = built.geometry;
    this.field = built.field;
    this.eyes = built.eyes;
    this.bindPositions = built.positions;
    this.adjacency = built.adjacency;
    this.stats = built.stats;

    this.attributes = {
      furLength: this.geometry.getAttribute('furLength'),
      furStiffness: this.geometry.getAttribute('furStiffness'),
      furFlow: this.geometry.getAttribute('furFlow'),
      furTangent: this.geometry.getAttribute('furTangent'),
      region: this.geometry.getAttribute('region'),
    };

    // ------------------------------------------------------------- material --
    // Temporary review material. Bible §3 "fur base (lit)" #fdfcfa, a hair
    // under 1.0, with a soft sheen so the form reads before fur exists.
    // The fur agent overrides this wholesale.
    this.material = new THREE.MeshPhysicalMaterial({
      name: 'foxSkinTemp',
      color: 0xfdfcfa,
      roughness: 0.55,
      metalness: 0.0,
      sheen: 0.38,
      sheenRoughness: 0.62,
      sheenColor: new THREE.Color(0xfff2e2),
      vertexColors: true,
      side: THREE.FrontSide,
    });

    this.skinnedMesh = new THREE.SkinnedMesh(this.geometry, this.material);
    this.skinnedMesh.name = 'foxBody';
    this.skinnedMesh.castShadow = true;
    this.skinnedMesh.receiveShadow = true;

    this.root.add(this.skinnedMesh);
    this.skinnedMesh.add(this.rig.rootBone);
    ctx.scene.add(this.root);
    this.root.updateMatrixWorld(true);
    this.skeleton.calculateInverses();
    this.skinnedMesh.bind(this.skeleton);

    // -------------------------------------------------------------- anchors --
    this._buildAnchors();
    this.setPose('stand');

    // ------------------------------------------------------------ publishing --
    ctx.fox = this;
    if (!ctx.subjectPosition) ctx.subjectPosition = new THREE.Vector3();
    this._updateSubject(ctx);

    this.initMs = performance.now() - t0;
    this.stats.initMs = +this.initMs.toFixed(1);
    console.info(
      `[fox] ${this.stats.triangles} tris · ${this.stats.vertices} verts · ` +
      `${this.boneList.length} bones · grid ${this.stats.gridDims.join('x')} ` +
      `(cell ${(this.stats.cell * 1000).toFixed(2)} mm) · init ${this.initMs.toFixed(0)} ms`,
    );
  }

  // --------------------------------------------------------------- anchors ---
  /**
   * Bone-parented attachment points. Positions that must land exactly on the
   * skin (nose, ear tips, tail tip, paw contact) are *measured* off the SDF
   * rather than guessed, so they stay correct if the anatomy is retuned.
   */
  _buildAnchors() {
    const f = this.field;
    const mk = (name, boneName, world) => {
      const o = new THREE.Object3D();
      o.name = `anchor_${name}`;
      const bone = this.bones[boneName];
      bone.add(o);
      bone.updateWorldMatrix(true, false);
      o.position.copy(bone.worldToLocal(this._tmpV.set(world[0], world[1], world[2])));
      this.anchors[name] = o;
      return o;
    };

    // --- nose: march forward out of the nose pad --------------------------
    // Authored in skull-reference space and mapped, like every other head
    // landmark — hardcoding world coordinates here left the nose anchor
    // stranded 33 mm off the face the moment the skull was repositioned.
    //
    // Both starts also go through `rostral()` for the same reason one step
    // further on: §4g lengthens the rostrum, and a fixed start that the jaw
    // has walked away from stops being inside the solid. Measured at
    // stretch 1.9 with the start left fixed, the MOUTH raycast returned null
    // and fell through to its 20 mm guess; the nose raycast survived but had
    // already been landing on the pad's rear flank rather than its apex.
    const noseStart = skullXf(rostral([0, 0.2930, 0.2480]));
    const noseDir = [0, -0.14, 0.990];
    const tn = f.raycast(noseStart[0], noseStart[1], noseStart[2], noseDir[0], noseDir[1], noseDir[2], 0.08);
    const noseT = tn > 0 ? tn : 0.030;
    mk('nose', 'head', [
      noseStart[0] + noseDir[0] * noseT,
      noseStart[1] + noseDir[1] * noseT,
      noseStart[2] + noseDir[2] * noseT,
    ]);

    // --- eyes: centre of the eyeball, measured during socket carving -------
    mk('eyeL', 'head', this.eyes.L.centre);
    mk('eyeR', 'head', this.eyes.R.centre);

    // --- mouth: front of the lower lip -------------------------------------
    const ms = skullXf(rostral([0, 0.2900, 0.2330]));
    const mt = f.raycast(ms[0], ms[1], ms[2], 0, -0.18, 0.984, 0.06);
    mk('mouth', 'jaw', mt > 0
      ? [ms[0], ms[1] - 0.18 * mt, ms[2] + 0.984 * mt]
      : [ms[0], ms[1] - 0.006, ms[2] + 0.020]);

    // --- ear tips: march along each pinna axis -----------------------------
    for (const side of ['L', 'R']) {
      const base = LANDMARKS[`ear${side}01`];
      const tip = LANDMARKS[`ear${side}_tip`];
      const d = [tip[0] - base[0], tip[1] - base[1], tip[2] - base[2]];
      const dl = Math.hypot(d[0], d[1], d[2]) || 1;
      d[0] /= dl; d[1] /= dl; d[2] /= dl;
      const mid = [base[0] + d[0] * dl * 0.5, base[1] + d[1] * dl * 0.5, base[2] + d[2] * dl * 0.5];
      const te = f.raycast(mid[0], mid[1], mid[2], d[0], d[1], d[2], 0.08);
      const tt = te > 0 ? te : dl * 0.5 + 0.018;
      mk(`earTip${side}`, `ear${side}03`, [
        mid[0] + d[0] * tt, mid[1] + d[1] * tt, mid[2] + d[2] * tt,
      ]);
    }

    // --- chest: sternum centre (breath origin / camera focus) --------------
    mk('chest', 'chest', [0, 0.1800, 0.0900]);

    // --- tail tip ----------------------------------------------------------
    const t8 = LANDMARKS.tail09, t9 = LANDMARKS.tail_tip;
    const td = [t9[0] - t8[0], t9[1] - t8[1], t9[2] - t8[2]];
    const tdl = Math.hypot(td[0], td[1], td[2]) || 1;
    td[0] /= tdl; td[1] /= tdl; td[2] /= tdl;
    const tTail = f.raycast(t8[0], t8[1], t8[2], td[0], td[1], td[2], 0.10);
    const tl = tTail > 0 ? tTail : tdl + 0.010;
    mk('tailTip', 'tail09', [t8[0] + td[0] * tl, t8[1] + td[1] * tl, t8[2] + td[2] * tl]);

    // --- paws: the audit harness measures foot slide and ground clearance
    //     off these, so they must be the real contact patch centroid, on the
    //     ground plane, not the joint centre.
    // Seed the contact search just ahead of each distal joint; _measureContact
    // then finds the true patch centroid, so these only have to be close.
    const pawSpecs = [
      ['pawFL', 'pawL', -Math.abs(LANDMARKS.pawL[0]), LANDMARKS.pawL[2] + 0.012],
      ['pawFR', 'pawR', Math.abs(LANDMARKS.pawR[0]), LANDMARKS.pawR[2] + 0.012],
      ['pawRL', 'footL', -Math.abs(LANDMARKS.footL[0]), LANDMARKS.footL[2] + 0.018],
      ['pawRR', 'footR', Math.abs(LANDMARKS.footR[0]), LANDMARKS.footR[2] + 0.018],
    ];
    this.pawContact = {};
    for (const [name, boneName, xc, zc] of pawSpecs) {
      const c = this._measureContact(xc, zc);
      this.pawContact[name] = c;
      // y = c.bottom, NOT 0.
      //
      // `_measureContact` measures where the sole actually is and this line
      // threw the answer away and substituted the authored ground plane. They
      // are not the same: smooth-union rounds the pad/toe blend UP, so the
      // drawn sole sits at y = +2.5 mm while the anchor sat at 0. Locomotion
      // pins THIS anchor to `ground - sink`, so every paw was planted with
      // 2.5 mm of drawn skin already below the commanded contact -- 2.5 mm
      // that then propagated through the shell canopy and the card fringe
      // into `spec.mjs`'s `the drawn foot meets the drawn snow`.
      //
      // It also buys margin on the audit's 22 mm stance classifier from the
      // other end: the paw bone rides `20.5 - c.bottom` above the anchor
      // instead of a flat 20.5, so stance clearance drops by the same 2.5 mm
      // without touching `sink`. Measured: bone-over-anchor 19.9 -> 17.4 mm at
      // idle. Both effects are the same correction, which is what makes it
      // safe: nothing is being traded, an error is being removed.
      mk(name, boneName, [c.x, c.bottom, c.z]);
    }
  }

  /**
   * Find the centroid of a paw's ground-contact patch by marching rays UP from
   * below the floor: the first crossing is the underside of the paw. Points
   * within 1.5 mm of the lowest hit count as "in contact".
   */
  _measureContact(xc, zc, halfX = 0.030, halfZ = 0.048) {
    const f = this.field;
    const NX = 13, NZ = 25;
    const hits = [];
    let ymin = Infinity;
    for (let i = 0; i < NX; i++) {
      const x = xc + (i / (NX - 1) * 2 - 1) * halfX;
      for (let j = 0; j < NZ; j++) {
        const z = zc + (j / (NZ - 1) * 2 - 1) * halfZ;
        const t = f.raycast(x, -0.020, z, 0, 1, 0, 0.090);
        if (t <= 0) continue;
        const y = -0.020 + t;
        hits.push(x, y, z);
        if (y < ymin) ymin = y;
      }
    }
    if (!hits.length) return { x: xc, y: 0, z: zc, bottom: 0, n: 0 };
    let sx = 0, sz = 0, w = 0;
    for (let i = 0; i < hits.length; i += 3) {
      const wi = Math.max(0, 1 - (hits[i + 1] - ymin) / 0.0015);
      if (wi <= 0) continue;
      sx += hits[i] * wi; sz += hits[i + 2] * wi; w += wi;
    }
    if (w <= 0) return { x: xc, y: ymin, z: zc, bottom: ymin, n: 0 };
    return { x: sx / w, y: ymin, z: sz / w, bottom: ymin, n: hits.length / 3 };
  }

  // ------------------------------------------------------------------ poses ---
  /** 'stand' | 'sit' | 'alert' — simple bone-rotation presets for review. */
  setPose(name) {
    if (!this.rig) return false;
    const ok = this.rig.setPose(name);
    if (ok) this.pose = typeof name === 'string' ? name : 'custom';
    return ok;
  }

  get poses() { return Object.keys(POSE_PRESETS); }

  bone(name) { return this.bones[name]; }

  // ------------------------------------------------------------------ update --
  update(dt, ctx) {
    if (this.useBuiltInIdle) this._builtInIdle(ctx);
    this._groundToTerrain(dt, ctx);
    this._updateSubject(ctx);
    this._pressFootprints(ctx);
  }

  /**
   * Sit the animal on the snow instead of on the y = 0 plane.
   *
   * The anatomy is authored with the paws at y = 0, but the terrain is not a
   * plane — under the fox it sits around -4 mm and it falls away to -33 mm a
   * metre out. Four millimetres of air under a paw is plainly visible at the
   * `paws` framing, so the root tracks the mean terrain height under the four
   * paw anchors.
   *
   * `heightAt()` includes footprint depressions, so this loop feeds back into
   * our own presses. That is fine and in fact correct: Footprints merges a
   * re-press by taking max(depth, decayed), so the depression does not deepen
   * without bound and the loop converges to the paw resting at the bottom of
   * its own print, which is what a real fox standing in snow does.
   *
   * ANIMATION AGENT: `ctx.fox.autoGround = false` once per-limb IK owns this.
   */
  _groundToTerrain(dt, ctx) {
    if (!this.autoGround) return;
    const terrain = ctx.terrain;
    if (!terrain || typeof terrain.heightAt !== 'function') return;

    let sum = 0, n = 0;
    for (const k of PAW_ANCHORS) {
      const a = this.anchors[k];
      if (!a) continue;
      a.updateWorldMatrix(true, false);
      const p = this._tmpV.setFromMatrixPosition(a.matrixWorld);
      sum += terrain.heightAt(p.x, p.z) - p.y;
      n++;
    }
    if (!n) return;

    const target = clamp(this.root.position.y + sum / n, -0.25, 0.25);
    // Snap on the first frame so the animal is never seen settling onto the
    // snow at load; damp after that so terrain changes are absorbed smoothly.
    this.root.position.y = this._grounded
      ? damp(this.root.position.y, target, 9, dt)
      : target;
    this._grounded = true;
    this.groundY = this.root.position.y;
    this.root.updateMatrixWorld(true);
  }

  /**
   * Stamp snow compression under each paw that is in contact.
   *
   * Without this the animal reads as levitating even though the paws are
   * geometrically touching — there is no depression and, more importantly, no
   * contact darkening, because the terrain writes its compaction channel from
   * these stamps. Terrain has a fallback that does the same thing, but it
   * switches itself off the moment anyone presses externally, so this takes
   * ownership of the handoff.
   *
   * Throttled off `ctx.time` (not wall clock) so the review harness stays
   * deterministic; Footprints merges repeat presses of a stationary paw into
   * one stamp, so re-pressing costs nothing.
   *
   * ANIMATION AGENT: this is yours to take over with real gait contacts —
   * `ctx.fox.pressFootprints = false` turns it off.
   */
  _pressFootprints(ctx) {
    if (!this.pressFootprints) return;
    const terrain = ctx.terrain;
    if (!terrain || typeof terrain.press !== 'function') return;

    const tick = Math.floor(ctx.time * PRESS_HZ);
    if (tick === this._lastPressTick) return;
    this._lastPressTick = tick;

    for (const k of PAW_ANCHORS) {
      const a = this.anchors[k];
      if (!a) continue;
      a.updateWorldMatrix(true, false);
      const p = this._tmpV.setFromMatrixPosition(a.matrixWorld);
      const gy = terrain.heightAt?.(p.x, p.z) ?? 0;
      if (p.y - gy > PRESS_CONTACT_BAND) continue;   // paw is lifted
      terrain.press(p.x, p.z, PRESS_RADIUS, PRESS_DEPTH, PRESS_SHARPNESS);
    }
  }

  _updateSubject(ctx) {
    if (!ctx.subjectPosition) ctx.subjectPosition = new THREE.Vector3();
    const b = this.bones.spine02;
    if (!b) return;
    b.updateWorldMatrix(true, false);
    ctx.subjectPosition.setFromMatrixPosition(b.matrixWorld);
  }

  /**
   * TEMPORARY IDLE — animation agent: `ctx.fox.useBuiltInIdle = false` and
   * this method stops touching the skeleton entirely. Nothing else in this
   * file writes bone transforms per frame.
   *
   * Breathing lifts `spine03` (and therefore the ribs, scapulae, neck and
   * head) and counter-lifts the humeri by the same amount so the front paws
   * stay planted on the snow. Tail sway is a travelling wave down the nine
   * tail joints. Everything is a pure function of `ctx.time`, so the review
   * harness stays deterministic.
   */
  _builtInIdle(ctx) {
    const rig = this.rig;
    if (!rig) return;
    const t = ctx.time;
    const q = this._tmpQ, e = this._tmpE;

    const set = (name, rx, ry, rz, dy = 0, dz = 0) => {
      const i = rig.index.get(name);
      if (i === undefined) return;
      const b = rig.boneList[i];
      e.set(rx, ry, rz, 'XYZ');
      q.setFromEuler(e);
      b.quaternion.copy(rig.poseQuaternion(i)).multiply(q);
      const r = rig.restPosition(i);
      b.position.set(r.x, r.y + dy, r.z + dz);
    };

    // --- breathing: ~25 breaths/min ---------------------------------------
    const br = Math.sin(t * TAU * 0.42);
    const rise = 0.0017 * br;
    set('spine03', 0.0042 * br, 0, 0, rise);
    set('spine04', -0.0030 * br, 0, 0);
    set('spine02', 0.0018 * br, 0, 0);
    // keep the forefeet on the ground while the chest lifts
    set('upperArmL', -0.004 * br, 0, 0, -rise);
    set('upperArmR', -0.004 * br, 0, 0, -rise);

    // --- micro head drift + a slow look-around ----------------------------
    const hy = fbm1(t * 0.11, 3, 11) * 0.055;
    const hx = fbm1(t * 0.093, 3, 23) * 0.028;
    set('neck01', hx * 0.30, hy * 0.28, 0);
    set('neck02', hx * 0.35, hy * 0.34, 0);
    set('head', hx * 0.45 - 0.004 * br, hy * 0.42, hy * 0.10);

    // --- ears: tiny independent swivel ------------------------------------
    set('earL01', fbm1(t * 0.17, 2, 41) * 0.05, fbm1(t * 0.13, 2, 57) * 0.06, 0);
    set('earR01', fbm1(t * 0.17, 2, 71) * 0.05, fbm1(t * 0.13, 2, 83) * 0.06, 0);

    // --- tail: gentle travelling wave, amplitude growing toward the tip ----
    for (let i = 1; i <= 9; i++) {
      const ph = t * TAU * 0.155 - i * 0.40;
      const amp = 0.0055 + 0.0115 * (i / 9);
      set(`tail${String(i).padStart(2, '0')}`,
        Math.sin(ph * 0.71 + 1.1) * amp * 0.45,
        Math.sin(ph) * amp,
        0);
    }
  }

  dispose() {
    this.geometry?.dispose();
    this.material?.dispose();
    this.skeleton?.dispose?.();
    this.root?.parent?.remove(this.root);
  }
}
