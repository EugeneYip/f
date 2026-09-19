/**
 * Eyes — the single most-scrutinised 12 mm of the whole render.
 * OWNER: face agent.  (ART_DIRECTION.md §4b · REVIEW.md category C)
 *
 * §4b, binding: "Iris amber/golden-brown, noticeably warm, with a darker
 * outer ring. Pupil round and black. DARK, ALMOST BLACK EYELID RIMS surround
 * the eye — this is what makes the eye read at distance, and it is the single
 * most important detail on the face. Eyes forward-set and comparatively
 * large, with a wet corneal highlight."
 *
 * ---------------------------------------------------------------------------
 * ANATOMY IS READ AT RUNTIME. Nothing here is a hardcoded world position.
 * Every eye is parented to `ctx.fox.anchors.eyeL/eyeR`, which are themselves
 * parented to the `head` bone, so the skull can move, rescale or be remeshed
 * underneath us and the eye simply rides along. The globe radius, the optical
 * axis and the forward seat are all *measured* off `ctx.fox.eyes` and
 * `ctx.fox.field` during init.
 * ---------------------------------------------------------------------------
 *
 * Construction, per eye (all children of a group at the eyeball centre, with
 * local +Z along the optical axis):
 *
 *   globe    opaque. Sclera + iris + pupil. The iris is NOT painted on the
 *            surface: the view ray is refracted through the corneal dome and
 *            intersected with a virtual iris plane 3.4 mm further back, so the
 *            iris genuinely sits behind a lens and slides as the camera moves.
 *            That parallax is the whole difference between a bead and an eye.
 *            Also carries the refractive caustic on the lower iris and the
 *            contact shadow cast by the upper lid.
 *   cornea   additive overlay on the corneal cap only. Owns the wet highlight
 *            — a tight GGX sun lobe plus a broad sky term, Fresnel-weighted.
 *            Because it is a separate surface *in front of* the iris, the
 *            catchlight sits proud of the iris and does not slide with it.
 *   lids     one mesh per eye carrying both lids. The palpebral aperture is a
 *            true almond: two curves that meet at the canthi, evaluated in the
 *            vertex shader from a blink uniform, so closure is free and exact.
 *            The first 6% of the band is the near-black lid margin §4b asks
 *            for, and it is also where the wet meniscus lives.
 *
 * Public surface:
 *   ctx.eyes.setBlink(t [, side])   0 open .. 1 closed. null clears the
 *                                   override and returns control to the rig.
 *   ctx.eyes.setLook(vec3 | null)   world-space gaze target.
 *   ctx.eyes.setPupil(f)            0 dilated .. 1 contracted.
 *
 * Read defensively from the animation agent: `ctx.fox.blinkL/blinkR` and
 * `ctx.fox.gazeYaw/gazePitch` are used when present and ignored when not.
 */
import * as THREE from 'three';
import { clamp, saturate, lerp, smoothstep, TAU } from '../util/math.js';
import { HASH, SIMPLEX3, WORLEY3, UTIL } from '../shaders/noise.glsl.js';

// --- proportions, as fractions of the measured globe radius ----------------
const CORNEA_R = 0.685;     // corneal cap radius / globe radius
const CORNEA_BULGE = 0.075; // apex stands this much proud of the scleral sphere
const BLEND_K = 0.055;      // limbal smooth-max blend width
const IRIS_DEPTH = 0.295;   // anterior chamber: apex -> iris plane
const IRIS_R = 0.86;        // iris radius / limbus radius (cornea magnifies it back)

// --- palpebral aperture, in gnomonic tangent units on the globe ------------
// (x, y) here are tan(angle) from the optical axis, so 0.70 ~ 35 degrees.
const AP_W = 0.700;         // angular half-width  (canthus to canthus)
const AP_UP = 0.345;        // upper margin height at u = 0
const AP_DN = 0.300;        // lower margin depth  at u = 0
const AP_TILT = 0.045;      // canthal tilt — outer corner rides higher
const BAND_UP = 0.520;      // how far the upper lid band reaches into the orbit
const BAND_DN = 0.400;
const OUTER_WIDEN = 0.30;   // the band splays past the canthi to cover corners

// How far proud of the *surrounding skin* the corneal apex is seated. The
// socket the anatomy agent carves is a shallow dish and the fur agent only
// fades the coat to ~25% at the aperture, so a flush eye is a buried eye.
const APEX_CLEARANCE = 0.0021;
const MAX_SEAT_PUSH = 0.0045;   // never shove the eye more than this far out

const F0_TEAR = 0.028;      // tear film, n = 1.336

/** Shared GLSL: the aperture curves. Lid geometry and the globe's contact
 *  shadow must agree on these exactly, so they are written once. */
