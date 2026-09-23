# Vulpes — Art Direction Bible

> Every contributor (human or agent) reads this before writing a line of shader or geometry.
> When in doubt, this document wins. If you must deviate, say so in your report.

## 1. The shot we are chasing

A single arctic fox (*Vulpes lagopus*) in winter coat, standing on a wind-carved snowfield at
**late-afternoon polar twilight**. The sun is 4–8° above the horizon, behind and to the left of the
fox, so the animal is **rim-lit**: a hot halo blooms through the guard hairs of its ruff, tail and
ear edges while the body core falls into cool skylight. Aurora hangs high and dim — present, never
a laser show. Breath condenses. Snow crystals catch the low sun as individual glints.

The emotional register is **stillness and cold**, not action. Awe, not spectacle.

## 2. Non-negotiables (the AAA bar)

A reviewer must never be able to say any of these:

1. "The fur looks like a solid plastic shell." Fur must break the silhouette. No hard mesh edge
   anywhere on the body outline.
2. "It looks like a toy / low-poly / Blender default." No visible faceting on any curved surface at
   the framing used in `shots/`.
3. "The whites are blown out" or "the shadows are pure black." Snow must hold gradation in the
   highlights; shadows must stay chromatic (blue), never crushed to 0.
4. "The animal is stiff." Anything with mass must lag: tail, ruff, ear tips, belly fur, head.
5. "Anatomy is wrong." Proportions, joint placement and gait must read as a real canid.
6. "It's aliased / shimmering / crawling." Temporal stability matters as much as a still frame.

## 3. Palette (linear-space authoring; all values sRGB hex for readability)

| Role | Hex | Notes |
|---|---|---|
| Sun (direct) | `#ffd2a1` | 5° elevation, warm; intensity ~7.0 physical |
| Sky / ambient | `#8fb4e8` | cool zenith fill, drives the shadow hue |
| Bounce from snow | `#cfe2f7` | upward fill; keeps the belly from going dead |
| Fur base (shadow) | `#b9c7d8` | never pure white — white fur in shade is BLUE |
| Fur base (lit) | `#fdfcfa` | warm-white, a hair under 1.0 |
| Fur undercoat | `#dcd3c6` | faint warm cream visible where coat parts |
| Skin / nose | `#171a20` | near-black, wet specular, never matte |
| Eye iris | `#7d5a2e` → `#3c2a15` | amber-brown, dark limbal ring |
| Snow (lit) | `#f2f6fb` | |
| Snow (shadow) | `#6d8cb8` | strongly blue — this sells the cold |
| Aurora core | `#7dffc4` | green, plus `#a77dff` violet at the fringes |
| Distant haze | `#aac4e0` | aerial perspective target |

Grading: ACES/AgX-family tonemap, exposure ~1.0, slight lift on the blue channel in shadow,
highlight rolloff long and soft. **No teal-orange crush. No heavy vignette. No lens dirt.**

## 4. Scale & anatomy reference (real animal, metres)

Work in metres, Y-up, fox faces **+Z**.

- Head-body length: **0.55 m**; shoulder height **0.28 m**; tail **0.32 m** (bushy, ~0.10 m diameter with fur)
- Mass 3.5 kg. Winter coat thickness up to **0.05 m** on the flank, thicker on the tail and ruff.
- Skull is **short and blunt** — an arctic fox is not a red fox. Muzzle short, forehead domed,
  ears **small, rounded, heavily furred** (cold adaptation; NOT the tall triangles of a red fox).
- Legs short relative to body; paws broad with dense fur between the toes.
- Eyes forward-set, amber-brown, with a dark rim. Pupil round.
- Body silhouette in winter is **round** — nearly spherical torso, the coat hides the waist entirely.

## 4b. Reference photographs — binding corrections

Six reference photographs of real *Vulpes lagopus* were supplied by the client.
Where this section disagrees with anything above, **this section wins**. These
are the specific ways our render currently differs from the real animal.

