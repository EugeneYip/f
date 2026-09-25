# Review 7 — VERDICT: REJECT

`A3 · B3 · E3 · D4 · H4 · C5 · F5 · G5` (weakest first).

Graded on my own renders at **`4d813af`**, in `shots/critic7/`:
`hi/` (all 14 poses, `--quality high`, 1920×1200, 0 console errors, 0 warnings),
`phone/` (390×844), `low/` (`--quality low`), `walk/`, `run/`, `sun45/`
(`--sun 45,140`), `build/` (`--build`), plus `seq/` time sweeps. Crops are in
`shots/critic7/crop/`.

**Provenance, because the tree moved under me.** `hi/` finished at 00:29:08;
`src/fox/Fox.js` was first touched at 00:29:15 and `41969cc` landed at 00:38:51.
So **every image in `hi/` is the clean `4d813af` tree**, and `phone/ low/ walk/
run/ sun45/` (00:29:08–00:34:07) carry one in-progress edit to `Fox.js` and
nothing else. All six runs exited 0 with zero console errors.

**My first `spec` and `audit` runs were worthless and `gate` is why I know.**
Both timed out on `__FOX_READY`; `gate.mjs` refused to start and said
`src/fox/FurMaterial.js: SyntaxError: Unexpected number`. An agent was mid-save
(`cardVeil: ,` at line 1722). I re-ran all three inside a detached worktree
pinned to `4d813af`, and that is where the numbers below come from:

- `node tools/spec.mjs` → **38 pass / 0 warn / 5 FAIL**
- `node tools/audit.mjs` → **122 pass / 0 FAIL**
- `node tools/gate.mjs` → **PASS 5/5**
- **`source tree stable during the run` PASSED** (65 + 7 files fingerprinted,
  none changed). REVIEW-6's blocker 12 is fixed and it did its job.

---

## BLOCKERS, ranked

### 1. [B/C] The nose is a bare, smooth, hairless pale globe with the rhinarium sunk inside it

This is first because §4f rule 3 makes it an automatic ≤4 on its own, because
§4h already diagnosed the cause and named the object, and because it is the
largest thing in `chin.png` and impossible to miss at `frontal`.

`hi/chin.png`, `crop/f_nose.png`: the muzzle tip is a **glossy pale-blue
sphere** with a vinyl sheen, no hair anywhere on it, and a hard circular
silhouette. The actual black rhinarium is a smaller ellipse sitting inside it.

Measured at `frontal`, where both are unoccluded:

| | |
|---|---|
| pale globe, horizontal extent at y=790 | x 855→997 = **142 px** |
| pale globe, vertical extent at x=950 | y 746→861 = **115 px** |
| dark rhinarium at y=830 | x 920→982 = **62 px** |
| bright-coat span across the head at eye row y=600 | 1030 px |

So the bare pale surface is **2.3× the rhinarium's width** and **13.8 % of the
head's width**, and the legitimate bare feature accounts for under a fifth of
its area. Globe reads rgb(168,179,191) L 177.4 against coat 12 px away at
rgb(221,221,222) L 220.9 — 43 levels darker, which is why it reads as a
separate bulb rather than as part of the face.

Flatness, 7×7 local sd < 1.6, on `chin`: **70.2 %** of the globe, against a
lower-cheek control in `macro_eye` at **4.1 %** and a `profile` flank control
at **2.0 %**. It also carries visible planar facets — straight-edged strips at
`chin` (430–600, 640–760) and (880–1020, 560–720), and a facet crease running
(660,900)→(1010,880).

§4h says this in as many words: *"the bare muzzle was never a fur bug. The
cause was `nosePad`, a 30.7 × 23.9 mm skin-tinted sphere standing in for a
13 mm rhinarium."* Nothing has changed. Visible at `chin`, `frontal`,
`portrait`, `phone/portrait`, `low/portrait`, `sun45/silhouette`.
→ `src/fox/FaceDetail.js` and whatever still authors `nosePad` in the SDF.

### 2. [A/F] Large flat hard-edged grey polygons sit on the coat at every close framing

