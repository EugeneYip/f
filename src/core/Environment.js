import * as THREE from 'three';

/**
 * Lighting backbone. Owns the sun, the sky fill, the snow bounce and the
 * shadow camera. Systems that need light data read it off `ctx` (sunDirection,
 * sunColor, …) rather than digging into this object.
 *
 * Art bible §3: warm low sun + cool sky fill + bright upward snow bounce.
 * That three-way split is what makes white fur read as white-in-cold-light
 * instead of grey.
 */
export class Environment {
  name = 'environment';
  order = -100; // before anything that wants to read light state

  init(ctx) {
    this.ctx = ctx;
    const { scene } = ctx;

    scene.background = null;
    // Aerial perspective. Distance target from the bible (#aac4e0).
    scene.fog = new THREE.FogExp2(0x9fbcdc, 0.0125);

    // --- sun ---------------------------------------------------------------
    //
    // THE PENUMBRA IS NOT SET HERE, AND CANNOT BE.
    //
    // shadow.radius is a fixed box blur of the shadow map in TEXELS, so it is
    // the same width under the paw as it is at the far tip of a shadow the
    // grazing sun has thrown 4.5 m downsun. Real penumbrae widen with distance
    // from the caster -- the sun subtends 0.5334 degrees, which is 9.31 mm of
    // penumbra per metre -- and no single number here can do that.
    //
    // Nor does this number buy the fixed penumbra it looks like it buys. three
    // blurs the VSM moments with a BOX and then Chebyshev-remaps them, and the
    // remap reads partial coverage as high variance and high variance as LIT,
    // so the drawn transition happens entirely between 72% and 90% coverage.
    // Measured on the snow in a plan view at 325.62 px/m with the per-fragment
    // filter disabled, the lateral 0.92 -> 0.08 ramp is 7.25 mm at a caster
    // distance of 0.25 m and 7.93 mm at 4.25 m -- flat, and sitting on the
    // probe's own hard-edge floor of 7.25 mm at both ends. Raising radius
    // widens the band the blur ERODES off the silhouette, not the penumbra.
    //
    // The distance-dependent penumbra therefore lives on the receiver, in
    // snShadowMask() in src/shaders/snow.glsl.js, where the filter radius can
    // be sized per fragment. The RADIUS stays where the shadow agent
    // calibrated it: it sets how much of the alpha-tested guard-hair fringe
    // survives into the shadow map and how much the silhouette is eroded, and
    // both were measured against shadow AREA and an edge probe. Do not retune
    // it for softness -- softness is not what it controls.
    //
    // blurSamples is a different quantity and was NOT calibrated: see
    // _blurSamples() below.
    this.sun = new THREE.DirectionalLight(ctx.sunColor.clone(), ctx.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.022;
    this.sun.shadow.radius = 4.5;
    scene.add(this.sun);
    this.sunTarget = new THREE.Object3D();
    scene.add(this.sunTarget);
    this.sun.target = this.sunTarget;

    // --- sky fill (cool, from above) --------------------------------------
    // The sky system generates a real PMREM environment map, which already
    // carries sky ambient with correct directionality. A full-strength
    // hemisphere light on top of that double-counts it -- the sky agent had to
    // set scene.environmentIntensity = 0.6 to compensate. So keep only a token
    // hemisphere as a floor for the moments before the IBL exists (and for the
    // low tier, where the env map is tiny), and let the IBL carry ambient at
    // full strength. _balanceAmbient() below owns this trade.
    this.hemi = new THREE.HemisphereLight(ctx.skyColor.clone(), ctx.groundBounce.clone(), 1.25);
    scene.add(this.hemi);

    // --- snow bounce (warm-cool, from below/front) ------------------------
    // A real snowfield throws a LOT of light back up. Without this the belly,
    // jaw and tail underside go dead and the fox reads as pasted-on.
    this.bounce = new THREE.DirectionalLight(ctx.groundBounce.clone(), 0.85);
    this.bounce.position.set(0.5, -1, 0.6);
    this.bounce.castShadow = false;
    scene.add(this.bounce);

    // --- a cool kicker opposite the sun, standing in for sky occlusion ----
    // Largely superseded by the IBL once that exists; see _balanceAmbient().
    this.rim = new THREE.DirectionalLight(new THREE.Color(0xa8c8f0), 0.55);
    this.rim.castShadow = false;
    scene.add(this.rim);

    this.applyQuality(ctx);
    this._placeLights(ctx);
    ctx.environment = this;
  }

  applyQuality(ctx) {
    const size = ctx.quality.get('shadowMapSize');
    this.sun.shadow.mapSize.set(size, size);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    // `softShadow` no longer means soft: see the note at the light. It selects
    // how hard the caster's own silhouette is eroded, and the snow's penumbra
    // is unaffected by it. SnowMaterial._penTaps keys the receiver-side filter
    // off shadowMapSize instead, because THAT is what sets how many texels a
    // 42 mm penumbra spans.
    this.sun.shadow.radius = ctx.quality.get('softShadow') ? 4.5 : 1;
    this.sun.shadow.blurSamples = Environment._blurSamples(this.sun.shadow.radius);
  }

  /**
   * TAP COUNT OF THE VSM PRE-BLUR. NOT A LOOK KNOB -- A SAMPLING RATE.
   *
   * `radius` sets the blur's WIDTH; `blurSamples` sets how densely that fixed
   * width is sampled. three spreads `n` taps evenly over [-radius, +radius]
   * texels, so the stride is 2 * radius / (n - 1), and the VSM target is
   * created with the default LinearFilter -- every tap is bilinear and
   * therefore already covers a full texel. A stride of 1.0 texel is exactly
   * continuous coverage; anything finer is resampling the same texels twice.
   *
   *     n = 2 * radius + 1   ->   stride 1.0
   *
   * At radius 4.5 that is 10. We were paying 16, a 0.60-texel stride, i.e.
   * 1.67x oversampled -- and the blur is two FULL passes over the whole
   * shadow map, so those six extra taps were 38 M texel fetches per frame
   * each at `high`.
   *
   * MEASURED, both halves.
   *
   * Cost, one page session at `high`/`hero`, 40 frames per arm behind a
   * readPixels drain, arms swept 1..128 in one quiet window (frame time at
   * n=16 read 15.98 ms against the orchestrator's 15.92 ms idle, so this
   * window was uncontended):
   *
   *     n     1      2      4      6      8     10     12     16     32     64    128
   *     ms  14.45  14.48  14.35  14.58  14.94  14.99  15.23  15.98  19.16  26.57  41.49
   *
   * Linear from n=6 up at 0.20-0.23 ms per tap, flat below n=4 where the two
   * full-screen passes' own fill dominates. 16 -> 10 is 0.99 ms; the whole
   * tap cost above the floor is only 1.5 ms, so there is no 3 ms here.
   * Error bar +-0.15 ms, from the 1/2/4 plateau's own spread.
   *
   * Fidelity, read straight out of sun.shadow.map and decoded back to three's
   * packed (mean, stddev) moments, referenced to n=64 (a 0.14-texel stride,
   * i.e. the converged box), over the caster's own bounding rect. Time is NOT
   * advanced between arms -- an earlier version stepped 10 frames per arm and
   * its same-arm control read rms 1.5e-2 with 1388 boundary flips, all of it
   * idle-life animation. With no time advance identical arms are bit
   * identical, which is what makes the rest of the row meaningful:
   *
   *     n      rms(mean)   max(mean)   silhouette area   boundary wiggle L/R
   *     16      1.89e-3     2.08e-2         1.00011           0.099 / 0.085
   *     12      2.74e-3     2.98e-2         1.00204           0.121 / 0.085
   *     10      3.61e-3     3.98e-2         1.00377           0.121 / 0.085
   *      8      4.55e-3     4.92e-2         1.00377           0.121 / 0.085
   *      4      1.12e-2     1.24e-1         1.00351           0.121 / 0.197
   *      1      4.70e-2     5.60e-1         0.91408           0.554 / 0.269
   *
   * The two things the brief protects both hold at 10. Silhouette AREA does
   * not fall -- it rises 0.4%, and the CoatShadow sweep that chose
   * `uHullFrac` 0.90 was scored on area not falling. Boundary wiggle, the
   * per-row high-passed silhouette position that is the fringe stipple
   * surviving into the map, does not fall either: 0.099 -> 0.121 and 0.085 ->
   * 0.085. A coarser sampling of a fixed-width box passes slightly MORE high
   * frequency, not less, so cutting taps cannot erase the fringe -- only
   * cutting `radius` could, and that is untouched.
   *
   * n=1 is where it actually breaks, and it breaks the way the theory says:
   * area collapses to 0.914 (the blur stops eroding the silhouette at all)
   * and the stddev channel goes to zero everywhere, so Chebyshev has no
   * variance to work with.
   */
  static _blurSamples(radius) {
    return Math.max(2, Math.round(2 * radius) + 1);
  }

  onQuality(e, ctx) { if (e.type === 'tier') this.applyQuality(ctx); }

  /** Shadow frustum follows the subject so we spend every texel on the fox. */
  _placeLights(ctx) {
    const d = ctx.sunDirection;
    const focus = ctx.subjectPosition ?? new THREE.Vector3(0, 0.25, 0);

    this.sunTarget.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(d, 22);

    // Frustum around the animal, WITH ENOUGH DEPTH TO HOLD ITS OWN SHADOW.
    //
    // `near 18 / far 27.5` at a light distance of 22 gives 5.5 m of depth
    // behind the subject, which is ample at a high sun and nowhere near
    // enough at a low one: a 0.45 m animal at 2 degrees of elevation casts
    // **12.9 m** of shadow, so 57% of it fell outside the far plane and
    // simply stopped. The lighting agent measured the clip and traced it
    // here. §2 makes a look that only works at one sun angle a fluke, and a
    // shadow that is correct at 14 degrees and truncated at 2 is exactly
    // that.
    //
    // Depth is now derived from the geometry that produces it: the shadow of
    // a body `H` tall at elevation `e` runs `H / tan(e)` along the ground,
    // and the far plane has to clear the light-space depth of its far end.
    // Clamped because tan() runs away below the horizon, and because a
    // needlessly deep frustum spends depth precision it does not get back.
    const cam = this.sun.shadow.camera;
    const half = 1.55;
    cam.left = -half; cam.right = half;
    cam.top = half; cam.bottom = -half;
    const elev = Math.max(Math.asin(Math.max(d.y, 1e-3)), 0.5 * Math.PI / 180);
    const H = 0.45;                               // animal height, metres
    const reach = Math.min(H / Math.tan(elev), 26);
    cam.near = 18;
    cam.far = 22 + Math.max(5.5, reach * Math.cos(elev) + 1.0);
    cam.updateProjectionMatrix();

    this.rim.position.copy(focus).add(new THREE.Vector3(-d.x, 0.55, -d.z).multiplyScalar(10));
    this.rim.target = this.sunTarget;
    this.bounce.position.copy(focus).add(new THREE.Vector3(d.x * 0.3, -1, d.z * 0.3).multiplyScalar(8));
    this.bounce.target = this.sunTarget;
  }

  /**
   * Hand ambient over to the image-based lighting once it exists.
   *
   * The snow bounce stays at full strength regardless: the sky system renders
   * a SKY-ONLY scene into the PMREM, so the environment map contains no
   * upward light off the snowfield at all -- and on a real snowfield that
   * bounce is most of what fills the belly, jaw and tail underside.
   */
  _balanceAmbient(ctx) {
    const hasIBL = !!ctx.scene.environment;
    if (hasIBL === this._iblApplied) return;
    this._iblApplied = hasIBL;

    if (hasIBL) {
      // Set at the postfx agent's request, with their reasoning: the animal's
      // key-to-fill ratio was under ~2 stops -- its lit and shade sides
      // measured within a level or two of each other -- and a grade can set
      // the black point and the shoulder but cannot put back separation that
      // was never rendered. Lowering ambient is the correct fix; lifting
      // contrast in the grade would only stretch noise.
      ctx.scene.environmentIntensity = 0.70;
      this.hemi.intensity = 0.10;   // floor only; the IBL does the real work
      this.rim.intensity = 0.22;    // IBL already wraps light round the far side
    } else {
      this.hemi.intensity = 1.25;
      this.rim.intensity = 0.55;
    }
  }

  update(dt, ctx) {
    this._balanceAmbient(ctx);
    // Keep the sun's colour/intensity authoritative on ctx so a UI slider or
    // the debug API can drive the whole scene from one place.
    this.sun.color.copy(ctx.sunColor);
    this.sun.intensity = ctx.sunIntensity;
    this.hemi.color.copy(ctx.skyColor);
    this.hemi.groundColor.copy(ctx.groundBounce);

    if (ctx.sunDirty || ctx.frame < 3 || ctx.frame % 6 === 0) {
      this._placeLights(ctx);
      ctx.sunDirty = false;
    }
    ctx.renderer.toneMappingExposure = ctx.exposure;
  }

  dispose() {
    this.sun.shadow.map?.dispose();
  }
}