### Skull and face — our weakest area
- The head is **proportionally larger and rounder** than we have it. The
  cranium is a broad dome; the widest part of the head is at the cheeks, not
  the skull.
- The muzzle is **much shorter and blunter** — closer to cat-like than to any
  fox stereotype. It tapers only slightly from the cheeks to the nose. If your
  muzzle looks at all like a red fox's, it is wrong.
- **Ears sit WIDE APART and LOW on the skull**, well out toward the sides —
  not high and close together. They are small, thickly furred, and rounded
  almost to a semicircle. Backs are faintly grey.
- **The cheek ruff flares outward dramatically**, making the head read wider
  than it is deep. This flare is a defining feature of the winter coat.
- There is effectively **no visible neck**. The head merges into the ruff.

### Eyes — currently a dark speck, must be built
- Iris is **amber / golden-brown**, noticeably warm, with a darker outer ring.
- Pupil round and black.
- **Dark, almost black eyelid rims** surround the eye. This is what makes the
  eye read at distance, and it is the single most important detail on the face.
- Eyes are forward-set and comparatively large, with a wet corneal highlight.

### Nose and whiskers
- Nose: small, **black**, wet and specular, with defined nostril slits.
- **Whiskers are long, white and prominent** — sweeping back from the muzzle
  well past the cheek line, plus shorter brow whiskers above the eye. We have
  none. On a white animal against snow they read as fine bright filaments and
  they matter more than their cost suggests.

### Body and tail
- The **tail is thicker than ours and carried LOW**, close to the ground when
  standing, curling around the flank when the animal is sitting or lying. It
  is roughly 60% of head-body length. A running animal does carry it straight
  out behind — so tail carriage is pose-dependent, not fixed.
- Legs are **short**, and the **belly fur hangs low enough to obscure the top
  of the leg**. Very little bare leg is visible on a standing animal.
- Curled up, the animal is very nearly a **sphere**.

### Colour — the pink cast is flatly wrong
- The coat is **pure white to a faint ivory/cream**. There is **no warm cast
  whatsoever**, even in direct low sun.
- Shaded fur goes **blue-grey**, never pink, never warm.
- Some individuals carry a faint grey-tan mottle along the back and flank.
  Optional; the clean winter animal is uniformly white.
- Against snow the animal is only slightly brighter than its background — the
  separation comes from *shadow hue* and from the hairy silhouette, not from
  luminance.

### Fur behaviour
- Face fur is genuinely **short** on the muzzle and forehead — a few
  millimetres — so those areas reading nearly smooth is correct, not a defect.
  The contrast against the long cheek and ruff fur is what sells the face.
- Guard hairs are individually visible at the silhouette **everywhere**, at
  every framing.
- Tail fur radiates outward from the core and is the longest on the animal.

## 5. Fur specification

- Technique: **shell (concentric-offset) fur** — 12–20 nested shells for `high`, alpha-cut by a
  3-octave noise that is *stable in object space* so shells don't swim. Plus **fin/card geometry**
  on silhouette-critical zones (ruff, tail, ear fringe, hock tufts, cheek).
- Length map drives per-vertex shell offset: short on muzzle/paws/forehead (2–6 mm), long on
  ruff/flank/tail (35–55 mm).
- Direction: guard hairs flow **nose → tail**, sweeping down on the flanks, radially on the tail,
  and **outward/forward** on the ruff. Store as a tangent field on the mesh.
- Shading: **Kajiya–Kay anisotropic specular** (two lobes: sharp primary, broad shifted secondary),
  plus a **wrapped/transmissive diffuse** term so backlit fur *glows*. Depth-attenuated ambient
  occlusion darkens the inner shells so the coat reads as deep, not flat.
- Clumping: fur must clump, not distribute evenly. Use a Worley/cellular term for tufts.
- Wind: fur bends against wind direction with per-strand phase; gusts arrive as travelling waves.

