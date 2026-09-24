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

**A backtick inside a `/* glsl */` template literal will close it.** This has
now fired three times in one session — in `Eyes.js` (`` `update` `` in a
comment, 66 lines early), in `snow.glsl.js` (`` `- 1e-4` `` and
`` `gate.mjs` ``), and once more in terrain. Node reports it as "missing )
after argument list" tens of lines from the actual character, and the second
occurrence left the page unparseable for about forty minutes and blocked
**every** agent's renders. Do not put backticks in GLSL comments. If the page
suddenly will not parse and the error makes no sense, grep your shader strings
for a backtick before anything else.

**Cross-run A/B renders are not trustworthy instruments on this project.** Fur
TAA convergence dominates the pixel difference between any two runs: an
in-page A/B in which *only one object's visibility* changed still moved 10.9%
of the frame and lit up the fox rather than the object. Compare arms inside one
page session at one simulation instant (`tools/ab.mjs` does this and aborts if
the animal moves), and prefer a derived quantity — a matte, a masked mean —
over a raw pixel diff. Relatedly: `gate.mjs`'s "Determinism" group checks
buffer SIZE, not pixels, so it will not catch a nondeterministic render.

**And a single-frame probe is not what the harness renders.** `shoot.mjs`
renders 2 warm-up plus 18 TAA frames per pose. A probe that renders one frame
per variant invented a fan of hard stripes around an eyelid that does not
exist converged, and an agent published a wrong cause before catching it
itself. Converge before you conclude.

**`page.screenshot()` can return a stale frame for a paused WebGL canvas.**
A fur agent ran three arms differing by 400,000 triangles and got PNGs
differing by no more than 31/255 — it nearly published "the controls do not
separate". Capturing inside the page with
`ctx2d.drawImage(renderer.domElement, 0, 0)` separated the same three arms at
105–129/255. `shoot.mjs` happens to be safe because it renders 2 + 18 frames
before the shot, and low-vs-ultra PNGs from it differ by a max of 177 with
21% of pixels over 8 — but any new probe that applies an arm and screenshots
is exposed. Use the in-page capture; `tools/matte.mjs` shows the pattern.

**Two audit thresholds have become design constraints.** This is the
sharpest form of the instrument problem here, and neither case was hidden —
both were written down deliberately by the agent that complied:

- `FoxBrain.MAX_ANKLE_MPS = 0.027` exists because "tools/audit.mjs measures
  exactly that bone; rate-limiting the plate quaternion bounds it by
  construction at any gait ... budget is 0.045, this leaves a ~40% margin."
  So the check passes because a limiter runs, and reports nothing about
  whether the foot visibly slides.
- A 22 mm stance tolerance drove the metacarpal down to satisfy it, and
  buried the sole 48 mm under the snow while all 78 paw checks stayed green.

A number an implementer can see and satisfy directly **will** be satisfied
directly. So a check on a quantity the product can reach is worth little: put
the assertion in image space, where it can only be satisfied by the thing
actually looking right. `spec.mjs`'s `the drawn foot meets the drawn snow` is
the model.

**The dangerous instrument failure is the ABSENT measurement, not the wrong
one.** Four times this session an instrument failed by removing a number
rather than reporting a bad one, and each took far longer to notice than any
wrong value would have:

- a null probe made two `record()` calls disappear, so the report came back
  with 22 checks instead of 24 and the gate had silently deleted itself;
- `audit.mjs`'s fur-reach check replaced itself with a *differently named*
  warning when it could not measure, so the named check vanished from the
  report and the gate still passed with the silhouette unguarded;
- `{ frameMs: <measured>, ...D.stats() }` let a spread overwrite a correct
  measurement with a frozen one, and the resulting constant then fired a
  "GPU contention" detector that suppressed budget enforcement on every run
  for a whole session;
- a "too few samples to measure" filter in the contour metric dropped exactly
  the hardest edges, because a cliff is the row with the fewest samples — so
  a bare muzzle scored a clean pass on the rows that survived.

So: never let a check disappear when it cannot measure. Record it as a
failure under its own name. If a value is unmeasurable, say which and why in
the message. And when you add a filter, ask what it removes *preferentially*
— a filter that is uncorrelated with the defect is fine, one that correlates
with it is an eraser.

**Commit the first working increment before you keep investigating.** This
project runs under session usage limits that kill agents mid-sentence with no
warning. Across seven waves, **four produced nothing at all** — not because
the agents were wrong, but because they were still verifying an instrument
when the limit hit, and an uncommitted insight is worth zero to the next
agent. The waves that produced the session's best work all committed
something small early and refined it afterwards.

This is in tension with the discipline above, and the resolution is ordering
rather than compromise: verify the instrument, make the smallest real change
it justifies, **commit it**, and then go deeper. A commit message is also the
only channel that reliably survives to your successor — several of this
session's findings reached the next agent solely because they were written
into one.

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

## TAA accumulates ACROSS A/B arms unless something resets it

`src/fx/TAA.js` resolves with `uAlpha = 1/(n+1)` and lets `n` run to 250
while the scene is static. In a hand-rolled in-page loop that applies arm 1,
renders, applies arm 2, renders, arm 2 is therefore a 1/50 blend of itself
over arm 1's converged image, and arm 6 is 1/251. The face agent proved it
with three IDENTICAL arms, 48 frames each: **135.8 / 110.9 / 99.4**. The
number tracked the arm's POSITION, and a tint arm's green was still visible
in the base image three arms later. With `ctx.postfx.reset()` between arms:
67.1 / 67.1 / 67.1, bit identical.

Contamination can only SHRINK a difference. A positive result from a
contaminated harness still stands; a NULL result from one means nothing.

`tools/ab.mjs` and `tools/spec.mjs` are NOT affected, but only by accident:
both call `D.setPose` per arm, and `setPose` treats a pose change as a hard
cut and already calls `postfx.reset()`. Measured on ab.mjs, three identical
arms differ by 254/198 px with an explicit reset and 238/177 without --
indistinguishable. If you write your own arm loop, or if you render several
arms WITHOUT changing pose, you get the contaminated version.

So: reset TAA explicitly at the top of every arm. Do not rely on setPose.

And note ab.mjs's own noise floor while you are there: identical arms are
not bit-identical. ~250 px of 2.3M and 12 levels is the floor; a difference
smaller than that is not a difference.

## git is broken on this machine: prefix every call

The system `git` at /usr/bin/git is Xcode's shim, and the Xcode license has
not been agreed on this host, so every plain `git` invocation exits 69 with a
license error -- including from inside agents, where it looks like an
unrelated failure and silently costs you your commit.

    DEVELOPER_DIR=/Library/Developer/CommandLineTools git status

That points the shim at the Command Line Tools instead. It needs no password
and works for every git subcommand. Use it for EVERY git call.

Do NOT run `sudo xcodebuild -license`: it is interactive and needs the user's
password, which no agent has. Only the user can clear this properly.

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
