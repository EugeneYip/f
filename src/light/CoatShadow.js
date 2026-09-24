import * as THREE from 'three';
import { REGION_COUNT } from '../shaders/fur.glsl.js';

/**
 * THE ANIMAL'S SHADOW IS CAST BY ITS SKIN, NOT ITS COAT.
 *
 * Measured, not argued. The complete caster set in this scene is ONE object:
 * the SkinnedMesh `foxBody` -- torso, skull, tail and legs in a single skinned
 * mesh. `furShells` and `furCards` are both castShadow = false, and nothing
 * else in the scene casts at all. So the shadow is the silhouette of the bare
 * skin, whose bounding box is **0.171 m wide**, while the drawn animal is that
 * skin plus a coat that measures up to **52.9 mm deep** on top of it. The
 * drawn animal reads three to four times wider than the shadow it throws,
 * which is the real content of the critic's "a 250 px animal throws four 25 px
 * sticks".
 *
 * The fix is not to make the shells cast. Nineteen alpha-stochastic shells in
 * a variance shadow map would be nineteen extra shadow draws of the whole
 * animal for a mask that dithers, and VSM stores moments -- a stochastic
 * caster writes noise into the variance and the penumbra falls apart. The fix
 * is to give `foxBody` a customDepthMaterial that extrudes the skin outwards
 * by the coat depth, so the depth pass draws the OUTER surface of the coat
 * while the beauty pass keeps drawing the skin under it.
 *
 * ## The extrusion is the coat depth field, not a constant
 *
 * The coat is not uniform and a uniform offset would be wrong in both
 * directions at once. ART_DIRECTION 4f gives the flank at 48 mm inside a
 * sourced 40-60 mm band, 4h restates the muzzle as "whatever is needed for no
 * bare skin to show" (the anatomy agent measured 8 mm there against a 26 mm
 * skull), and the one properly sourced fact about regional depth is a RANKING
 * (Underwood & Reynolds via Prestrud 1991): deepest at the lateral trunk and
 * lower leg, shallowest at the head, distal legs and belly. A constant would
 * flatten exactly the gradient the art direction is built on.
 *
 * So this reads the SAME field the shells draw with, vertex for vertex:
 *
 *     L = furLength * uCoatScale * uRegionA[region].y * crush
 *
 * `furLength` is the anatomy agent's per-vertex coat thickness attribute,
 * `uCoatScale` and `uRegionA[].y` are the fur agent's global and per-region
 * multipliers, and `crush` is the impact compression the coat already gets on
 * a landing. All three uniform OBJECTS are shared with the fur system by
 * reference, not copied, so a tier change or a gallop landing moves the shadow
 * and the coat together by construction -- there is no second copy of the
 * number to drift.
 *
 * The tangential `lay` shear is included for the same reason: the outermost
 * shell is at `nb * L + tb * L * lay`, not `nb * L`, and the hair lying down
 * along the flow is a real part of where the outer surface is.
 *
 * Measured coat depth per region, in mm, from the fur agent's own probe:
 *   nose 1.6 - muzzle 14.6 - jaw 14.1 - cheek 33.2 - forehead 16.6 -
 *   skull 38.3 - throat 33.0 - neck 43.7 - ruff 45.0 - chest 42.2 -
 *   shoulder 41.5 - back 43.0 - flank 47.4 - belly 22.2 - croup 43.8 -
 *   haunch 42.9 - legFU 37.6 - legFL 21.2 - pawF 23.2 - hock 16.8 -
 *   tailBase 51.4 - tailMid 67.1 - tailTip 48.0
 *
 * ## Two traps, both of which have already cost an agent a round here
 *
 * 1. Under `VSMShadowMap`, three renders every `receiveShadow` object into the
 *    shadow map as well as every `castShadow` one (WebGLShadowMap.renderObject:
 *    `castShadow || (receiveShadow && type === VSMShadowMap)`). `foxBody` is
 *    receiveShadow = true, so clearing its `castShadow` moves the shadow mask
 *    by exactly zero pixels and looks like proof it was never the caster. To
 *    take the animal out of the map you must hide `fox.root`.
 *
 * 2. Nothing on the animal samples the shadow map -- the fur base, shell and
 *    card materials carry no shadowmap chunk -- so inflating the caster cannot
 *    produce self-shadow acne on the fox. The only receiver is the snow, via
 *    `snShadowMask()` in snow.glsl.js. That is why this is safe to do at full
 *    coat depth rather than at some fraction of it.
 *
 * Owns nothing but the depth material: `foxBody`, its geometry and the fur
 * uniforms all belong to other agents and are only READ here.
 */

