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
  stair-stepping of review blocker 5; thicken the pinna slightly to compensate
  and watch the worst neighbour-normal angle.
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