## 6. Snow specification

- Multi-scale surface: large wind drifts (sastrugi) → medium ripples → micro grain, all in the
  normal/height.
- BRDF: high-albedo diffuse + **subsurface forward-scattering** (light bleeds through edges of
  drifts), plus a **sparkle** term — discrete, view-dependent specular glints from procedurally
  seeded crystal facets. Sparkle must twinkle as the camera moves and must NOT look like noise.
- Compression: the fox leaves **footprints** — persistent depressions with a raised rim and a
  darker, denser interior. Written into a height render target the terrain samples.
- Contact: no floating. Paws must visibly sink and displace.

## 7. Atmosphere

- Physically based sky (Hosek/Preetham-class) with correct twilight hue ramp.
- Aerial perspective on distance: contrast and saturation fall off toward `#aac4e0`.
- Airborne snow: three layers — near sparse large flakes with motion blur, mid drift sheets driven
  by curl noise, far haze. Snow must be **advected by the same wind vector as the fur.**
- Breath: short-lived condensation puffs from the nose, synced to the breathing cycle.
- Aurora: high-altitude emissive curtains, vertical filament structure, slow lateral drift,
  faint reflection in the snow. Dim. Restrained.

## 8. Motion specification

- Gait engine driven by a **phase** variable, with real canid footfall order for walk (LH-LF-RH-RF),
  trot (diagonal pairs) and a bound/gallop. Stride length must match forward velocity — **zero
  foot sliding**; feet are IK-locked to the ground while in stance.
- Terrain-adaptive: IK targets raycast the snow height; hips/shoulders pitch and roll to match.
- Secondary dynamics: spring-damper chains for tail (8+ joints), ears, ruff and belly fur.
  Critically damped enough not to wobble like jelly; loose enough to read as mass.
- Idle life: breathing (chest + nostril), blinks (with a real eyelid, ~120 ms, irregular spacing),
  ear swivels toward sounds, weight shifts, micro head drift. **The fox is never perfectly still.**
- Look-at: head/neck/eyes track a point of interest with per-joint weights and limits.

## 9. Camera

Cinematic: long lens (50–85 mm equivalent), shallow DoF focused on the eye, slow parallax drift.
Framing respects the rule of thirds; horizon never dead-centre. Orbit is user-controllable but
damped and range-limited so the user cannot find a bad angle.

## 10. Performance contract

- 60 fps at 1× DPR on an M-series Mac at `high`; graceful degradation to `medium`/`low`.
- Adaptive resolution scaling before anything else is sacrificed.
- Never block the main thread >16 ms after load. Build heavy geometry/textures progressively.

## 4c. Correction to §4b — the head over-corrected into chunky

**This section supersedes §4b on these two points. §4b remains binding on
everything else.**

When I wrote §4b from the client's reference photographs I over-stated the
bluntness, and anatomy implemented what I wrote faithfully. The result reads
**chunky and bear-like**, which is not what the photographs show. Re-reading
them:

### Ears: rounded triangles, NOT semicircular paddles
§4b said "rounded almost to a semicircle". That is wrong. In every reference
photograph the ear is a **triangle with a rounded tip** — clearly wider at the
base and tapering upward to a soft point. It is small and thickly furred
*relative to a red fox*, which is the real distinction; it is not a paddle.
- **Measure VISIBLE SILHOUETTE HEIGHT, not height above the cranium.** This
  matters more than it sounds: because the pinna leans outward, it leaves the
  head silhouette well below the dome, so visible height is much greater than
  height-above-dome. Anatomy's first pass hit "height above dome ≈ base width"
  exactly and rendered at ~1.8:1 tall-to-wide — clearly rabbit-like. Target
  **visible height ≈ base width (about 1:1)**, which lands near 37 mm proud on
  a 52 mm base at the current lean.
