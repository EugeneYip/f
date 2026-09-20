# REVIEW-2 — second critic pass

VERDICT: **REJECT**

Gates: `gate.mjs --build` **PASS 5/5** (prod build, 11/11 poses, 0 console errors, 62/220 draw calls, 1.18M/3.5M tris, determinism OK) · `spec.mjs` **12 pass / 1 FAIL** (silhouette breakup, median 2px — I checked this one by eye and the instrument is telling the truth) · `audit.mjs --state idle,walk,trot,run` **98/98 pass**, frame-time budgets not enforced this run (GPU contention).

Scores (weakest first, REVIEW.md categories):

| | |
|---|---|
| **B. Anatomy & believability** | **2/10** — it does not read as an arctic fox |
| **A. Silhouette & fur** | **3/10** — fur is a rim effect; camera-facing surfaces are bald |
| **G. Composition & atmosphere** | **3/10** — subject dead-centre in three of four wide framings; aurora still a smear |
| **C. Materials** | **4/10** — nose renders cream at distance; eye has no socket; snow is excellent |
| **E. Motion** | **5/10** — mechanically correct, artistically one note |
| **F. Image quality** | **5/10** — stair-stepping on every head contour, stipple outline, stray geometry |
| **D. Lighting & grade** | **6/10** — good separation and shadow hue, but the signature §1 setup is the one it handles worst |
| **H. Performance & robustness** | **8/10** — genuinely healthy |

---

## The headline

**This animal reads as a rabbit, a hare, or a white squirrel — depending on the pose — and almost never as a fox.** Every individual subsystem has had work done on it, and several are good. But the thing a viewer actually sees is a small round head with tall bald paddle ears, perched on a formless fur duvet, standing on four bare grey tubes that end in dark hoof-like nubs. In `hero` — the flagship — a big plumed tail curls *up over the back*. That silhouette is a squirrel's.

This is the charm question from the brief, and the answer is no. It is an impressive technical demonstration of fur that has not been assembled into an animal.

---

## BLOCKERS

**1. [B] Ears are bald, parallel-sided paddles — a verbatim violation of §4c.**
`portrait.png` (ear crop), `nape.png`. §4c is explicit: *"a triangle with a rounded tip — clearly wider at the base and tapering upward to a soft point… it is not a paddle."* Both ears have **parallel long edges** and a domed top. `nape.png` shows them from behind as two smooth rounded rectangles with **no fur on the rim at all** and a hard dark seam down the left ear's edge. §4b requires "small, thickly furred". The inner pinna is a flat untextured plane — no bowl, no concha, no inner fur. The measured height:width ratio (~1.25:1) may well satisfy §4c's number; the *shape* does not. This looks like the ratio was fixed and the silhouette was not.
→ Owner: ear geometry + fur length map on the pinna. Give the pinna a real base-to-tip taper and put fur cards on the rim and the inner bowl.

**2. [A] The fur is a silhouette-only effect. Surfaces facing the camera are bald.**
`tail.png` is the proof and it is stark: the tail is a **flat white blade** — a smooth, untextured slab with a fringe of hair around its perimeter and nothing in its interior. Same on the back in the same shot. §5 asks for shells *plus* fins; what is shipping reads as fins on the outline only. From any angle where you see a broad surface rather than an edge, the coat is a painted decal. REVIEW.md-A's "flat decal" is exactly what this is.
→ Owner: shell fur coverage / fin card placement. Note this is not a tail-length complaint — I am not contesting the 60% measurement.

**3. [C] The nose renders as an opaque cream dome at any distance past a tight portrait.**
Measured, not eyeballed:
- `portrait.png` nose: `rgb(14, 18, 24)`, R−B = −9.9 — **correct**, matches spec `#171a20`.
- `hero.png` muzzle tip: `rgb(153, 149, 148)`, R−B = **+5.1** — ~6.5× too bright and **warm**.
- `silhouette.png` muzzle tip: `rgb(132, 149, 169)`, L = 139 — ~6× too bright.

The 7× zoom on `hero`'s muzzle shows a solid, clearly-delineated beige dome — this is not bloom, not whiskers, not a mis-placed sample box. The hue is a near-exact match for the fur **undercoat** swatch `#dcd3c6`, which points at a fur layer being drawn over the nose at distance rather than a nose-material bug.
→ Owner: fur LOD/layering over the muzzle, not the nose material. The material is fine — `spec.mjs` proves it.