const APERTURE_GLSL = /* glsl */ `
uniform float uApW, uApUp, uApDn, uApTilt;
uniform float uBlinkU, uBlinkD;
float apShape(float u, float p){ return pow(max(1.0 - u*u, 0.0), p); }
float apUpY(float u){ return uApUp * apShape(u, 0.58) + uApTilt * u; }
float apDnY(float u){ return -uApDn * apShape(u, 0.72) + uApTilt * u; }
float apClosedY(float u){ return -0.17 * uApDn * apShape(u, 0.50) + uApTilt * u; }
float lidUpY(float u){ return mix(apUpY(u), apClosedY(u), uBlinkU); }
float lidDnY(float u){ return mix(apDnY(u), apClosedY(u), uBlinkD); }
`;

/** Shared GLSL: the globe's surface of revolution z = f(rho). */
const GLOBE_GLSL = /* glsl */ `
uniform float uR, uRc, uZc, uK;
float smaxK(float a, float b, float k){
  float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0);
  return mix(b, a, h) + k * h * (1.0 - h);
}
float globeZ(float rho){
  float zs = sqrt(max(uR * uR - rho * rho, 0.0));
  float ic = uRc * uRc - rho * rho;
  if (ic <= 0.0) return zs;
  return smaxK(zs, uZc + sqrt(ic), uK);
}
`;

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

const smaxK = (a, b, k) => {
  const h = clamp(0.5 + 0.5 * (a - b) / k, 0, 1);
  return lerp(b, a, h) + k * h * (1 - h);
};

/**
 * The globe: a sphere of radius R with a corneal cap of radius Rc smooth-maxed
 * onto its front. Normals are derived analytically from the profile rather
 * than by face averaging — a UV sphere's duplicated seam column averages to
 * two slightly different normals and leaves a visible hairline down the iris.
 */
function buildGlobe(R, Rc, zc, k, segW, segH) {
  const g = new THREE.SphereGeometry(1, segW, segH);
  g.rotateX(Math.PI / 2);                       // pole -> +Z (the optical axis)
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  const prof = (rho) => {
    const zs = Math.sqrt(Math.max(R * R - rho * rho, 0));
    const ic = Rc * Rc - rho * rho;
    return ic <= 0 ? zs : smaxK(zs, zc + Math.sqrt(ic), k);
  };
  const H = 2e-6;
  for (let i = 0; i < pos.count; i++) {
    const ux = pos.getX(i), uy = pos.getY(i), uz = pos.getZ(i);
    const rho = Math.hypot(ux, uy) * R;
    const x = ux * R, y = uy * R;
    if (uz <= 0) {                              // rear hemisphere: plain sphere
      pos.setXYZ(i, x, y, uz * R);
      nrm.setXYZ(i, ux, uy, uz);
      continue;
    }
    pos.setXYZ(i, x, y, prof(rho));
    if (rho < 1e-6) { nrm.setXYZ(i, 0, 0, 1); continue; }
    // n = normalize(-f'(rho) * rhoHat, 1)
    const dfd = (prof(rho + H) - prof(rho - H)) / (2 * H);
    const inv = 1 / rho;
    let nx = -dfd * x * inv, ny = -dfd * y * inv, nz = 1;
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm.setXYZ(i, nx / l, ny / l, nz / l);
  }
  pos.needsUpdate = true; nrm.needsUpdate = true;
  g.computeBoundingSphere();
  return g;
}

/** The corneal overlay: a cap of the cornea sphere, nudged out of z-fighting. */
function buildCornea(Rc, zc, thetaMax, segW, segH) {
  const g = new THREE.SphereGeometry(Rc + 4e-5, segW, segH, 0, TAU, 0, thetaMax);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, zc);
  return g;
}

/**
 * Both lids of one eye as a single mesh. Positions are placeholders: the real
 * vertex position is evaluated in the shader from (aU, aS, aLid) so that a
 * blink costs one uniform write and no CPU work at all.
 */
