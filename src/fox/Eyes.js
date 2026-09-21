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
 *   cornea   additive overlay on the corneal cap only. Two tight GGX lobes,
 *            Fresnel-weighted: one on the sun, one on the sky. The broad,
 *            physically-correct env reflection is NOT here — it is three's
 *            own clearcoat lobe on the globe, so it is lit by the real PMREM
 *            and by all four of Environment.js's lights. This mesh exists to
 *            guarantee a discrete, bloomable catchlight that sits in front of
 *            the refracted iris instead of sliding with it.
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
import { clamp, saturate, lerp, TAU } from '../util/math.js';
import { HASH, SIMPLEX3, WORLEY3, UTIL } from '../shaders/noise.glsl.js';

// --- proportions, as fractions of the measured globe radius ----------------
//
// SOURCED, and it closes REFERENCE-FOX.md §3d's "clean, complete gap". §3d
// suggested chasing comparative canid ophthalmology, and that works: there is
// no ocular measurement for either Vulpes, but there is for a wild fox of
// almost exactly our animal's build.
//
//   Cerdocyon thous, 5.1-5.6 kg, n = 5 animals / 8 eyes, callipers on
//   enucleated globes (PLOS ONE 2019, e0224245, open access):
//     globe diameter          15.8 - 16.3 mm  (median)
//     CORNEAL DIAMETER        13.52 mm horizontal, 13.53 vertical
//     palpebral fissure       17.32 mm  (and 17.45 +- 1.55 mm live, in a
//                             second independent study, PMID 31961037)
//   Small domestic dog, 4.2-8.6 kg, same paper, n = 10 eyes:
//     globe 19.4-19.9 mm, cornea 14.32 mm horizontal
//
// The load-bearing result is that GLOBE size differs significantly between
// the two (p < 0.0155) and CORNEAL diameter does not (p > 0.122). A canid
// carries a nearly size-invariant cornea on a globe that does scale — so a
// small fox is, proportionally, almost all cornea. 13-14 mm is well supported
// for a 3.0-4.5 kg arctic fox.
//
// CORNEA_R was 0.685, which puts the limbus at 0.49 R — the HUMAN ratio
// (11.7 mm cornea on a 24 mm globe), and 10.4 mm of cornea on our globe. That
// is the single measurable reason the eye read as an amber bead in a black
// ring. 0.815 lands the limbus near 0.65 R = 13.6 mm of cornea.
//
// Our globe is 21.1 mm across, which is a 20-35 kg dog's eye rather than a
// fox's — but it is set by the socket the anatomy agent carved, not by us, so
// it is reported rather than fought. See the note on the fissure below.
const CORNEA_R = 0.815;     // corneal cap radius / globe radius
const CORNEA_BULGE = 0.075; // apex stands this much proud of the scleral sphere
const BLEND_K = 0.055;      // limbal smooth-max blend width
const IRIS_DEPTH = 0.295;   // anterior chamber: apex -> iris plane
const IRIS_R = 0.90;        // iris radius / limbus radius (cornea magnifies it back)

// --- palpebral aperture, in gnomonic tangent units on the globe ------------
// (x, y) here are tan(angle) from the optical axis, so 0.70 ~ 35 degrees.
//
// The fissure is WIDE relative to the cornea, and ours was narrower than it.
// Measured (same two sources as above): palpebral fissure 17.3-17.5 mm over a
// 13.5 mm cornea, i.e. FISSURE / CORNEA = 1.28. Ours was 11.9 mm of fissure
// over 14.5 mm of cornea — 0.82, the wrong side of 1. That is what made the
// eye read as a slit: not that the cornea was covered top and bottom (it
// should be) but that the fissure did not reach the corners of it.
//
// Aperture HEIGHT has no measured value for any canid — that search came back
// a clean GAP — so it is derived instead: at 17.3 mm long and the old 2.03:1
// the height would be 8.5 mm, covering ~37% of a 13.5 mm cornea, which is
// plausible for a canid at rest. Height is therefore held near 0.63 x corneal
// diameter and only the WIDTH is opened up. That also keeps faith with
// REFERENCE-FOX.md §6's warning: the cuteness literature it cites measures
// eye AREA relative to the face, and widening a real dimension toward a
// measured target is a different act from rounding a slit into a circle
// because circles look cuter.
//
// AP_W is capped by the skull, not by this file. The anatomy agent's socket
// lets the globe out of the skin only ~23 degrees off axis on the NASAL side
// (37 degrees once Eyes.js seats the globe forward), so a canthus beyond
// AP_W ~ 0.80 is buried in the muzzle. 0.780 gives a 13.0 mm fissure against
// the measured 17.3: still short, and short for a reason that belongs to the
// socket.
const AP_W = 0.780;         // angular half-width  (canthus to canthus)
const AP_UP = 0.477;        // upper margin height at u = 0
const AP_DN = 0.413;        // lower margin depth  at u = 0
const AP_TILT = 0.045;      // canthal tilt — outer corner rides higher

// How far proud of the *surrounding skin* the corneal apex is seated. The
// socket the anatomy agent carves is a shallow dish and the fur agent only
// fades the coat to ~25% at the aperture, so a flush eye is a buried eye.
//
// SKIN IS NO LONGER THE RIGHT DATUM. §4f moved the bulk into the coat and the
// skull coat went 7.5 -> 26 mm; measured off `furLength`, the orbital rim now
// authors 8-14 mm of hair within 16 mm of the eyeball centre, and the socket
// FLOOR itself authors 8.3 mm. 1.8 mm of clearance over the skin is 1.8 mm
// under six millimetres of hair. So the clearance is the skin clearance PLUS a
// bounded share of the coat actually measured at the socket — bounded, because
// an eye pushed out far enough to clear every hair is a marble on a stick.
const APEX_CLEARANCE = 0.0018;
const COAT_CLEAR_SHARE = 0.55;  // of the locally authored coat depth...
const COAT_CLEAR_MAX = 0.0036;  // ...up to this much extra push
const MAX_SEAT_PUSH = 0.0058;   // never shove the eye more than this far out
const MAX_SEAT_PULL = -0.0022;  // ...nor sink it

