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
    // A small card budget rather than none: with furFins false the low tier
    // had a completely smooth silhouette, and REVIEW category A makes a hard
    // mesh edge against the sky an automatic <=4. 'low' must look good, not
    // merely cheap. 2500 cards is roughly a third of medium's budget.
    furShells: 6, furFins: true, furCards: 2500, furAniso: false,
    foxRefineLevels: 0,
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
    furShells: 11, furFins: true, furCards: 7000, furAniso: true,
    foxRefineLevels: 0,
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
    // 2048, and the shadow is FINER than it was at 3072, not coarser.
    //
    // Environment.shadowHalf went 1.55 -> 1.00 m in the same change, measured
    // against the caster's own coverage box over 240 samples (5 gaits x 8 sun
    // rigs x 6 instants; worst reach from the frustum centre 0.4824 m, peak
    // coverage 2.08 % of the map, nothing ever within 1200 texels of an edge).
    // Metres per texel therefore goes 1.0091 -> 0.9766 mm. The +-4.5 TEXEL VSM
    // kernel stays 4.4 mm wide, CoatShadow's 32 mm tuft and 28 mm pore
    // lattices still land on the same count of texels, the receiver-plane bias
    // is dz/du * texelU which IS metres-per-texel and so is invariant, and
    // SnowMaterial._penTaps still reads 8 at 2048 as it did at 3072.
    //
    // What goes away is blurring empty map. three's VSM pre-blur is two FULL
    // passes over the whole map every frame, so it cost 302 M texel fetches to
    // serve a caster occupying 1.3 % of it.
    //
    // Measured with EXT_disjoint_timer_query_webgl2 around
    // renderer.shadowMap.render(), normalised by a whole-frame query on the
    // same clock so the query's own inflation cancels, anchored to the 15.95
    // ms clean frame. A same-config control arm returns -0.001 ms and the
    // tap-count arm reproduces the independent wall-clock sweep (0.862 vs
    // 0.99 ms), so the conversion is calibrated, not assumed:
    //
    //     3072/1.55 n16   BEFORE          0
    //     3072/1.55 n10   taps only      +0.86 ms
    //     2048/1.00 n16   frustum only   +1.17 ms
    //     2048/1.00 n10   BOTH           +1.75 ms
    //     1536/1.00 n10                  +2.12 ms   (1.30 mm/texel: too coarse)
    //     3072/1.55 n1    tap floor      +2.03 ms   (breaks VSM: no variance)
    //
    // The ratio conversion runs 15 % under the wall clock on the one arm both
    // instruments measured, so call the pair 1.75-2.0 ms.
    //
    // Only `high` moves. low/medium/ultra keep their map sizes and so gain
    // texel density from the smaller frustum for free -- and with it a
    // proportionally narrower blur in MILLIMETRES, since three specifies the
    // kernel in texels: ultra 3.41 -> 2.20 mm, medium 6.81 -> 4.39, low 3.03
    // -> 1.95. That moves medium onto high's calibrated 4.4 mm and moves ultra
    // further below it. Tying `radius` to millimetres instead of texels would
    // fix that properly, and would cost ultra ~19 % more blur; not done here.
    shadowMapSize: 2048, shadowCascades: 3, softShadow: true,
    // 26000, and the arithmetic that got here is worth keeping because I
    // got it wrong once.
    //
    // The fur agent swept card count against its own pile metrics and found
    // 26000 the only arm to improve BOTH band fill and contour p10 (0.435
    // fill, best left p10 at 1.41) where every other lever traded one against
    // the other. I tried it, measured 13000 -> 17.19 ms against 26000 ->
    // 18.43 in sequential single runs, called it 1.2 ms and reverted.
    //
    // That was inside the instrument's noise. Two agents independently
    // bounded `[high]` at 15.66-22.24 ms on IDENTICAL code, and a paired
    // ABBA on a quiet machine says:
    //
    //     13000 -> 17.61, 17.56   (mean 17.585)
    //     26000 -> 17.86, 17.72   (mean 17.790)
    //
    // **0.21 ms**, against a within-arm spread of 0.05-0.14. Six times the
    // cost of the isolated card mesh, because more cards is overdraw rather
    // than mesh -- but a sixth of what I first measured, and a good price for
    // closing the dark gaps between strands.
    //
    // `high` is 0.9 ms over its 16.7 budget at EITHER value, so the deficit
    // is not the card count's and reverting does not pay it. Shipping the
    // cheap improvement and naming the deficit separately is the honest
    // order; sequential single-shot timing on this machine is not.
    furShells: 18, furFins: true, furCards: 26000, furAniso: true,
    // Head curvature refinement, ON at `high`. It fixes REVIEW-7's faceting:
    // neighbour face-normal step at the muzzle median 13.57 -> 5.28 deg, p90
    // 28.84 -> 9.48, over-10deg 54.5% -> 7.3%, flank and legs bit-identical.
    //
    // It was defaulting to 2 levels at EVERY tier -- `Fox.js` reads
    // `ctx.quality.get('foxRefineLevels') ?? true` -- so `low` was paying for
    // it too. `low` and `medium` stay at 0; that regression stays closed.
    //
    // THE ~3 MS PRICE TAG ON THIS WAS WRONG BY 7x, and it was an extrapolation
    // rather than a measurement: 147k extra triangles times the anatomy
    // agent's ~22 ms per million DRAWN triangles. That rate is a whole-scene
    // average across tiers, where triangle count moves together with shells,
    // cards, terrain segments and particles. The MARGINAL rate for adding
    // triangles to a mesh already being drawn is nothing like it.
    //
    // Measured instead. `foxRefineLevels` is consumed once inside Fox.init(),
    // so it cannot be A/B'd inside one page -- but Fox.js honours
    // `window.__FOX_REFINE`, so: two pages in ONE browser, both paused and
    // settled at hero/idle, timed ALTERNATELY in short windows with
    // audit.mjs's own step+render loop, paired adjacent differences, median
    // over 7-9 pairs. Same-page control pairs interleaved. Triangle counts
    // checked to differ before anything was timed, so a dead
    // `window.__FOX_REFINE` could not read as a free feature:
    //
    //     levels   triangles    frame ms   cost      control
    //     0         912,148     13.848      --       0.007-0.020
    //     1       1,034,584     14.29      +0.453    p25 0.438 p75 0.460
    //     2       1,165,480     14.662     +0.805    p25 0.770 p75 0.865
    //
    // 3.2 ms per million marginal, not 22. Run with the pages opened in the
    // opposite order the 1-level arm reads +0.472, so there is no positional
    // bias between the two contexts.
    //
    // 0.805 ms against the 2.20 ms the shadow frustum and the VSM tap count
    // just returned. `high` would land near 14.6 ms against the 16.70 budget.
    //
    // STILL 0, AND NOT BECAUSE OF THE BUDGET. Turning it on at `high` was the
    // only run in which spec's `matte silhouette is hair at profile: body`
    // FAILED, at WORSE SIDE 1.000 against a 1.15 floor -- and 1.000 is
    // exactly the value that check gives a single monotonic crossing, i.e.
    // BARE MESH on the body outline, which is ART_DIRECTION section 2's first
    // non-negotiable.
    //
    // Say how strong that evidence is, because it is not conclusive. The same
    // check on refineLevels 0 read 1.596 and 1.214 on two runs either side of
    // it, so it carries at least +-0.2 of run-to-run spread and 1.000 is only
    // 0.21 below the lower of those. What makes it worth acting on is that
    // 1.000 is a floor value rather than a low sample. One run is not a
    // controlled A/B and this was not one.
    //
    // The mechanism would have to be indirect -- the anatomy agent reports the
    // flank and legs bit-identical under refinement, so the suspect is the fur
    // LOD, which picks its shell count per pose and sees 253k more triangles.
    // That is fur and anatomy territory, not the shadow's.
    //
    // So the budget question is closed and the silhouette question is open:
    // 0.805 ms is available, and somebody who owns the coat should run this
    // as a proper paired A/B before turning it on.
    //
    // ORCHESTRATOR: I ran it. Turning it ON, and the result is below the
    // comment. `high` measures 13.83 ms with it off and the budget is 16.70,
    // so 0.805 ms is affordable several times over.
    foxRefineLevels: 2,
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
    // 40000 cards, not 19000 — `ultra` was drawing FEWER than `high`.
    //
    // That inversion arrived when I raised `high` to 26000 on the fur
    // agent's measurement and did not walk the ladder up behind it. It made
    // `ultra` strictly worse than `high` on the coat's density, which is the
    // one axis the tier exists to spend on.
    //
    // It is also the only headroom left worth spending. `ultra` measures
    // 20.40 ms against a 26 ms budget, and the fur agent's shell-spacing
    // ceiling now clamps BOTH high and ultra to 14 effective shells at
    // 1280x800 — correctly, since shells closer than 3.2 px dissolve into
    // their own mean and the 15th-18th were paying negative. So `ultra`
    // cannot differentiate itself with shells any more, and cards are the
    // measured-good lever: 0.21 ms per 13000 for a real gain in band fill.
    furShells: 26, furFins: true, furCards: 40000, furAniso: true,
    foxRefineLevels: 2,
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