- The tip is **rounded, not flat** — a soft apex, not an arc. Note a sharper
  apex on a thin pinna has sub-cell rim curvature and will reintroduce the ear
  stair-stepping of review blocker 5; watch the worst neighbour-normal angle.

  > **"Thicken the pinna slightly to compensate" was wrong and is struck.**
  > `EAR_NORMAL` is 71 % Z, and Z lies in the profile view's shadow plane — so
  > thickening moves the blade *across* the silhouette this rule is about.
  > Measured: `thickTip` 0.92 → 1.10 takes the blade 10 mm below the tip from
  > 25.5 mm **up** to 27.5 mm, i.e. it makes the paddle worse on exactly the
  > framing §4c exists to fix. The real lever turned out to be the blade's
  > radius **profile**: at `power` 1.8 the blade held ~95 % of `rBase` through
  > its first third and then domed over, which is the semicircular paddle
  > itself. `power` → 1.0 makes the radius linear in u — a wedge — and took
  > the blade 22 % narrower 10 mm below the tip with the apex radius 12.6 →
  > 9.1 mm.
- Keep the wide-set, low, outward-leaning placement from §4b. That part was right.

### Muzzle: short but genuinely tapering to a point
§4b said "near cat-like" and a taper ratio near 1:1 was the result. Also wrong.
The arctic fox muzzle is **short relative to a red fox, but it still tapers to
a distinct point at the nose.** In the running photograph the wedge from cheek
to nose is obvious. A taper around **1.4–1.6 : 1** is the target, not 1.23 : 1.
- The nose pad sits at a **defined apex**, not on a blunt dome.
- Shorten by all means; do not blunt.

### The principle behind both
"Short" and "blunt" are different axes and I conflated them. An arctic fox is
a **short-faced, small-eared fox** — it is not a cat and it is not a bear. When
the two readings conflict, preserve the **fox wedge**: a clear taper front-to-
back on the skull and a clear taper base-to-tip on the ear.

## 8b. Motion should not read as lag

> **The 18 % overshoot figure this section used to specify was wrong, and has
> been struck.** It was measured without a no-step control, so it was reading
> the intentional idle-life fbm rather than the spring. Reconstructing the
> exact tail chain from the commit that wrote this section: the base joint at
> ζ = 0.95 has a linear step overshoot of **0.007 %**, and measures 0.00 % with
> the control subtracted, at every step size from 0.08 to 3.0 rad/s. 18 % is
> not reachable by that spring under any input. The uncontrolled reading scales
> as 1/step, because an additive noise floor is a larger fraction of a smaller
> step — 0.7 % at 3.0 rad/s rising to 8.9 % at 0.08, and ~18 % extrapolates to
> a step of about 0.036 rad/s. So the figure was an artefact of the test, not a
> property of the animal.
>
> **Specify settling time instead.** It is what a reviewer can actually see: a
> 5 % overshoot that is gone in a tenth of a second reads as mass, while a slow
> return reads as lag no matter how small the overshoot. Current tuning,
> controlled: base 0.9 % / 33 ms to 50 % / 75 ms settled; tip 5.0 % / 50 ms /
> 225 ms. A previous tuning whose tip reached 50 % at 1033 ms and settled at
> 2883 ms is what "noticeable lag" actually looked like.
>
> Everything else in this section — phase delay down the chain, prefer stiff to
> loose, the distinction between mass and lag — stands. Only the number was bad.


The secondary dynamics are currently visible **as lag** — the viewer notices
the tail, ears and head trailing rather than reading them as mass. That is the
failure mode of an under-damped or over-delayed spring chain, and it is worse
than no secondary motion at all.

- Follow-through should be **felt, not seen**. If a reviewer can point at a
  part and say "that is lagging", it is wrong.
- Raise damping toward critical and reduce the phase delay down each chain.
  A 9-joint tail that accumulates delay per joint will read as rubber.
- Anticipation matters as much as follow-through: real animals *lead* a turn
  with the head, they do not only trail with the tail.
