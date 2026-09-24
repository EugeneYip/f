# Review 6 — VERDICT: REJECT

`A2 · B2 · D2 · H2 · C3 · E3 · F3 · G3` (weakest first).

Graded on my own renders at **`bc74c99`**, `shots/critic6/v3/` (all 14 poses,
`--quality high`, 0 console errors), plus `p3/` (390×844), `l3/` (`low`),
`w3/` (`--state walk`), `r3/` (`--state run`). Probes and crops are under
`shots/critic6/crop/`. `node tools/spec.mjs` on the same tree: **36 pass / 5
FAIL**. `node tools/audit.mjs`: **114 pass / 0 FAIL**, budgets self-disabled
for contention.

Everything I rendered before 23:10 I threw away: `0150c91`, `865d198`,
`023f66c`, `281e186`, `f8f10e6`, `14595b6`, `187bd67` and `bc74c99` all landed
underneath me. Numbers below are from `bc74c99` unless stated.

---

## BLOCKERS, ranked

### 1. [H, instrument] `shoot.mjs` renders every pose at a fur shell count the LOD never chose for it — and it is not the count the product runs

This is first because it invalidates the images *and* it explains why the gate
and the eye keep disagreeing.

`FurSystem.update()` computes the shell count from camera distance and screen
coverage. `shoot.mjs` never calls `update()` between poses — it does
`setPose(); render(); render(); render()×18`, and `render()` does not step the
simulation. So the shell count in every PNG is whatever the *settle* camera
chose. `spec.mjs`'s `renderPose()` does `D.settle(0.3)` per pose, so it gets
the live value. Same build, same instant, two harnesses:

| pose | `shoot.mjs` PNG | live LOD (`spec.mjs`, and the product) |
|---|---|---|
| hero | **14** | **18** |
| portrait | **14** | **10** |
| macro_eye | **14** | **9** |
| silhouette | **14** | **18** |
| profile | **14** | **17** |
| tail | **14** | **18** |
| paws | **14** | **16** |
| **wide** | **14** | **4** |
| aurora | 4 | 4 |
| terrain / hero_long / nape / frontal / chin | 7 / 12 / 9 / 13 / 9 | 7 / 12 / 9 / 11 / 9 |

Probe: `/tmp/.../critic6-poseleak.mjs` and `-ps2.mjs`, reading
`fur.shellGeometry.instanceCount` after each pose in one page session.

Consequences:
- **Every fur number in `spec.mjs` is measured on a different animal from the
  one in `shots/`.** At `macro_eye` the gate sees 9 shells and the critic sees
  14 (+56 %). At `silhouette` the gate sees 18 and the critic sees 14 (−22 %).
  That is the mechanism behind "the check passes and it still looks wrong",
  and it has been there the whole time.
- **`wide` ships at 4 shells and is reviewed at 14.** Nobody has ever looked at
  what a user sees at that framing.
- Poses 10–14 are the *only* ones with a live LOD, and only by accident:
  `0150c91`'s sun-restore added `ctx.app.step(0)` for any pose after the first
  one that sets a sun, which happens to be `aurora` (pose 9). So the run now
  has two LOD regimes in it, split at pose 9.

Fix: make `setPose` always run `ctx.app.step(0)`, or move the shell LOD into
`prerender()` where the harness will reach it. `src/core/Debug.js`
(orchestrator) and `src/fox/FurSystem.js:501`.

**Related, and how I found it:** before `0150c91`, `aurora`'s `sun: [-6,140]`
also leaked — poses 10–14 were shot at **−6.0°**, below the horizon, against
`+6.6°` for 1–9, *and* at 4 shells (552 k triangles against 832 k). That is
fixed; the shell half is not. Do not credit any `frontal`/`chin`/`nape` image
dated between `f4143a1` and `0150c91`.

### 2. [D] The sun is darker than the snow it lights

`v3/hero.png`, solar disc centred (1536, 210):

| | luminance |
|---|---|
| solar disc peak | **234.2** (rgb 242,233,223) |
| ground 99.9th percentile | **242.3** |
| brightest frame pixel | 253.1 |
| fox coat peak | 250.1 |

The brightest object in the scene is the dullest thing in the frame, by 8
levels. Radial profile from the centre: 235 → 224 (r=20) → 201 (r=45) → 180
(r=70) → 165 (r=110), against a sky floor of ~158 — a **96-px-wide grey blob**,
not a tight halo. `silhouette` reads +4.8 over the ground; `wide` +13.5.