/** Extra attributes and uniforms the stock depth shader does not declare. */
const COAT_PARS = /* glsl */ `
attribute float furLength;
attribute float furStiffness;
attribute vec3  furTangent;
attribute float region;
uniform float uCoatScale;
uniform float uLay;
uniform float uCoatCompress;
uniform float uCoatSquash;
uniform float uCoatShadow;
uniform vec4  uRegionA[${REGION_COUNT}];
`;

/**
 * Object-space offset from the skin to the outer surface of the coat.
 *
 * Injected immediately after begin_vertex, i.e. BEFORE skinning_vertex, so the
 * offset is skinned along with the vertex exactly as the shell shader does it
 * (see furVertexShader: sk * vec4(position + offB, 1.0)). Injecting it after
 * skinning would rotate the coat off the body on every bent joint.
 *
 * uCoatShadow is the A/B lever: 0 reproduces the old skin-only caster to the
 * pixel, 1 is the full measured coat. It is a uniform rather than a define so
 * an A/B costs no recompile and cannot accidentally compare two programs.
 */
const COAT_OFFSET = /* glsl */ `
{
  int  ri = int(clamp(region, 0.0, ${REGION_COUNT - 1}.0) + 0.5);
  vec4 ra = uRegionA[ri];
  float crush = clamp(1.0 - uCoatCompress * uCoatSquash, 0.62, 1.30);
  float L = furLength * uCoatScale * ra.y * crush * uCoatShadow;
  float soft = 1.0 - furStiffness;
  float lay = uLay * ra.z * (0.30 + 1.05 * soft);
  transformed += normalize(normal) * L + furTangent * (L * lay);
}
`;

const NEEDED = ['furLength', 'furStiffness', 'furTangent', 'region'];

export class CoatShadow {
  name = 'coatShadow';
  order = 260;            // after fox (0) and fur (200) have published