- Prefer slightly stiff over slightly loose. Stiff reads as an alert animal;
  loose reads as a broken rig.

## 4d. The head is chunky — soft continuous curves, not faceted planes

**Client feedback, binding.** The head still does not read as a realistic
*cute* arctic fox. Named areas: **chin, jawbone, brow bone** — and the note was
explicitly "such as but not limited to", so treat these as symptoms of one
underlying problem rather than three isolated fixes.

Visible in `shots/head2/portrait.png`:

- **A heavy angular slab below and behind the eye**, running down to the jaw.
  In every reference photograph the cheek is a smooth rounded mass that flows
  continuously into the ruff. Ours has a distinct planar face with an edge.
- **A pronounced brow shelf above the eye.** Real arctic foxes have a gently
  domed forehead; the supraorbital ridge is subtle and rounded, never a ledge.
- **A blunt, heavy chin block.** The real chin is small and neat and tucks up
  under the muzzle.
- **The stop** (muzzle-to-forehead transition) is too abrupt and angular.

### The underlying cause, and therefore the fix
This reads as **primitive boundaries showing through the SDF union**. Where two
smooth-min'd primitives meet with too small a blend radius, the join becomes a
visible ridge or a flat facet — which is exactly what a "slab", a "shelf" and a
"block" are.

So the fix is not to shrink the chin, the jaw and the brow individually. It is
to **increase the blend radii through the skull** so the head becomes one
continuous surface. Judge it by silhouette *and* by shading: a chunky form
shows as a luminance discontinuity across a curved surface even when the
outline looks fine.

### The standard
A real arctic fox head is a sequence of **soft, continuous, convex curves**.
There is no flat plane anywhere on it. "Cute" here is not a stylisation — it is
what the anatomy actually looks like: rounded cranium, full cheeks, short
tapering muzzle, no visible bone structure through the coat.

**Do not trade the §4c fox wedge for this.** The muzzle must still taper to a
defined point and the ears must still be tapering triangles. Smooth the
*surface*, keep the *proportions*.

## 4e. The head seen FRONT-ON

**Why this section exists.** Contributors have never seen the client's
reference photographs — they work from these written descriptions. §4b's error
(conflating *short* with *blunt*, which produced a bear) happened precisely
because a description stood in for an image. Anatomy then reported it had been
inferring the skull's cross-sectional roundness and the true cheek-flare width
from profile and 3/4 views alone, and that *"that inference is exactly where
the last three head rounds went wrong."*

So: a front-on description, as precise as I can make it from the reference.

### Proportions, head-on
- The head is **roughly as wide as it is tall** — crown to chin ≈ cheek to
  cheek, measured over the fur. It is not a narrow skull with fur added.
- **The widest point of the whole animal's head is the cheek ruff**, and it
  sits at **about eye level or slightly below** — not at the cranium, and not
  at the jaw.
- The cheek flare extends **well outside the ear bases**. Looking front-on you
  see cheek fur beyond the ears on both sides.
- The muzzle is **narrow — roughly a third of the cheek width** — and emerges
  from the centre of that mass. The overall face shape is a **soft inverted
  triangle**: broad across the cheeks, tapering to a small dark nose.

### Surface, head-on
- **There is no visible cheekbone, jaw angle or zygomatic arch.** The outline
  from ear to cheek to chin is one continuous convex curve of fur.
- The cranium in cross-section is **round**, not a flattened dome. Seen
  head-on the top of the skull is an arc, and it continues smoothly into the
  cheek without a corner.
- Eyes are **wide-set** — roughly a third of the face width in from each side —
  and set forward, not on the sides of the head.
- Ears sit on the **outer upper corners** of that arc, leaning slightly
  outward, with their bases buried in fur.

### The test
If a front-on render shows a distinct skull width and a separate, wider fur
width — i.e. you can see where the bone stops and the coat starts — it is
wrong. On the real animal those read as **one continuous mass**.