// Globe-to-socket fit. Past the aperture the globe must sit inside the skin.
const FIT_ANGLE = 50 * Math.PI / 180;
const FIT_MARGIN = 0.97;

// ORBITAL AXIS vs VISUAL AXIS. `fox.eyes[side].look` is the socket's surface
// normal — the ORBITAL axis — and on this skull it diverges 35.9 degrees from
// the midline. No canid's eye points there. The orbital rims of a fox face far
// out to the side while the globes sit rotated forward inside them, which is
// what "forward-set" in §4b actually describes and why a fox can look at you
// at all. Pointing the globe down the socket normal means that at `frontal`
// framing the camera sees each eye from 36 degrees off its own axis, so the
// iris foreshortens to a sliver, the lid margin crosses in front of it, and
// the eye reads as a dark bead however bright the iris is.
//
// So: the SOCKET (lids, seat, fit, spread) is still built on the measured
// normal, and only the globe is converged. The lids therefore still fit the
// skull exactly, and the iris sits slightly nasal inside the fissure — which
// is precisely what an animal looking at the lens looks like.
const EYE_CONVERGE = 0.30;   // share of the lateral splay taken out
const EYE_LEVEL = 0.50;      // ...and of the upward tilt

// How far the lid band sweeps outward over the globe, in radians of arc from
// its own margin. It has to reach from the aperture edge to wherever the skin
// starts covering the globe (about 50 degrees off axis) with room to spare,
// or a ring of bare sclera shows between lid and face.
const LID_SPREAD = 0.62;         // fallback when the SDF is unavailable
const LID_SLACK = 0.10;          // tuck this much further under the skin
const LID_SPREAD_MIN = 0.17;     // always enough band for a margin + a blend
const LID_SPREAD_MAX = 0.95;

/** Gnomonic tangent -> sine of the angle: where that margin sits on the globe. */
const chord = (t) => t / Math.sqrt(1 + t * t);

