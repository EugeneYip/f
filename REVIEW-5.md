# Review 5 — VERDICT: REJECT

`A2 · B2 · D2 · E2 · C3 · F3 · G3 · H3`. Graded numerically against
`REFERENCE-FOX.md`; WebSearch returned prose and stock-photo listings only.

## One blocker of the critic's that is WRONG, checked before acting on it

**"The fox locomotes on the spot — root x and z are exactly 0 in walk, trot
and run."** It is not. Root z measured at three settle times in `run`:

    settle 1.0 -> z = -2.7      settle 2.5 -> z = 0      settle 4.0 -> z = +2.7

5.4 m in 3 s. The critic read a single review render, and `REVIEW_SETTLE`
deliberately launches the animal *upstream* so it **arrives** at the origin
after the harness's 2.5 s settle — that is what puts it inside the absolute
camera poses. Root ≈ 0 in a review frame is the mark working.

Its other observations inside that blocker — no spinal flexion at `run`, a
rigid broomstick tail, a detached hairless foreleg wedge — are not covered by
this correction and stand until measured.

## Thirteen instruments the critic believes are lying

1. **`no foot slide` measures a structurally-zero quantity** — contact point
   reads **exactly 0.0000 in all 78 paw checks across idle, walk, trot and
   run**. That is the IK target, stationary by construction. *This is a
   regression of a fix made earlier in the same session.*
2. **`IK converges` reports exactly 23.5 mm for every paw in every gait** —
   twelve combinations, one number. A constant offset, not a convergence
   error; it cannot detect an IK failure at all.
3. **audit and spec contradict each other and audit claims success.** audit:
   `pawFL not sunk, penetrates -0.0065 m` PASS. spec: the drawn foot is
   **34.4 mm below the snow line** FAIL. A 5x disagreement between bone and
   pixels — and 78 of audit's 98 checks are paw kinematics.
4. **All four frame-budget checks pass while declaring themselves void**,
   with the audit reporting **350% drift** (19.96 vs 89.89 ms).
5. `fur card reach in band` asserts on the **mean** while its own reported
   min and max are both outside the band.
6. `highlights not clipped` pools over the whole frame; the portrait ruff is
   **16.54% of pixels ≥252 and 7.53% railed at exactly 255**.
7. **`no hard horizon step` FAILS when the horizon is perfect** — its
   predicate needs `agreeing >= 4`, so "no coherent edge found" fails. The
   horizon measures a 0.83–1.77 level max jump at `high`.
8. `aurora has vertical filament structure` asserts a gradient *ratio* and
   never an amplitude: **0 of 1782 sky cells exceed +3 green excess; the
   most-green cell is −0.51, the median −4.61** against §3's +94.5.
9. `fur covers camera-facing surfaces` has a 1.2-level bar against lit snow's
   own 7.80 of natural texture — ~6x under the noise floor.
10. Both coat-colour checks are one-sided and cannot fail toward grey; the
    shaded coat measures B−R **+11.4** against §3's **+31**.
11. `eye is warm` has **13x slack**: bar +6, §3's iris +79, measured +41.
12. `fur reads as hair at macro: muzzle` uses a floor that is 35% of the brow
    — global degradation is invisible to it.
13. No instrument measures any tier but `high`, and the audit's per-tier
    frame-budget lines read as coverage when only frame time is covered.

## Blockers, ranked
1. **The torso is not a shadow caster** — only legs and fur cards are. Wide
   framings show four thin parallel strips with lit snow between; at `nape`
   the only shadow is a detached five-pronged finger floating above the head
   (ear cards casting, skull not). No shadow at all at `tail` or `--sun 2,140`.
2. **The feet are 34 mm underground** and the foreleg is a smooth cone sliced
   flat by the ground plane. At `low` the paws render with toe bumps, so the
   geometry is fine and the `high` coat buries it.
3. **Bare smooth geometry over large runs** — the nape is a 950×650 px
   hairless surface, the largest object in its frame. spec fails all four
   `profile` contours: top 14.4%, left 11.0%, right 6.6%, bottom 5.2%.
4. **The coat is feathers, not fur** — broad flat translucent vanes 17–40 px
   wide with a central shaft and parallel diagonal barbs, overlapping in rows
   like plumage, with **319 perfectly vertical luminance risers, longest 59
   rows** against a snow control's longest 5.
5. **The eye has no lid, no lashes, no canthus**, a uniform-width dark
   annulus that does not thicken at the corners, and a 50–90 px pale ring
   **+38 levels brighter than the cheek** outside it.
6. **A hard-edged blue polygon chip sits on the face at `portrait`** — the far
   eye's assembly reading through the muzzle.
7. **The nose pad is visibly faceted at `chin`** — ~12–14 traceable facet
   edges. §2.2 is a non-negotiable and `chin` is in `shots/`.
8. *(corrected above — the locomotion claim is false; the rigidity claims
   stand)*
9. **No aurora and no footprints** at any pose or gait; contact AO absent, and
   the penumbra is inverted (11 levels at the foot, 45 over 16 px at 450 px away).
10. **The coat's surface is smoother than the ground** — flank HF sd 4.21
    against lit snow's 7.80.
11. **Backlit fur is opaque** — rim/core 1.040 against a 1.12 bar, and that
    check has been demoted to non-asserting while the asserted one reads the
    sky through a gap.
12. **`low` is a different, worse animal** and nothing measures it: ears at
    1.43:1 with flat blunt tops (the rabbit §4c forbids), 16 levels of form
    shading against high's 62, a 0.6-level cast shadow.
13. Anchored poses still do not reframe at 390×844 (~11% of frame height).
14. **The bulk is still bone**: uniform-diameter sausage, no withers, no
    croup, no hock, plantigrade stance, and the coat fringe is a 30–50 px
    skirt on a ~300 px animal.
15. Local highlight clipping on the subject; `frame has contrast` fails at
    sd 32.6 against a 35 bar.

## The critic's own retractions, which are worth keeping
Its first-pass reads that it then disproved: the white patches at `tail` are
DoF-blurred crust, not litter; the `wide` sawtooth LOD seam is an organic
sastrugi ridge and appears **fixed**; the `profile` picket fence shows no
periodic autocorrelation at any lag and appears **fixed**; the far ear at
`hero` is not pierced.

## What is genuinely good
The rhinarium, measured (18,21,28) against §3's (23,26,32), holding across
four framings. The macro iris's radial fibre and limbal ring. **Snow is the
strongest system in the build** — genuine multi-scale sastrugi, wind-carved
swales, discrete varied sparkle. Composition at `wide`, `aurora` and
`terrain`. Sky dither solved. **The horizon cliff is fixed at `high`** — 0.83–
1.77 levels where REVIEW-4 measured 43. `report.json`'s frozen vsync fields
are gone. **The production build is pixel-identical to dev, mean delta 0.00.**
Zero console errors and zero shader warnings across 14 poses, 3 gaits, 2 sun
angles, 4 tiers, 2 aspect ratios and the production bundle. And `frontal`'s
cheek and ruff read **0.0 / 1.2 / 0.7 / 0.0 %** below the hair floor on all
four edges — proof the fur system can do what `profile` still cannot.