## 4f. The bulk is in the wrong place — it belongs in the COAT, not the BODY

Three rounds of head work have chased "chunky" as a *shape* problem. Measuring
the rig says it is a *distribution* problem, and it explains the body, the
head, the visible skin and the hard silhouette all at once.

> **Corrected against sources.** The table below originally carried a "real
> winter fox" column that I derived by reasoning rather than from any source.
> `REFERENCE-FOX.md` went looking for those numbers and could not confirm
> them — and warned, correctly, that inventing zoology-flavoured numbers "is
> exactly the mechanism that produced the bear and the rabbit". The column is
> now split into what is sourced and what is not.

Measured, current rig, mid-torso:

| | ours | evidence |
|---|---|---|
| body radius (skin, no fur) | **80 mm** | the only real datum is a **150 mm diameter at the hip** of an explicitly *obese* outlier carcass carrying 30–40 mm of subcutaneous fat, >50 % body fat against a population mean of 22 % (Prestrud 1991, Fig. 5, read in full). Our typical animal's mid-torso is **wider than that obese outlier's hip.** [MEASURED, outlier] |
| coat depth, flank | 48 mm | arctic fox winter fur clusters with reindeer, wolf and grizzly in Scholander et al. 1950, plausibly a **40–60 mm** band. **48 mm is already correct — do not deepen it.** [INFERRED from a figure, not a printed digit] |
| coat as share of silhouette radius | 37 % | no source reports this ratio; zoologists publish fur depth and body size separately. My ~48 % target is [ESTIMATED — unverified, plausible, not contradicted]. Do not treat it as a specification. |
| forehead / skull / jaw coat | 3.8 / 7.5 / 4.8 mm | **[GAP]** — no mm data exists for muzzle, forehead, skull, cheek, throat, ruff, shoulder, haunch, leg, paw or either ear surface. My "15–25 mm" was invented. What *is* sourced is the ordering (below). |

The one thing about regional depth that is properly sourced is a **ranking**,
from Underwood & Reynolds via Prestrud 1991: deepest and most seasonal are the
foot pads, posterior-medial lower leg and lateral trunk; also deep are the
dorsal and lateral trunk; and **shallowest in all seasons are the head, the
distal legs and the belly.** So head coat *must* stay shallower than flank
coat. Our current ordering is right; the question is only how shallow.

Which means the head's coat depth is not an anatomical number we can look up.
**It is set by a rendering requirement**: deep enough that no bare skin shows
and the outline is hair everywhere, and no deeper. Tune it against
`tools/spec.mjs`'s silhouette-hardness gate, not against an invented mm figure.

We built a fat animal and put a thin coat on it. The real animal is a slight
animal — the torso of a large domestic cat — inside an enormous coat. Every
symptom follows from getting that backwards:

- **"Bulky, not bouncy."** Solid geometry reads as *mass*: heavy, inert,
  weight-bearing. Deep fur reads as *volume*: light, compressible, and it
  moves a beat behind the body. Same silhouette, opposite feeling. You cannot
  get bounce out of a shape whose bulk is bone.
- **Visible skin, visible interior.** A 3.8 mm coat on the forehead is a
  shaved head. There is nothing there to hide the skin surface, so the skin
  renders, and its mesh silhouette is a hard edge with nothing to break it.
- **The chunky chin, jaw and brow.** Those regions carry 4–5 mm of coat over
  a skin surface that was then *sculpted* to look furry. A bare surface
  sculpted into a fur shape is a chunky surface. The fix is not a softer
  sculpt — it is to make the skin there *slighter* and let 10–15 mm of actual
  coat carry the volume.
- **Why §4e's test keeps failing.** "You can see where the bone stops and the
  coat starts" is inevitable when the coat is 5 % of the head's radius. The
  test was right; the coat was never deep enough for anything to pass it.

### The standard