  init(ctx) {
    this.ctx = ctx;
    this.installed = false;
    this.scale = 1.0;
    this.report = { ok: false, reason: 'not initialised' };

    const fox = ctx.fox;
    const fur = ctx.fur;
    const mesh = fox?.skinnedMesh;
    if (!mesh) { this._fail('no ctx.fox.skinnedMesh'); return; }

    // An unmeasurable input is a hard failure with a name, never a silent
    // skip: a coat shadow that quietly did not install would look exactly
    // like the defect it exists to fix.
    const g = mesh.geometry;
    const missing = NEEDED.filter((a) => !g.getAttribute(a));
    if (missing.length) {
      this._fail(`foxBody geometry is missing ${missing.join(', ')} — the ` +
        'coat depth field cannot be read, so the shadow stays skin-shaped');
      return;
    }
    const fu = fur?.uniforms;
    if (!fu?.uCoatScale || !fu?.uRegionA) {
      this._fail('fur system published no uCoatScale/uRegionA — there is no ' +
        'coat depth field to extrude by, so the shadow stays skin-shaped');
      return;
    }

    this.uCoatShadow = { value: this.scale };
    const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    mat.name = 'foxCoatDepth';
    // SHARE the fur uniform objects rather than copying their values: a tier
    // change or a landing must move the shadow and the coat together.
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uCoatScale = fu.uCoatScale;
      shader.uniforms.uLay = fu.uLay;
      shader.uniforms.uCoatCompress = fu.uCoatCompress;
      shader.uniforms.uCoatSquash = fu.uCoatSquash;
      shader.uniforms.uRegionA = fu.uRegionA;
      shader.uniforms.uCoatShadow = this.uCoatShadow;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${COAT_PARS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${COAT_OFFSET}`);
    };
    mat.customProgramCacheKey = () => 'foxCoatDepth.v1';
    this.material = mat;
    this.mesh = mesh;
    this.setInstalled(true);

    this.report = this.measure();
    const r = this.report;
    console.info(`[coatShadow] caster extruded by the measured coat field: ` +
      `${r.meanMm.toFixed(1)} mm mean, ${r.maxMm.toFixed(1)} mm max over ` +
      `${r.vertices} verts · skin bbox ${(r.skinWidth * 1000).toFixed(0)} mm ` +
      `wide -> coat hull ${(r.coatWidth * 1000).toFixed(0)} mm ` +
      `(${(r.coatWidth / Math.max(r.skinWidth, 1e-6)).toFixed(2)}x)`);
    ctx.coatShadow = this;
  }

  _fail(reason) {
    this.report = { ok: false, reason };
    console.error(`[coatShadow] ${reason}`);
    this.ctx.coatShadow = this;
  }

  /**
   * Install or remove the depth material. This is the honest cost A/B: with it
   * removed three falls back to its own shared MeshDepthMaterial and the
   * shadow pass runs exactly the work it ran before this system existed.
   * `setScale(0)` is the SILHOUETTE A/B and keeps the same program.
   */
  setInstalled(on) {
    if (!this.material || !this.mesh) return false;
    this.mesh.customDepthMaterial = on ? this.material : undefined;
    this.installed = !!on;
    return this.installed;
  }

  /** 0 reproduces the skin-only caster; 1 is the full measured coat. */
  setScale(s) {
    this.scale = s;
    if (this.uCoatShadow) this.uCoatShadow.value = s;
    return s;
  }

  /**
   * What the extrusion actually is, measured off the same attributes and
   * uniforms the shader reads, plus the bind-space bounding box of the skin
   * and of the extruded hull. Reported in the console at boot and readable
   * from the harness, so the number in the report is the number the GPU used.
   *
   * Bind space, not world: the skin matrix is common to both boxes, so the
   * ratio is the thing this measures and it does not move with the pose.
   */
  measure() {
    const g = this.mesh?.geometry;
    const fu = this.ctx.fur?.uniforms;
    if (!g || !fu) return { ok: false, reason: 'geometry or fur uniforms gone' };
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const fl = g.getAttribute('furLength');
    const rg = g.getAttribute('region');
    const st = g.getAttribute('furStiffness');
    const tn = g.getAttribute('furTangent');
    if (!pos || !nrm || !fl || !rg || !st || !tn) {
      return { ok: false, reason: 'an attribute the shader reads is missing' };
    }
    const ra = fu.uRegionA.value;
    const cs = fu.uCoatScale.value;
    const lay0 = fu.uLay.value;
    const crush = Math.min(1.30, Math.max(0.62,
      1 - fu.uCoatCompress.value * fu.uCoatSquash.value));

    let min = Infinity, max = 0, sum = 0;
    const sLo = [Infinity, Infinity, Infinity], sHi = [-Infinity, -Infinity, -Infinity];
    const cLo = [Infinity, Infinity, Infinity], cHi = [-Infinity, -Infinity, -Infinity];
    const n = pos.count;
    for (let v = 0; v < n; v++) {
      const i = Math.min(REGION_COUNT - 1, Math.max(0, Math.round(rg.getX(v))));
      const r = ra[i];
      const L = fl.getX(v) * cs * (r.y || 1) * crush * this.scale;
      if (L < min) min = L;
      if (L > max) max = L;
      sum += L;
      const lay = lay0 * (r.z || 1) * (0.30 + 1.05 * (1 - st.getX(v)));
      const p = [pos.getX(v), pos.getY(v), pos.getZ(v)];
      const nn = [nrm.getX(v), nrm.getY(v), nrm.getZ(v)];
      const nl = Math.hypot(nn[0], nn[1], nn[2]) || 1;
      const t = [tn.getX(v), tn.getY(v), tn.getZ(v)];
      for (let k = 0; k < 3; k++) {
        if (p[k] < sLo[k]) sLo[k] = p[k];
        if (p[k] > sHi[k]) sHi[k] = p[k];
        const q = p[k] + (nn[k] / nl) * L + t[k] * (L * lay);
        if (q < cLo[k]) cLo[k] = q;
        if (q > cHi[k]) cHi[k] = q;
      }
    }
    return {
      ok: true, vertices: n, installed: this.installed, scale: this.scale,
      minMm: min * 1000, meanMm: (sum / n) * 1000, maxMm: max * 1000,
      skinWidth: sHi[0] - sLo[0], coatWidth: cHi[0] - cLo[0],
      skinHeight: sHi[1] - sLo[1], coatHeight: cHi[1] - cLo[1],
      skinDepth: sHi[2] - sLo[2], coatDepth: cHi[2] - cLo[2],
    };
  }

  dispose() {
    if (this.mesh) this.mesh.customDepthMaterial = undefined;
    this.material?.dispose();
  }
}