The clipping fix (`5afd090`, asymmetric AgX shoulder) is real and I verified it
— 0.00 % at/above 252 on the worst subject block. But the shoulder has been
pulled so hard it has eaten the sun, and that is what makes every wide frame
read as fog rather than late polar light. This is also the *actual* defect that
`frame has contrast` (sd 34.2 vs an unsourced 35) is groping at with the wrong
instrument — do not raise exposure to satisfy sd; give the sun its highlight
back. `src/shaders/grade.glsl.js`, postfx.

### 3. [C/G] The animal's cast shadow erases the snow underneath it

`v3/hero.png`, inside the body shadow versus lit snow on the same image rows:

| | HF sd | sparkle glints per 10 000 px |
|---|---|---|
| lit snow (230,930) 300×90 | **9.05** | **293** |
| shadow (560,1030) 300×90 | **1.19** | **0** |
| lit snow (1450,930) | **14.60** | **958** |
| shadow (700,1090) | **1.67** | **2.2** |

The shadowed snow loses **87 %** of its surface micro-relief and **100 %** of
its sparkle. §6 puts the ripple and grain in the normal/height, so they must
survive into shade lit by skylight — they do not, which says the ambient term
is applied with no normal response and every bit of snow detail is carried by
the sun term alone. Visible as a flat blue paper cut-out laid over the terrain
in `hero`, `wide`, `paws`, `silhouette` and both gaits. `shots/critic6/crop/v3_shadow.png`.
`src/world/SnowMaterial.js` / `src/shaders/snow.glsl.js`, terrain.

### 4. [G] The airborne-snow system is invisible in every review pose

`high` budgets **12 000 particles in 4 layers** (near 1200, mid 4080, far 3600,
spindrift 3120; `uOpacity` 0.14–0.42, all `visible: true`). I hid all of them
and re-rendered in-page at one simulation instant, with a same-state
reproducibility control (`on` → `off` → `on`):

| pose | whole-frame meanAbs, snow ON vs OFF | control, ON vs ON-again | sky-band meanAbs | sky max |
|---|---|---|---|---|
| hero | 0.461 | **0.543** | 0.101 | 4 |
| profile | 0.406 | **0.481** | 0.056 | 4 |
| silhouette | 0.350 | **0.453** | 0.056 | 5 |
| tail | 0.477 | **0.637** | 0.360 | 35 |

**Deleting the entire system changes the frame less than re-rendering it
unchanged does.** The control is larger than the signal at all four poses. Against the sky — where §7's "near sparse large flakes" would actually
read — the maximum change is 4 levels. §7 asks for three layers of wind-driven
snow and §1 for "snow crystals catch the low sun as individual glints"; we are
paying for 12 000 instances and delivering nothing.
(`--state run` does show large defocused near-field flakes over the tail, so
the system is not dead — it is invisible in `idle`, which is the state all 14
review poses use.) Probe: `critic6-ab.mjs`. `src/world/SnowParticles.js`.

### 5. [B/C] The nostrils are holes you can see through

`v3/chin.png`, `shots/critic6/crop/v3_nostril.png`. The two nostril apertures
are not recesses — they are **openings punched through the rhinarium shell with
the pale muzzle surface showing straight through them**. Measured: the aperture
interiors read **(162,168,178), luminance 167**, against a rhinarium body of
**(7,11,19), luminance 10.8** — a **15× ratio**, and the aperture colour is the
same blue-white as the coat around the nose, not a nasal cavity. The left
aperture is 77×49 px on a ~490 px nose.

At `chin` the animal therefore has a black mask with two white eye-holes in it.
There is no nasal vestibule behind the opening. `src/fox/FaceDetail.js`, face.

### 6. [A] The shadow of a hairy animal has no hair in it, and no features either

`023f66c`'s coat extrusion fixed the *width* — `v3/hero.png` now throws one
solid body shadow instead of four sticks, and that is a genuine win. But at a
6.6° sun the shadow is displaced ~8.6× height, so it is the single largest
object in the frame, and it is a **featureless parallelogram**: trace it from
(1300, 775) to (250, 1160) and there is no ear, no muzzle, no tail, no leg
separation beyond two small notches — `shots/critic6/crop/v3_shadow.png`. At
`nape` the shadow's left boundary is a smooth curve for 660 px while the animal
casting it is a mass of spikes; over comparable runs the shadow's boundary
wiggle (path/net 2.7) is 2.5× smoother than the coat's own edge (6.8) — crude
tracer, directional only, but the images are not ambiguous.