`crop/me_plate.png`. At `macro_eye`, immediately left of the eye, there is a
**flat grey polygon roughly 430 × 490 px** — 22 % of the frame width — whose
boundary is a chain of straight segments meeting at 30–60° corners, with four
parallel bevelled ridges along its left edge and a smooth dead interior. There
is a second at (1230–1520, 540–790), a third at (900–1130, 0–130).

Flatness (7×7 local sd < 1.6), with a positive control in the **same frame**:

| region | flat % |
|---|---|
| `macro_eye` plate left of eye | **47.6 %** |
| `macro_eye` plate right of eye | **63.0 %** |
| `macro_eye` lower cheek (control) | 4.1 % |
| `profile` flank (control) | 2.0 % |
| `portrait` cheek (control) | 0.1 % |

A 12–15× separation against two controls. The same plates appear at `portrait`
as grey quads above and beside both eyes (`crop/p_eyes.png`, at (250–350,
140–210) and (600–700, 230–330) of that crop), at `frontal` as grey patches
above each eye at (830–900, 530–560) and (1020–1080, 520–560), and **the far
eye is one of them** — a hard-edged grey chip at `portrait` (900–980, 690–740)
and at `sun45/silhouette` (785, 618), which REVIEW-6 already flagged.

§2.2 is a stated non-negotiable: "no visible faceting on any curved surface at
the framing used in `shots/`." This fails it at the framing built to show the
most detail. `src/fox/FurCards.js` / `src/fox/Eyes.js` — whichever owns the
quads that are not dissolving.

### 3. [A] The coat is a corrugated membrane with translucent sheets for a fringe — it is not hair at any framing

Known and owned (card LOD dissolve, deep shells returning constant alpha), so
I am not filing it as a discovery. I am restating it because the *character* is
worse than "flat blades" and because two instruments certify it as passing.

- `crop/pr_flank.png` (`profile`, 850–1270 × 470–750): the flank is a field of
  rounded vertical ridges and valleys — brain coral, crinkle-cut, wind-carved
  crust. In 420 × 280 source px I cannot find one individual strand. It reads
  as the same ripple octave the snow uses.
- `crop/pr_cards.png` (`profile` chest, 4.5×): the silhouette fringe is made of
  **wide semi-transparent hard-edged SHEETS**, 80–150 px across, each printed
  with parallel straight rules. They cross the background like cling film.
- `crop/pr_tailroot.png`, `crop/pw_feet.png`: visible horizontal **terracing**
  where each shell's silhouette steps.
- `chin.png`: every strand is a dead-straight constant-width ribbon radiating
  from the nose. No clumping (§5's Worley term), no taper, no curl.
- `low/hero.png`: the coat collapses into a regular **knitted basket-weave**.

Two instruments say this is fine and neither can see it:
`silhouette breaks up: head/body` passes on "median ramp 5 px", but a soft
translucent quad gives exactly that ramp — the check measures softness, not
hairiness. And `fur reads as hair at macro: muzzle` passes at 3.47 against
"a floor of 1.77 (35 % of the brow's 5.06)" **while `macro reference region
carries hair detail` FAILS in the same run at brow 5.06 vs an absolute 6.0**.
The muzzle's pass is certified by a reference the run itself calls inadequate.
The brief says a self-referential macro floor was caught once already; this
instance survived.

### 4. [B] The animal does not read as an arctic fox — it reads as a Pomeranian

`hero`, `hero_long`, `wide`, `phone/hero`, `sun45/silhouette`, `terrain`.
Four specific, separable things:

- **No neck and no chest.** The head merges straight into a barrel. There is no
  withers, no shoulder, no rib cage anywhere in the silhouette.
- **The tail is carried horizontally at spine height and merges with the rump.**
  §4b is binding and says "carried LOW, close to the ground when standing".
  At `hero_long` and `sun45/hero` it is a second torso; at `run/profile` it is a
  straight horizontal sausage (1280–1700, 570–760) as thick as the trunk. This
  is REVIEW-6 blocker 10's third bullet, unchanged.
- **The widest point of the head is the jaw, not the cheek ruff at eye level.**
  §4e: "The widest point of the whole animal's head is the cheek ruff, and it
  sits at about eye level or slightly below — not at the cranium, and not at
  the jaw." At `frontal` the head spans y≈130→1140; the eyes sit at y≈600 (47 %
  down) and the widest row is y≈960 (82 % down). Eye call on the image, not a
  matte number — my colour threshold could not separate coat from snow at that
  framing and I am not quoting it.
