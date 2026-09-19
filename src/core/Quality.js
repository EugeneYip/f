import { clamp } from '../util/math.js';

/**
 * Quality tiers. Systems read `ctx.quality.get('someKey')` rather than
 * branching on a tier name, so a new tier only touches this file.
 */
export const TIERS = {
  low: {
    label: 'Low',
    dpr: 1.0, maxDpr: 1.0,
    shadowMapSize: 1024, shadowCascades: 1, softShadow: false,
    furShells: 6, furFins: false, furAniso: false,
    terrainSegments: 160, terrainRadius: 90,
    snowParticles: 1500, snowLayers: 1,
    // TAA on at low, SMAA off. SMAA cannot resolve the fur's stochastic
    // dither -- the coat degraded to television static (review blocker 13).
    // TAA costs more than SMAA, but a broken image is not a cheaper image.
    ao: false, bloom: true, dof: false, godRays: false, taa: true, smaa: false,
    aurora: true, auroraSteps: 6,
    breath: true, footprints: true, footprintRes: 512,
    envMapSize: 64, grassTufts: 0,
  },
  medium: {
    label: 'Medium',
    dpr: 1.0, maxDpr: 1.5,
    shadowMapSize: 2048, shadowCascades: 2, softShadow: true,
    furShells: 11, furFins: true, furAniso: true,
    terrainSegments: 256, terrainRadius: 130,
    snowParticles: 5000, snowLayers: 2,
    ao: true, bloom: true, dof: true, godRays: false, taa: true, smaa: false,
    aurora: true, auroraSteps: 10,
    breath: true, footprints: true, footprintRes: 1024,
    envMapSize: 128, grassTufts: 400,
  },
  high: {
    label: 'High',
    dpr: 1.0, maxDpr: 2.0,
    shadowMapSize: 3072, shadowCascades: 3, softShadow: true,
    furShells: 18, furFins: true, furAniso: true,
    terrainSegments: 384, terrainRadius: 190,
    snowParticles: 12000, snowLayers: 3,
    ao: true, bloom: true, dof: true, godRays: true, taa: true, smaa: false,
    aurora: true, auroraSteps: 16,
    breath: true, footprints: true, footprintRes: 2048,
    envMapSize: 256, grassTufts: 1200,
  },
  ultra: {
    label: 'Ultra',
    dpr: 1.0, maxDpr: 2.0,
    shadowMapSize: 4096, shadowCascades: 3, softShadow: true,
    furShells: 26, furFins: true, furAniso: true,
    terrainSegments: 512, terrainRadius: 240,
    snowParticles: 20000, snowLayers: 3,
    ao: true, bloom: true, dof: true, godRays: true, taa: true, smaa: false,
    aurora: true, auroraSteps: 24,
    breath: true, footprints: true, footprintRes: 2048,
    envMapSize: 256, grassTufts: 2000,
  },
};

export class Quality {
  constructor(tier = 'high') {
    this.tier = TIERS[tier] ? tier : 'high';
    this.overrides = {};
    this._listeners = new Set();

    // Adaptive resolution state.
    this.renderScale = 1;
    this._targetFrameMs = 1000 / 60;
    this._emaFrameMs = this._targetFrameMs;
    this._cooldown = 0;
    this.adaptive = true;
  }

  get params() { return TIERS[this.tier]; }

  get(key) {
    return key in this.overrides ? this.overrides[key] : TIERS[this.tier][key];
  }

  set(key, value) {
    this.overrides[key] = value;
    this._emit({ type: 'override', key, value });
  }

  setTier(tier) {
    if (!TIERS[tier] || tier === this.tier) return;
    this.tier = tier;
    this.overrides = {};
    this.renderScale = 1;
    this._emit({ type: 'tier', tier });
  }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit(e) { for (const fn of this._listeners) fn(e, this); }

  /** Detect a sensible starting tier from the GPU string and device hints. */
  static detect(renderer) {
    let tier = 'medium';
    try {
      const gl = renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
      const g = gpu.toLowerCase();
      const cores = navigator.hardwareConcurrency || 4;
      const mobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent) ||
                     (navigator.maxTouchPoints > 1 && /mac/i.test(navigator.platform) &&
                      !matchMedia('(pointer:fine)').matches);

      if (/swiftshader|software|basic render|llvmpipe/.test(g)) tier = 'low';
      else if (mobile) tier = /apple a1[5-9]|apple m/.test(g) ? 'medium' : 'low';
      else if (/apple m[1-9]/.test(g)) tier = /max|ultra|pro/.test(g) ? 'ultra' : 'high';
      else if (/rtx ?[34-9]0[7-9]|rtx ?[45]0[6-9]|radeon rx ?[67-9]\d00/.test(g)) tier = 'ultra';
      else if (/nvidia|geforce|radeon|rtx|arc/.test(g)) tier = 'high';
      else if (/intel/.test(g)) tier = cores >= 8 ? 'medium' : 'low';
      else tier = cores >= 8 ? 'high' : 'medium';

      const mem = navigator.deviceMemory || 8;
      if (mem <= 4 && tier === 'ultra') tier = 'high';
    } catch { /* fall through to medium */ }
    return tier;
  }

  /** Call once per frame with the measured CPU+GPU frame time. */
  tickAdaptive(frameMs, dt) {
    if (!this.adaptive) return this.renderScale;
    // Ignore hitches (tab switches, GC, shader compiles).
    if (frameMs > 200) return this.renderScale;
    this._emaFrameMs += (frameMs - this._emaFrameMs) * 0.06;
    this._cooldown -= dt;
    if (this._cooldown > 0) return this.renderScale;

    const budget = this._targetFrameMs;
    const prev = this.renderScale;
    if (this._emaFrameMs > budget * 1.25) {
      this.renderScale = clamp(this.renderScale - 0.08, 0.6, 1);
      this._cooldown = 0.7;
    } else if (this._emaFrameMs < budget * 0.78 && this.renderScale < 1) {
      this.renderScale = clamp(this.renderScale + 0.04, 0.6, 1);
      this._cooldown = 1.1;
    }
    if (this.renderScale !== prev) this._emit({ type: 'renderScale', value: this.renderScale });
    return this.renderScale;
  }

  get avgFrameMs() { return this._emaFrameMs; }
  get fps() { return 1000 / Math.max(this._emaFrameMs, 1e-3); }
}
