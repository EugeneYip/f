/**
 * Whiskers — mystacial, genal and superciliary vibrissae.
 * OWNER: face agent.  (ART_DIRECTION.md §4b)
 *
 * §4b, binding: "Whiskers are long, white and prominent — sweeping back from
 * the muzzle well past the cheek line, plus shorter brow whiskers above the
 * eye. We have none. On a white animal against snow they read as fine bright
 * filaments and they matter more than their cost suggests."
 *
 * ---------------------------------------------------------------------------
 * PLACEMENT IS MEASURED. Every follicle is found by raycasting `ctx.fox.field`
 * inward onto the muzzle from a seed defined in a frame built out of the live
 * `anchors.nose` / `anchors.eyeL` / `anchors.eyeR`. The strand then emerges
 * along the SDF's own surface normal. Nothing is a world position, so the
 * anatomy agent's skull rework moves the follicles with it.
 * ---------------------------------------------------------------------------
 *
 * RENDERING. A whisker is ~0.1 mm thick: at any sane framing it is far under
 * one pixel, and sub-pixel geometry is exactly what shimmers and crawls
 * (non-negotiable #6, rubric F). Drawing it as thin geometry and hoping TAA
 * saves it does not work — TAA is gated OFF at the `low` tier.
 *
 * So each strand is a camera-facing ribbon that is widened in the VERTEX
 * SHADER to a floor of `uMinPx` screen pixels, and its opacity is scaled by
 * exactly the ratio it was widened by. Total emitted light is therefore
 * unchanged while the rasterised footprint never falls below a pixel — the
 * standard analytic thin-line trick. The result is stable with or without a
 * temporal resolve, which is why it holds up at `low`.
 *
 * MOTION. The roots are rigidly parented to the `head` bone, so they never
 * slide on the muzzle. The lag lives in the vertex shader instead: a single
 * head-local `uSway` vector, applied with a t^1.7 falloff along the strand, so
 * the follicle is pinned and the tip trails. `uSway` is driven in fixed() by a
 * critically-damped spring forced by the measured acceleration of the muzzle
 * plus `ctx.wind` — i.e. real inertia, not a sine wave.
 */
import * as THREE from 'three';
import { clamp, saturate, lerp, rng, gauss, TAU, spring } from '../util/math.js';

// --- follicle layout -------------------------------------------------------
// Rows run dorsal (0) to ventral, columns caudal (0) to rostral, which is the
// order a real mystacial pad is arranged in and the order length varies along.
const MYS_ROWS = 5;
const MYS_COLS = 5;
const MYS_BACK = [0.0030, 0.0175];   // distance caudal of the nose anchor
const MYS_AZ = [0.62, -0.52];        // azimuth about the muzzle axis, dorsal +
const MYS_LEN = [0.030, 0.082];      // rostro-ventral shortest, caudo-dorsal longest

const BROW_N = 4;
const BROW_LEN = [0.018, 0.031];

const GENAL_N = 3;                   // a few on the cheek behind the pad
const GENAL_LEN = [0.030, 0.048];

const THICK_ROOT = 0.000150;         // 0.15 mm at the follicle — a real vibrissa
const THICK_TIP = 0.000030;

const MIN_PX = 1.35;                 // screen-space width floor

const WHISKER_GLSL = /* glsl */ `
// Prefixed fw* — this is a standalone program, but the convention is shared
// with Eyes.js and FaceDetail.js so a future merge cannot collide.
float fwSat(float x){ return clamp(x, 0.0, 1.0); }
`;

export class Whiskers {
  name = 'whiskers';
  order = 154;

  constructor() {
    this.enabled = true;
    this._sway = new THREE.Vector3();
    this._swayV = [{ v: 0 }, { v: 0 }, { v: 0 }];
    this._probePrev = new THREE.Vector3();
    this._probeVel = new THREE.Vector3();
    this._accel = new THREE.Vector3();
    this._have = false;
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._mat3 = new THREE.Matrix3();
  }