- **The legs are smooth tubes.** `crop/pr_leg.png`, `low/hero` (750–890,
  700–880): pale cylinders with hard silhouettes carrying almost no hair.

What is right and should not be traded away: the muzzle taper (§4c/§4i) now
reads as a fox wedge, the skull is the right size, and the cheek fur does
extend past the ear bases at `frontal` (cheek span ≈900 px vs ear outer span
≈690 px), which is §4e's own test passing.

### 5. [B] At `paws` — the pose built to show the feet — there are no feet

`crop/pw_feet.png`. Each leg is a blunt column of blue-grey lumps, like a pine
cone, terminating at the snow line. No toes, no pads, no paw shape, no
displacement, no contact. The leg surfaces show stacked oval cells in a
staggered brick lattice (the uniform SDF cell). Same at `walk/paws`
(`crop/gait_2.70.png`), where the stub ends *above* the snow with a visible gap.

`spec`'s `the drawn foot meets the drawn snow` passes with **pawL 18.8 mm below
the projected snow line against a 25 mm budget** ("9.5 mm of paw coat + 15 mm of
legitimate sink"). That check bounds *floating*; it says nothing about whether
a paw is visible, and 25 mm of allowed burial is the same shape as the 22 mm
stance tolerance AGENTS.md records as having driven the metacarpal down and
buried a sole 48 mm under the snow with all 78 paw checks green.

### 6. [D] The rim light does not survive the grade, at the pose built for it

§1's central promise: "a hot halo blooms through the guard hairs of its ruff,
tail and ear edges while the body core falls into cool skylight."

Measured on the **post** frame at `hi/silhouette.png`, five columns down the
back, rim = peak luminance in the first 40 px inside the edge, core = a 30×40
box 70 px further in:

| column | edge y | sky above | rim peak | core | rim/core |
|---|---|---|---|---|---|
| 950 | 448 | 185.1 | 236.1 | 212.6 | **1.111** |
| 1000 | 465 | 191.9 | 233.4 | 235.0 | **0.993** |
| 1050 | 461 | 190.8 | 232.6 | 232.3 | **1.001** |
| 1100 | 517 | 185.4 | 240.1 | 205.2 | **1.170** |
| 1150 | 566 | 177.7 | 244.1 | 234.0 | **1.044** |

Median **1.04** — the rim is 4 % brighter than the core, which is invisible.
`spec`'s `[reported] rim/core luminance ratio` reads **1.262 on the RAW frame**
and the check's own note anticipates exactly this: *"REVIEW-5 looked at the
POST frame and reported no visible hot rim… if [both are true] the defect is in
the grade, not the coat."* It is. `hero` is better (1.10–1.50) because the sun
is higher in frame, but `silhouette` is the shot.
→ `src/shaders/grade.glsl.js`, `src/fx/**`.

### 7. [E] Nothing ever breathes, and nothing blinks into a frame

Four settles at `portrait` (2.50 / 2.90 / 3.30 / 4.10 s), rendered in one
harness at one tier:

- **Breath.** A 220 × 180 box in front of the nose reads L **182.89 / 182.71 /
  182.83 / 182.79** — a 0.18-level spread across 1.6 s of simulation. There is
  no condensation puff at any sample. §1 "Breath condenses." §7 specifies it.
- **Blink.** `crop/idle_2.50.png` vs `crop/idle_4.10.png`: identical aperture,
  identical pupil, identical lash positions.
- The animal is not frozen — mean |ΔL| against t=2.50 is 6.2–6.9 whole-frame
  and 8.0–8.2 on the ruff, against a sky control of **2.1**. So the coat and
  ruff drift. But §8's named idle life (breathing, blinks, ear flicks, weight
  shifts) does not reach any delivered frame, which is REVIEW-6 blocker 11
  unchanged.

At `run/paws` and `run/profile` a second E problem: **all four limbs disappear
into the coat.** At `run/paws` the animal is a levitating pom-pom with no legs
at all above its shadow; at `run/profile` there is one shapeless lump at
(550–700, 720–830) where a foreleg should be. A gallop with no limb extension
is not a gait.

