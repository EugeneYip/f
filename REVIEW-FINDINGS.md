# Vulpes — review findings

Shot fresh after the adaptive-resolution fix. All frames referenced below are from
`shots/r2-*`, rendered at 1440×900 ×1.5 DSF unless stated. Everything captured before
that fix has been discarded and is not cited.

```
VERDICT: REJECT
Scores: E2/10 B3/10 C3/10 D3/10 F3/10 G3/10 A4/10 H4/10   (weakest first)
```

The single most important thing in this report: **run `node tools/ab.mjs --variants nopost`
before you believe anything you see in a default frame.** The raw render is substantially
better than the graded one. PostFX is currently deleting finished work from other
departments — a built amber iris, a dense hair fringe, an opaque animal. Several defects
that look like fur, face or anatomy problems are not.

---

## BLOCKERS — must fix before this can ship

### 1. [C / H] The eye material fails to compile. `owner: face`
`shots/r2-walk/report.json` and `r2-trot/report.json` carry a hard shader error:

```
Material Name: eyeGlobeL   (MeshPhysicalMaterial)
ERROR: 0:1646: 'uR' : undeclared identifier
ERROR: 0:1649: 'uSunCol' : undeclared identifier
ERROR: 0:1655: 'uR' : undeclared identifier
```
followed by **183 `WebGL: INVALID_OPERATION: useProgram: program not valid`** warnings in a
single 3-second capture — one per draw attempt per frame.

Likely cause, and it is a one-line discrepancy: at `src/fox/Eyes.js:515` the globe fragment
shader is assembled as `HASH + SIMPLEX3 + WORLEY3 + UTIL + APERTURE_GLSL + IRIS_GLSL + …`.
`GLOBE_GLSL` — which declares `uniform float uR, uRc, uZc, uK;` at `Eyes.js:103` — is **not**
in that list. The eyelid material at `Eyes.js:665` *does* include it
(`APERTURE_GLSL + GLOBE_GLSL + …`). Please confirm `uSunCol` reaches the same program.

→ This is why the eye is missing. It is not "mid-build", it is a compile failure.
→ It is also a strong candidate for the renderer deaths in blocker 2: a per-frame flood of
   invalid GL calls is exactly what provokes a driver reset.

### 2. [H] The renderer process still dies mid-run. `owner: orchestrator + face`
Before the adaptive-resolution fix, two consecutive full 11-pose runs died (pose 10, then
pose 6) with `Execution context was destroyed` and **zero JS console errors** — a
process-level kill, not an exception. After the fix the 11-pose idle runs pass cleanly
(`shots/r2-review`, `shots/r2-full`, buffer stable at 2160×1350 throughout).

But it is **not fixed for moving states**: `node tools/shoot.mjs --state trot` died on its
second pose (`shots/r2-trot/report.json`, `paws` FAILED, then `FATAL … reading 'setQuality'`).
Moving states are exactly where the eye shader error fires. Fix blocker 1 first, then re-test.

→ Until this is green, `shoot.mjs` cannot reliably produce a full review set, and a green
  CI run means nothing.

### 3. [D / A / C] PostFX is net-negative — it is subtracting quality, not adding it. `owner: postfx`
Attributed with `tools/ab.mjs` on the **absolute** poses `profile` and `paws` (see the caveat
in NOTABLE about anchor-relative poses). Three separate defects, all in post, none of them
DoF or bloom except where stated:

**3a. A milky veil over the entire frame.** Measured across `shots/r2-ab/profile.*`:

| variant | min RGB | max RGB | mean RGB |
|---|---|---|---|
| nopost | 0, 0, 1 | 255, 255, 255 | 134.7, 144.9, 153.9 |
| base | 12, 26, 56 | 253, 250, 247 | 110.6, 121.3, 138.3 |
| nodof | 12, 27, 56 | 255, 252, 249 | 110.2, 121.1, 138.2 |
| nobloom | 11, 26, 55 | 254, 251, 247 | 110.2, 121.0, 138.1 |