  async init(ctx) {
    const fox = ctx.fox;
    if (!fox?.anchors?.nose) throw new Error('Whiskers: ctx.fox.anchors.nose missing');

    const head = fox.bone?.('head');
    if (!head) throw new Error('Whiskers: no head bone');
    const bones = fox.skeleton?.bones;
    const bi = bones ? bones.indexOf(head) : -1;
    const inv = bi >= 0 ? fox.skeleton.boneInverses?.[bi] : null;
    if (!inv) throw new Error('Whiskers: head bind inverse unavailable');

    const tier = ctx.quality.tier;
    const segs = ctx.quality.get('whiskerSegments') ??
      (tier === 'low' ? 6 : tier === 'medium' ? 10 : 14);
    const density = ctx.quality.get('whiskerDensity') ?? (tier === 'low' ? 0.55 : 1.0);

    const strands = this._layout(ctx, fox, inv, density);
    if (!strands.length) throw new Error('Whiskers: no follicles could be placed on the muzzle');

    this.mesh = new THREE.Mesh(this._build(strands, segs), this._material(ctx));
    this.mesh.name = 'foxWhiskers';
    this.mesh.castShadow = false;       // 0.1 mm hairs cast nothing legible
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 6;
    this.mesh.frustumCulled = false;    // the shader moves and widens vertices
    head.add(this.mesh);

    this.head = head;
    this.probe = fox.anchors.nose;
    ctx.whiskers = this;
    console.info(`[whiskers] ${strands.length} strands · ${segs} segments · ` +
      `${strands.length * segs * 2} tris · 1 draw call`);
  }