function buildLids(R, nu, ns) {
  const count = 2 * (nu + 1) * (ns + 1);
  const pos = new Float32Array(count * 3);
  const aU = new Float32Array(count);
  const aS = new Float32Array(count);
  const aLid = new Float32Array(count);
  const idx = [];
  let v = 0;
  for (let lid = 0; lid < 2; lid++) {
    const sign = lid === 0 ? 1 : -1;
    const base = v;
    for (let j = 0; j <= ns; j++) {
      const s = j / ns;
      for (let i = 0; i <= nu; i++) {
        const u = (i / nu) * 2 - 1;
        const ax = u * AP_W * (1 + OUTER_WIDEN * s);
        const margin = sign > 0 ? AP_UP * Math.pow(Math.max(1 - u * u, 0), 0.58)
          : -AP_DN * Math.pow(Math.max(1 - u * u, 0), 0.72);
        const band = sign * (sign > 0 ? BAND_UP : BAND_DN) *
          Math.pow(Math.max(1 - u * u, 0), 0.45);
        const ay = margin + AP_TILT * u + band * s;
        const l = Math.hypot(ax, ay, 1) || 1;
        pos[v * 3] = (ax / l) * R * 1.06;
        pos[v * 3 + 1] = (ay / l) * R * 1.06;
        pos[v * 3 + 2] = (1 / l) * R * 1.06;
        aU[v] = u; aS[v] = s; aLid[v] = sign;
        v++;
      }
    }
    for (let j = 0; j < ns; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i;
        const b = a + 1, c = a + (nu + 1), d = c + 1;
        // Wind so both lids face outward despite the mirrored v direction.
        if (sign > 0) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
  g.setAttribute('aS', new THREE.BufferAttribute(aS, 1));
  g.setAttribute('aLid', new THREE.BufferAttribute(aLid, 1));
  g.setIndex(idx);
  // The shader moves vertices; give the culler a sphere that covers every
  // blink position rather than letting three derive one from the rest pose.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), R * 1.45);
  return g;
}

// ---------------------------------------------------------------------------
// shader fragments
// ---------------------------------------------------------------------------

const IRIS_GLSL = /* glsl */ `
uniform vec3 uIrisInner, uIrisMid, uIrisOuter, uLimbal, uPupilCol, uSclera;
uniform float uIrisR, uLimbusR, uPupilR, uFibreN, uCollarette, uEta, uIrisZ;
uniform float uCaustic, uWetness;
uniform vec3 uCamL, uSunL;

/** Procedural iris. r is normalised to the iris radius, a is the angle. */
vec3 irisColour(float r, float a){
  float rr = clamp(r, 0.0, 1.35);

  // Radial stromal fibres. The angle is warped with radius so the fibres are
  // not dead-straight spokes, and three incommensurate harmonics keep them
  // from reading as a regular star.
  float aw = a + 0.19 * snoise(vec3(cos(a) * 2.1, sin(a) * 2.1, rr * 1.9));
  float fib = 0.52 * sin(aw * uFibreN)
            + 0.30 * sin(aw * uFibreN * 2.37 + 1.7)
            + 0.42 * sin(aw * uFibreN * 0.51 - 0.9);
  fib = fib * 0.5 + 0.5;
  float fibAmt = smoothstep(0.26, 0.92, rr) * 0.58 + 0.10;

  // Crypts — the pitted lacework just outside the collarette.
  vec3 cid;
  float w = worley3(vec3(cos(a) * 3.4, sin(a) * 3.4, rr * 4.6), cid).x;
  float crypt = smoothstep(0.12, 0.60, w);

  // §4b / §3 palette: warm amber core, golden-brown mid, dark outer ring.
  vec3 c = mix(uIrisInner, uIrisMid, smoothstep(0.08, 0.58, rr));
  c = mix(c, uIrisOuter, smoothstep(0.55, 0.90, rr));

  // Collarette: the raised ruff about 40% out, brighter and crenulated.
  float coll = exp(-pow((rr - uCollarette) / 0.080, 2.0)) * (0.70 + 0.55 * fib);
  c += uIrisInner * coll * 0.50;

  c *= mix(1.0 - fibAmt * 0.52, 1.0 + fibAmt * 0.34, fib);
  c *= mix(0.84, 1.07, crypt);

  // Limbal ring — §4b's "darker outer ring". Hard and nearly black.
  c = mix(c, uLimbal, smoothstep(0.84, 1.00, rr) * 0.94);

  // Round black pupil with a thin bright pupillary ruff at its margin.
  c = mix(uPupilCol, c, smoothstep(uPupilR * 0.93, uPupilR * 1.07, rr));
  c += uIrisInner * 0.30 * exp(-pow((rr - uPupilR) / 0.050, 2.0));
  return c;
}
`;

// ---------------------------------------------------------------------------

export class Eyes {
  name = 'eyes';
  order = 150;               // after animation (100), before fur (200)

  constructor() {
    this.eyes = [];
    this.enabled = true;
    this._blinkOverride = { L: null, R: null };
    this._lookTarget = null;
    this._pupil = 0.5;
    this._pupilNow = 0.5;
    this._v = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
  }

  async init(ctx) {
    const fox = ctx.fox;
    if (!fox?.anchors?.eyeL || !fox?.anchors?.eyeR) {
      throw new Error('Eyes: ctx.fox.anchors.eyeL/eyeR missing — anatomy has not published yet');
    }
    const tier = ctx.quality.tier;
    const seg = (tier === 'low' ? 0 : tier === 'medium' ? 1 : 2);
    const GW = [28, 48, 72][seg], GH = [20, 34, 52][seg];
    const CW = [20, 30, 44][seg], CH = [8, 12, 18][seg];
    const LU = [20, 34, 52][seg], LS = [4, 6, 8][seg];

    this.group = new THREE.Group();
    this.group.name = 'eyes';

    for (const side of ['L', 'R']) {
      this.eyes.push(this._buildEye(ctx, side, { GW, GH, CW, CH, LU, LS }));
    }

    ctx.eyes = this;
    this._syncUniforms(ctx);
    const e = this.eyes[0];
    console.info(
      `[eyes] globe r ${(e.R * 1000).toFixed(2)} mm · cornea r ${(e.Rc * 1000).toFixed(2)} mm · ` +
      `apex ${(e.apexZ * 1000).toFixed(2)} mm · seated +${(e.seat * 1000).toFixed(2)} mm · ` +
      `iris plane ${(e.irisZ * 1000).toFixed(2)} mm · aperture ` +
      `${(2 * e.R * AP_W * 1000).toFixed(1)}x${(e.R * (AP_UP + AP_DN) * 1000).toFixed(1)} mm`,
    );
  }

  // ------------------------------------------------------------------ build --
  _buildEye(ctx, side, segs) {
    const fox = ctx.fox;
    const anchor = fox.anchors[`eye${side}`];
    const meta = fox.eyes?.[side] ?? null;

    // --- globe radius, measured, never assumed ----------------------------
    let R = 0.0116;
    if (meta?.centre && meta?.surface) {
      const c = meta.centre, s = meta.surface;
      R = Math.hypot(s[0] - c[0], s[1] - c[1], s[2] - c[2]) + (meta.cornealProud ?? 0.003);
    }
    R = clamp(R, 0.006, 0.020);

    const Rc = CORNEA_R * R;
    const zc = R * (1 + CORNEA_BULGE) - Rc;       // cornea sphere centre on +Z
    const k = BLEND_K * R;
    const apexZ = R * (1 + CORNEA_BULGE);

    // Limbus: where the corneal cap falls back inside the scleral sphere.
    let limbusR = 0.5 * R;
    for (let i = 1; i <= 64; i++) {
      const rho = (i / 64) * Rc * 0.999;
      const zs = Math.sqrt(Math.max(R * R - rho * rho, 0));
      const zcn = zc + Math.sqrt(Math.max(Rc * Rc - rho * rho, 0));
      if (zs > zcn) { limbusR = rho; break; }
    }
    const irisZ = apexZ - IRIS_DEPTH * R;
    const irisR = IRIS_R * limbusR;

    // --- the optical axis, in the anchor's own frame ----------------------
    // `meta.look` lives in the skinned mesh's object space; the anchor hangs
    // off the head bone. Map one to the other through the bind inverse so a
    // reposed or rescaled skull changes nothing here.
    const axis = new THREE.Vector3(side === 'R' ? 0.58 : -0.58, 0.15, 0.80);
    if (meta?.look) axis.fromArray(meta.look);
    axis.normalize();
    const head = fox.bone?.('head');
    const bones = fox.skeleton?.bones;
    const bi = bones ? bones.indexOf(head) : -1;
    if (bi >= 0 && fox.skeleton.boneInverses?.[bi]) {
      axis.transformDirection(fox.skeleton.boneInverses[bi]).normalize();
    }

    // --- seat the eye so the cornea clears the coat ------------------------
    // March out along the optical axis and find the skin. The fur agent fades
    // the coat to roughly a quarter of its length at the aperture, so aim the
    // apex a couple of millimetres proud of the skin and cap how far we may
    // push so a bad measurement can never eject the eyeball out of the head.
    let seat = 0;
    const meas = this._measureSkin(fox, meta, R);
    if (meas > 0) seat = clamp(meas + APEX_CLEARANCE - apexZ, -0.0005, MAX_SEAT_PUSH);

    // --- assemble ----------------------------------------------------------
    const root = new THREE.Group();
    root.name = `eye${side}`;
    root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    root.position.copy(axis).multiplyScalar(seat);
    anchor.add(root);

    const ball = new THREE.Group();          // carries gaze rotation
    ball.name = `eyeBall${side}`;
    root.add(ball);

    const u = this._makeUniforms(ctx, R, Rc, zc, k, irisZ, irisR, limbusR);

    const globe = new THREE.Mesh(
      buildGlobe(R, Rc, zc, k, segs.GW, segs.GH),
      this._globeMaterial(u, side),
    );
    globe.name = `eyeGlobe${side}`;
    globe.castShadow = false;
    globe.receiveShadow = false;
    ball.add(globe);

    const thetaMax = Math.min(Math.asin(clamp(limbusR / Rc, 0, 1)) * 1.06, Math.PI * 0.49);
    const cornea = new THREE.Mesh(
      buildCornea(Rc, zc, thetaMax, segs.CW, segs.CH),
      this._corneaMaterial(u),
    );
    cornea.name = `eyeCornea${side}`;
    cornea.renderOrder = 12;
    cornea.castShadow = false;
    ball.add(cornea);

    const lids = new THREE.Mesh(buildLids(R, segs.LU, segs.LS), this._lidMaterial(u));
    lids.name = `eyeLids${side}`;
    lids.castShadow = false;
    lids.receiveShadow = false;
    lids.frustumCulled = false;   // shader-moved verts; the bound is a guess
    root.add(lids);

    return {
      side, anchor, root, ball, globe, cornea, lids, u, axis,
      R, Rc, zc, apexZ, irisZ, irisR, limbusR, seat,
      blink: 0, gazeYaw: 0, gazePitch: 0,
    };
  }

  /**
   * Distance from the eyeball centre out to the skin along the optical axis.
   * Uses the anatomy agent's own SDF, so it re-measures correctly after their
   * rework. Returns -1 when the field is unavailable or the ray misses.
   */
  _measureSkin(fox, meta, R) {
    const f = fox.field;
    if (!f?.raycast || !meta?.centre || !meta?.look) return -1;
    const c = meta.centre, n = meta.look;
    // Start just inside the ball so we never begin outside the surface.
    const t0 = R * 0.55;
    const ox = c[0] + n[0] * t0, oy = c[1] + n[1] * t0, oz = c[2] + n[2] * t0;
    const t = f.raycast(ox, oy, oz, n[0], n[1], n[2], R * 2.6);
    return t > 0 ? t0 + t : -1;
  }

  // -------------------------------------------------------------- uniforms --
  _makeUniforms(ctx, R, Rc, zc, k, irisZ, irisR, limbusR) {
    return {
      uR: { value: R }, uRc: { value: Rc }, uZc: { value: zc }, uK: { value: k },
      uIrisZ: { value: irisZ }, uIrisR: { value: irisR }, uLimbusR: { value: limbusR },
      uPupilR: { value: 0.36 }, uEta: { value: 1.0 / 1.376 },
      uFibreN: { value: 118.0 }, uCollarette: { value: 0.41 },
      uCaustic: { value: 1.0 }, uWetness: { value: 1.0 },

      uIrisInner: { value: new THREE.Color(0xc08a3c) },
      uIrisMid: { value: new THREE.Color(0x8a6229) },
      uIrisOuter: { value: new THREE.Color(0x46310f) },
      uLimbal: { value: new THREE.Color(0x140d05) },
      uPupilCol: { value: new THREE.Color(0x05040a) },
      uSclera: { value: new THREE.Color(0x2a231d) },

      uMarginCol: { value: new THREE.Color(0x0d0b0c) },
      uLidSkin: { value: new THREE.Color(0x6e6158) },
      uLidFur: { value: new THREE.Color(0xf2f4f8) },

      uCamL: { value: new THREE.Vector3(0, 0, 1) },
      uSunL: { value: new THREE.Vector3(0, 0, 1) },
      uSunCol: { value: new THREE.Color().copy(ctx.sunColor) },
      uSunInt: { value: ctx.sunIntensity },
      uSkyCol: { value: new THREE.Color().copy(ctx.skyColor) },
      uBounceCol: { value: new THREE.Color().copy(ctx.groundBounce) },
      uWorldNrm: { value: new THREE.Matrix3() },

      uApW: { value: AP_W }, uApUp: { value: AP_UP },
      uApDn: { value: AP_DN }, uApTilt: { value: AP_TILT },
      uBlinkU: { value: 0 }, uBlinkD: { value: 0 },
      uBandUp: { value: BAND_UP }, uBandDn: { value: BAND_DN },
      uWiden: { value: OUTER_WIDEN },
    };
  }

  // -------------------------------------------------------------- materials --
  /**
   * The globe rides MeshPhysicalMaterial so it inherits the scene's sun, sky
   * fill, snow bounce, env map and tonemapping exactly like every other
   * surface. Only the albedo and roughness are ours.
   */
  _globeMaterial(u, side) {
    const m = new THREE.MeshPhysicalMaterial({
      name: `eyeGlobe${side}`,
      color: 0xffffff,
      roughness: 0.45,
      metalness: 0.0,
      clearcoat: 0.0,
      envMapIntensity: 0.55,
    });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = 'varying vec3 vLP; varying vec3 vLN;\n' + sh.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLP = transformed;')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vLN = objectNormal;');

      sh.fragmentShader = 'varying vec3 vLP; varying vec3 vLN;\n' +
        HASH + SIMPLEX3 + WORLEY3 + UTIL + APERTURE_GLSL + IRIS_GLSL +
        sh.fragmentShader
          .replace('#include <map_fragment>', /* glsl */ `
  // Everything here is prefixed ey* — three's own chunks own the short names
  // (normal, geometryNormal, diffuseColor, ...) and a collision only shows up
  // as a shader compile error buried in a console the harness swallows.
  vec3 eyP = vLP;
  vec3 eyN = normalize(vLN);
  vec3 eyV = normalize(uCamL - eyP);
  float eyRho = length(eyP.xy);

  // --- refractive iris parallax ----------------------------------------
  // Bend the view ray at the corneal surface and intersect it with the iris
  // plane. The iris therefore sits behind a lens: it shifts as the camera
  // moves and is magnified toward the limbus, which is exactly what stops an
  // eye reading as a painted bead.
  vec3 eyRd = refract(-eyV, eyN, uEta);
  if (eyRd.z > -1e-4) eyRd = vec3(eyRd.xy, -1e-4);
  float eyT = (uIrisZ - eyP.z) / eyRd.z;
  vec2 eyIp = eyP.xy + eyRd.xy * max(eyT, 0.0);
  float eyIr = length(eyIp) / max(uIrisR, 1e-6);

  vec3 eyIris = irisColour(eyIr, atan(eyIp.y, eyIp.x));

  // --- refractive caustic on the lower iris -----------------------------
  // The same bend applied to the SUN: the cornea throws a soft crescent of
  // focused light onto the iris opposite the light. Four instructions, and
  // it is what makes a lit eye look like it contains fluid.
  vec3 eySr = refract(-uSunL, vec3(0.0, 0.0, 1.0), uEta);
  vec2 eyCp = vec2(0.0);
  if (eySr.z < -1e-4) eyCp = eySr.xy * ((uIrisZ - uR * 1.075) / eySr.z);
  float eyCd = length(eyIp - eyCp) / max(uIrisR, 1e-6);
  float eyLit = saturate(uSunL.z) * saturate(1.0 - eyIr * 0.55);
  eyIris += uSunCol * exp(-pow(eyCd / 0.34, 2.0)) * uCaustic * 0.42 * eyLit;

  // --- sclera -----------------------------------------------------------
  // A fox's visible sclera is pigmented, not white. Keeping it dark means any
  // sliver that escapes the lid reads as shadow rather than as a googly eye,
  // and it deepens the dark ring §4b is asking for.
  vec3 eyScl = uSclera * mix(1.0, 0.22, smoothstep(0.55, 0.95, eyRho / max(uR, 1e-6)));
  float eyOnCornea = 1.0 - smoothstep(uLimbusR * 0.94, uLimbusR * 1.03, eyRho);
  vec3 eyCol = mix(eyScl, eyIris, eyOnCornea);

  // --- contact shadow under the lid margins ------------------------------
  // Evaluated from the same aperture curves the lid geometry uses, so the
  // shadow tracks a blink exactly.
  vec3 eyD = normalize(eyP);
  float eyDz = max(eyD.z, 1e-3);
  float eyGu = clamp((eyD.x / eyDz) / uApW, -1.0, 1.0);
  float eyGy = eyD.y / eyDz;
  float eyShU = smoothstep(-0.30, 0.02, eyGy - lidUpY(eyGu));
  float eyShD = smoothstep(-0.22, 0.02, lidDnY(eyGu) - eyGy);
  eyCol *= mix(1.0, 0.30, max(eyShU, eyShD * 0.55));

  diffuseColor.rgb = eyCol;
`)
          .replace('#include <roughnessmap_fragment>', /* glsl */ `
  float roughnessFactor = mix(0.16, 0.50, eyOnCornea);
`);
    };
    m.customProgramCacheKey = () => 'foxEyeGlobe';
    return m;
  }

  /**
   * The cornea. A separate additive surface in front of the iris — that is
   * what puts the catchlight physically ahead of the iris instead of pasted
   * onto it, and it is the difference between "wet" and "plastic".
   */
  _corneaMaterial(u) {
    return new THREE.ShaderMaterial({
      name: 'eyeCornea',
      uniforms: u,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
      vertexShader: /* glsl */ `
varying vec3 vLP; varying vec3 vLN; varying vec3 vWN;
void main(){
  vLP = position;
  vLN = normal;
  vWN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
      fragmentShader: UTIL + APERTURE_GLSL + /* glsl */ `
uniform vec3 uCamL, uSunL, uSunCol, uSkyCol, uBounceCol;
uniform float uSunInt, uR, uLimbusR, uWetness;
varying vec3 vLP; varying vec3 vLN; varying vec3 vWN;

void main(){
  vec3 N = normalize(vLN);
  vec3 V = normalize(uCamL - vLP);
  float ndv = saturate(dot(N, V));
  float F = ${F0_TEAR.toFixed(4)} + (1.0 - ${F0_TEAR.toFixed(4)}) * pow(1.0 - ndv, 5.0);

  // Tight primary sun lobe — this is the catchlight.
  vec3 H = normalize(V + uSunL);
  float ndh = saturate(dot(N, H));
  float ndl = saturate(dot(N, uSunL));
  float a = 0.026;                       // tear film is very smooth
  float a2 = a * a;
  float dn = ndh * ndh * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159265 * dn * dn);
  vec3 spec = uSunCol * uSunInt * D * F * ndl * 0.02;

  // Broad sky/bounce term so the eye is never a dead black bead when the sun
  // is behind the animal — the twilight sky is the dominant reflector here.
  vec3 Rw = reflect(-normalize(vWN * 0.0 + V), N);      // local is fine: dim + broad
  float up = saturate(vWN.y * 0.5 + 0.5);
  vec3 env = mix(uBounceCol, uSkyCol, up) * 1.35;
  spec += env * F * 1.6;

  // A second, wider lobe keeps the highlight alive after the bloom downsample
  // and stops it disappearing entirely at portrait framing.
  float a3 = 0.18, a32 = a3 * a3;
  float dn3 = ndh * ndh * (a32 - 1.0) + 1.0;
  spec += uSunCol * uSunInt * (a32 / (3.14159265 * dn3 * dn3)) * F * ndl * 0.012;

  // Fade the cap out at the limbus so its edge never draws a ring.
  float rho = length(vLP.xy);
  float edge = 1.0 - smoothstep(uLimbusR * 0.80, uLimbusR * 1.02, rho);
  gl_FragColor = vec4(spec * edge * uWetness, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    });
  }

  /**
   * The lids. Vertex positions are evaluated from (aU, aS) against the
   * aperture curves, so `uBlinkU/uBlinkD` closes the eye with no CPU cost and
   * the canthi stay pinned. The first slice of the band is the near-black lid
   * margin — §4b's "single most important detail on the face" — with the wet
   * meniscus sitting immediately inside it.
   */
  _lidMaterial(u) {
    const m = new THREE.MeshPhysicalMaterial({
      name: 'eyeLid',
      color: 0xffffff,
      roughness: 0.7,
      metalness: 0.0,
      envMapIntensity: 0.7,
    });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader =
        'attribute float aU; attribute float aS; attribute float aLid;\n' +
        'varying float vU; varying float vS; varying float vLid; varying vec3 vLP;\n' +
        'uniform float uBandUp, uBandDn, uWiden;\n' + APERTURE_GLSL + GLOBE_GLSL +
        sh.vertexShader.replace('#include <begin_vertex>', /* glsl */ `
  vU = aU; vS = aS; vLid = aLid;
  float shp = pow(max(1.0 - aU * aU, 0.0), 0.45);
  float yIn  = aLid > 0.0 ? lidUpY(aU) : lidDnY(aU);
  float yOut = (aLid > 0.0 ? apUpY(aU) + uBandUp * shp
                           : apDnY(aU) - uBandDn * shp);
  float ax = aU * uApW * (1.0 + uWiden * aS);
  float ay = mix(yIn, yOut, aS);
  vec3 dir = normalize(vec3(ax, ay, 1.0));

  // Ride over whatever the globe actually is at this direction (the corneal
  // dome stands proud of the scleral sphere, and a blinking lid sweeps right
  // across it), plus a lid thickness that swells into a fold and then tucks
  // back under the skin so its outer edge is never visible.
  float rho = uR * length(dir.xy);
  float surf = max(uR, globeZ(rho) * 0.30 + uR * 0.86);
  float proud = mix(0.00058, 0.00006, smoothstep(0.55, 1.0, aS))
              + 0.00150 * 4.0 * aS * (1.0 - aS);
  vec3 transformed = dir * (surf + proud * (uR / 0.0116));
  vLP = transformed;
`)
          .replace('#include <beginnormal_vertex>', /* glsl */ `
  vec3 objectNormal = normalize(vec3(aU * uApW, mix(aLid > 0.0 ? lidUpY(aU) : lidDnY(aU),
      (aLid > 0.0 ? apUpY(aU) + uBandUp : apDnY(aU) - uBandDn), aS), 1.0));
`);

      sh.fragmentShader =
        'varying float vU; varying float vS; varying float vLid; varying vec3 vLP;\n' +
        HASH + SIMPLEX3 + UTIL + /* glsl */ `
uniform vec3 uMarginCol, uLidSkin, uLidFur, uCamL, uSunL;
uniform float uR;
` + sh.fragmentShader
          .replace('#include <map_fragment>', /* glsl */ `
  // s = 0 is the free edge of the lid. The dark rim §4b demands lives here.
  float margin = 1.0 - smoothstep(0.015, 0.105, vS);
  float skin   = smoothstep(0.06, 0.30, vS);
  float furry  = smoothstep(0.26, 0.62, vS);

  // Short, fine hairs over the lid fold so it does not read as a plastic cap.
  float hair = snoise(vec3(vU * 46.0, vS * 7.0, 3.1)) * 0.5 + 0.5;
  vec3 fur = uLidFur * mix(0.80, 1.06, hair);

  vec3 col = mix(uMarginCol, uLidSkin, skin);
  col = mix(col, fur, furry);
  // Keep the extreme margin genuinely dark — this is the line that makes the
  // eye read from across the frame.
  col = mix(col, uMarginCol, margin * 0.94);
  diffuseColor.rgb = col;
`)
          .replace('#include <roughnessmap_fragment>', /* glsl */ `
  // Wet meniscus: the tear strip where lid meets globe is the glossiest thing
  // on the face. It dries out quickly into ordinary skin and then into fur.
  float wet = 1.0 - smoothstep(0.005, 0.085, vS);
  float roughnessFactor = mix(mix(0.62, 0.86, smoothstep(0.25, 0.7, vS)), 0.09, wet);
`);
    };
    m.customProgramCacheKey = () => 'foxEyeLid';
    return m;
  }

  // ---------------------------------------------------------------- public --
  /** 0 = open, 1 = closed. Pass null to hand control back to the rig. */
  setBlink(t, side = null) {
    const v = t == null ? null : saturate(t);
    if (side === 'L' || side === 'R') this._blinkOverride[side] = v;
    else { this._blinkOverride.L = v; this._blinkOverride.R = v; }
  }

  /** World-space gaze target, or null to follow the animation agent. */
  setLook(v) {
    if (!v) { this._lookTarget = null; return; }
    this._lookTarget = (this._lookTarget ?? new THREE.Vector3()).copy(v);
  }

  /** 0 = fully dilated, 1 = fully contracted. */
  setPupil(f) { this._pupil = saturate(f); }

  // ---------------------------------------------------------------- update --
  update(dt, ctx) {
    if (!this.enabled) return;
    const fox = ctx.fox;

    // Pupil responds to how much light is actually falling on the animal.
    // A pure function of ctx state, so the harness stays deterministic.
    const bright = saturate(ctx.sunIntensity * saturate(ctx.sunDirection.y * 3.0) / 6.0);
    const want = saturate(lerp(this._pupil, lerp(0.46, 0.27, bright), 0.85));
    this._pupilNow += (want - this._pupilNow) * (1 - Math.exp(-2.5 * dt));

    for (const e of this.eyes) {
      // --- blink --------------------------------------------------------
      const ov = this._blinkOverride[e.side];
      const rig = e.side === 'L' ? fox?.blinkL : fox?.blinkR;
      const b = saturate(ov ?? (typeof rig === 'number' ? rig : (fox?.blink ?? 0)));
      e.blink = b;
      // The upper lid leads and the lower trails; both land on the same curve
      // at b = 1 so the aperture shuts exactly.
      e.u.uBlinkU.value = Math.pow(b, 0.82);
      e.u.uBlinkD.value = Math.pow(b, 1.70);
      e.u.uPupilR.value = lerp(0.50, 0.24, this._pupilNow);

      // --- gaze ---------------------------------------------------------
      let yaw = 0, pitch = 0;
      if (this._lookTarget) {
        e.root.updateWorldMatrix(true, false);
        this._m.copy(e.root.matrixWorld).invert();
        this._v.copy(this._lookTarget).applyMatrix4(this._m).normalize();
        yaw = Math.atan2(this._v.x, Math.max(this._v.z, 1e-3));
        pitch = Math.asin(clamp(this._v.y, -1, 1));
      } else {
        yaw = typeof fox?.gazeYaw === 'number' ? fox.gazeYaw : 0;
        pitch = typeof fox?.gazePitch === 'number' ? fox.gazePitch : 0;
      }
      // Real eyes cannot rove far in the socket; the neck does the rest.
      yaw = clamp(yaw, -0.42, 0.42);
      pitch = clamp(pitch, -0.30, 0.30);
      e.gazeYaw += (yaw - e.gazeYaw) * (1 - Math.exp(-16 * dt));
      e.gazePitch += (pitch - e.gazePitch) * (1 - Math.exp(-16 * dt));
      e.ball.rotation.set(e.gazePitch, e.gazeYaw, 0, 'YXZ');

      // Lids follow the eye a little, as real lids do.
      e.lids.rotation.x = e.gazePitch * 0.22;
    }
  }

  /** Camera and sun into each eye's local frame — last thing before the draw. */
  prerender(ctx) {
    if (this.enabled) this._syncUniforms(ctx);
  }

  _syncUniforms(ctx) {
    const cam = ctx.camera;
    for (const e of this.eyes) {
      e.ball.updateWorldMatrix(true, false);
      this._m.copy(e.ball.matrixWorld).invert();
      e.u.uCamL.value.copy(cam.position).applyMatrix4(this._m);
      e.u.uSunL.value.copy(ctx.sunDirection).transformDirection(this._m).normalize();
      e.u.uSunCol.value.copy(ctx.sunColor);
      e.u.uSunInt.value = ctx.sunIntensity;
      e.u.uSkyCol.value.copy(ctx.skyColor);
      e.u.uBounceCol.value.copy(ctx.groundBounce);
    }
  }

  onQuality() { /* geometry is built once; tier changes do not remesh */ }

  dispose() {
    for (const e of this.eyes) {
      e.globe.geometry.dispose(); e.globe.material.dispose();
      e.cornea.geometry.dispose(); e.cornea.material.dispose();
      e.lids.geometry.dispose(); e.lids.material.dispose();
      e.root.parent?.remove(e.root);
    }
    this.eyes.length = 0;
  }
}