`nodof` and `nobloom` are numerically identical to `base`, so **this is the grade/composite
stage, not DoF and not bloom**. Nothing in the frame is darker than B=56 — including the
night sky. A blue shadow lift is specified (§3); a global floor of 56 across the whole
image is a scrim. Overall mean drops 18%.

**3b. The subject goes semi-transparent.** In `shots/r2-review/paws.png` the horizon line and
background snow are clearly visible *through* the fox's hindquarters at roughly x 1050–1450,
y 200–500. Same in `shots/r2-review/portrait.png` through the shoulder. The stacked A/B
(`shots/r2-abw/paws.{nopost,nodof,base}.png`) shows the animal fully opaque in `nopost` and
already see-through in `nodof` — so again not DoF. Look at AO / grade / composite.

**3c. DoF dissolves the hair fringe.** In `shots/r2-ab/profile.nopost.png` the tail carries a
dense fringe of individual guard hairs along its *entire* upper contour. In `profile.base.png`
that upper fringe is gone and the tail reads as a smooth curve. `nodof` retains most of it.
This is the "sub-pixel coverage gate in the near DoF field" failure mode — thin alpha
features failing a coverage test and being dropped. Owner: `src/fx/DoF.js`.

**3d. Post erases the face.** The most damaging instance. `shots/r2-absil/silhouette.nopost.png`
shows **two eyes with warm amber-brown irises and dark rims**, exactly as §4b asks. In
`silhouette.base.png` the left eye is **completely gone** and the right is a flat dark blob
with no iris. The nose is also smeared *warmer* by post, which §4b explicitly forbids.

### 4. [D] There is no rim light — at any sun angle. `owner: fur (+ environment)`
§1 is built entirely on this: "a hot halo blooms through the guard hairs of its ruff, tail
and ear edges". It does not exist.

- `shots/r2-review/silhouette.png` — camera pointed almost into the sun, fox between. Not one
  hot pixel on the animal. The ears, the best possible test for transmission, are opaque and
  lit identically to the body.
- `shots/r2-absil/silhouette.nopost.png` — **confirmed present in the raw render too**, so this
  is not post eating it. It is genuinely absent.
- `shots/r2-sun1/*` (sun 2°/140) and `shots/r2-sun2/*` (sun 14°/−30) — no rim at either.

At sun 14°/−30 the look collapses completely: flat bright midday snow, grey sky, no twilight
ramp, hard navy cut-out shadow, and the fur shells go dark and mottled on the lit back
(`r2-sun2/hero.png`, upper back) — it reads as mange on a white animal.

→ The wrapped / transmissive diffuse term in §5 is either not implemented or not firing.
  A look that works at zero sun angles isn't a look.

### 5. [A / F] Hard, aliased mesh edges on the silhouette. `owner: fur + anatomy`
REVIEW.md makes this an automatic ≤4, and it is the canonical example in the rubric.

- `shots/r2-review/profile.png`, tail: the entire **upper** contour from the base to the tip is
  a smooth mesh curve with zero hair breakup, ending in a visibly blunt **capsule cap**. Hair
  cards are present only on the *underside*, hang uniformly downward rather than radiating,
  and are separated from the tail by a visible gap. §4b: "Tail fur radiates outward from the
  core and is the longest on the animal."
- Same frame, head crop: the crown/ear/nape contour is a **stair-stepped** silhouette with
  discrete 4–6 px steps, at 1.5× DSF with TAA running.
- `shots/r2-review/portrait.png`, near ear: hard staircase outline, and the soft white halo
  around it sits *outside* the hard edge with a gap — that is a bloom/AO halo around a
  cut-out, not fur breaking the silhouette.
- Ears have no fringe at all, despite §5 listing "ear fringe" as a fin/card zone.

The fur system is not the problem here — `nopost` proves it does break the silhouette
beautifully on the rump, ruff and belly. The cards simply are not applied to the tail's outer
contour, the ears, or the skull.

→ Extend the fin/card zones in `src/fox/FurCards.js` to the tail's full circumference (radial,
  not just the underside) and to the ear margin; and give the tail tip a taper instead of a
  capsule cap in `src/fox/AnatMesher.js`.

