# Review 3 — VERDICT: REJECT

`A2 B2 E2 C3 D3 F4 G4 H4` (weakest first). Graded numerically against
`REFERENCE-FOX.md` with pixels measured out of the PNGs; WebSearch returned
only text, so no photographic comparison was possible this round.

## Five instruments certifying defects that are visible in the render

Found by the critic. All five are the orchestrator's.

1. **`lit coat is not warm` cannot fail blue.** It asserts only `R − B < 10`,
   so a coat at B−R = **+59** passes. And it is sampling the **bare muzzle
   skin**: the critic read (88,116,147) at `chin.png` (900,500), on the
   hairless disc — the same value the gate reports as "lit coat". A gate
   actively certifying the top blocker as correct.
2. **`fur reads as hair at macro: muzzle` passes on a bare muzzle.** It exists
   specifically to catch bare muzzle skin, and `chin.png` is 100% bare skin
   varying ±3 levels over 400 px while the gate reads 11.18. It must be
   catching whiskers or the fur ring outside the disc.
3. **`silhouette is hair, not a curve: body` only samples torso rows.** It
   passes by 0.034 while all four legs measure a clean monotonic ramp — p10
   ≈ 1.0, bare mesh. §4f says trace the WHOLE contour.
4. **`backlit fur transmits` compares rim against core**, which hides that the
   rim is **32% darker than the snow behind it**: (153,146,142) against
   (218,218,218) at `silhouette`, and warm-grey rather than hot white.
5. **`aurora has vertical filament structure`** measures whole-frame gradient
   energy, swamped by sun, stars and horizon. Passes at 1.039 on three
   unambiguously horizontal smears. (Correctly flagged `[unvalidated]`.)

Also: "the concha saw-tooth is visible only with the coat hidden" is false —
plainly visible with the coat on in `nape.png` (760–1010, 320–520).

## Blockers, ranked

1. **Shell fur darkens and blue-shifts multiplicatively with shell count.**
   high (81,108,140) / low (118,141,166) / phone (145,158,182) against snow
   ~(182,184,195); palette target `#fdfcfa`. Monotonic with shell count means
   per-shell transmittance / energy conservation, not grade. *Highest-leverage
   change in the build — it is why the animal reads as ice.* → fur
2. **Bare skin on muzzle, chin, haunch, pinna interior.** `chin.png` is ~600 px
   of flat skin behind a literal 12-sided polygonal fur boundary, ±3 levels
   over 400 px. §4f standard 3, automatic ≤4. → anatomy
3. **Limbs collapse in motion.** No legs *at all* at `run` — a furry blimp with
   translucent drips. Three flat shards at `trot`, belly intersecting terrain.
   A crash of the limb/fur path, not an art note. → animation + fur
4. **Legs and paws are hairless, jointless posts.** No hock (the hindleg is one
   straight post; a canid's is a Z), no digits, no pads. Foreleg edge scan is a
   monotonic 13 px ramp with no hair crossing it. → anatomy
5. **Shadow peter-panning, and the shadow caster is the skin only.** `nape.png`
   proves it: ears span 670 px, their shadow 250 px with a clean geometric
   outline. Plus a ~100 px detached shadow at `sun2`, a gap at `terrain` and
   `aurora`, and *no shadow at all* at `sun1` (2° sun). This is what makes the
   fox float. → postfx/lighting
6. **Foot sliding ≈33% of stride.** Root Z 0 → 0.1692 m in 0.242 s needs 277 px
   of screen travel; the near foreleg moved ~185 px and a hind foot ~150 px.
   Four identical parallel shadow bars during a walk. → animation
7. **No tail at `high`.** The geometry is fine — `review-N-low/hero.png` has a
   clear, separate, correctly low-carried brush. The high-tier rump/flank coat
   swells over the tail base and swallows it. → fur
8. **Fur is spines, not locks** at `nape`, `paws`, `macro_eye`: uniform-length
   rigid needles, no clumping, curvature, crossing or gravity; flat 1–2 px
   scratches with no cylindrical shading at macro. → fur
9. **No pupil and no eyelid rim at normal framings**; eyes asymmetric in
   `frontal`; the macro rim overcorrects to a black O-ring. → face
10. **The bulk is still bone.** chest:leg **2.9:1** (a fox is ~1:1), dead
    straight topline and belly line, constant coat depth. → anatomy
11. **Visible faceting** on skull, ears and macro face. Non-negotiable #2.
12. **Production build ≠ dev**: 28 triangles and 8–15 level pixel deltas on the
    fox, while terrain is bit-identical. → orchestrator
13. **No trustworthy perf measurement.** `frameMs` is 15.69 for all 14 poses
    (the vsync interval); `perf` reports ultra faster than low. → orchestrator
14. **The mouth is a hard-edged black decal** that protrudes past the
    silhouette in `paws.png`. → face
15. **DoF focuses in front of the subject** at `tail.png`. → postfx

## Notable, not blocking
Ears high and close rather than wide and low; no cheek ruff flare (head widest
at ear base, not cheek). Muzzle:braincase 0.9:1 against a callipered 1.57:1.
Whiskers too few, perfectly radial from a point outside the pad, no brow
whiskers. Aurora has no vertical structure and no snow reflection; sun, stars
and aurora coexist. Grass billboards identical and screen-space-sized; sparkle
does not scale with distance. Orphaned white shards on the snow. Horizon
perfectly straight; subject dead-centre in four framings.

## Genuinely good
Sky dither measured properly: 684 distinct values over 800 rows, zero long runs
on the teal ramp. Highlights roll off (0.05% at/above 252), shadows stay
chromatic. The nose is the one fully realised material — wet, black, specular,
real nostril slits, holding value across all four range checks. The macro iris
is amber with a dark limbal ring and a round pupil. Zero console errors and
zero shader warnings across 14 poses; draw calls and triangles at a third of
budget; determinism holds.