**4. [A/D] Backlit fur does not transmit. The §1 signature lighting is the condition this renderer handles worst.**
`silhouette.png` — sun directly behind the animal, which should be the money shot. Instead the fox is a flat pale blue-grey mass, in places *darker* than the snow behind it, with a thin bright fringe on the rump and no glow anywhere. §1 promises "a hot halo blooms through the guard hairs of its ruff, tail and ear edges"; §5 requires "a wrapped/transmissive diffuse term so backlit fur *glows*".

I isolated this with `ab.mjs --pose silhouette --variants base,nopost,nobloom,nofur`: the glow is absent in `nopost` too, so **this is the raw render, not post or bloom**. Corroborating evidence — `--sun 14,-30` (front-lit, 14°) produces by far the best image in the entire review, because form-shading carries it. The look currently *depends* on abandoning the art direction's own lighting.
→ Owner: fur shading — Kajiya–Kay secondary lobe / wrapped transmissive term.

**5. [B] Legs are bare grey tubes ending in flared, dark, hoof-like paws.**
`silhouette.png` (leg crop), `hero.png`, `walk-paws`. Smooth tapered cylinders with a hard silhouette edge, no fur, no toes, no pads, widening into a dark cone at the bottom like a chair foot. §4b: *"the belly fur hangs low enough to obscure the top of the leg. Very little bare leg is visible"* and §4: *"paws broad with dense fur between the toes."* The paws are also near-black, which appears nowhere in the §3 palette — an arctic fox's paws are densely furred white. This single detail is doing enormous damage to the species read.

**6. [C] The mouth is a painted 2D stroke.**
`portrait.png` face crop. A thin, uniform-width black line with a visible rounded pen-cap where it starts under the nose, which curves back and simply stops mid-cheek. No lip volume, no corner, no depth, no shadow. It is unmistakably a brush stroke in a texture, and it is the single most toy-like element on the face (§2.2).

**7. [B/C] Whiskers grow from the wrong place and cross the eyeball.**
`macro_eye.png`, `portrait.png`. At macro they are perfectly smooth **uniform-width** lines with no taper to a tip and no root thickening — they read as drawn strokes or stray line geometry. Several originate on the forehead/brow and sweep *forward and down across the muzzle*; **two pass directly over the cornea**. Real mystacial whiskers come off the lateral muzzle pad and sweep back. They are also too many and too evenly fanned. Getting whiskers in was right (§4b called them out as missing); the emitter placement is wrong.

**8. [G] The aurora is still a structureless smear.**
`aurora.png`, and more damningly `sun-low/aurora.png` and `sun-high/aurora.png` where it is brighter: **horizontal green bands**, soft on both edges, like green cirrus. §7 requires "vertical filament structure" — there is none, at any sun angle. No bright lower border. No violet fringe (`#a77dff` in §3 is entirely absent — it is pure green). No reflection in the snow. It *is* dim and restrained, so the "restraint" note was addressed — by fading it, not by building a curtain. That is fixing the adjective instead of the noun.

**9. [F] Hard, stair-stepped mesh edges on every contour of the head.**
`portrait.png` ear-notch crop at 2× and `hero.png` muzzle crop at 7×: the ear-to-skull junction and the top of the muzzle are clean polygon boundaries with countable pixel steps and zero fur breakup, plus a fine **dotted stipple ring** tracing the mesh outline (clearly visible along the chest, rump and tail in `silhouette.png`) — the outermost fur shell's alpha cut resolving to isolated pixels. §2.1 and §2.6 both forbid this.

This corroborates the one `spec.mjs` FAIL. Important nuance the median hides: the **torso and rump silhouette are genuinely good** — soft, feathered, individual hairs. It is the **head, ears and legs** that are bald. A fix that improves the torso average would pass the check without touching the actual defect.