### 6. [B] The body is still a capsule and the hind limb has no hock. `owner: anatomy`
`shots/r2-review/profile.png` and `shots/r2-ab/profile.nopost.png` (the clean read):

- The topline is a **dead-straight horizontal line** from withers to croup, and the belly is a
  second dead-straight horizontal line. Two parallel lines with rounded caps. §4 requires a
  "nearly spherical torso… the coat hides the waist entirely"; REVIEW B asks directly whether
  anything reads as "a capsule for a body". It does.
- **No hock.** The hind limb descends with a single gentle forward bend, structurally identical
  to the forelimb. No caudal-pointing hock, no metatarsal segment.
- **Legs are long and bare** — smooth, fur-free, glossy tubes from elbow/stifle down, with a
  hard line where the belly fur stops. §4b: "belly fur hangs low enough to obscure the top of
  the leg. Very little bare leg is visible on a standing animal."
- **Tail carried high and horizontal at spine height** in an idle standing pose, and roughly
  75–80% of head-body length. §4b: "carried LOW, close to the ground when standing…roughly 60%".
- **No cheek ruff flare** and a **visible neck**. §4b calls the flare "a defining feature" and
  says there is "effectively no visible neck".

Credit where due: the skull rework landed. The head is rounder, the muzzle blunter, and in
`r2-sun1/hero.png` and `r2-low/hero.png` the ears read as small rounded paddles set reasonably
wide. That part is right.

→ In `src/fox/FoxAnatomy.js` / `AnatField.js`: put a real barrel on the ribcage and a rounded
  croup so the topline and belly stop being parallel lines; add a caudal hock with a proper
  metatarsal segment to the hind limb in `src/fox/FoxSkeleton.js`; drop the tail's default
  carriage to near-ground for idle/stand and shorten it to ~60% of head-body length; extend the
  belly and flank fur length map down over the elbow and stifle.

### 7. [B / E] The fox floats, and limbs intersect the torso in motion. `owner: anatomy + animation`
- `shots/r2-review/terrain.png` — the clearest instance. The paws end in mid-air and the shadow
  begins visibly below and detached from them. Either the animal floats or the shadow
  peter-pans; both are blockers.
- `shots/r2-walk/profile.png` — the hind limb is **detached from the body**, emerging from behind
  the rump with a visible gap at the hip.
- `shots/r2-trot/profile.png` — a hard-edged dark blue-grey polygonal patch on the flank where a
  limb is **penetrating the torso surface**.
- `shots/r2-review/profile.png` — the fox casts **no shadow at all** at this camera/sun
  combination, while `hero`/`silhouette`/`paws` at the same sun do cast one. Measured: snow
  directly beneath the animal is RGB (158.1, 165.7, 183.5) against (153.7, 164.1, 184.9) far to
  its left — i.e. *marginally brighter* under the fox than away from it. No shadow, and no
  contact occlusion of any kind. Suspect shadow cascade coverage.

→ Clamp the IK foot targets to the sampled snow height in `src/anim/IK.js` and verify against
  the *rendered* bone, not the target (see blocker 8); re-fit the cascade split ranges in
  `src/core/Environment.js`; and add a self-intersection guard to the limb/torso blend in
  `src/fox/AnatMesher.js`.

### 8. [E] Gait speeds are 3–5× too slow, and the foot-lock audit is vacuous. `owner: animation`
From `shots/r2-audit/audit.json`, 3 s of simulation at 120 Hz:

| state | travelled | speed | plausible for a 0.28 m-shoulder canid |
|---|---|---|---|
| walk | 1.077 m | 0.36 m/s | ~0.7–1.0 m/s |
| trot | 2.154 m | 0.72 m/s | ~1.8–2.5 m/s |
| run  | 3.889 m | **1.30 m/s** | ~6–13 m/s |

"Run" moves at a slow human walking pace. Stride-vs-speed matching has therefore never been
exercised at a realistic speed.

**The audit is not catching this or anything else about the feet:**
- `maxSlideMps` is **exactly 0.0000** for every paw in every state including `run`. Not small —
  zero. A real rig shows numerical noise. The probe is almost certainly reading the IK *target*
  (pinned by construction) rather than the rendered paw bone.
