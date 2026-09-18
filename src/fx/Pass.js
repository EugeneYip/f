// OWNER: postfx. Minimal fullscreen-pass plumbing.
//
// We deliberately do NOT use EffectComposer: it owns a read/write ping-pong of
// two identically-sized buffers, and this chain needs half-res layers, a mip
// pyramid, a persistent TAA history and hand-ordered reads of the depth
// texture. Building on `FullScreenQuad` from the addons gives us the same
// fullscreen-triangle draw with none of the constraints.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { FX_VERT, FX_COMMON } from './glsl/common.js';

let _quad = null;
function quad() {
  if (_quad === null) _quad = new FullScreenQuad(null);
  return _quad;
}

/** One fullscreen shader pass. `u` is the live uniform object. */
export class FxPass {
  constructor(name, fragmentShader, uniforms = {}, defines = {}) {
    this.name = name;
    this.u = uniforms;
    this.material = new THREE.ShaderMaterial({
      name: `fx/${name}`,
      uniforms,
      defines,
      vertexShader: FX_VERT,
      fragmentShader: FX_COMMON + fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      // Critical: without this three would apply the renderer's AgX tonemap on
      // top of ours for any pass that draws straight to the canvas.
      toneMapped: false,
    });
  }

  /** Renders into `target` (null = canvas). `additive` blends instead of overwriting. */
  render(renderer, target = null) {
    const q = quad();
    q.material = this.material;
    renderer.setRenderTarget(target);
    q.render(renderer);
  }

  setAdditive(on) {
    this.material.blending = on ? THREE.AdditiveBlending : THREE.NoBlending;
    this.material.needsUpdate = true;
    return this;
  }

  dispose() { this.material.dispose(); }
}

/** Half-float colour target with sane post-processing defaults. */
export function makeRT(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: opts.type ?? THREE.HalfFloatType,
    format: opts.format ?? THREE.RGBAFormat,
    minFilter: opts.minFilter ?? THREE.LinearFilter,
    magFilter: opts.magFilter ?? THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: opts.depthBuffer === true,
    stencilBuffer: false,
    generateMipmaps: false,
    samples: opts.samples ?? 0,
  });
  rt.texture.name = `fx/${opts.name ?? 'rt'}`;
  return rt;
}

export function disposeRT(rt) {
  if (!rt) return;
  rt.depthTexture?.dispose?.();
  rt.dispose();
}

export function disposeQuad() {
  if (_quad) { _quad.dispose(); _quad = null; }
}
