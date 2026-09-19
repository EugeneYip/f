// OWNER: terrain agent.
//
// The snow BRDF, assembled as a three.js ShaderMaterial that is wired into the
// standard light/shadow/fog/tonemap plumbing (`lights: true` + the shadowmap,
// fog and tonemapping chunks) so it sits in the same colour pipeline as every
// other material in the scene — but replaces the whole reflectance model:
//
//   * high-albedo multiple-scattering diffuse with a wide wrap
//   * sky-dominated shadow term, deliberately BLUE
//   * forward subsurface scattering through drift crests
//   * discrete, world-locked crystal glints
//   * wind-packing dependent GGX sheen + grazing fresnel
//   * aerial perspective through the scene's own fog

import * as THREE from 'three';
import { rng } from '../util/math.js';

const _clear = new THREE.Color();
import {
  SNOW, SNOW_VERT, SNOW_FRAG, DETAIL_BAKE_FRAG, PROBE_FRAG,
  FULLSCREEN_VERT, snowResolve, snowConstsGLSL,
} from '../shaders/snow.glsl.js';

/**
 * 256x256 RGBA8 gradient table. RG is a quantised unit gradient, BA are spare
 * hashes. The SAME bytes drive the GPU noise and the JS port, which is what
 * keeps `heightAt()` on the surface the vertex shader actually built.
 */