- All four paws report **identical** `minClearance` and `stanceRatio` to 4 decimal places in
  `idle` (−0.006 / 0.997) and identical `maxClearance` (0.045) in `walk`. Four limbs at
  different (x,z) on a noisy snow surface cannot agree to 4 dp.
- The "not floating" check is `minClearance <= 0.055` — it passes if the paw ever gets *near*
  the ground, so it can never meaningfully fail. It tests the wrong direction.
- **There is no footfall-order check at all**, despite §8 specifying LH-LF-RH-RF for walk and
  diagonal pairs for trot.

→ In `src/core/Debug.js`, make `probe()` report the paw anchors' **world matrices** rather than
  IK targets, then re-run; raise the gait speeds in `src/anim/Locomotion.js` to the table above;
  add a footfall-order assertion and a stance-phase drift check to `tools/audit.mjs` that can
  actually fail.

Also: the spine and tail are rigid. The topline does not flex, the pelvis does not counter-
rotate, and the tail is a straight rod with no lag in walk or trot. §8 asks for 8+ spring-damper
joints on the tail; nothing is lagging.

**Idle life is not there either.** Over the 3 s `idle` probe: root displacement exactly
`0.000 m`, and all four paw clearances constant at `−0.006` with `stanceRatio 0.997` — no weight
shift, no foot adjustment, nothing. §8 is explicit: "ear swivels toward sounds, weight shifts,
micro head drift. **The fox is never perfectly still.**" REVIEW E makes a perfectly still animal
an automatic ≤5. Breath and blink systems exist (`src/world/Breath.js`, `src/anim/IdleLife.js`)
and I could not judge them from stills — but the body itself does not move at all.

### 9. [G] The world visibly ends inside the frame. `owner: terrain + atmosphere`
`shots/r2-review/wide.png`, `aurora.png`, and worst in `shots/r2-low/hero.png`. Sampling a
vertical column at x=648 in `wide.png`:

```
y=461..491   (113,116,122)  ← sky, flat to ±2 levels over 30 rows
y=493        (147,144,145)  ← STEP +34,+29,+23 in one row
y=495..509   (147,145,148)  ← flat band, ~18 rows
y=511        (156,159,170)  ← STEP +8,+11,+15
```

That is **two stacked hard horizontal edges** with a flat cream-grey band between them — a
horizon card butted against the terrain and the sky with no blend into either. It is the muddy
brown-grey stripe visible in essentially every frame in this review.

→ Blend `src/world/Horizon.js` into both neighbours with a depth-driven aerial-perspective ramp
  toward `#aac4e0` rather than butting a card against the terrain edge; push `terrainRadius`
  past the far plane or fade the terrain into the same haze in `src/world/Terrain.js`.

Alongside it:

- The horizon is **dead straight** across the full width — no distant drift silhouette.
- **No aerial perspective.** Snow at the horizon is the same value and saturation as snow in the
  near field (`terrain.png`: identical top to bottom). §7 requires falloff toward `#aac4e0`.
- **Sparkle does not scale with distance.** Glints at the horizon are the same pixel size as
  glints in the near field, which flattens the whole plane. §6 wants world-space crystal facets.
- **Grass tufts are same-size billboards** at every depth, dark and hard-aliased into black
  specks in the raw render.

### 10. [G] The aurora is a structureless smear. `owner: atmosphere`
`shots/r2-ab/profile.nopost.png` shows it honestly: large flat mint-green blobs across the
upper sky with **visibly stepped, banded edges** and no vertical filament structure, no curtain
form, no lateral drift read. §7 asks for "high-altitude emissive curtains, vertical filament
structure… Dim. Restrained." In the graded frame it is dim to the point of absence
(`r2-review/aurora.png`), so the current state is "invisible or a splodge" with nothing in
between. No snow reflection either.

→ `src/world/Aurora.js`: add vertical filament structure and a curtain lower edge, raise the
  ray-march step count or dither the steps to kill the banded terminator, and re-balance
  brightness against the grade so it survives post without being a splodge pre-post.