A depth-extruded caster cannot produce hair, so this needs the fur cards in the
shadow pass or an alpha-tested skirt. `src/light/CoatShadow.js`.

### 7. [G] Aurora: no reflection in the snow, structure that is not vertical, and a dither screen inside it

`v3/aurora.png`. The daylight bug is genuinely fixed (23.2 % of sky above +3
green excess, p99 35.0, peak 51.5). Three things it did not fix:

- **No reflection.** §7 asks for a "faint reflection in the snow". Snow green
  excess measures **−4.73** (and −3.68 just below the horizon): the snow is net
  *magenta*. There is no aurora on the ground at all.
- **The structure is diagonal and near-isotropic, not vertical.** Structure
  tensor of the green-excess field inside the mask (n = 86 915): Jxx 1.156,
  Jyy 0.994, Jxy 0.355 → dominant structure orientation **128.6°**, i.e. 51°
  off vertical, with Jyy/Jxx = 0.86. The curtains render as a diagonal string
  of soft blobs (`crop/v3_aurdither.png`), not filaments.
  **`aurora has vertical filament structure` is lying.** It asserts
  gx/gy ≥ 0.85 and reports 1.266. A field that is 1.27:1 is essentially
  isotropic; a genuine vertical-filament field would be several times that.
  The check can only fail on *extreme horizontal* banding and says nothing
  about whether anything is vertical. It certifies the word in its own name.
- **An ordered-dither screen is visible inside the aurora.** High-pass sd
  **2.84** inside the curtain against **1.15** in plain sky 950 px away, with a
  coherent oblique autocorrelation (dx −3, dy +1 → 0.710; dx −5, dy +4 →
  0.683) where the control has nothing past lag 1. At 1:1 it reads as a fine
  cross-hatch on the bright bands. `src/world/Aurora.js`.

### 8. [C] The eye — much better, and still three specific things

`14595b6`/`281e186` are real progress: dark wet rim, lid thickness, a canthus
at the inner corner, no pale sclera ring. Grading it fresh at `v3/macro_eye.png`:

- **The pupil is navy, and it has a hard horizontal terminator across it.**
  Above y ≈ 618: mean **(8.5, 14.1, 22.8)**, B−R **+14.3**. Below: **(7.1, 8.2,
  11.7)**, neutral. The step completes in ~5 px across a 130 px pupil and
  carries on out into the iris. §4b: "Pupil round and black." It is neither.
- **The corneal highlight is 7×7 px — 2.1 % of the 337-px iris width — and it
  is the only specular on the eye.** A wet cornea at this magnification should
  carry a shaped sky reflection and a wet meniscus at the lid margin. There is
  one square dot (peak 246, rgb 245,246,247) and nothing else, so the eye does
  not read as wet at the framing built to show it.
- **The lashes start on the eyeball and cross the iris.** Three dead-straight
  3-px filaments of constant width, no taper, no curve, terminating in mid-air
  at (690,620) / (805,600) / (950,430). They originate at the lid/iris boundary
  and sweep *down and inward over the cornea*. They read as scratches on a lens.

### 9. [H] `low` is a different, worse animal, and nothing measures it

