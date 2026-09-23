# Review 4 — VERDICT: REJECT

`A2 · B2 · G2 · C3 · D3 · E3 · F3 · H3` (weakest first). Graded numerically
against `REFERENCE-FOX.md`; WebSearch returned prose only, no viewable image.

## Nine instruments the critic believes are lying

1. **`audit.mjs` is 72% paw-bone kinematics and never looks at the image.**
   76 of 106 checks are `[gait] pawXX …` and all pass — while **the rendered
   animal has no visible foot at any framing.** A joint can be perfectly
   planted while nothing renders at its position. Tolerances confirm it was
   never an image test: "plants on the snow" passes at up to **25 mm** of
   clearance (9% of shoulder height); "IK converges" passes at a **24.1 mm**
   miss.
2. **`matte.mjs` scanned LEFT only** — a quarter of the contour, and every
   contour defect in the build lives in the other three quarters. *Fixed.*
3. **`report.json` still writes the frozen vsync `frameMs` / `fps` / `perf`**,
   identical for all 14 poses, while `measuredMs` in the same file spans
   23.3 → 87.7 ms. REVIEW.md sends critics to the JSON.
4. **The frame-time measurement is not repeatable**: `high` read 42.61 /
   17.18 / 23.51 ms in three runs within ten minutes. §10 still unenforceable.
5. **`aurora has vertical filament structure` certifies an invisible signal.**
   Max green excess anywhere in the sky is **+3.5 levels**; the sky-wide mean
   is **−2.48** — net magenta. There is no aurora in the aurora pose. The
   check asserts anisotropy and never asserts visibility.
6. **`backlit fur is lit THROUGH` cannot fail opaque fur.** Its bar is
   rim/backdrop ≥ 0.80 — a rim 20% *darker* than the sky passes a
   transmission test. Measured 0.955–1.090.
7. **The coat's colour contract is graded where the snow is also in shadow.**
   Both checks render `profile` and sample snow at (0.12w, 0.80h): B−R +27.8,
   shaded. At `hero`, where snow is lit: coat B−R **+17.7 to +22.9** against
   lit snow **+1.7**, and 14% darker against a 0.80 floor.
8. **`silhouette breaks up` reports medians**, and the defect is entirely in
   the tail of the distribution.
9. **The "neck notch" was mislabelled** — mine. The column heights reproduce
   (319 / 171 / 305) but at x=643 the span is y=324→499: the belly-to-back gap
   **between the fore and hind legs**, mid-torso, not a neck. The real
   head-to-withers dip is 13 px on a 370 px animal.

## Blockers, ranked

1. **The muzzle's silhouette is bare mesh** — 33 top-scan and 26 bottom-scan
   columns at tv 1.000, ramp 1–3 px. §4h cured the *interior*; the contour was
   never touched. The muzzle has **no card band at all**. → fur + anatomy
2. **The animal has no feet and leaves no footprints** at any gait. `addPaw`
   exists; the coat buries it whole. Distal-leg coat at 22 mm is the suspect.
   → anatomy + terrain
3. **`report.json`'s frame numbers, then repeatability.** → orchestrator
4. **`matte.mjs` must scan four directions and report p10.** → *done*
5. **The coat is long combed hair, not a dense pile** — and length and
   direction are *identical* on shoulder, flank, haunch, cheek and muzzle,
   which erases §4h's short-muzzle/deep-skull contrast. → fur
6. **The coat's lower contour is a pixel lattice** — right-angled chevrons at
   macro. Shell alpha-cut aliasing against the screen grid. → fur
7. **The shadow caster is the skin, not the coat** (6–21 px monotone shadow
   edge under a 40–80 px hairy silhouette), shadow fully detached at
   `--sun 14,-30`, **no shadow at all at `--sun 2,140`**, zero contact AO at
   any angle. → lighting
8. **There is no aurora.** → atmosphere
9. **The tail is a constant-diameter torso extension**, 135–140 px over 150 px
   of length, carried horizontally, invisible at five of fourteen framings
   while reading correctly at `low`. → fur
10. **The lit coat is 10–20% darker and ~20 levels bluer than lit snow**, and
    still 15 levels darker at `high` than at `low`. → fur
11. **The eyelid rim is bright where §4b says near-black**, with a matte-black
    false sclera inside it — §4b's "single most important detail on the face",
    inverted. → face
12. **The ears are semicircular lobes head-on** (34% narrowing over 80% of
    height, ~1.86:1 against §4c's 1:1). `power 1.8 → 1.0` did not reach the
    frontal read. → anatomy
13. **Anchored poses do not frame the subject at 390×844** — `portrait` puts
    the head at 7% of frame height instead of 70%. → orchestrator
14. **Four environment artefacts**: unantialiased horizon (43-level 1 px
    cliff), `low`-tier polyline horizon with a kink, a sawtooth LOD seam across
    `wide`'s foreground, and the picket-fence lattice in `profile`'s snow
    (5× local-contrast spike over two scanlines). → terrain
15. **The horizon haze is olive-grey (93,99,97), B−R +3.8** against §3's
    `#aac4e0` at +54 — 95 levels darker. → atmosphere

## What is genuinely good
The nose — wet, near-black, correct specular, real nostril slits, holding
value across four range checks. The macro iris: radial fibre, dark limbal
ring, round pupil, believable catchlight. Sky dither properly solved (48–73
distinct values per channel over 870 rows, longest identical run 6–7). Idle
life is real — 59% of pixels move over 1.8 s and the head genuinely turns.
Footfall order correct for all three gaits. **Production build now matches dev
to a mean delta of 1.0 level.** Zero console errors and zero shader warnings
across 14 poses, 3 gaits, 2 sun angles, 4 tiers, 2 aspect ratios. Draw calls
and triangles at a third of budget. And the frontal cheeks and ruff are 60–100
px of dense, genuinely hairy breakup — proof the system can do what the muzzle
and tail still need.