### 11. [C] The nose is wrong, and it is the most visible error on the animal. `owner: face`
`shots/r2-review/portrait.png`, nose crop. Measured over the nose region: **mean RGB
(127, 145, 166)**, core ~(98, 120, 155). Spec §4b / §3 is `#171a20` = (23, 26, 32). That is
~5× too bright and decisively blue. Additionally:

- **Completely matte** — a uniform flat fill, zero specular, no sky reflection, no wetness.
- **Hard rectangular stair-steps** along its right edge, with a perfect rectangular notch. This
  is a low-resolution mask/texture sampled near-nearest; the texel grid is visible at roughly
  18 screen px per texel. It is not geometry.
- **No nostril slits.**
- It **bleeds past the muzzle silhouette** and gets clipped by it, so it reads as paint on a
  mask that doesn't match the geometry.
- At other angles it renders warm tan (`r2-review/hero.png`, `silhouette.png`, `r2-low/hero.png`)
  — on a pure-white animal it is the one warm object in frame, which §4b forbids outright.
- `shots/r2-review/profile.png` shows **no nose at all** at that angle.

→ `src/fox/FaceDetail.js`: drive the nose from geometry or a much higher-resolution mask, set
  the albedo to `#171a20`, give it a low-roughness specular lobe and modelled nostril slits,
  and re-anchor it to the muzzle tip so it stops being clipped by the silhouette.

### 12. [F / C] `macro_eye` is a total miss, and the material cannot survive close inspection. `owner: face + fur`
`shots/r2-review/macro_eye.png` — the pose specified for "iris parallax, corneal highlight,
lids, lashes" contains **no eye anywhere in frame**. It is a full-frame field of pale blue
noise, and that noise shows:

- a **cellular / Worley "reptile scale"** pattern of rounded polygonal cells,
- dense **moiré interference fringes** forming chevrons and zigzags — a noise function sampled
  well below Nyquist, which will crawl violently under any camera motion,
- **hard polygon faceting** — a straight vertical crease and an L-shaped corner.

§2.2 is a stated non-negotiable: "No visible faceting on any curved surface at the framing used
in `shots/`."

→ Fix the `macro_eye` anchor in `src/core/Debug.js` so the pose actually finds the eye, then
  band-limit the fur/skin noise in `src/shaders/fur.glsl.js` (mip or derivative-based octave
  fade) so the Worley and simplex terms stop aliasing at close range, and subdivide the skull
  in `src/fox/AnatMesher.js`.

### 13. [H] The `low` tier is broken, not merely cheap. `owner: orchestrator + fur`
`shots/r2-low/hero.png` vs `shots/r2-review/hero.png`:

- **The fox casts no shadow at all** at `low`. High/ultra/build all show three clear shadow
  bars; low shows none. The animal is a sticker on a plane. Note `low` *does* have shadows
  configured (`shadowMapSize: 1024, shadowCascades: 1`), so this is a coverage or bias failure
  at one cascade, not a disabled feature.
- **The coat degrades to television static.** With `furShells: 6, furFins: false` the entire
  animal is covered in a hard, high-frequency salt-and-pepper dither — unresolved stochastic
  alpha with no fins and no filtering to hide it. The silhouette underneath is a clean hard
  mesh edge. The coat is the whole point of the piece and at `low` it is noise on a blob.
- The terrain edge (blocker 9) is more obvious at `low`, not less — a hard horizontal line
  across the full width with the muddy band directly above it.
- The nose here is distinctly **pink** (see blocker 11), and the eye is a flat black dot with
  no iris at all.

REVIEW H: "`low` tier still looks good, not just cheap."

→ In `src/core/Quality.js`, give `low` enough shells (or a fins-only fallback) plus alpha
  dithering with a resolve, rather than 6 raw stochastic shells; and fix the single-cascade
  shadow fit so the subject's own shadow is inside it.

### 14. [CAMERA] Nothing compensates fov for aspect — the phone crops the subject. `owner: camera`
`shots/r2-phone/hero.png` (390×844 ×2) and `shots/r2-ui-phone/hero.png`: **the fox's head and
muzzle are cropped off the left edge of frame.** Only the rear ~80% of the animal is visible.