**10. [G] The subject is dead-centre in `hero`, `wide` and `silhouette`.**
~47%, ~46% and ~47% of frame width respectively, with the fox small in frame and large empty margins either side. §9: "Framing respects the rule of thirds." In `hero` the cast shadow — the most dynamic element present — exits the bottom-left corner and pulls the eye out of the frame. In `silhouette` the sun sits almost touching the fox's head. Neither `hero` nor `wide` is an image anyone stops scrolling for; they are asset record shots.
→ Camera/pose framing. Flagged as a defect but **not actioned by me** — `src/camera/**` is out of scope this pass.

---

## NOTABLE BUT NOT BLOCKING

- **Motion is correct and monotone.** `audit.mjs` proves no foot slide and correct footfall order, and I believe it. But `walk`, `trot` and `run` share one body carriage: crouched, low, forward-leaning, belly fur near the snow. A real fox trots level and brisk and extends when it runs. `run-profile` reads as *slinking*. Nothing in the gait is wrong; nothing in it is characterful either. §8b's "prefer slightly stiff over slightly loose" has been taken — I could not point at anything lagging, which is a genuine improvement.
- **Airborne snow turns the sky to mud in the `run` state.** `mo-run/paws.png`, sky crop: a blotchy brown-grey mottle across the upper frame with no crystalline quality and no directionality. Reads as grime; §3 says "No lens dirt." Clean in idle, so it is wind/speed driven.
- **Horizon seam in `wide.png`.** Scanned it: at y=491 the mean |ΔL| across the frame is **9.28 with 66 of 212 columns exceeding 8 levels** — a horizontally coherent step, i.e. a real seam. `aurora.png`'s horizon by contrast measures ~1.0 with 0/212. So this is framing-dependent: at `wide`'s lower, longer camera the terrain's far edge becomes a hard silhouette instead of dissolving into §7's aerial perspective.
- **Stray detached geometry.** `tail.png`, lower centre: a small white/blue angular shard with a hair fringe sitting alone on the snow, disconnected from the animal. Looks like an orphaned fur card.
- **No snow compression under the standing animal.** `silhouette.png`, `hero.png`, `tail.png`: pristine snow right up to the paws, no depression, no raised rim, no contact darkening (§6 "Contact: no floating"). Footprints *do* exist — there is a trail in `wide.png` — but it runs across the lower third disconnected from the fox, so it reads as a baked decal rather than this animal's path.
- **The eye is too small and has no socket.** §4b calls the dark eyelid rim "the single most important detail on the face" and says eyes are "comparatively large". At `portrait` distance the eye is a bead with a smudged upper-lid crescent and essentially no lower rim; the surrounding fur is a featureless plane with no brow, no orbital depression, no fur direction change. At macro the lid edge against the iris is visibly ragged and aliased.
- **No cheek ruff flare.** §4b calls it "a defining feature of the winter coat". The cheek is a smooth surface flowing straight into the neck; the head reads narrow and deep rather than wide.
- **Head is small relative to the body**, against §4b's "proportionally larger and rounder than we have it".
- **DoF is doing almost nothing** — `profile.base` vs `profile.nodof` are near-identical. Camera-owned, out of scope, noted only.
- **Sky streaks read as scratches** — thin, sharp, uniformly bright hairlines over the sky in `portrait`/`hero`/`aurora`, plus a diagonal flare streak off the sun in `hero`. Near-field flakes over sky is physically fine; the rendering is too hard-edged to read as snow.

---

## WHAT'S GENUINELY GOOD

- **The snow is excellent and it is not close.** Sastrugi structure, discrete twinkling sparkle that reads as crystal rather than noise, correct strongly-blue shadows, and the specular sun-glitter path running to the horizon in `aurora.png` and `wide.png` is beautiful. This subsystem looks photographed.
- **The eye interior at macro is properly built** — radial iris fibre, dark limbal ring, round pupil, corneal highlight. The previous "macro_eye contains no eye" blocker is genuinely fixed, not papered over.
- **Restraint on figure/ground separation is correct and was the hard call.** §4b says the fox should be only slightly brighter than the snow and should separate by shadow hue and hairy silhouette. It does. The obvious wrong move — punching the animal out from the background — was resisted.
- **`nape.png`'s neck fur** has real directional flow and clumping. The fur system can clearly do what §5 asks; it just isn't doing it everywhere.
- **Performance headroom is large** — 62 of 220 draw calls, 1.18M of 3.5M triangles, zero console errors, production build renders identically.
- **The gates are fast and honest.** 34 seconds, and the single FAIL is a true positive that I independently confirmed by eye.

