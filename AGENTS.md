# Contributor contract

Read `ART_DIRECTION.md` first — it is the binding visual spec. This file is the
*engineering* contract.

## Golden rules

1. **Only edit files you own.** The ownership map is below. If a build error
   comes from a file you do not own, report it and keep working — do not "fix"
   someone else's file. We work in one shared checkout, concurrently.
2. **One manifest file per owner.** Register your systems by creating exactly
   `src/manifest/<NN>-<you>.js` exporting `systems = [YourSystem, …]`.
   Never edit `src/main.js`, `src/core/App.js`, `src/core/Debug.js`,
   `src/core/Quality.js` or `tools/shoot.mjs`.
3. **No new runtime dependencies.** `three` only. No CDN fetches, no asset
   downloads — every texture and mesh is generated in code. The build must work
   offline and the page must work on GitHub Pages from a relative base.
4. **Never break the review harness.** `node tools/shoot.mjs` must exit 0 with
   zero console errors before you declare done.
5. **Respect the quality tiers.** Read counts/flags from `ctx.quality.get(key)`;
   never hardcode a shell count or particle budget.
6. **Determinism.** Given the same `ctx.time`, your system must produce the same
   image. Seed every RNG (`rng(seed)` from `src/util/math.js`). Never call
   `Math.random()` at runtime, and never read `performance.now()` or `Date.now()`
   for animation — use the `dt`/`ctx.time` you are handed.

## The System interface

Register a class with a unique `name`. All members optional except `name`:

```js
export class MySystem {
  name = 'mySystem';
  order = 100;                 // lower runs first
  async init(ctx) {}           // build + add to ctx.scene; may await
  fixed(h, ctx) {}             // FIXED step h=1/120 — all physics/springs here
  update(dt, ctx) {}           // once per rendered frame, variable dt
  prerender(ctx) {}            // last chance before the draw (render targets)
  renderFrame(ctx) {}          // ONLY PostFX may define this (replaces the draw)
  resize(w, h, ctx) {}
  onQuality(e, ctx) {}
  dispose() {}
}
```

`order` convention: `-100` environment · `-50` terrain · `0` fox anatomy ·
`100` animation · `200` fur · `300` atmosphere/particles · `900` camera ·
`950` post-processing · `1000` debug.

## The shared `ctx`

Read these; do not redefine them.

| field | meaning |
|---|---|
| `scene`, `camera`, `renderer`, `quality` | three.js core |
| `time`, `dt`, `frame` | simulated seconds, last delta, frame counter |
| `size`, `bufferSize` | CSS pixels / actual backbuffer pixels |
| `sunDirection` (Vector3, **towards the sun**), `sunColor`, `sunIntensity` | |
| `skyColor`, `groundBounce`, `exposure`, `focusDistance` | |
| `wind` (unit Vector3), `windSpeed` (m/s), `windGust` (0..1) | **fur, snow and grass must all use these** |
| `subjectPosition` (Vector3) | where the fox is; shadow + camera follow it |
| `systemsByName` (Map) | late-bound lookup of other systems |

Publish your own system on ctx under its name (`ctx.terrain = this`) so others
can find it. **Always read other systems defensively** — they may not exist yet:
`const t = ctx.terrain; const y = t ? t.heightAt(x,z) : 0;`

## Cross-system contracts (do not change these signatures)

```js
// Terrain — consumed by IK, particles, footprints, grass
ctx.terrain.heightAt(x, z) -> number                 // world Y of the snow surface
ctx.terrain.normalAt(x, z, outVec3) -> Vector3
ctx.terrain.press(x, z, radius, depth, sharpness)    // stamp a footprint

// Fox anatomy — consumed by fur, animation, face
ctx.fox.skinnedMesh  -> THREE.SkinnedMesh            // body, with skinning
ctx.fox.skeleton     -> THREE.Skeleton
ctx.fox.bone(name)   -> THREE.Bone                   // see BONES below
ctx.fox.root         -> THREE.Group                  // world transform of the animal
ctx.fox.attributes   -> { furLength, furStiffness, furFlow, region }  // BufferAttributes
ctx.fox.anchors      -> { nose, eyeL, eyeR, mouth, … } // Object3D, bone-parented

// Atmosphere — consumed by everything that needs IBL
ctx.sky.envMap       -> THREE.Texture                // PMREM, already on scene.environment
ctx.sky.sunColorAt(elevation) -> THREE.Color
```

## Bone names (canonical — animation and fur both key off these)

```
root · hips · spine01..spine04 · chest · neck01 · neck02 · head · jaw
earL01 earL02 earL03 · earR01 earR02 earR03
tail01..tail09
shoulderL upperArmL lowerArmL wristL pawL · (same for R)
thighL shinL hockL footL toeL       · (same for R)
```

## Verifying your work

```bash
node tools/shoot.mjs --out shots/<you> --poses <the poses that show your work>
```

Pose names: `hero portrait macro_eye silhouette profile tail paws wide aurora
terrain nape`. Use `--state walk|trot|run|sit|idle`, `--quality low|…|ultra`,
`--sun elev,azimuth`, `--wind speed,gust`, `--build` (production bundle).

Then **look at the PNGs with the Read tool.** Do not declare success on a green
exit code alone — a black frame also exits 0. Read `shots/<you>/report.json` for
draw calls, triangle counts and per-tier frame times.

## Performance budget (per system, at `high`, 1280×800)

Whole frame ≤ 16 ms. Fur ≤ 6 ms · terrain ≤ 2 ms · atmosphere ≤ 2.5 ms ·
post ≤ 3.5 ms · animation+physics ≤ 1.5 ms CPU. Total draw calls ≤ 220.

## Ownership map

| Owner | Files |
|---|---|
| orchestrator | `src/main.js` `src/core/**` `tools/**` `index.html` `vite.config.js` `src/manifest/00-core.js` `src/util/math.js` `src/shaders/noise.glsl.js` `*.md` |
| anatomy | `src/fox/Fox.js` `src/fox/FoxAnatomy.js` `src/fox/FoxSkeleton.js` `src/fox/FoxSurface.js` `src/manifest/50-fox.js` |
| terrain | `src/world/Terrain.js` `src/world/SnowMaterial.js` `src/world/Footprints.js` `src/shaders/snow.glsl.js` `src/manifest/30-terrain.js` |
| atmosphere | `src/world/Sky.js` `src/world/Aurora.js` `src/world/SnowParticles.js` `src/world/Breath.js` `src/world/Horizon.js` `src/shaders/sky.glsl.js` `src/manifest/20-sky.js` `src/manifest/70-atmos.js` |
| postfx | `src/fx/**` `src/shaders/grade.glsl.js` `src/manifest/95-postfx.js` |
| camera+ui | `src/camera/**` `src/ui/**` `src/manifest/80-camera.js` `src/manifest/90-ui.js` |
| fur | `src/fox/FurSystem.js` `src/fox/FurMaterial.js` `src/fox/FurCards.js` `src/shaders/fur.glsl.js` `src/manifest/60-fur.js` |
| animation | `src/anim/**` `src/manifest/55-anim.js` |
| face | `src/fox/Eyes.js` `src/fox/FaceDetail.js` `src/fox/Whiskers.js` `src/manifest/58-face.js` |