The cause is in the source, not the pose. `src/core/App.js:205` is the only aspect handling in
the project — `this.camera.aspect = w / h` — and every authored fov is a three.js **vertical**
fov. At 1440×900 (aspect 1.6) a 40° vertical fov gives ~60° horizontal; at 390×844 (aspect 0.46)
the same 40° gives ~19.5° horizontal, a 3× narrower field. `CameraRig._compose()` has the same
bug live: `fovTarget = lerp(FOV_LONG, FOV_WIDE, smoothstep(0.6, 6.5, dist))` is vertical-only.

→ Every phone visitor in portrait sees a cropped animal at every orbit distance until they
  dolly far out. Needs a horizontal-fit clamp when aspect < 1, in `CameraRig._compose()` and in
  the `POSES` table in `src/core/Debug.js`.

### 15. [UI] The interface fails contrast at sizes that are unreadable to begin with. `owner: camera+ui`
Computed from `src/ui/ui.css` against the panel background (`rgba(--deep, 0.9)` over a bright
snow scene) and verified visually in `shots/r2-ui-desk/hero.png` and `r2-ui-phone/hero.png`:

| element | size | colour | contrast | WCAG AA (4.5:1) |
|---|---|---|---|---|
| `.vx-note` | 8.5 px | `rgba(ink, 0.26)` | **≈2.2 : 1** | fail |
| `.vx-keys dd` | 9 px | `rgba(ink, 0.34)` | **≈2.8 : 1** | fail |
| `.vx-lab` | 8.5 px | `rgba(ink, 0.42)` | **≈3.6 : 1** | fail |
| `.vx-cap` | 9.5 px | `rgba(ink, 0.34)` | over the scene — no plate | fail |
| `.vx-perf b` | 9.5 px | `rgba(ink, 0.30)` | over the scene — no plate | ≈1.0 : 1 over lit snow |

8.5–9.5 px at 0.14–0.26 em letterspacing is below any legibility floor regardless of contrast.

Confirmed empirically: in `shots/r2-ui-desk/hero.png` the credit block bottom-left
("VULPES LAGOPUS" / "Arctic fox — realtime") sits over sunlit snow and the caption is
essentially **illegible**. Same on phone. There is no plate, scrim or shadow behind any of it,
so legibility is left entirely to whatever the camera happens to be pointing at. The perf
readout has the same problem and will be invisible over snow — which is most of the frame.

→ In `src/ui/ui.css`: raise every body size to ≥12 px, raise the alphas to clear 4.5:1, and put
  a scrim or text-shadow behind anything that sits directly over the canvas (`.vx-title`,
  `.vx-cap`, `.vx-perf`). Drop `.vx-dim` to ~0.45 rather than 0.13.

Additionally `.vx-title.vx-dim` drops the credit to `opacity: 0.13` after first interaction,
which makes the only remaining text on screen invisible rather than quiet.

### 16. [UI / A11Y] The experience is unusable without sight, and undiscoverable with it. `owner: camera+ui`
- **The canvas has no accessible name, role or text alternative.** `index.html` is
  `<canvas id="stage"></canvas>` with nothing inside it. A screen-reader user gets nothing —
  the entire content of the page is invisible to assistive tech. WCAG 1.1.1.
- **There is no heading after load.** The only `<h1>` lives in the loader, and `UI._dismiss()`
  calls `this.loader.remove()` after 1.9 s. The document ends up with no heading at all.
- **The perf panel is permanently hidden from assistive tech.** `UI._buildPerf()` sets
  `aria-hidden="true"` once and `setPerf()` only ever toggles the `hidden` property, never the
  aria state.
- **No onboarding.** In `shots/r2-ui-desk/hero.png` the sole affordance is one unlabelled
  44×44 icon in the bottom-right corner. Nothing indicates that dragging orbits, that scrolling
  dollies, or that the scene is interactive at all.
- Two independent `window` keydown listeners exist (`UI._bindKeys` and `CameraRig._bind`).
  `CameraRig`'s does not ignore a focused `BUTTON`, so arrow keys orbit the camera while the
  user is tabbing the quality panel.