I could not build a trustworthy foot-sliding instrument this round — the camera
follows the subject and my patch tracker pegged at its search limit on every
patch with errors of 20–38 levels, so I am **not** applying REVIEW §E's
automatic ≤3 for sliding. Note also that `audit`'s ankle check is bounded by
construction: AGENTS.md records `FoxBrain.MAX_ANKLE_MPS = 0.027` exists because
"tools/audit.mjs measures exactly that bone". Neither of us has evidence.

### 8. [A/B] The ears are bare smooth paddles, not furred rounded triangles

`crop/p_earL.png` (`portrait`, 2.2×): the near pinna is a **smooth blue-grey
EGG** — a near-perfect ellipse with a soft gradient, no hair on its surface,
ringed by long straight blades that make it read as a sea urchin. §4c is
explicit: "a **triangle with a rounded tip**… it is **not a paddle**." This is a
paddle, and an untextured one. §4b: "small, thickly furred".

`crop/p_earR.png`: the far pinna is a field of unresolved alpha stipple with
horizontal terracing across its lower half.
`nape.png` (680–930, 250–540) and (980–1200, 300–640): from above, both ears are
smooth spatulate leaves with visible flat facets — two fish fins.

I could not build a number that separates the pinna from the coat: blades cross
in front of it, so the ovoid's box sd (27.7) comes out *higher* than the
cheek's (12.9) and my flat-plate metric reads only 7.2 % there. The crop is the
evidence; I am not quoting a statistic that does not hold.

### 9. [G] The aurora has over-corrected from a diagonal smear into a ruled barcode

`crop/a_curtain.png`. The vertical structure is a genuine fix and I verified it
(`spec`: dominant orientation **68.1°**, coherence **0.807**, against REVIEW-6's
128.6° and an isotropic 0.86 axis ratio). What replaced it:

- **The rays are dead-straight, parallel, constant-width and of uniform
  length**, and they do not attenuate downward — they run as hard streaks
  through the lower sky at (100–900, 620–810) of the crop. Real curtains fold,
  kink and vary along each ray.
- **The emission band has a straight horizontal TOP EDGE** at crop y≈565–600
  and a second at y≈95–130 — a geometric shell boundary showing, not an
  altitude falloff.
- The curtain has a **hard vertical left boundary** at x≈1150 and fills the
  right quarter of frame; §1 asks for "high and dim — present, never a laser
  show".
- Column-profile high-pass sd inside the curtain **1.877** against clean sky
  **0.528**.

Also at `aurora`: the airborne snow is **one population of near-identical soft
white ovals**, evenly scattered — confetti, not §7's three layers. `hero` and
`wide` do show two size classes, so this is framing-specific.

### 10. [A] The cast shadow still contains no ear, no muzzle and no tail, and no hair on its boundary

`crop/tr_shadow.png` (`terrain`): past the two leg notches within ~100 px of the
paws, the shadow is a **plain parallel-sided ribbon for 430 px**, with smooth
boundaries. The animal casting it has two ears, a ruff, a tail and four legs.
Same at `wide` (a 950 px constant-width stripe) and `silhouette`.

This is materially better than REVIEW-6: `crop/h_shadow.png` shows real leg
separation with taper and wobble, and at `sun45/silhouette` the shadow clearly
carries the head, the ears and a leg — so the caster is fine and it is the 6.6°
raking sun that flattens it. Ranked last of the blockers for that reason.

---

## NOTABLE, not blocking

- **`low` is still a different, worse animal.** `low/hero`: knitted-jumper coat,
  bare smooth leg cylinders with hard silhouettes and flat cut-off feet, **no
  airborne snow at all**, no temporal resolve so the whole animal is stippled.
  `low/portrait`: the coat is ~30 sparse hard-edged ice shards, the far ear is a
  ribbed grey caterpillar, the muzzle is a waxy plastic tube. §2.2 and REVIEW §H
  both fail here. Unchanged since REVIEW-5. Every `spec` check runs at one tier.
- **The tail root is open at `profile`.** `crop/pr_tailroot.png`: a ~60 × 180 px
  channel between rump and tail with the background's sastrugi bands running
  continuously through it (channel L 187.0 sd 15.3, against rump coat 198.6 and
  tail coat 150.4). REVIEW-6 found this only in `run`; it is there in idle.