---

## GATE GAPS — checks worth writing

Ordered by how much review time each would save.

1. **No ear-shape check at all.** §4c is the most explicitly corrected passage in the bible and nothing measures it. It needs *two* numbers, because the current ear satisfies the one §4c names: (a) visible silhouette height ÷ base width ≈ 1:1, **and** (b) a base-width ÷ tip-width taper ratio with a floor, to catch parallel-sided paddles. Add (c) fur-card count on the pinna rim > 0.
2. **The nose check samples one projected point in one framing.** It reports `rgb(8,11,17)` and passes while `hero` shows `rgb(153,149,148)`. Project the nose in **every** pose and assert luminance < ~60 and B ≥ R in all of them. This would have caught blocker 3 in seconds and it is the clearest instrument-coverage gap in the suite.
3. **The horizon check also runs on one framing.** `wide.png` has a coherent step (66/212 columns) the check never visits. Run the existing horizontally-coherent logic per pose.
4. **The silhouette-breakup check reports a median over the whole animal.** It correctly failed — but the median conceals that the torso is good and the head/ears/legs are bald. Report per region (head / torso / tail / legs) with a floor on each, or a fix that improves the torso will turn it green without touching the defect. This is precisely the "Sonnet cut a mandated feature by 71% to satisfy a check" failure mode.
5. **No backlit-transmission check.** Measurable and cheap: with the sun behind, luminance at the fur silhouette rim ÷ luminance at the body core should clear a threshold. It is currently ~1.0. This is blocker 4, and it is the single highest-value check on this list because §1's whole concept depends on it.
6. **No check that fur covers camera-facing surfaces.** Local variance / high-frequency energy inside the animal mask should exceed a floor. A bald slab has near-zero. `tail.png` would fail hard and blocker 2 would have been caught automatically.
7. **No aurora structure check.** Ratio of vertical to horizontal gradient energy within the aurora band. A curtain is vertically dominated; the current smear is purely horizontal. This is the check that stops "restraint" being achieved by fading the feature out — and it directly guards §7.
8. **No stray-geometry check.** Connected-component analysis on the animal mask: any small component disconnected from the main body is an orphaned card. Catches the `tail.png` shard.
9. **No sky-cleanliness check across states.** Sky chroma variance in `run` vs `idle` — the brown mottle is very measurable.
10. **No paw-contact check.** Sample the snow height field under each stance paw and assert non-zero displacement plus a contact-AO darkening.

### Tooling hazard (I hit this live)

`tools/shoot.mjs` defaults `out: 'shots'` (line 23) and then runs `rm(outDir, { recursive: true, force: true })` (line 107) unless `--keep`. **Running `node tools/shoot.mjs` with no `--out` recursively deletes the entire `shots/` tree** — including `shots/gate`, `shots/spec`, `shots/audit` and every previous review directory. It cost ~190 result directories here.

It is made worse by `parseArgs` **silently ignoring unrecognised flags**: I typed `--help`, which is not handled, so the tool skipped straight to the destructive default. `shots/` is gitignored, so nothing is recoverable.

Two cheap fixes: refuse to `rm` when `out` resolves to the `shots` root (require a subdirectory), and error on unknown flags instead of ignoring them.

---

## On instrument honesty

Per the brief's warning, I tried to break the checks before trusting them.

- The **silhouette metric** has a plausible failure mode — a hot rim light raises `peak`, which raises `thr = peak * 0.25`, which can terminate the outward walk early and under-report a genuine fur ramp. It failed anyway, and the visual evidence (hard stair-stepped head contours at 7×) matches. **True positive.**
- The **nose checks** are mathematically honest; their *coverage* is wrong, not their arithmetic. Do not "fix" them by loosening the threshold.
- The **horizon check**'s isolated-vs-coherent distinction is well designed and correctly separates sparkle from seams. It just needs to run everywhere.
- `audit.mjs`'s 98/98 on foot slide and footfall order matches what I see. I have no reason to doubt it, and my motion criticism is explicitly *not* a contradiction of it.
- I am **not** contesting the tail length measurement (60%, to spec). My tail criticism is shape, volume and carriage only.