export function makePermTable(seed = 20260918) {
  const T = SNOW.TABLE;
  const data = new Uint8Array(T * T * 4);
  const rand = rng(seed);
  for (let i = 0; i < T * T; i++) {
    const a = rand() * Math.PI * 2;
    data[i * 4 + 0] = Math.round((Math.cos(a) * 0.5 + 0.5) * 255);
    data[i * 4 + 1] = Math.round((Math.sin(a) * 0.5 + 0.5) * 255);
    data[i * 4 + 2] = Math.round(rand() * 255);
    data[i * 4 + 3] = Math.round(rand() * 255);
  }
  const tex = new THREE.DataTexture(data, T, T, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return { data, tex };
}

export class SnowMaterial {
  constructor(footUniforms) {
    this.footUniforms = footUniforms;
  }

  init(ctx, perm) {
    this.perm = perm;
    const q = ctx.quality;

    // --- uniforms shared with the probe pass (same objects, never copies) ---
    this.field = {
      uPerm: { value: perm.tex },
      uWindXZ: { value: new THREE.Vector2(1, 0) },
      uPadCenter: { value: new THREE.Vector2(0, 0) },
      uHeightBias: { value: 0 },
      uFoot: this.footUniforms.uFoot,
      uFootOrigin: this.footUniforms.uFootOrigin,
    };

    this.detail = this._bakeDetail(ctx);

    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.lights,
      THREE.UniformsLib.fog,
      {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uSunInt: { value: 6.0 },
        uSkyColor: { value: new THREE.Color(1, 1, 1) },
        uSkyInt: { value: 0.86 },
        uShadowEmpty: { value: 0.02 },
        uBounce: { value: new THREE.Color(1, 1, 1) },
        uBounceInt: { value: 0.13 },
        uAlbedo: { value: new THREE.Color(0.90, 0.93, 0.965) },
        uDeepTint: { value: new THREE.Color(0.56, 0.72, 1.0) },
        uDetail: { value: null },
        uDetailScale: { value: new THREE.Vector4(0.055, 0.32, 1.55, 0.40) },
        uSparkle: { value: new THREE.Vector3(240.0, 1.36, 170.0) },
        uSheen: { value: new THREE.Vector3(0.74, 0.42, 0.38) },
        uSSS: { value: 1.7 },
        uAerial: { value: new THREE.Vector3(0.016, 0.62, 0.62) },
        uHaze: { value: new THREE.Color(0xaac4e0) },
        uSkirtDrop: { value: 60.0 },
        uDebugView: { value: 0 },
      },
    ]);
    // Share, do not clone, the field uniforms.
    for (const k of Object.keys(this.field)) uniforms[k] = this.field[k];
    uniforms.uDetail.value = this.detail;

    this.uniforms = uniforms;
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: snowResolve(SNOW_VERT),
      fragmentShader: snowResolve(SNOW_FRAG),
      lights: true,
      fog: true,
      defines: { SUN_TAPS: this._sunTaps(q), SPARKLE_OCT: this._sparkleOct(q) },
    });
    this.material.name = 'snow';

    // --- CPU/GPU agreement probe -------------------------------------------
    this.probeRT = new THREE.WebGLRenderTarget(16, 16, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.probeMat = new THREE.RawShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: snowResolve(PROBE_FRAG),
      uniforms: {
        ...this.field,
        uProbe: { value: new THREE.Vector3(0, 0, 1.6) },
        uProbeFw: { value: 0 },
      },
      depthTest: false, depthWrite: false,
    });
    this._probeScene = new THREE.Scene();
    this._probeCam = new THREE.Camera();
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    tri.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
    this._probeMesh = new THREE.Mesh(tri, this.probeMat);
    this._probeMesh.frustumCulled = false;
    this._probeScene.add(this._probeMesh);
    this._probeBuf = new Uint8Array(16 * 16 * 4);

    return this.material;
  }

  _sparkleOct(q) {
    const seg = q.get('terrainSegments');
    return seg >= 384 ? 4 : seg >= 256 ? 3 : 2;
  }

  _sunTaps(q) {
    const seg = q.get('terrainSegments');
    return seg >= 384 ? 4 : seg >= 256 ? 3 : 2;
  }

  /**
   * Bake the tileable micro-detail map: grain normals, crystal density and a
   * grain AO. Generated on the GPU at init — no assets, no main-thread stall.
   */
  _bakeDetail(ctx) {
    const N = 512;
    const rt = new THREE.WebGLRenderTarget(N, N, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: true,
    });
    rt.texture.anisotropy = Math.min(4, ctx.renderer.capabilities.getMaxAnisotropy());

    const mat = new THREE.RawShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: DETAIL_BAKE_FRAG.replace('SNOW_CONSTS', snowConstsGLSL()),
      uniforms: {
        uPerm: { value: this.perm.tex },
        uPeriod: { value: 16.0 },
      },
      depthTest: false, depthWrite: false,
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);

    const prev = ctx.renderer.getRenderTarget();
    ctx.renderer.setRenderTarget(rt);
    ctx.renderer.render(scene, new THREE.Camera());
    ctx.renderer.setRenderTarget(prev);

    geo.dispose();
    mat.dispose();
    this._detailRT = rt;
    return rt.texture;
  }

  /** Push the frame's art-direction state. */
  update(ctx) {
    const u = this.uniforms;
    u.uSunDir.value.copy(ctx.sunDirection).normalize();
    u.uSunColor.value.copy(ctx.sunColor);
    u.uSkyColor.value.copy(ctx.skyColor);
    u.uBounce.value.copy(ctx.groundBounce);
    // Track whatever haze the atmosphere agent is using, so the snow recedes
    // into the same colour the sky does.
    if (ctx.scene.fog?.color) u.uHaze.value.copy(ctx.scene.fog.color);
    // three clears the shadow map with whatever clear colour the app has set,
    // so track it and treat texels at that value as "nothing ever rendered".
    ctx.renderer.getClearColor(_clear);
    u.uShadowEmpty.value = Math.min(0.25, _clear.r * 1.6 + 0.02);
    const w = ctx.wind;
    const wl = Math.hypot(w.x, w.z) || 1;
    this.field.uWindXZ.value.set(w.x / wl, w.z / wl);
  }

  onQuality(ctx) {
    const taps = this._sunTaps(ctx.quality);
    const oct = this._sparkleOct(ctx.quality);
    if (this.material.defines.SUN_TAPS !== taps || this.material.defines.SPARKLE_OCT !== oct) {
      this.material.defines.SUN_TAPS = taps;
      this.material.defines.SPARKLE_OCT = oct;
      this.material.needsUpdate = true;
    }
  }

  /**
   * Render the height field on a grid and read it back so JS can check its own
   * port against the shader. Returns a Float32Array of 16x16 heights, or null.
   */
  readProbe(ctx, cx, cz, half, fw) {
    const u = this.probeMat.uniforms;
    u.uProbe.value.set(cx, cz, half);
    u.uProbeFw.value = fw;
    const r = ctx.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.probeRT);
    r.render(this._probeScene, this._probeCam);
    r.readRenderTargetPixels(this.probeRT, 0, 0, 16, 16, this._probeBuf);
    r.setRenderTarget(prev);

    const out = new Float32Array(256);
    const b = this._probeBuf;
    for (let i = 0; i < 256; i++) {
      const v = b[i * 4] / 255 + b[i * 4 + 1] / 65025 +
                b[i * 4 + 2] / 16581375 + b[i * 4 + 3] / 4228250625;
      out[i] = v * 8.0 - 4.0;
    }
    return out;
  }

  dispose() {
    this.material?.dispose();
    this.probeMat?.dispose();
    this.probeRT?.dispose();
    this._detailRT?.dispose();
    this.perm?.tex?.dispose();
  }
}