- **Coloured fringing on thin dark geometry.** Grass blades carry magenta/violet
  on one edge and yellow on the other — `crop/a_grass2.png`, peak channel spread
  **86/255** at (1747, 973) in `aurora`, rgb(119,132,205) on a grey-blue
  snowfield. It does **not** scale with radius (spread 41 at r=184, 36 at r=302,
  25 at r=400, 35 at r=709 in `hero`), so it is not lens CA being modelled.
- **Eyelashes are still straight constant-width sticks at `portrait`.** Three
  tan filaments hang vertically over the iris and terminate in mid-air
  (`crop/p_eyes.png`). At `macro_eye` most lashes are now dark, tapered and
  curving correctly — but two are pure white and dead straight across the iris
  at (700,440)→(692,600) and (805,380)→(800,455). Two populations, one bad.
- **The `nape` interior is a waxy sheet with concentric onion-ring contours**
  (400–1000, 700–1100). Known and assigned; confirmed present.
- **Near-field defocused snow particles land on the subject** as soft pale ovals
  at `walk/paws` — they read as smudges on the coat at a framing focused on the
  coat. Not a colour violation (see retraction 4).
- **Performance is unmeasurable again and I am not scoring it.** `audit` reports
  `high` **18.6 ms** with the same tier measuring 18.6 and 22.72 ten seconds
  apart (22 % drift) and budgets self-disabled; `gate`'s Budget group checks only
  draw calls and triangles. I cannot credit the 16.37 ms figure either way.
  What I can confirm: **62–71 draw calls against 220**, max 1.37 M triangles.

---

## WHAT IS GENUINELY GOOD

- **The sun is the brightest object in the frame at every pose where it is in
  frame, and nothing is railed.** `hero` 253.1 at (1535,209) — the solar disc;
  `silhouette` 253.3 at (1016,339); `wide` 253.4 at (1307,248); `paws` 253.1 at
  (1684,339). 0.000 % of pixels at/above 254 in all seven poses I scanned.
  REVIEW-6's blocker 2 is fixed and I verified it independently.
- **Shaded snow keeps its micro-relief and its sparkle.** `terrain`, matched
  rows: shadow HF sd **9.30** with **631** glints/10 k against lit 12.96 / 1445
  near; 5.57 / 182 against 10.05 / 1000 far. REVIEW-6's 87 % relief loss and
  100 % glint loss are gone. You can see glints inside the shadow in
  `crop/tr_shadow.png`.
- **The cast shadow now has a real distance-dependent penumbra and a real
  wobble** — see retraction 5. My eye said ruler-straight; the instrument says
  otherwise and the instrument is right.
- **Shaded white fur is blue, not grey.** b−r of **+40.1** (profile flank),
  +32.0 (belly), +30.5 (tail), +28.6 (hero flank), +25.2 (portrait cheek),
  +24.2 (nape). Against §3's shaded swatch `#b9c7d8` at +31.
- **The eye at `macro_eye` is the best thing on the animal.** Fibrous amber iris
  with visible fibre structure, dark limbal ring, round black pupil, a shaped
  catchlight with a satellite, a second lower catchlight, dark wet lid rims,
  lashes that taper and curve. REVIEW-6's navy pupil and 7×7 dot are gone.
- **The nostrils are no longer see-through.** `chin.png`: the rhinarium is
  uniformly dark with two subtle slits meeting at a point. REVIEW-6 blocker 5
  closed.