  // ------------------------------------------------------------------ layout --
  /**
   * Build a muzzle frame from the live anchors, then find each follicle by
   * raycasting inward onto the skin. Returns strands in HEAD-BONE local space.
   */
  _layout(ctx, fox, inv, density) {
    const f = fox.field;
    const bindMat = new THREE.Matrix4().copy(inv).invert();
    const rotToBone = new THREE.Matrix4().extractRotation(inv);
    const rand = rng(0x5f0c);

    // --- muzzle frame, in field space -----------------------------------
    const pos = (a) => a.position.clone().applyMatrix4(bindMat);
    const pNose = pos(fox.anchors.nose);
    const eL = fox.anchors.eyeL, eR = fox.anchors.eyeR;
    const pEye = eL && eR
      ? pos(eL).add(pos(eR)).multiplyScalar(0.5)
      : pNose.clone().add(new THREE.Vector3(0, 0.03, -0.05));

    const F = new THREE.Vector3().subVectors(pNose, pEye).normalize();  // forward
    const U = new THREE.Vector3(0, 1, 0).projectOnPlane(F).normalize();
    const R = new THREE.Vector3().crossVectors(U, F).normalize();       // fox's left
    const back = F.clone().negate();

    const strands = [];
    const tmp = new THREE.Vector3();

    /** Drop a follicle: seed outside the skin, march in, keep the hit. */
    const place = (seed, outDir, len, spread, kind, jitter, droop = 1) => {
      if (!f?.raycast) return;
      const d = outDir.clone().normalize();
      const o = tmp.copy(seed).addScaledVector(d, 0.055);
      const t = f.raycast(o.x, o.y, o.z, -d.x, -d.y, -d.z, 0.11);
      if (!(t > 0)) return;                      // missed the animal entirely
      const root = o.clone().addScaledVector(d, -t);

      // True surface normal at the follicle — a whisker leaves the skin
      // perpendicular before it arcs back.
      const n = d.clone();
      if (f.normal) {
        const arr = [0, 0, 0];
        f.normal(root.x, root.y, root.z, 3e-4, arr);
        if (Math.hypot(arr[0], arr[1], arr[2]) > 1e-6) n.fromArray(arr).normalize();
      }

      // Emergence direction: mostly along the normal, swept caudally, with a
      // little per-strand scatter so the rows do not read as a printed grid.
      const dir = n.clone().multiplyScalar(0.80)
        .addScaledVector(back, spread)
        .addScaledVector(U, jitter.y)
        .addScaledVector(R, jitter.x)
        .normalize();

      // Arc: whiskers bow backward and droop under their own weight, more so
      // the longer they are.
      //
      // NOTE: Vector3.transformDirection NORMALISES. The magnitude therefore
      // has to be captured before the transform and reapplied after it —
      // chaining `.transformDirection(m).multiplyScalar(v.length())` reads
      // fine and silently yields a UNIT vector, i.e. a one-METRE curve term.
      // That produced metre-long whiskers whose visible portion was only the
      // stub in front of the face, with the rest buried inside the animal.
      // Mystacial and genal whiskers droop under their own weight; the
      // superciliary row arcs UP and back over the brow instead (droop < 0),
      // which is both correct and stops them sagging across the eye.
      const cv = back.clone().multiplyScalar(0.30 + 0.22 * rand())
        .addScaledVector(U, -(0.16 + 0.20 * rand()) * droop);
      const cvMag = cv.length() * len;
      const curve = cv.transformDirection(rotToBone).multiplyScalar(cvMag);

      strands.push({
        root: root.clone().applyMatrix4(inv),
        dir: dir.transformDirection(rotToBone).normalize(),
        curve,
        len,
        kind,
        phase: rand() * TAU,
        // Short, thick whiskers are stiffer; the flex term is what makes the
        // brow whiskers quiver while the long mystacials sweep.
        flex: clamp(len / MYS_LEN[1], 0.25, 1.25),
      });
    };

    // --- mystacial pads ---------------------------------------------------
    const rows = Math.max(3, Math.round(MYS_ROWS * density));
    const cols = Math.max(3, Math.round(MYS_COLS * density));
    for (const side of [-1, 1]) {
      for (let r = 0; r < rows; r++) {
        const fr = rows > 1 ? r / (rows - 1) : 0.5;
        const az = lerp(MYS_AZ[0], MYS_AZ[1], fr);
        for (let c = 0; c < cols; c++) {
          const fc = cols > 1 ? c / (cols - 1) : 0.5;
          const b = lerp(MYS_BACK[1], MYS_BACK[0], fc);
          // Caudo-dorsal whiskers are the long ones.
          const lf = saturate(0.62 * (1 - fr) + 0.38 * (1 - fc));
          const len = lerp(MYS_LEN[0], MYS_LEN[1], lf) * (0.88 + 0.24 * rand());
          const seed = pNose.clone().addScaledVector(back, b);
          const out = R.clone().multiplyScalar(side * Math.cos(az))
            .addScaledVector(U, Math.sin(az));
          place(seed, out, len, 0.16 + 0.13 * fr, 'mystacial',
            { x: side * gauss(rand, 0, 0.05), y: gauss(rand, 0, 0.06) });
        }
      }
    }

    // --- genal (cheek) ----------------------------------------------------
    const gn = Math.max(1, Math.round(GENAL_N * density));
    for (const side of [-1, 1]) {
      for (let i = 0; i < gn; i++) {
        const fi = gn > 1 ? i / (gn - 1) : 0.5;
        const seed = pNose.clone().addScaledVector(back, lerp(0.030, 0.042, fi))
          .addScaledVector(U, lerp(-0.004, 0.006, fi));
        const out = R.clone().multiplyScalar(side * 0.96).addScaledVector(U, -0.15);
        place(seed, out, lerp(GENAL_LEN[0], GENAL_LEN[1], fi) * (0.9 + 0.2 * rand()),
          0.26, 'genal', { x: side * gauss(rand, 0, 0.05), y: gauss(rand, 0, 0.05) });
      }
    }

    // --- superciliary (brow) ---------------------------------------------
    // Anchored off the eye itself so they stay above the eye if it moves.
    const bn = Math.max(2, Math.round(BROW_N * density));
    for (const side of ['L', 'R']) {
      const a = fox.anchors?.[`eye${side}`];
      if (!a) continue;
      const pe = pos(a);
      const sgn = side === 'L' ? -1 : 1;
      for (let i = 0; i < bn; i++) {
        const fi = bn > 1 ? i / (bn - 1) : 0.5;
        // Just above and slightly FORWARD of the eye. Seeding further back
        // walked the ray onto the top of the skull and grew a pair of long
        // spikes out of the forehead.
        const seed = pe.clone()
          .addScaledVector(U, 0.0055)
          .addScaledVector(F, lerp(0.010, 0.000, fi))
          .addScaledVector(R, sgn * lerp(-0.001, 0.006, fi));
        const out = U.clone().multiplyScalar(0.86)
          .addScaledVector(R, sgn * 0.46)
          .addScaledVector(F, 0.20);
        place(seed, out, lerp(BROW_LEN[0], BROW_LEN[1], 1 - fi) * (0.85 + 0.3 * rand()),
          0.30, 'brow', { x: sgn * gauss(rand, 0, 0.05), y: gauss(rand, 0.22, 0.05) }, -0.55);
      }
    }
    return strands;
  }