`l3/portrait.png`: the coat has collapsed into **large hard-edged polygonal
plates with straight edges** across the whole cheek (850–1450, 620–1050) —
countable quads, crumpled-foil reading. The ear rims are stair-stepped. There
is no temporal resolve, so the whole animal is stippled and aliased. §2.2 ("no
visible faceting on any curved surface at the framing used in `shots/`") is a
stated non-negotiable and `low` fails it outright, as does REVIEW §H's "low
tier still looks good, not just cheap". Every check in `spec.mjs` runs at one
tier; `audit.mjs` measures only frame time per tier. Unchanged since REVIEW-5.

### 10. [B] The tail is a striped cylinder with a see-through slot at its root

- **Slot.** At `r3/profile.png` there is a ~40 × 215 px channel between the
  rump and the tail base (source x 1267–1309, y 562–778) with **sky visible
  through it** — `crop/r3_tailgap.png`. The tail reads as a detached object
  towed behind the animal.
- **Stripes.** Low-frequency luminance across the tail spans **57 levels**
  (p5 144 → p95 201, sd 18.97) against **13** on the flank (sd 4.39) and **22**
  on lit snow (sd 8.24). The result is a banded, segmented, caterpillar
  reading, and it is the strongest mottle anywhere on the animal.
- At `hero`, `paws` and the phone `hero` the tail is carried horizontally at
  torso diameter and merges with the rump, so the animal reads as having two
  torsos and no tail. §4b: carried LOW, close to the ground when standing.

### 11. [E] Every review pose is shot at exactly t = 2.5 s, so idle life cannot be photographed

`shoot.mjs` settles once and then renders all 14 poses at that one instant —
correct for comparability, and the reason `run-paws` was fixed. The side effect
is that **no transient is ever in a review image**: breath, blinks, ear flicks,
weight shifts are either always present or always absent at t = 2.5 s, and they
are absent. I found the breath system alive in an A/B (max delta 134 at
t = 5.0 s) but there is no condensation puff in any of the 14 delivered poses,
and §1 says "Breath condenses."

REVIEW §E grades idle life and §8 requires it; as the harness stands, an agent
could delete all of it and no review image or spec check would move. Suggest a
`--at t1,t2,t3` sweep, or a second settle target for the face poses.

### 12. [instrument] `source tree stable during the run` only exists when it fails

`tools/spec.mjs:1958` records the check **only inside `if (drifted.length)`**.
On a clean run there is no entry — the report came back with 41 checks, and a
contaminated run would return 42. That is precisely the failure mode AGENTS.md
names ("never let a check disappear when it cannot measure; record it as a
failure under its own name"), in the one check that exists to protect all the
others. You cannot follow your own instruction to "check it on every run"
because on a good run there is nothing to check.

It also fingerprints `src/` only. `tools/audit.mjs` was being edited during my
spec run and would never have been caught, and `spec.mjs` can be edited under
itself.

---

## NOTABLE, not blocking

- **The muzzle barrel is a visible low-poly prism at `chin`.** Separate from
  the known faceted nose *pad*: the pale surface around it shows straight-edged
  planar strips and a ~10-segment polygonal rim at (450–950, 850–980) —
  `crop/v3_nostril.png`. I could not build a kink metric that separated it from
  blade noise (muzzle max |d²L| 36.1 against a coat-flank control of 37.7), so
  this is an eye call on the crop, not a number.
- **Fur distribution has no clumping anywhere.** §5 asks for a Worley/cellular
  tuft term. At `chin` and `frontal` the coat is a perfectly even starburst
  radiating from the nose — a dandelion clock. This is distinct from the known
  "flat blades" finding: the *blade shape* is one defect, the *even angular
  distribution* is another, and only the first is assigned.
- **Ears sit high and close together.** §4b is binding and says "WIDE APART and
  LOW on the skull, well out toward the sides — not high and close together".
  At `v3/portrait` and `v3/frontal` they are two tufts on the crown separated
  by ~150 px on a 978-px head.
- **Cheek fur is less textured than the muzzle.** `v3/frontal`, mean |px − 7×7
  mean|: cheek **2.14**, muzzle 4.28, ruff 3.19, pale nose dome 5.03. A number
  for the already-assigned smooth-grey-jowl finding.
- **`low` and the phone both recovered a pose that previously failed to
  screenshot.** My very first run (pre-`0150c91`) lost `terrain` and `chin` to
  20 s screenshot timeouts, and one `low` run died on
  `PAGEERROR: Unexpected identifier 'above'` — an agent's file mid-save. Both
  are contention, not product; flagging only so the next critic does not chase
  them.
- **Performance is unmeasurable and I am not scoring it.** `audit.mjs` reports
  `high` 30.34 ms and disables budget enforcement for contention (18 % drift in
  10 s, 1.71× an idle reference); my own `report.json` spans 16.3–195.8 ms for
  the same tier across poses. 67 draw calls at `hero` is comfortably inside 220.

## WHAT IS GENUINELY GOOD

- **The highlight clipping fix is real and I verified it independently.** Worst
  64×64 block on the subject: 0.00 % at/above 252, 0.00 % railed. No pose in my
  set shows a blown ruff.
- **The phone framing is fixed.** `p3/hero.png` puts the animal at ~22 % of
  frame height, well placed — against ~11 % last round.
- **The body shadow is now one shadow.** `023f66c` is the right idea and the
  four-stick figure is gone.
- **The eye rebuild is the biggest single improvement in the build.** Dark wet
  rim, lid thickness, canthus, fibrous amber iris with a limbal ring. My three
  complaints above are details on something that now has real structure.
- **Snow remains the strongest system**, when the sun reaches it: genuine
  multi-scale sastrugi, wind-carved swales, discrete varied sparkle at 293–958
  glints per 10 000 px, and a real footprint with a raised rim and a shadowed
  interior at `tail` (750–880, 930–1010).
- **The horizon cliff is genuinely gone** — 0 coherent columns, no seam to
  measure. DoF bokeh is round (brightest near-field discs measure 1.00–1.13
  w/h), not the anisotropic smear I first suspected.
- Composition at `wide` and `aurora`. Zero console errors across 14 poses on a
  clean tree.

## MY OWN RETRACTIONS — things I claimed, measured, and disproved

Recorded so nobody re-files them.

1. **"Near-field bokeh is a 4:1 horizontal smear."** The high-pass residual is
   anisotropic (half-correlation 20 px in x, 5 px in y) but that is the
   sastrugi content: the brightest isolated defocus discs measure w/h 1.11,
   1.13, 1.00, 1.00. Bokeh is round.
2. **"A periodic lattice / woven screen in the near snow."** No off-origin
   autocorrelation peak at any lag up to 40 in x or y. It is the micro-ripple
   octave, defocused. Reads oddly at 1:1; it is not a lattice.
3. **"The cast-shadow terminator is ruler-straight with no penumbra."** Fitted
   over 620 px at `hero`: RMS deviation **26.7 px**, max 66 px, and the 10–90
   transition is **92 px median**. Both the wobble and the penumbra are there.
   REVIEW-5's "inverted penumbra" — I could not reproduce that either.
4. **"Snow loses its high-frequency detail in shadow at `frontal`."** That
   first probe read HF sd *higher* in shadow (12.2 vs 8.8) because it straddled
   the transition. Blocker 3 is the corrected measurement at `hero`, away from
   the edge, and it is large and in the other direction.
5. **"Evenly spaced onion-ring contours in the coat at `macro_eye`."**
   Autocorrelation decays monotonically to 30 px; no periodic peak.
6. **"White polygonal litter on the snow at `tail`."** REVIEW-5's critic
   retracted this and was right: `crop/tail_litter.png` shows a soft-edged
   raised rim with a shadowed depression — it is a footprint, and a good one.
7. **The `PAGEERROR`s in two of my runs** were another agent saving a file, not
   a product defect.

## Already assigned — seen, confirmed, not re-filed as new

Flat blade coat and the smooth grey-blue cheek/jowl (cheek HF 2.14 above); bare
faceted nose pad (`crop/v3_nostril.png`, hard planar facet at its upper right);
the blue polygon chip is the far eye — clearly visible at
`nape_post/portrait.png` (680–730, 550–620); limbs are smooth tubes with
square-cut ends (`p3/hero.png`, 155–250, 720–790); feet amputated at the snow
line. `spec.mjs`'s four coat-contour failures (left 9.3 %, top 9.9 %, bottom
5.8 % against a 2 % allowance; `body` matte band at exactly 1.000 = one
monotonic crossing = bare mesh) are the same defect measured properly, and I
agree with the instrument. I did not credit `frame has contrast`.

VERDICT: REJECT
Scores: A2/10 B2/10 D2/10 H2/10 C3/10 E3/10 F3/10 G3/10

---

## ORCHESTRATOR ADDENDUM — the grey flank patches scale with shell count

Added after the review, from my own measurement, because it changes who owns
the defect.

With the fur LOD fix (20791ea) in place, `hero` at `high` shows large smooth
GREY PATCHES on the flank, shoulder and rump. The shell agent's last words
before a usage limit killed it were "The patches are already there with my
term off", so they are **not** its per-strand shadowing.

Same flank box (rows 500-700, cols 800-1150 of the 1920x1200 `hero` frame),
same commit, two quality tiers:

| tier | meanL | p10 | p90 | frac < 160 | sd |
|---|---|---|---|---|---|
| high (18 shells, 967k tris) | 153.3 | 110.5 | 224.2 | **62.7 %** | **45.02** |
| low (303k tris) | 174.2 | 155.6 | 212.1 | 25.5 % | 21.27 |

At `low` the coat is bright and even and there are no patches at all. At
`high` nearly two thirds of the flank sits below 160 and the variance
doubles. The defect therefore scales with the shell count, which points at
the shell stack itself — a per-shell term that accumulates per SHELL rather
than per unit of coat depth would behave exactly like this, and would have
been invisible while `shoot.mjs` was freezing every pose at 14 shells.

Caveat, stated because the comparison is not clean: `low` and `high` differ
in more than shell count (cards, shadow resolution, AO). This is a pointer,
not an attribution. The controlled experiment is to hold the tier fixed and
sweep the shell count alone.

Also worth noting from the same pair: `low` reads as a *plusher* animal than
`high` — smoother, denser, less bladed — which is the opposite of what the
tier ladder is supposed to deliver.