1. **The trunk slims; the flank coat does not deepen.** 48 mm of flank coat is
   already inside the only sourced band. The silhouette-share figure (~48 %)
   is an unverified estimate and is a *direction*, not a target to hit — the
   evidence that actually bites is that our mid-torso is wider than an obese
   outlier's hip.
2. **The muzzle stays short-coated (3–5 mm) and the nose bare.** This is not
   an exception to the rule, it is the point of it: the contrast between a
   deep skull coat and a short muzzle coat is what makes the face read as
   *pointy*. Deepening the muzzle would give back the bear.
3. **No bare skin is visible anywhere on the animal** at any framing, except
   the rhinarium, the eyes and the paw pads. If a render shows a smooth
   surface with a geometric silhouette, that is a failure regardless of what
   any other metric says.
4. **Slimming the body must not shrink the animal.** Total silhouette stays
   where it is; radius moves from geometry into coat. If the fox gets visibly
   smaller, the change was done wrong.

### The test
Render `frontal`, `chin` and `profile`. Trace the outer contour. If any
continuous run of it longer than ~2 % of the contour is a smooth curve with a
hard edge rather than a broken, hairy one, it fails. The silhouette of a
winter arctic fox is hair, everywhere, without exception.

## 4g. "Short" has now been misread twice. The muzzle is too SHORT.

§4b said "short muzzle"; it was implemented as BLUNT and produced a bear, and
§4c corrected it. The same word has now produced a second error, on the other
axis: "short" has been implemented as **shorter than the cranium**, and that is
not what an arctic fox is.

Three independent measurements agree, and none of them is mine:

| source | muzzle : braincase |
|---|---|
| Nanova & Prôa 2017, n=43 callipered crania (`REFERENCE-FOX.md` §3a) | **1.57 : 1** (rostrum 74.1 mm of 121.3 mm CBL) |
| critic, pixels off `profile.png` | 0.9 : 1 |
| anatomy agent, measured on the SDF field | **0.62 : 1** (muzzle ≈46, braincase ≈74) |

Our whole head is the right size — nose-tip-to-occiput measures ≈116 mm against
a real CBL of 121.3 mm. The head is correctly scaled and **wrongly divided**.

### Is the craniometric ratio usable here?

Partly, and the anatomy agent was right to refuse to act on it alone. The
researcher's warning stands: 61 % rostrum is a *dry-bone length* ratio, not the
same quantity as §4c's live-tissue *width taper*, and substituting one for the
other is exactly the move that produced the bear.

But it is not incomparable either. Craniometric rostrum means the facial region
anterior to the orbits, and on a canid the stop sits roughly at the orbits — so
our "muzzle measured from the stop" is approximately the same span. Treat the
craniometry as establishing the **direction and rough magnitude**, not as a
number to hit.

### The standard

- **Target rostrum ≈ 55 % of nose-tip-to-occiput**, against our current ~40 %.
  That is deliberately short of the sourced 61 %, because the source is dry
  bone and because §4b/§4c's "short" is still binding against a red fox.
- **Get there in increments and render at every step.** A single 25 mm jump on
  a 116 mm skull, taken on a number alone, is precisely how this went wrong
  before. §4c's width taper of 1.4–1.6 : 1 does not change.
- **If lengthening starts to read as a red fox, stop and report the number you
  stopped at.** That figure is worth more than reaching the target.

## 4h. Correction to §4f rule 2: the muzzle coat is set by rule 3, not by a number

§4f rule 2 fixed the muzzle at 3–5 mm of coat, reasoning that the contrast
against a deep skull coat is what makes the face read pointy. The reasoning is
right; the number was not mine to invent.

The anatomy agent measured it: at 15 mm of muzzle coat, **62 % of the muzzle
core is still skin-dominant.** So no depth anywhere in rule 2's band satisfies
rule 3 ("no bare skin visible anywhere except rhinarium, eyes and pads"), and
the two rules were in direct conflict. Rule 3 wins — bare skin is the defect
the user has actually complained about, three rounds running.