- **The flank grey patches are largely gone.** Same box as REVIEW-6's addendum:
  fraction of 8×8 blocks below L 160 is **27.1 %** at `high` against their
  62.7 %. `spec`'s `matte silhouette is hair at profile: body` reads **1.314**
  against REVIEW-6's exactly 1.000 (bare mesh), and `contour has no bare run at
  profile: left` now passes at 1.3 %.
- **The look is not a one-sun fluke.** `sun45/` holds up completely: three-way
  separation readable, shadows chromatic and blue, shadow carries head, ears and
  leg, nothing clipped, sky gradient clean.
- **The production build renders identically to dev.** mean |ΔL| 0.000 / 0.001 /
  0.532 / 0.003 across `hero`, `portrait`, `frontal`, `wide`; **0.00 %** of
  pixels differ by more than 8 levels; identical draw calls and triangle counts.
- **The snow is still by a distance the strongest system**: multi-scale
  sastrugi, discrete varied sparkle, footprints with a raised rim and a shadowed
  interior (`sun45/hero` at (1400,620) — `crop/s45_lozenge.png`), correct aerial
  perspective, no horizon seam, round bokeh.
- **Phone framing is right.** `phone/hero` places the animal well; `phone/
  portrait` is the most fox-like image in the whole set.
- **No banding anywhere.** Max adjacent-row step in the sky is **0.67 levels**
  at `high` and **0.56** at `low`, over 295 rows against 87 levels of gradient.
- **Zero console errors and zero shader warnings** across 14 poses × 6
  configurations plus a production build.
- **`gate.mjs` behaved correctly when everything else lied.** It refused to
  start, named the file and the error class, and pointed at the backtick trap —
  which is how I knew my first `spec` and `audit` runs were noise rather than
  spending a round on phantom numbers. `source tree stable during the run` now
  records on clean runs and fingerprints `tools/` too.

---

## MY OWN RETRACTIONS — claimed, measured, disproved

Recorded so nobody re-files them.

1. **"The aurora's vertical bars continue through the horizon and are drawn over
   the snow."** I could see them in `crop/a_horizon.png`. They are not the
   aurora. Correlating the ground's column-profile high-pass against the sky's,
   same columns: **r = −0.004** (ground 15–70 px below the horizon), **−0.116**
   (100–170 px), **−0.121** (foreground), against a clean-column control of
   **+0.142**. Snow green excess under the curtain **4.05** vs clean **4.49** —
   the clean side is greener. It is haze and sastrugi reading as vertical.
2. **"Visible banding step in the `low` sky."** Max adjacent-row step 0.56
   levels over 295 rows against a total range of 87. No banding at any tier.
3. **"The lit snow has a warm tan cast."** `paws` lit band rgb(177,182,190),
   b−r **+12.3**; `frontal` lit snow b−r +10.5; `wide` mid-field +3.5. It reads
   warm only in contrast with the b−r **+63.7** shadow beside it. Shadow snow
   rgb(105,137,174) is a near-exact match for §3's `#6d8cb8`.
4. **"Pink/apricot blotches on the coat at `walk/paws`."** They are near-field
   defocused snow particles: r−b **−8.8 to −10.6** against a coat control of
   **−37.7** — 29 levels warmer than the coat but still net blue. Only **1.27 %**
   of coat pixels are r>b+3. Not a §4b colour violation.
5. **"The cast shadow's edges are straight with no penumbra widening."**
   `terrain` left edge, 49 rows over y=700–1180: RMS deviation from a fitted
   line **17.0 px**, max 67.6 px; 10–90 transition width **35.8 px near →
   45.4 px far**. Both the wobble and the distance-dependent penumbra are real.
6. **"The airborne snow flakes are warm-lit tan."** `hero` flakes rgb(82,95,119)
   and (96,104,125), r−b −37.1 and −28.8. They are blue.
7. **"The animal is blown out to a flat white blob at `silhouette`."** On-animal
   luminance p05..p95 spans **78 levels** (165→243), p99 247, 0.000 % at/above
   254. The range is there. What is missing is the rim/core separation —
   blocker 6 — which is a different defect with a different owner.

---

## Already assigned — seen, confirmed, not re-filed as new

Coat reads as flat blades rather than plush, and the `nape` interior as a waxy
sheet (blocker 3 and NOTABLE above, restated only because two instruments
certify them as passing). Muzzle and ear faceting from the uniform 6 mm SDF cell
— visible as the staggered brick lattice on the legs in `crop/pw_feet.png` and
as the polygonal rim on the nose globe. The far eye as a polygon chip. Legs as
smooth tubes with square-cut ends. Feet amputated at the snow line.

I did **not** credit `frame has contrast` (FAIL, sd 33.4 against an unsourced
35) or the four `contour has no bare run` checks (right 3.1 %, top 8.2 %,
bottom 3.9 %), per the standing instruction.

---

VERDICT: REJECT
Scores: A3/10 B3/10 E3/10 D4/10 H4/10 C5/10 F5/10 G5/10