- `UI._loop()` re-arms unconditionally when called synchronously (`setPerf`, `_syncPaused`),
  so enabling the perf readout while the loader loop is still alive starts a second concurrent
  rAF chain.
- The loader self-dismisses at 16 s and hard-bails at 22 s regardless of readiness, so a slow
  device drops the visitor into a possibly-unbuilt scene.

→ In `index.html` give the canvas `role="img"` and an `aria-label` describing the scene, and
  keep a persistent visually-hidden `<h1>` outside the loader. In `src/ui/UI.js` toggle the perf
  box's `aria-hidden` alongside `hidden`, gate `CameraRig`'s arrow-key handler on the focused
  element, guard `_loop()` against double-arming, and add a one-time "drag to look" hint.

### Camera & UI — scope note
The rubric (REVIEW.md) has **no category for camera or UI**, which is itself a gap given that a
visitor's entire experience runs through that code. Blockers 14–16 are therefore scored under
G and H. They are established from source plus rendered frames (`shots/r2-phone/`,
`shots/r2-ui-phone/`, `shots/r2-ui-desk/`, rendered with `shoot.mjs --ui`).

A separate live-interaction pass is still running at the time of writing. **Not yet verified,
and nobody should assume these work:** whether attract mode actually starts and whether its five
authored shots frame acceptably; whether the Time-of-day and Wind sliders have any visible
effect; whether the five behaviour buttons change the animal and whether `sit` works at all;
orbit feel at the elevation and dolly limits (including whether the terrain edge from blocker 9
is visible at max dolly-out, and whether you clip inside the fox at the 0.35 m minimum); tab
order and focus visibility. I will not claim a result I do not have.

---

## NOTABLE BUT NOT BLOCKING

- **`shoot.mjs`'s own perf numbers are ~50× wrong and will mislead.** `report.perf` reports
  0.21–0.39 ms/frame for a 768k-tri scene with a full post chain. It times CPU submit only and
  never drains the pipeline. `audit.mjs` does this correctly (1×1 `readPixels` sync) and
  documents why. Either delete `report.perf` or copy the audit's approach. `owner: orchestrator`
- **Frame time is still unmeasured.** Every `audit.mjs` run in this review reported
  `contended: true` (frame time varying <0.1% across tiers whose triangle counts vary 4.5×).
  I could not get an uncontended machine. The performance contract is unverified — not passed,
  not failed.
- **`ab.mjs` cannot be used on anchor-relative poses.** `portrait`, `macro_eye` and `nape`
  re-resolve against the live rig per variant, so the framing shifts between variants and the
  images are not pixel-comparable. I had to redo the attribution on `profile` and `paws`
  (absolute poses). Worth either snapping the anchor once per run or documenting the
  restriction. `owner: orchestrator`
- **`PAGEERROR: Unexpected identifier 'low'`** — a reproducible uncaught `SyntaxError` in
  `shots/r2-audit/audit.json`, the one FAIL in an otherwise 65-pass run. It fires during the
  tier sweep, correlating with the tier literally named `low`. There is no `eval`/`new Function`
  in `src/`, so I could not locate it statically. `owner: orchestrator`
- **Stochastic alpha has not converged** after 18 TAA frames. In
  `shots/r2-absil/silhouette.nopost.png` the ruff fringe is a salt-and-pepper dither of hard
  on/off pixels rather than smooth coverage. It will shimmer in motion. `owner: fur`
- **The sky gradient bands in the raw render** and is only rescued by post's noise. A centre
  column of `profile.nopost.png` has 12 flat runs of ≥4 identical rows (longest 8); `base` has
  none. That is fragile — fix the gradient rather than relying on the grade to dither it.
  `owner: atmosphere`
- **Footprints exist but are misplaced and misshapen.** `wide.png` shows a zig-zag chain of
  sharp-cornered gouges running across the foreground, unconnected to the animal;
  `terrain.png` shows two small ovals ahead of and to the right of the fox. No raised rim, no
  denser interior (§6). Nothing under the actual paws. `owner: terrain`
- **No paw compression or sinking anywhere.** The snow surface is perfectly continuous under
  every paw in every frame. §6: "Paws must visibly sink and displace."
