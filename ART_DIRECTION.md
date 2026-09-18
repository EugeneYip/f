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
