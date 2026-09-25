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
    // be sized per fragment. 4.5 / 16 stay as the shadow agent calibrated
    // them: they set how much of the alpha-tested guard-hair fringe survives
    // into the shadow map and how much the silhouette is eroded, and both were
    // measured against shadow AREA and an edge probe. Do not retune them for
    // softness -- softness is not what they control.
    this.sun = new THREE.DirectionalLight(ctx.sunColor.clone(), ctx.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.022;
    this.sun.shadow.radius = 4.5;
    this.sun.shadow.blurSamples = 16;
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