const smoothstep01 = (a, b, x) => {
  const t = clamp((x - a) / (b - a || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
};

const F0_TEAR = 0.028;      // tear film, n = 1.336

/**
 * EVERY uniform this file injects, declared in ONE place.
 *
 * This block is prepended unconditionally to all five of our shader stages.
 * It used to be split across the aperture/globe/iris chunks, and because each
 * stage concatenates a DIFFERENT SUBSET of those chunks, a uniform used in one
 * chunk but declared in another compiled fine in one stage and failed in
 * another — `uR` and `uSunCol` were used by the iris chunk but declared only
 * by the globe chunk, which the globe's *fragment* stage does not include.
 * That surfaced as an intermittent "undeclared identifier", App.js disabled
 * the whole system, and the untextured blob left behind was mistaken for a
 * post-processing wash by two other agents. One block, no subsets, no repeat.
 *
 * Unused declarations in a given stage are free — GLSL compilers strip them.
 */
const EYE_UNIFORMS = /* glsl */ `
uniform float uR, uRc, uZc, uK;
uniform float uIrisR, uLimbusR, uPupilR, uFibreN, uCollarette, uEta, uIrisZ;
uniform float uCaustic, uWetness, uSunInt;
uniform float uApW, uApUp, uApDn, uApTilt, uBlinkU, uBlinkD;
uniform float uSpread;
uniform vec3 uIrisInner, uIrisMid, uIrisOuter, uLimbal, uPupilCol, uSclera;
uniform vec3 uMarginCol, uLidSkin, uLidFur;
uniform vec3 uCamL, uSunL, uSunCol, uSkyCol, uBounceCol;
`;

/**
 * Shared GLSL: the aperture curves. Lid geometry and the globe's contact
 * shadow must agree on these exactly, so they are written once.
 *
 * NAMING. Everything injected from this file is prefixed `fe` (fox eye).
 * These chunks are spliced into three's own meshphysical program at a scope
 * we do not control, and an unprefixed helper that happens to match something
 * three adds in a future release fails as a shader compile error — which
 * App.js swallows into a disabled system and a silently empty socket. The
 * prefix is cheap; finding that bug is not.
 */
const APERTURE_GLSL = /* glsl */ `
float feSat(float x){ return clamp(x, 0.0, 1.0); }
float feApShape(float u, float p){ return pow(max(1.0 - u*u, 0.0), p); }
// The two margins meet exactly at u = +/-1, and "exactly" leaves a one-pixel
// crack at the canthus that the dark sclera shows through as a black notch.
// Lap them over each other slightly at the corners instead.
float feLap(float u){ return 0.022 * smoothstep(0.78, 1.0, abs(u)); }
float feApUpY(float u){ return uApUp * feApShape(u, 0.58) + uApTilt * u - feLap(u); }
float feApDnY(float u){ return -uApDn * feApShape(u, 0.72) + uApTilt * u + feLap(u); }
float feApClosedY(float u){ return -0.17 * uApDn * feApShape(u, 0.50) + uApTilt * u; }
float feLidUpY(float u){ return mix(feApUpY(u), feApClosedY(u), uBlinkU); }
float feLidDnY(float u){ return mix(feApDnY(u), feApClosedY(u), uBlinkD); }
`;

/** Shared GLSL: the globe's surface of revolution z = f(rho). */
const GLOBE_GLSL = /* glsl */ `
float feSmaxK(float a, float b, float k){
  float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0);
  return mix(b, a, h) + k * h * (1.0 - h);
}
float feGlobeZ(float rho){
  float zs = sqrt(max(uR * uR - rho * rho, 0.0));
  float ic = uRc * uRc - rho * rho;
  if (ic <= 0.0) return zs;
  return feSmaxK(zs, uZc + sqrt(ic), uK);
}
/**
 * Radius of the globe surface along a unit direction. The profile is given as
 * z = f(rho), so solve t*d.z = f(t*|d.xy|) by fixed point — it converges in
 * two steps for anything the lid can reach (d.z stays above ~0.6) and it is
 * exact on the optical axis. The lid has to ride over the real corneal dome,
 * not a sphere, or a closing lid saws straight through the cornea.
 */
float feGlobeR(vec3 d){
  float dz = max(d.z, 0.35);
  float dxy = length(d.xy);
  float t = uR;
  t = feGlobeZ(t * dxy) / dz;
  t = feGlobeZ(t * dxy) / dz;
  t = feGlobeZ(t * dxy) / dz;
  return t;
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
function buildLids(R, nu, ns, spreadAt) {
  const count = 2 * (nu + 1) * (ns + 1);
  const pos = new Float32Array(count * 3);
  const aU = new Float32Array(count);
  const aS = new Float32Array(count);
  const aLid = new Float32Array(count);
  const aSpread = new Float32Array(count);
  const idx = [];
  let v = 0;
  for (let lid = 0; lid < 2; lid++) {
    const sign = lid === 0 ? 1 : -1;
    const base = v;
    for (let j = 0; j <= ns; j++) {
      const s = j / ns;
      for (let i = 0; i <= nu; i++) {
        const u = (i / nu) * 2 - 1;
        const ax = u * AP_W;
        const ay = (sign > 0 ? AP_UP * Math.pow(Math.max(1 - u * u, 0), 0.58)
          : -AP_DN * Math.pow(Math.max(1 - u * u, 0), 0.72)) + AP_TILT * u;
        const l = Math.hypot(ax, ay, 1) || 1;
        const inx = ax / l, iny = ay / l, inz = 1 / l;
        const rl = Math.hypot(inx, iny) || 1;
        const th = Math.acos(clamp(inz, -1, 1)) + spreadAt(sign, u) * s;
        const st = Math.sin(th);
        pos[v * 3] = (inx / rl) * st * R * 1.06;
        pos[v * 3 + 1] = (iny / rl) * st * R * 1.06;
        pos[v * 3 + 2] = Math.cos(th) * R * 1.06;
        aU[v] = u; aS[v] = s; aLid[v] = sign;
        aSpread[v] = spreadAt(sign, u);
        v++;
      }
    }
    for (let j = 0; j < ns; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i;
        const b = a + 1, c = a + (nu + 1), d = c + 1;
        // Both lids must wind counter-clockwise as seen from OUTSIDE the eye
        // or FrontSide culls them and the bare globe shows through with no
        // aperture at all. +i is +x for both, but +j is +y on the upper lid
        // and -y on the lower, so the lower lid's triangles are mirrored.
        if (sign > 0) idx.push(a, b, c, b, d, c);
        else idx.push(a, c, b, b, c, d);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
  g.setAttribute('aS', new THREE.BufferAttribute(aS, 1));
  g.setAttribute('aLid', new THREE.BufferAttribute(aLid, 1));
  g.setAttribute('aSpread', new THREE.BufferAttribute(aSpread, 1));
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

/** Procedural iris. r is normalised to the iris radius, a is the angle. */
vec3 feIris(float r, float a){
  float rr = clamp(r, 0.0, 1.35);

  // Radial stromal fibres. The angle is warped with radius so the fibres are
  // not dead-straight spokes, and three incommensurate harmonics keep them
  // from reading as a regular star.
  // atan() jumps by 2*PI across the -X axis. sin(k*a) only survives that jump
  // when k is an INTEGER, so the harmonic multipliers are integers rather than
  // the pretty irrational ratios you would otherwise reach for — 2.37 and 0.51
  // drew a hard seam straight across the iris. The warp is a function of
  // cos(a)/sin(a) and so is continuous on its own.
  float aw = a + 0.19 * snoise(vec3(cos(a) * 2.1, sin(a) * 2.1, rr * 1.9));
  float fib = 0.52 * sin(aw * 118.0)
            + 0.30 * sin(aw * 279.0 + 1.7)
            + 0.42 * sin(aw * 61.0 - 0.9);
  fib = fib * 0.5 + 0.5;
  float fibAmt = smoothstep(0.26, 0.92, rr) * 0.58 + 0.10;

  // Crypts — the pitted lacework just outside the collarette.
  vec3 cid;
  float w = worley3(vec3(cos(a) * 3.4, sin(a) * 3.4, rr * 4.6), cid).x;
  float crypt = smoothstep(0.12, 0.60, w);

  // §4b / §3 palette: warm amber core, golden-brown mid, dark outer ring.
  // Keep the amber broad. §4b wants "noticeably warm"; ramping to the dark
  // outer ring too early leaves a thin gold annulus on black, which is what
  // the first pass rendered and it reads as a doll's eye.
  vec3 c = mix(uIrisInner, uIrisMid, smoothstep(0.10, 0.62, rr));
  c = mix(c, uIrisOuter, smoothstep(0.68, 0.94, rr));

  // Collarette: the raised ruff about 40% out, brighter and crenulated.
  float coll = exp(-pow((rr - uCollarette) / 0.080, 2.0)) * (0.70 + 0.55 * fib);
  c += uIrisInner * coll * 0.50;

  c *= mix(1.0 - fibAmt * 0.52, 1.0 + fibAmt * 0.34, fib);
  c *= mix(0.84, 1.07, crypt);

  // Limbal ring — §4b's "darker outer ring". Hard and nearly black.
  c = mix(c, uLimbal, smoothstep(0.90, 1.02, rr) * 0.92);

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
    const LU = [20, 34, 52][seg], LS = [5, 9, 13][seg];

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
      `apex ${(e.apexZ * 1000).toFixed(2)} mm · skin ${(e.skin * 1000).toFixed(2)} mm · ` +
      `coat ${(e.coat * 1000).toFixed(2)} mm · seated ${(e.seat * 1000).toFixed(2)} mm · ` +
      `iris ø ${(2 * e.irisR * 1000).toFixed(1)} mm · cornea ø ${(2 * e.limbusR * 1000).toFixed(1)} mm · ` +
      // CHORD, not tangent-plane. The margin at u = 1 sits at angle atan(AP_W)
      // off the optical axis, so its half-width on the globe is
      // R*sin(atan(AP_W)), not R*AP_W. Reporting the tangent value overstated
      // the fissure by 21% and is why it took a measured comparison to notice
      // ours was too narrow.
      `fissure ${(2 * e.R * chord(AP_W) * 1000).toFixed(1)}x` +
      `${(e.R * (chord(AP_UP) + chord(AP_DN)) * 1000).toFixed(1)} mm ` +
      `(${(2 * chord(AP_W) / (chord(AP_UP) + chord(AP_DN))).toFixed(2)}:1, ` +
      `fissure/cornea ${(e.R * chord(AP_W) / e.limbusR).toFixed(2)})`,
    );
  }

  // ------------------------------------------------------------------ build --
  _buildEye(ctx, side, segs) {
    const fox = ctx.fox;
    const anchor = fox.anchors[`eye${side}`];
    const meta = fox.eyes?.[side] ?? null;

    // --- globe radius: what the anatomy says, CLAMPED to what fits --------
    // The rig's nominal ball radius and the depth of the socket carved for it
    // are independent numbers, and right now they disagree: the ball is
    // 11.56 mm but the socket floor is only 8.56 mm down and the skin does not
    // wrap the ball until about 55 degrees off axis. Taking the nominal radius
    // literally puts a third of a 23 mm sphere outside the face — a marble
    // stuck on the head, which is what the first pass rendered.
    //
    // So: measure how much room the socket really has and shrink to fit. This
    // only ever shrinks, and it re-measures from the live SDF, so if the
    // anatomy agent deepens the socket the globe grows back on its own.
    let rNominal = 0.0116;
    if (meta?.centre && meta?.surface) {
      const c = meta.centre, sf = meta.surface;
      rNominal = Math.hypot(sf[0] - c[0], sf[1] - c[1], sf[2] - c[2]) +
        (meta.cornealProud ?? 0.003);
    }
    rNominal = clamp(rNominal, 0.006, 0.020);
    const rFit = this._fitGlobeRadius(fox, meta);
    const R = rFit > 0 ? clamp(Math.min(rNominal, rFit), 0.55 * rNominal, rNominal)
                       : rNominal;

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
    //
    // The orientation is composed as (bindInverse * qField) rather than taken
    // straight from the rotated axis, because those two differ by a TWIST
    // about the optical axis and the twist decides which way is "up" for the
    // eyelids. _lidSpreadSampler measures the skin through qField, so the
    // geometry has to be built in the same frame or the upper lid's measured
    // clearance gets applied to the side of the eye.
    const look = new THREE.Vector3(side === 'R' ? 0.58 : -0.58, 0.15, 0.80);
    if (meta?.look) look.fromArray(meta.look);
    look.normalize();
    const qField = new THREE.Quaternion()
      .setFromUnitVectors(new THREE.Vector3(0, 0, 1), look);

    const head = fox.bone?.('head');
    const bones = fox.skeleton?.bones;
    const bi = bones ? bones.indexOf(head) : -1;
    const qBind = new THREE.Quaternion();
    if (bi >= 0 && fox.skeleton.boneInverses?.[bi]) {
      qBind.setFromRotationMatrix(
        new THREE.Matrix4().extractRotation(fox.skeleton.boneInverses[bi]));
    }
    const qLocal = qBind.clone().multiply(qField);
    const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(qLocal).normalize();

    // The globe's rest rotation inside that socket (see EYE_CONVERGE above).
    // Expressed as a yaw/pitch in the socket's own frame so it simply adds to
    // whatever gaze the animation agent hands us.
    const conv = new THREE.Vector3(
      look.x * (1 - EYE_CONVERGE), look.y * (1 - EYE_LEVEL), look.z).normalize()
      .applyQuaternion(qField.clone().invert());
    const restYaw = clamp(Math.atan2(conv.x, Math.max(conv.z, 1e-3)), -0.55, 0.55);
    const restPitch = clamp(Math.asin(clamp(conv.y, -1, 1)), -0.35, 0.35);

    // --- seat the eye so the cornea clears the coat ------------------------
    // March out along the optical axis and find the skin. The fur agent fades
    // the coat to roughly a quarter of its length at the aperture, so aim the
    // apex a couple of millimetres proud of the skin and cap how far we may
    // push so a bad measurement can never eject the eyeball out of the head.
    let seat = 0;
    const meas = this._measureSkin(fox, meta, R);
    const coat = this._measureCoat(fox, meta, R);
    const clear = APEX_CLEARANCE + Math.min(COAT_CLEAR_SHARE * Math.max(coat, 0), COAT_CLEAR_MAX);
    if (meas > 0) seat = clamp(meas + clear - apexZ, MAX_SEAT_PULL, MAX_SEAT_PUSH);

    // --- assemble ----------------------------------------------------------
    const root = new THREE.Group();
    root.name = `eye${side}`;
    root.quaternion.copy(qLocal);
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

    const spreadAt = this._lidSpreadSampler(fox, meta, R, seat);
    const lids = new THREE.Mesh(buildLids(R, segs.LU, segs.LS, spreadAt), this._lidMaterial(u));
    lids.name = `eyeLids${side}`;
    lids.castShadow = false;
    lids.receiveShadow = false;
    lids.frustumCulled = false;   // shader-moved verts; the bound is a guess
    root.add(lids);

    return {
      side, anchor, root, ball, globe, cornea, lids, u, axis,
      R, Rc, zc, apexZ, irisZ, irisR, limbusR, seat, coat, skin: meas,
      restYaw, restPitch,
      blink: 0, gazeYaw: 0, gazePitch: 0,
    };
  }

  /**
   * Distance from the eyeball centre out to the skin along the optical axis.
   * Uses the anatomy agent's own SDF, so it re-measures correctly after their
   * rework. Returns -1 when the field is unavailable or the ray misses.
   */
  /**
   * Build `spreadAt(lidSign, u)` — how far, in radians of arc, the lid band at
   * column `u` must sweep before the fox's own skin closes over the globe.
   *
   * Sampled at COLS columns per lid and linearly interpolated; the skin varies
   * smoothly enough around one socket that more would be wasted raycasts.
   * Falls back to a constant if the SDF is not available.
   */
  _lidSpreadSampler(fox, meta, R, seat = 0) {
    const COLS = 15;
    const f = fox.field;
    const flat = () => LID_SPREAD;
    if (!f?.raycast || !meta?.centre || !meta?.look) return flat;

    const c = meta.centre;
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1), new THREE.Vector3().fromArray(meta.look).normalize());
    const d = new THREE.Vector3();
    // The lid rides the globe, and the globe is seated `seat` further out
    // along the optical axis than the socket centre these rays start from. A
    // sampler that ignores the seat stops the band exactly one seat-length
    // short of the skin and leaves a ring of bare sclera all the way round.
    const need = R + Math.max(seat, 0) + 0.0009;   // globe + lid thickness

    // Distance to the skin along a direction given in EYE-LOCAL coordinates.
    const skinAt = (lx, ly, lz) => {
      d.set(lx, ly, lz).normalize().applyQuaternion(q);
      const t = f.raycast(c[0] + d.x * 1e-3, c[1] + d.y * 1e-3, c[2] + d.z * 1e-3,
        d.x, d.y, d.z, 0.07);
      return t > 0 ? 1e-3 + t : Infinity;
    };

    const table = [new Float32Array(COLS), new Float32Array(COLS)];
    for (let li = 0; li < 2; li++) {
      const sign = li === 0 ? 1 : -1;
      for (let i = 0; i < COLS; i++) {
        const u = (i / (COLS - 1)) * 2 - 1;
        const shp = (pw) => Math.pow(Math.max(1 - u * u, 0), pw);
        const lap = 0.022 * smoothstep01(0.78, 1.0, Math.abs(u));
        const ay = sign > 0 ? AP_UP * shp(0.58) + AP_TILT * u - lap
          : -AP_DN * shp(0.72) + AP_TILT * u + lap;
        const ax = u * AP_W;
        const l = Math.hypot(ax, ay, 1);
        const th0 = Math.acos(clamp(1 / l, -1, 1));
        const rl = Math.hypot(ax, ay) || 1;
        const rx = ax / rl, ry = ay / rl;

        // March outward until the skin has closed over the globe.
        let found = LID_SPREAD;
        for (let k = 1; k <= 14; k++) {
          const th = th0 + (k / 14) * 1.05;
          const st = Math.sin(th), ct = Math.cos(th);
          if (skinAt(rx * st, ry * st, ct) >= need) { found = th - th0; break; }
        }
        table[li][i] = clamp(found + LID_SLACK, LID_SPREAD_MIN, LID_SPREAD_MAX);
      }
    }

    return (sign, u) => {
      const t = clamp((u + 1) * 0.5, 0, 1) * (COLS - 1);
      const i = Math.min(COLS - 2, Math.floor(t));
      const row = table[sign > 0 ? 0 : 1];
      return lerp(row[i], row[i + 1], t - i);
    };
  }

  /**
   * Largest globe radius that the socket can swallow.
   *
   * Marches out from the eyeball centre on a cone at FIT_ANGLE and takes the
   * nearest skin hit over eight azimuths. Beyond the palpebral aperture the
   * globe has to be INSIDE the skin, or it bulges through the face; inside the
   * aperture it is the lids' job to cover it. Returns -1 if the field is not
   * available, in which case the caller keeps the nominal radius.
   */
  _fitGlobeRadius(fox, meta) {
    const f = fox.field;
    if (!f?.raycast || !meta?.centre || !meta?.look) return -1;
    const c = meta.centre, n = meta.look;
    // An orthonormal basis about the optical axis.
    const up = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let t = [n[1] * up[2] - n[2] * up[1], n[2] * up[0] - n[0] * up[2],
      n[0] * up[1] - n[1] * up[0]];
    const tl = Math.hypot(t[0], t[1], t[2]) || 1;
    t = [t[0] / tl, t[1] / tl, t[2] / tl];
    const b = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2],
      n[0] * t[1] - n[1] * t[0]];

    const ca = Math.cos(FIT_ANGLE), sa = Math.sin(FIT_ANGLE);
    let best = Infinity;
    for (let i = 0; i < 8; i++) {
      const az = (i / 8) * TAU, cb = Math.cos(az), sb = Math.sin(az);
      const d = [0, 1, 2].map((j) => n[j] * ca + (t[j] * cb + b[j] * sb) * sa);
      const hit = f.raycast(c[0] + d[0] * 1e-3, c[1] + d[1] * 1e-3, c[2] + d[2] * 1e-3,
        d[0], d[1], d[2], 0.06);
      if (hit > 0) best = Math.min(best, 1e-3 + hit);
    }
    return Number.isFinite(best) ? best * FIT_MARGIN : -1;
  }

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

  /**
   * How deep is the coat right at the socket, in metres.
   *
   * `furLength` is a published cross-system attribute (AGENTS.md: `ctx.fox
   * .attributes -> { furLength, … }`), authored per skin vertex by the anatomy
   * agent and consumed by fur. We read it for the same reason fur does: the
   * eye has to be seated relative to the hair canopy, not relative to the bare
   * skin under it, and the canopy is theirs to author.
   *
   * MEDIAN, not max, over the vertices nearest the eyeball centre. The socket
   * rim carries the long cheek hair and one outlier there would eject the
   * eyeball; the median of the ring that actually overhangs the aperture is
   * the number that decides whether the cornea is visible. Returns 0 when the
   * attribute is absent, which reduces this to the old skin-only behaviour.
   */
  _measureCoat(fox, meta, R) {
    const geo = fox.skinnedMesh?.geometry;
    const len = fox.attributes?.furLength ?? geo?.attributes?.furLength;
    const pos = geo?.attributes?.position;
    if (!len || !pos || !meta?.centre) return 0;
    const c = meta.centre;
    // A RING, 0.95 R to 1.9 R from the eyeball centre — the orbital rim, not
    // the socket floor. The fur shader already shaves the floor (its own eye
    // mask ramps length in from ~0.45 of its clearance radius), so including
    // those vertices would measure hair that is never drawn and understate the
    // canopy that actually leans over the fissure.
    const r0 = R * 0.95, r1 = R * 1.90;
    const r02 = r0 * r0, r12 = r1 * r1;
    const vals = [];
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) - c[0], dy = pos.getY(i) - c[1], dz = pos.getZ(i) - c[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r02 && d2 <= r12) vals.push(len.getX(i));
    }
    if (!vals.length) return 0;
    vals.sort((a, b) => a - b);
    return vals[vals.length >> 1];
  }

  // -------------------------------------------------------------- uniforms --
  _makeUniforms(ctx, R, Rc, zc, k, irisZ, irisR, limbusR) {
    return {
      uR: { value: R }, uRc: { value: Rc }, uZc: { value: zc }, uK: { value: k },
      uIrisZ: { value: irisZ }, uIrisR: { value: irisR }, uLimbusR: { value: limbusR },
      uPupilR: { value: 0.36 }, uEta: { value: 1.0 / 1.376 },
      uFibreN: { value: 118.0 }, uCollarette: { value: 0.41 },
      uCaustic: { value: 1.0 }, uWetness: { value: 1.0 },

      // §4b: "amber / golden-brown, noticeably warm". These were authored a
      // stop and a half darker than that and the eye graded out to a brown
      // bead: the scene is a polar TWILIGHT with the key behind the animal,
      // so whatever the iris reflects is already being multiplied by a dim,
      // cold fill before tonemapping. An iris that is "correct" under a studio
      // key is a black hole here.
      uIrisInner: { value: new THREE.Color(0xf6c874) },
      uIrisMid: { value: new THREE.Color(0xd39a44) },
      uIrisOuter: { value: new THREE.Color(0x9c6f2e) },
      uLimbal: { value: new THREE.Color(0x1a1206) },
      uPupilCol: { value: new THREE.Color(0x05040a) },
      uSclera: { value: new THREE.Color(0x2a231d) },

      uMarginCol: { value: new THREE.Color(0x0d0b0c) },
      uLidSkin: { value: new THREE.Color(0x8d8076) },
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
      uSpread: { value: LID_SPREAD },
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
      // The wet corneal layer is three's own clearcoat lobe, modulated per
      // pixel below. Doing it this way rather than with a hand-rolled
      // specular means the highlight is lit by the real env map and all four
      // of Environment.js's lights — which matters enormously here, because
      // the bible's key is BEHIND the animal: there is no sun catchlight on
      // a backlit eye, and what sells it is the twilight sky and the snow
      // bounce reflecting off the cornea.
      clearcoat: 1.0,
      clearcoatRoughness: 0.028,
      envMapIntensity: 0.85,
    });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = 'varying vec3 vLP; varying vec3 vLN;\n' + sh.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLP = transformed;')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vLN = objectNormal;');

      sh.fragmentShader = 'varying vec3 vLP; varying vec3 vLN;\n' +
        EYE_UNIFORMS + HASH + SIMPLEX3 + WORLEY3 + UTIL + APERTURE_GLSL + IRIS_GLSL +
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
  // Refraction goes unstable right at the limbus: the surface normal swings
  // through most of a right angle across a couple of vertices, so the
  // refracted hit point flies outward and the iris edge comes out crenulated.
  // Fade back to the straight view ray over the outer fifth of the cornea —
  // nothing is visible through there anyway, it is already limbal ring.
  float eyRel = eyRho / max(uLimbusR, 1e-6);
  vec3 eyRd = mix(refract(-eyV, eyN, uEta), -eyV, smoothstep(0.62, 1.0, eyRel));
  eyRd = normalize(vec3(eyRd.xy, min(eyRd.z, -1e-3)));
  float eyT = (uIrisZ - eyP.z) / eyRd.z;
  vec2 eyIp = eyP.xy + eyRd.xy * max(eyT, 0.0);
  float eyIr = min(length(eyIp) / max(uIrisR, 1e-6), 1.12);

  vec3 eyIris = feIris(eyIr, atan(eyIp.y, eyIp.x));

  // --- refractive caustic on the lower iris -----------------------------
  // The same bend applied to the SUN: the cornea throws a soft crescent of
  // focused light onto the iris opposite the light. Four instructions, and
  // it is what makes a lit eye look like it contains fluid.
  vec3 eySr = refract(-uSunL, vec3(0.0, 0.0, 1.0), uEta);
  vec2 eyCp = vec2(0.0);
  if (eySr.z < -1e-4) eyCp = eySr.xy * ((uIrisZ - uR * 1.075) / eySr.z);
  float eyCd = length(eyIp - eyCp) / max(uIrisR, 1e-6);
  float eyLit = feSat(uSunL.z) * feSat(1.0 - eyIr * 0.55);
  eyIris += uSunCol * exp(-pow(eyCd / 0.34, 2.0)) * uCaustic * 0.42 * eyLit;

  // --- sclera -----------------------------------------------------------
  // A fox's visible sclera is pigmented, not white. Keeping it dark means any
  // sliver that escapes the lid reads as shadow rather than as a googly eye,
  // and it deepens the dark ring §4b is asking for.
  vec3 eyScl = uSclera * mix(1.0, 0.38, smoothstep(0.55, 0.95, eyRho / max(uR, 1e-6)));
  float eyOnCornea = 1.0 - smoothstep(uLimbusR * 0.94, uLimbusR * 1.03, eyRho);
  vec3 eyCol = mix(eyScl, eyIris, eyOnCornea);

  // --- contact shadow under the lid margins ------------------------------
  // Evaluated from the same aperture curves the lid geometry uses, so the
  // shadow tracks a blink exactly.
  vec3 eyD = normalize(eyP);
  float eyDz = max(eyD.z, 1e-3);
  float eyGu = clamp((eyD.x / eyDz) / uApW, -1.0, 1.0);
  float eyGy = eyD.y / eyDz;
  float eyShU = smoothstep(-0.30, 0.02, eyGy - feLidUpY(eyGu));
  float eyShD = smoothstep(-0.22, 0.02, feLidDnY(eyGu) - eyGy);
  eyCol *= mix(1.0, 0.48, max(eyShU, eyShD * 0.55));

  diffuseColor.rgb = eyCol;
`)
          .replace('#include <roughnessmap_fragment>', /* glsl */ `
  float roughnessFactor = mix(0.16, 0.50, eyOnCornea);
`)
          // The tear film only exists over the cornea, and it dulls where the
          // lid margin presses on the globe.
          .replace('#include <lights_physical_fragment>', /* glsl */ `
#include <lights_physical_fragment>
  material.clearcoat = mix(0.55, 1.0, eyOnCornea) * (1.0 - max(eyShU, eyShD) * 0.7);
  // A real cornea is mirror-smooth, but our env map is a 256 px PMREM: at
  // mirror roughness it reflects the sky/ground horizon as a HARD LINE across
  // the eye, which reads as a rendering artifact rather than as a reflection.
  // Roughing the tear film slightly turns that into the soft vertical
  // gradient a photograph actually shows, and widens the catchlight enough to
  // survive the bloom downsample.
  material.clearcoatRoughness = mix(0.16, 0.075, eyOnCornea);
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
      fragmentShader: EYE_UNIFORMS + UTIL + APERTURE_GLSL + /* glsl */ `
varying vec3 vLP; varying vec3 vLN; varying vec3 vWN;

void main(){
  vec3 N = normalize(vLN);
  vec3 V = normalize(uCamL - vLP);
  float ndv = feSat(dot(N, V));
  float F = ${F0_TEAR.toFixed(4)} + (1.0 - ${F0_TEAR.toFixed(4)}) * pow(1.0 - ndv, 5.0);

  // Tight primary sun lobe — this is the catchlight.
  vec3 H = normalize(V + uSunL);
  float ndh = feSat(dot(N, H));
  float ndl = feSat(dot(N, uSunL));
  float a = 0.026;                       // tear film is very smooth
  float a2 = a * a;
  float dn = ndh * ndh * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159265 * dn * dn);
  vec3 spec = uSunCol * uSunInt * D * F * ndl * 0.02;

  // A narrow sky catchlight. The globe's clearcoat lobe already does the
  // physically-correct env reflection, so this is deliberately small: it only
  // guarantees a discrete, bloomable point of light. §1 puts the key BEHIND
  // the animal, so on most frames the sun lobe above contributes nothing and
  // this — the twilight sky and the snow bounce off a wet cornea — is the
  // entire catchlight. Aimed up and slightly camera-ward, where the brightest
  // part of a polar twilight sky actually is.
  vec3 skyDir = normalize(vec3(V.x * 0.35, abs(V.y) * 0.25 + 0.85, V.z * 0.35));
  vec3 Hs = normalize(V + skyDir);
  float ndhs = feSat(dot(N, Hs));
  float as2 = 0.052 * 0.052;
  float dns = ndhs * ndhs * (as2 - 1.0) + 1.0;
  vec3 skyLit = mix(uBounceCol, uSkyCol, 0.7);
  spec += skyLit * (as2 / (3.14159265 * dns * dns)) * F * 0.055;

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
        'attribute float aSpread;\n' +
        'varying float vU; varying float vS; varying float vLid; varying vec3 vLP;\n' +
        'varying float vArc;\n' +
        EYE_UNIFORMS + APERTURE_GLSL + GLOBE_GLSL +
        sh.vertexShader
          // beginnormal_vertex runs first, so the direction is solved there
          // once and both hooks use the same vector — an approximated normal
          // that disagrees with the position is what makes a shell read as
          // faceted plastic.
          .replace('#include <beginnormal_vertex>', /* glsl */ `
  // The lid margin is authored in gnomonic tangent coordinates, which are
  // convenient for an almond but diverge at 90 degrees — and the band has to
  // wrap past the aperture to meet the skin. So place the margin gnomonically,
  // then sweep OUTWARD as an arc over the globe. At the canthi the outward
  // direction is horizontal, so the two lids splay sideways and meet there.
  //
  // aSpread is MEASURED per column against the real skin (see
  // _measureLidSpread) rather than being one constant. It has to be: the skin
  // closes over the globe about 27 degrees off axis above the eye but not
  // until 50 degrees below it, so a single spread either leaves bare sclera
  // under the eye or stands the upper lid out over the brow as a hard-edged
  // slab. Measuring makes the lid tuck under the coat in every direction, and
  // re-measures itself if the anatomy changes.
  // Build the band from the REST margin, then close it by ROTATING the whole
  // lid about the eye's X axis — which is what an eyelid physically does.
  //
  // Sweeping outward from the *blinked* margin instead looks equivalent and is
  // not: once the upper lid's margin crosses the optical axis, "radially away
  // from the axis" flips to point DOWNWARD, so the closing upper lid swept its
  // band below the eye and left the top of the aperture wide open. A blink
  // shut the bottom half only.
  float feYRest = aLid > 0.0 ? feApUpY(aU) : feApDnY(aU);
  vec3 feRest = normalize(vec3(aU * uApW, feYRest, 1.0));
  vec3 feRad = vec3(feRest.xy, 0.0);
  float feRl = length(feRad);
  feRad = feRl > 1e-5 ? feRad / feRl : vec3(0.0, aLid, 0.0);
  float feTh = acos(clamp(feRest.z, -1.0, 1.0)) + aSpread * aS;
  vec3 feDir = vec3(0.0, 0.0, cos(feTh)) + feRad * sin(feTh);

  // Rotation angle, tapered to zero at the canthi so the corners of the
  // fissure stay pinned exactly where a real one does.
  float feB = aLid > 0.0 ? uBlinkU : uBlinkD;
  float feRestA = aLid > 0.0 ? atan(uApUp) : -atan(uApDn);
  float feClosA = atan(-0.17 * uApDn);
  float feRot = (feRestA - feClosA) * feB * feApShape(aU, 0.5);
  float feCs = cos(feRot), feSn = sin(feRot);
  feDir = vec3(feDir.x, feDir.y * feCs - feDir.z * feSn,
                        feDir.y * feSn + feDir.z * feCs);
  vec3 objectNormal = feDir;
`)
          .replace('#include <begin_vertex>', /* glsl */ `
  vU = aU; vS = aS; vLid = aLid;
  // Distance from the free edge in METRES of arc, not in band fractions. The
  // band's angular length is measured per column against the live skin and
  // varies 3:1 around one socket, so a rim authored as "the first 5% of the
  // band" is three times wider under the brow than at the canthus — and it
  // rescales every time the anatomy agent changes the coat depth. §4b calls
  // this line the single most important detail on the face; it should be one
  // width, in millimetres, everywhere.
  vArc = aS * aSpread * uR;
  // Sit on the real globe surface — the corneal dome stands proud of the
  // scleral sphere and a closing lid sweeps straight across it — plus a lid
  // thickness that is proud enough at the margin to cast a real edge, swells
  // into the fold, then tucks back onto the globe so the outer boundary
  // vanishes under the skin instead of ending in a visible rim.
  float feProud = uR * (0.010 + 0.048 * exp(-aS * 9.0) + 0.070 * 4.0 * aS * (1.0 - aS));
  vec3 transformed = feDir * (feGlobeR(feDir) + feProud);
  vLP = transformed;
`);

      sh.fragmentShader =
        'varying float vU; varying float vS; varying float vLid; varying vec3 vLP;\n' +
        'varying float vArc;\n' +
        EYE_UNIFORMS + HASH + SIMPLEX3 + UTIL + sh.fragmentShader
          .replace('#include <map_fragment>', /* glsl */ `
  // vArc = 0 is the free edge of the lid. The dark rim §4b demands lives here,
  // and it is authored in METRES so it is the same line all the way round the
  // fissure and does not rescale when the coat does.
  //
  //   0.00 -> 0.85 mm   near-black tarsal margin (the line itself)
  //   0.85 -> 1.70 mm   dark periocular skin, which every reference photo
  //                     shows as a distinct ring darker than the coat
  //   1.70 -> 4.50 mm   short lid fur taking over
  //
  // Widths matter in both directions. A first pass at 1.05 / 2.60 / 6.20 mm
  // put a black donut as wide as the iris around the eye and the socket read
  // as a hole in the face — the exact failure the fraction-based version was
  // written to avoid, arrived at from the other side. On the real animal the
  // black is a LINE, and the periocular skin merely a shade darker than the
  // coat over it.
  //
  // The previous version authored these as fractions of the band (0.008-0.055
  // of vS) and the band is 1.8-10 mm long depending on the column, so the
  // "single most important detail on the face" was a 0.1 mm hairline at the
  // canthus and a 0.55 mm smudge under the brow. At frontal framing the whole
  // ring was sub-pixel and the eye reduced to a grey dot.
  float feMargin = 1.0 - smoothstep(0.00030, 0.00085, vArc);
  float feRing   = 1.0 - smoothstep(0.00085, 0.00170, vArc);
  float feFurry  = smoothstep(0.00170, 0.00450, vArc);

  // Short, fine hairs over the lid fold so it does not read as a plastic cap.
  float feHair = snoise(vec3(vU * 46.0, vS * 7.0, 3.1)) * 0.5 + 0.5;
  vec3 feFur = uLidFur * mix(0.80, 1.06, feHair);

  // The periocular ring is the margin colour lifted toward skin, NOT skin
  // darkened — keeping it on the same hue is what stops the ring reading as
  // a separate painted band with its own edge.
  vec3 feRingCol = mix(uLidSkin, uMarginCol, 0.45);
  vec3 feCol = mix(uLidSkin, feRingCol, feRing);
  feCol = mix(feCol, feFur, feFurry);
  // Keep the extreme margin genuinely dark — this is the line that makes the
  // eye read from across the frame.
  feCol = mix(feCol, uMarginCol, feMargin * 0.96);
  diffuseColor.rgb = feCol;
`)
          .replace('#include <roughnessmap_fragment>', /* glsl */ `
  // Wet meniscus: the tear strip where lid meets globe is the glossiest thing
  // on the face. It dries out quickly into ordinary skin and then into fur.
  float feWet = 1.0 - smoothstep(0.00012, 0.00075, vArc);
  float roughnessFactor = mix(mix(0.62, 0.86, smoothstep(0.0025, 0.0060, vArc)), 0.09, feWet);
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
      // Dilated / contracted, as a fraction of the iris radius. Narrower than
      // it was: the cornea magnifies the iris by ~1.25x and the outer edge is
      // then clipped at the limbus, so the pupil grows on screen while the
      // amber does not. 0.50 dilated measured out at nearly 60% of the
      // VISIBLE iris and ate the colour §4b is asking for.
      e.u.uPupilR.value = lerp(0.42, 0.22, this._pupilNow);

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
      e.ball.rotation.set(e.restPitch + e.gazePitch, e.restYaw + e.gazeYaw, 0, 'YXZ');

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