- **Airborne snow is confined to a narrow band at the horizon.** In `shots/r2-low/hero.png` the
  particles form a single horizontal row of bright dashes all at the same altitude rather than
  filling the volume, and in `r2-review/silhouette.png` / `hero.png` the near-field particles
  read as out-of-focus smudges on the lens rather than wind-driven snow. §7 asks for three
  layers advected by the same wind vector as the fur, with depth. `owner: atmosphere`
- **Snow micro-texture tiles visibly** — a regular diagonal corduroy weave at a constant period,
  most obvious in the out-of-focus foreground of `portrait.png` and across `terrain.png`.
  Sastrugi also organise into concentric arcs around a common centre, which betrays a radial
  noise parameterisation. `owner: terrain`
- **`hero` gives the subject less looking room than tailing room.** Measured in
  `shots/r2-review/hero.png` (2160 wide, centre 1080): the animal occupies columns 700–1320, so
  it does sit slightly left of centre as `src/core/Debug.js:20` intends — but it faces left with
  **700 px in front of the nose and 840 px behind the tail**. The intent is half-achieved; the
  negative space is on the wrong side. `owner: orchestrator`
- **The `aurora` pose points at the sun.** Target `[-0.5, 2.4, -2.0]` still puts the sun disc in
  frame, which is not what that pose is for. `owner: orchestrator`
- **The `nape` pose doesn't show what it claims.** It is specified for "ruff depth and ear
  interior"; the frame is dominated by the fox's own shadow, the ruff is a smooth blown-out
  expanse, and the ears have no interior at all. `owner: orchestrator + anatomy`
- **A corner vignette is present** in every graded frame. §3: "No heavy vignette."
- **Attract mode's second shot is an 18-second push into the face** (`Cinematics.SHOTS[1]`,
  dist 1.6 → 0.62). Until the face lands that is the worst possible thing to hold on.
  `owner: camera`
- Range sliders use a 9 px thumb, which is a poor touch target on mobile even inside a 22 px
  input. `owner: camera+ui`

---

## WHAT'S GENUINELY GOOD

- **The fur system is strong and is being misjudged.** `shots/r2-ab/profile.nopost.png` and
  `shots/r2-abw/paws.nopost.png` show a dense, woolly coat with hundreds of individual guard
  hairs genuinely breaking the silhouette on the rump, ruff, belly and flank, with believable
  directional flow. This is real work and post is hiding most of it.
- **The grade's highlight handling is correct, and I checked hard.** **0.000% clipped white**
  over the whole of `silhouette.png` (2.9 M px), over the sun's glitter path on the snow in
  `wide.png`, and over the lit and shadowed snowfield in `profile.png`. The only clipping
  anywhere is the sun **disc core** itself (168 px, 0.295% of the disc region in `wide.png`),
  which is correct behaviour. Foreground snow measures R159 / G165 / B182 — properly,
  decisively blue in shadow, not grey. §3 and REVIEW C are satisfied on both counts, and this
  is the one area where the grade is doing real work.
- **The eye material, when it compiles, is right.** `silhouette.nopost.png` shows warm
  amber-brown irises with dark rims, which is exactly what §4b specifies.
- **The skull rework landed.** Rounder cranium, blunter muzzle, and small rounded ear paddles
  set reasonably wide — clearly visible in `r2-sun1/hero.png` and `r2-low/hero.png`.
- **The paws are well made.** Individual toes with fur tufts between them, clearly readable in
  `r2-review/paws.png` and `r2-walk/paws.png`.
- **Production build matches dev exactly.** `shots/r2-build/hero.png` vs `shots/r2-review/hero.png`
  are indistinguishable in framing, lighting, shadows and fur.
- **Budgets are comfortable.** 36 draw calls at `low` → 54 at `ultra` against a 220 budget;
  258k → 1.15M triangles against 3.5M. Nobody needs to worry about these.
- **The adaptive-resolution fix worked.** Buffer size is now stable at 2160×1350 across all 11
  poses and both consecutive runs, and the idle full-run crash is gone.
- **The sun's specular glitter path on the snow** in `wide.png` is the single most photographic
  thing in the project.