**Rule 2 is restated:** the muzzle carries whatever coat depth is needed for no
bare skin to show, and no more. The thing that must hold is the *contrast*
between the muzzle's coat and the skull's, not the muzzle's absolute depth. At
a 26 mm skull coat, a muzzle at 8 mm is still a 3:1 contrast and the face still
reads pointy.

Also settled by that measurement: the bare muzzle was never a fur bug. The
cause was `nosePad`, a 30.7 × 23.9 mm skin-tinted sphere standing in for a
13 mm rhinarium — FaceDetail had been clamping its *drawn* pad to 10–14.2 mm to
survive it, while nothing clamped the SDF.

## 4i. Corrections to §4g and §4f, both landmark errors of mine

Two targets I wrote turned out to be measured against the wrong thing. Both
were caught by measurement, not argument.

### §4g's "55 % of nose-to-occiput" was the wrong landmark

The sourced figure — Nanova & Prôa 2017, rostrum 61.1 % of a 121.3 mm CBL —
is measured to the **condyles**, the atlanto-occipital pivot. §4g's landmark
was the caudal pole of a head-only field, which sits further back. The same
animal reads differently on the two:

| stretch | rostrum | § 4g landmark | condyle / CBL-equivalent |
|---|---|---|---|
| 1.00 | 48.3 mm | 39.4 % | 52.3 % |
| **1.60 (shipped)** | **71.3 mm** | **49.0 %** | **61.8 %** |
| 2.07 | 90.7 mm | 55.0 % | 67.4 % |

**On the source's own landmark, stretch 1.60 is already at the sourced ratio**
— 61.8 % against 61.1 %, with the absolute rostrum just under the sourced
74.1 mm. Reaching §4g's stated 55 % would need stretch 2.07: a 90.7 mm
rostrum on a 164.9 mm head, 35 % over the sourced CBL and **longer than a red
fox's skull**. Rendered as a probe at 1.75, the eye already sits past the
middle of the head and the nose drops into a straight down-slope.

**The muzzle is done at 1.60.** §4g's numeric target is withdrawn; the
condyle-referenced figure is the one that means anything, and comparing a
craniometric ratio to a landmark the craniometrist did not use is the same
error class as §4b's "short".

Also settled: `occipitalTuck` is a dead lever and is now documented as such.
Its premise was that the coat hides a change at the caudal end. It does not —
the *neck* does, which means there is no change. A 20 mm tuck moves the
sagittal topline by ≤ 0.70 mm. Using it to reach 55 % would have been gaming
the instrument.

### "A fox is ~1:1" is a SHORT-COATED figure

I set chest:leg ≈ 1:1 as the target and §4f.4 pins the furred silhouette. The
anatomy agent showed those cannot both hold, and the arithmetic is simple
enough that I should have seen it: **a constant coat of depth *c* adds 2*c* to
the chest depth and takes *c* off the ground clearance.** So a 1.46:1 skin —
which is what we have, and which is a fox — cannot present below about 2:1
under the sourced 40–60 mm coat. Measured: skin 1.46:1, canopy 2.30:1
(2.17:1 measuring height at the withers rather than the neck crest).

And the two levers that could move it are both already spoken for. Raising
the belly canopy shrinks the furred silhouette by exactly what it raises, with
nowhere sourced to put it back — §4f.1 forbids deepening the flank coat and
the Underwood & Reynolds ranking forbids deepening the belly's. Lifting the
animal takes shoulder height from 278 mm to 293/310/333 mm for 2.00/1.75/1.50,
against the 0.28 m every source in `REFERENCE-FOX.md` §4b agrees on.

**The target is restated: chest:leg ≈ 2.0–2.2 : 1 on the furred canopy**,
which is where we are. The remaining discrepancy against a photographed fox is
**ruff**, not trunk — the neck crest reads higher than the withers, and that
is a coat-distribution question, not a proportion one.