  // ------------------------------------------------------------------- build --
  _build(strands, segs) {
    const nv = strands.length * (segs + 1) * 2;
    const position = new Float32Array(nv * 3);
    const tangent = new Float32Array(nv * 3);
    const aT = new Float32Array(nv);
    const aSide = new Float32Array(nv);
    const aWidth = new Float32Array(nv);
    const aPhase = new Float32Array(nv);
    const aFlex = new Float32Array(nv);
    const idx = [];

    const p = new THREE.Vector3(), pn = new THREE.Vector3(), tg = new THREE.Vector3();
    let v = 0;

    for (const s of strands) {
      const base = v;
      // P(t) = root + dir*len*t + curve*t^2  — a quadratic arc is plenty for a
      // whisker and gives an exact analytic tangent.
      const at = (t, out) => out.copy(s.root)
        .addScaledVector(s.dir, s.len * t)
        .addScaledVector(s.curve, t * t);

      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        at(t, p);
        at(Math.min(1, t + 1e-3), pn);
        tg.subVectors(pn, p);
        if (tg.lengthSq() < 1e-12) tg.copy(s.dir);
        tg.normalize();
        // Taper: a vibrissa is a smooth cone, thinning fast near the tip.
        const w = lerp(THICK_ROOT, THICK_TIP, Math.pow(t, 0.75)) * 0.5;
        for (const sd of [-1, 1]) {
          position[v * 3] = p.x; position[v * 3 + 1] = p.y; position[v * 3 + 2] = p.z;
          tangent[v * 3] = tg.x; tangent[v * 3 + 1] = tg.y; tangent[v * 3 + 2] = tg.z;
          aT[v] = t; aSide[v] = sd; aWidth[v] = w;
          aPhase[v] = s.phase; aFlex[v] = s.flex;
          v++;
        }
      }
      for (let i = 0; i < segs; i++) {
        const a = base + i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('aTangent', new THREE.BufferAttribute(tangent, 3));
    g.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
    g.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1));
    g.setAttribute('aWidth', new THREE.BufferAttribute(aWidth, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
    g.setAttribute('aFlex', new THREE.BufferAttribute(aFlex, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    // Room for the sway and the screen-space widening.
    g.boundingSphere.radius *= 1.6;
    return g;
  }

  // ---------------------------------------------------------------- material --
  _material(ctx) {
    this.u = {
      uSway: { value: new THREE.Vector3() },
      uWindLocal: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uMinPx: { value: MIN_PX },
      uViewportH: { value: 800 },
      uSunDir: { value: new THREE.Vector3().copy(ctx.sunDirection) },
      uSunCol: { value: new THREE.Color().copy(ctx.sunColor) },
      uSunInt: { value: ctx.sunIntensity },
      uSkyCol: { value: new THREE.Color().copy(ctx.skyColor) },
      uBounce: { value: new THREE.Color().copy(ctx.groundBounce) },
      uTint: { value: new THREE.Color(0xfffaf2) },
      uOpacity: { value: 1.0 },
    };
    return new THREE.ShaderMaterial({
      name: 'foxWhiskers',
      uniforms: this.u,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
attribute vec3 aTangent;
attribute float aT, aSide, aWidth, aPhase, aFlex;
uniform vec3 uSway, uWindLocal;
uniform float uTime, uMinPx, uViewportH;
varying float vT, vAcross, vCov;
varying vec3 vWT, vWP;

void main(){
  vT = aT;

  // --- secondary motion ------------------------------------------------
  // Root pinned, tip trailing. t^1.7 puts almost all of the travel in the
  // outer half of the strand, which is how a real vibrissa bends.
  float k = pow(aT, 1.7) * aFlex;
  vec3 p = position + uSway * k;
  // A little independent flutter so the rows never move as one rigid comb.
  p += uWindLocal * k * (0.55 + 0.45 * sin(uTime * 5.3 + aPhase));

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 tv = normalize((modelViewMatrix * vec4(aTangent, 0.0)).xyz);
  vec3 toEye = normalize(-mv.xyz);
  vec3 sideDir = cross(tv, toEye);
  float sl = length(sideDir);
  // Strand pointing straight at the camera: any perpendicular will do.
  sideDir = sl > 1e-5 ? sideDir / sl : normalize(cross(tv, vec3(0.0, 1.0, 0.0)));

  // --- sub-pixel width floor -------------------------------------------
  // Pixels per metre at this depth, from the projection's vertical scale.
  float pxPerM = projectionMatrix[1][1] / max(-mv.z, 1e-4) * uViewportH * 0.5;
  float minW = uMinPx / max(pxPerM, 1e-4);
  float wUse = max(aWidth, minW);
  vCov = aWidth / wUse;          // how much we cheated, paid back in alpha
  vAcross = aSide;

  mv.xyz += sideDir * (aSide * wUse);
  vWP = (modelMatrix * vec4(p, 1.0)).xyz;
  vWT = normalize((modelMatrix * vec4(aTangent, 0.0)).xyz);
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: WHISKER_GLSL + /* glsl */ `
uniform vec3 uSunDir, uSunCol, uSkyCol, uBounce, uTint;
uniform float uSunInt, uOpacity;
varying float vT, vAcross, vCov;
varying vec3 vWT, vWP;

void main(){
  // Energy-preserving tent across the ribbon: the integral is the strand's
  // true width however far it was widened, so a whisker neither brightens as
  // it recedes nor drops below a pixel and starts to crawl.
  float shape = 1.0 - smoothstep(0.0, 1.0, abs(vAcross));
  float alpha = fwSat(vCov * shape * 2.0);
  // Fade the last of the tip out rather than ending on a blunt cut.
  alpha *= 1.0 - smoothstep(0.82, 1.0, vT);

  // --- Kajiya-Kay: a cylinder has no normal, only a tangent -------------
  vec3 T = normalize(vWT);
  vec3 V = normalize(cameraPosition - vWP);
  vec3 L = normalize(uSunDir);
  float tl = dot(T, L);
  float tv = dot(T, V);
  float sinTL = sqrt(max(1.0 - tl * tl, 0.0));
  float sinTV = sqrt(max(1.0 - tv * tv, 0.0));

  // Sharp primary lobe along the strand.
  float spec = pow(fwSat(sinTL * sinTV - tl * tv), 42.0);
  // Keratin is translucent: a backlit whisker lights up along its whole
  // length, which is exactly the read §4b asks for against snow.
  float trans = pow(fwSat(-dot(T, L) * 0.0 + (1.0 - abs(tl))), 2.0) *
                fwSat(-dot(V, L) * 0.5 + 0.5);

  // A sub-pixel strand can never exceed ~25% coverage, so at equal radiance
  // to the coat it is mathematically invisible against it — which is why the
  // first pass rendered 66 strands that nobody could see. What makes a real
  // whisker read is that a smooth dielectric fibre is far BRIGHTER than
  // diffuse fur wherever it glints, and translucent where it is backlit.
  // Kajiya-Kay diffuse for a cylinder is sin(T,L); there is no N to dot.
  vec3 amb = (uSkyCol * 0.5 + uBounce * 0.5);
  vec3 col = uTint * (amb + uSunCol * uSunInt * sinTL * 0.16);
  col += uSunCol * uSunInt * spec * 0.40;
  col += uSunCol * uSunInt * trans * 0.13;

  gl_FragColor = vec4(col, alpha * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    });
  }

  // ------------------------------------------------------------------ motion --
  /**
   * Spring the tips against the measured motion of the muzzle. Forced by the
   * real acceleration of the nose anchor (which captures head rotation as well
   * as translation) so the whiskers lag a turn instead of oscillating on a
   * timer, plus `ctx.wind`.
   */
  fixed(h, ctx) {
    if (!this.enabled || !this.mesh) return;
    const probe = this.probe;
    const head = this.head;
    if (!probe || !head) return;

    probe.updateWorldMatrix(true, false);
    head.updateWorldMatrix(true, false);
    const p = this._tmp.setFromMatrixPosition(probe.matrixWorld);

    if (!this._have) { this._probePrev.copy(p); this._have = true; }
    const vel = this._tmp2.subVectors(p, this._probePrev).divideScalar(Math.max(h, 1e-6));
    this._accel.subVectors(vel, this._probeVel).divideScalar(Math.max(h, 1e-6));
    this._probeVel.copy(vel);
    this._probePrev.copy(p);

    // World -> head-local (rotation only; the strand offsets are directions).
    const rot = this._mat3.setFromMatrix4(head.matrixWorld).invert();
    const aLocal = this._accel.clone().applyMatrix3(rot);

    // Inertia pushes the tips OPPOSITE the acceleration.
    const target = aLocal.multiplyScalar(-0.0016);
    const wind = ctx.wind
      ? this._tmp2.copy(ctx.wind).applyMatrix3(rot)
        .multiplyScalar(0.00055 * (ctx.windSpeed ?? 0) * (1 + 0.8 * (ctx.windGust ?? 0)))
      : this._tmp2.set(0, 0, 0);
    target.add(wind);
    // A whisker is stiff; it must never look like wet string.
    const lim = 0.010;
    target.clampLength(0, lim);

    const OMEGA = 26, ZETA = 0.55;
    this._sway.set(
      spring(this._sway.x, target.x, this._swayV[0], OMEGA, ZETA, h),
      spring(this._sway.y, target.y, this._swayV[1], OMEGA, ZETA, h),
      spring(this._sway.z, target.z, this._swayV[2], OMEGA, ZETA, h),
    );
    this._sway.clampLength(0, lim * 1.8);
    this.u.uSway.value.copy(this._sway);
    this.u.uWindLocal.value.copy(wind).multiplyScalar(0.6);
  }

  update(dt, ctx) {
    if (!this.enabled || !this.mesh) return;
    const u = this.u;
    u.uTime.value = ctx.time;
    u.uSunDir.value.copy(ctx.sunDirection);
    u.uSunCol.value.copy(ctx.sunColor);
    u.uSunInt.value = ctx.sunIntensity;
    u.uSkyCol.value.copy(ctx.skyColor);
    u.uBounce.value.copy(ctx.groundBounce);
  }

  resize(w, h, ctx) {
    // The width floor is in BACKBUFFER pixels, so it must track render scale
    // and DPR, not CSS size — otherwise the whiskers thin out and start to
    // crawl the moment adaptive resolution kicks in.
    if (this.u) this.u.uViewportH.value = ctx.bufferSize?.height ?? h;
  }

  prerender(ctx) {
    if (this.u && ctx.bufferSize) this.u.uViewportH.value = ctx.bufferSize.height;
  }

  onQuality() { /* geometry is built once */ }

  dispose() {
    this.mesh?.geometry?.dispose();
    this.mesh?.material?.dispose();
    this.mesh?.parent?.remove(this.mesh);
    this.mesh = null;
  }
}
