# Where the ~5M tokens went, and how to spend 1%

Measured, not estimated. Every number here comes from agent-reported token
counts, timed harness runs, or the git history of this repo.

## 1. Baseline

Subagent spend, cumulative per agent:

| agent | tokens | rounds |
|---|---:|---:|
| fur | 786,559 | 6 |
| anatomy | 784,651 | 6 |
| postfx | 666,976 | 5 |
| animation | 666,876 | 3 |
| atmosphere | 602,897 | 2 |
| terrain | 586,368 | 1 |
| face | 506,353 | 3 |
| critic | 320,425 | 1 |
| camera+ui (died early) | ~150,000 | — |
| **total** | **~5.07M** | **27+** |

Output: ~20,000 lines of `src/`, ~1,400 lines of `tools/`, 43 commits.

## 2. Verification is effectively free; review is not

| | wall clock | tokens |
|---|---:|---:|
| `shoot.mjs`, 6 poses | 8 s | 0 |
| `audit.mjs`, 2 states | 14 s | 0 |
| `spec.mjs`, 13 invariants | 6 s | 0 |
| `gate.mjs` (everything) | 28 s | 0 |
| one hostile critic pass | 22 min | 320,425 |

**Of the critic's 16 blockers, 13 were numerically detectable.** Not "in
principle" — `tools/spec.mjs` now detects several of them directly, and found
one still-open defect (the horizon step, 47 levels) that the critic reported
and nobody ever fixed.

The three that genuinely needed eyes: aurora curtain structure, compositional
balance, and whether the animal has charm.

## 3. Model tiering — measured

Two tooling tasks, both fully specified with an objective pass/fail:

| experiment | model | tokens | wall clock | result |
|---|---|---:|---:|---|
| A — contact sheet | Haiku | 43,624 | 69 s | pass, self-verified visually |
| B — consolidated CI gate | Sonnet | 143,594 | 13 min | pass, verified in both directions |
| baseline content round | Opus | 506k–787k | 5–30 min | — |

Haiku did A for **5.5–8.6%** of a typical Opus content round. Sonnet did the
harder, integration-heavy B for **18–28%**.

The distinguishing feature is not difficulty, it is **specifiability**. Both
tasks had a closed-form definition of done. Neither required taste.

## 4. Where the waste actually was

Rework attributable to the orchestrator, with counts from this transcript:

**a. Diagnoses handed down and then disproved — 10 occurrences.** The salmon
cast (I said diffuse over-weighting; it was the forward-scattering term), the
lens smudge (near-layer snow; it was spindrift), the DoF veil (far-field
bleed; it was not DoF at all), macro aliasing (octave undersampling; every
octave was *above* Nyquist), the nose rectangles (face pad, then fur cards; it
was a shell dither hashing cubes), the tail offset (integration bias; it was
an intentional carriage), the motion lag (damping constants; it was cascade
topology), fur card length (too long — twice; it was droop, then sparseness).

Each cost an agent a measure-and-disprove cycle before real work began.

**b. Specification error — ~2 full anatomy rounds (~260k).** §4b conflated
*short* with *blunt*, which are different axes. Anatomy implemented it
faithfully and produced a bear. §4c corrected it. The client's reference
photographs existed from the start of that section — my reading of them was
wrong, not the reference.

**c. Adjective-driven oscillation — ~3 fur rounds (~390k).** "Too long", "too
short", "still too long", with no number attached. Ended only when a numeric
band (1.10–1.25× coat thickness) and a regression guard replaced the
adjectives.

**d. Instruments that lied — 6 found.** A foot-slide probe reading IK targets
(pinned by construction) and reporting a meaningless `0.0000`; `__FOX_READY`
raised before boot finished; adaptive resolution leaking into review runs so
two runs weren't comparable; Vite HMR hot-reloading pages mid-capture and
looking like driver deaths; a `renderFrame` that threw once and was silently
disabled for the session; and — while writing this document — `spec.mjs`'s own
silhouette check passing for the wrong reason.

A conservative floor, counting only whole rounds: **~22% of spend was rework
caused by the orchestrator.**

## 5. The 1% question, answered honestly

**Getting this original build to ~50k tokens is not credible.** Twenty
thousand lines including novel shader work is not a one-shot task, and most of
the spend was genuine discovery: nobody knew a Voronoi site sliced by concentric
shells becomes a stack of discs until fur measured it.

The question decomposes into three, with different answers:

### (a) Marginal defect cost — plausibly ~1%
Once a gate defines "done", a defect becomes a closed-form task. This is what
experiment C tests directly: a real open defect, a cheap model, a failing
numeric test as the entire brief.

### (b) Rebuild cost — realistically 15–25%, not 1%
With `ART_DIRECTION.md` (corrected), `REVIEW.md`, the four harnesses and the
regression guards in hand, plus the process changes in §6, a rebuild of this
same scope should land around 800k–1.2M. A 4–6× saving, not 100×.

### (c) Sibling-project cost — genuinely ~1–5%
**This is the real answer.** The reusable asset is not the process, it is the
repository. A wolf, a hare, or a second creature in this same engine inherits
the renderer, the quality tiers, the fur system, the gait engine, the snow, the
sky, and all four gates. The marginal cost is the creature-specific SDF and its
art direction.

Claiming 1% for (a) and (c) is defensible. Claiming it for (b) would not be.

## 6. The changes that would have paid for themselves

Ranked by measured evidence, not intuition:

1. **Gate before you review.** Run `gate.mjs` and `spec.mjs` before spending a
   single critic token. 13 of 16 blockers, in 34 seconds, for nothing.
2. **Never hand down a diagnosis.** Report the observation, the pose and the
   measurement; let the owner diagnose. Ten wrong hypotheses cost ten
   disproof cycles. The agents were right every time.
3. **Numbers, never adjectives.** "Card reach 1.10–1.25× coat thickness" ended
   an oscillation that "too long" had sustained across three rounds.
4. **Every fix ships with a guard.** The fur reach guard costs one round and
   would have prevented three. Its constants are injected into the shader from
   one place, so it cannot drift from what is actually drawn.
5. **Verify the instrument before trusting the measurement.** Six instruments
   lied here. A metric reading *exactly* zero is a red flag, not a result.
6. **Tier the models.** Haiku for specified tooling, Sonnet for integration,
   Opus only where taste or novel shader reasoning is required.
7. **Reference material at specification time.** §4b's error was authored
   before the reference photographs were in hand.

## 7. What still cannot be automated

Aurora curtain structure. Compositional balance. Whether the ears read as a fox
or a rabbit — a distinction the client made instantly and no metric here would
have caught. Gates make review cheaper by removing arithmetic from it; they do
not remove the need for someone with taste to look.
