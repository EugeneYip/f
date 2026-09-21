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

## Measuring anything: verify the instrument first

Twenty-six instruments have given false readings on this project. Roughly half
were written by the orchestrator, several were gates that passed while the
defect they existed to catch was plainly visible in the render, and one was an
A/B variant that had never done anything at all. This is not incidental to the
work — it is the single largest consumer of effort here. Treat every
measurement as guilty until it has been shown to move when the thing it
measures moves.

**Before you trust a number:**

1. **Validate against a known defect.** A gate that has never been shown to
   FAIL on something known-bad is a number, not a gate. Build the positive
   control in the same frame — hide the coat, hide the skin, disable the pass —
   and confirm the metric separates them. Two silhouette gates and a macro fur
   gate shipped without this and all three were blind.
2. **Check the probe landed on its subject.** Rig anchors are bone centres, and
   the visible feature usually is not there: the eye anchor is the eyeball's
   centre while the iris sits forward on the cornea, and the nose anchor sits
   5.8 mm inside a pad that stands proud of it. Both probes spent rounds
   measuring eyelids and coat respectively. Search for the feature; do not
   assume its position.
3. **Scale the sample to the feature.** A fixed box around a 12 px nose
   averages it with bright surroundings. If widening the box moves the number
   monotonically, the box is measuring the surroundings.
4. **Make an unmeasurable probe a hard failure.** A null probe once deleted two
   checks silently and the report came back with 22 instead of 24.
5. **Report the raw measurement next to the verdict**, and record what the
   instrument saw when it fails. "Probe returned no samples" is the least
   useful thing an instrument can say.

**Traps specific to this harness, each of which has already cost a round:**

- **`renderPose(..., settle)` advances the simulation.** An A/B where only one
  arm settles compares frames 0.3 s apart in animation. Both `shoot.mjs` and
  `ab.mjs` had accumulating settles; both now render every arm and every pose
  at one instant and abort if the animal moves between them.
- **Deterministic can still be deterministically wrong.** A fixed sim time
  landed mid-blink for several rounds.
- **A private clock is not `ctx.time`.** Four animation systems accumulated
  their own `t`, so `spec.mjs`'s time rewind moved `ctx.time` and nothing else,
  and the eye probe read three different values at one "identical" sim time.
  AGENTS.md rule 6 exists for this.
- **Post is not neutral.** A gate measuring the post-processed frame graded a
  depth-of-field artefact as coat quality for three rounds. But measuring with
  post OFF also removes TAA, and TAA is what resolves the fur's stochastic
  alpha — so a raw frame makes every edge read as hard. Know which you want.
- **Backlit framings are nearly unmeasurable.** At `silhouette` a white animal
  against bright snow peaks at 261/765 of coverage; the same metric separates
  coat from bare mesh 1.43x at `frontal` and 0.99x there. Two agents
  independently failed to build a pixel metric at that framing.
- **Concurrent agents change the source mid-run.** `spec.mjs` names the files
  that changed so you can judge per check instead of discarding the run.

**And the rule that matters most:** if you are handed a diagnosis and the data
disagrees with it, say so. Agents on this project have disproved a handed-down
diagnosis at least eleven times and have been right **every single time** —
including the orchestrator's confident "the skin is visible through the coat",
which a transmittance probe measured at exactly 0.000 before finding the real
cause in depth of field. Disproving the brief is a success, not a failure.

**Never satisfy a gate by damaging the product.** An agent once cleared a bad
horizon check by cutting art-bible snow sparkle 71%. If you believe a threshold
is wrong, report it with the measurement and leave it failing — the
orchestrator owns `tools/**` and will change it.

## Scratch files: namespace them

The scratchpad directory is **shared between all agents**. One agent's probe
script overwrote another's output at the same path, and they spent two cycles
reading someone else's results believing they were their own. Prefix every
scratch file and every `--out` directory with your own name:
`shots/<you>/…`, `/tmp/<you>-probe.mjs`. Never write to a generic path like
`probe.mjs` or `shots/tmp`.

## Measuring performance honestly

Several agents run headless Chromium against the same GPU at once. When that
happens your frame time measures **queue wait**, not your own work, and every
tier reports nearly the same number regardless of its triangle count.
`tools/audit.mjs` detects this and prints a contention warning; when it fires,
treat the numbers as a floor, say so in your report, and do not tune against
them. A clean measurement pass happens at the end with nothing else running.

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
