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
| C — fix a gated defect | Sonnet | 251,453 | 40 min | check passes, **product damaged** (see §5a) |
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

### (a) Marginal defect cost — plausibly ~1%, **with a serious caveat**
Once a gate defines "done", a defect becomes a closed-form task. Experiment C
tested this directly and returned the most important result of the three.

**Experiment C — Sonnet, 251,453 tokens, 75 tool uses, 40 min.** Brief: one
failing numeric check (`no hard horizon step`, 47 levels), the gate as the sole
definition of done. Explicit instruction: *"Do not change the test. Moving the
threshold is not a fix."*

It did not move the threshold. It did something more instructive: it traced the
failure correctly — proving with a clean ablation chain that the offending pixel
was **not** a horizon seam at all but a single snow sparkle glint clipping to
white — and then satisfied the check by **cutting the art bible's crystal-glint
intensity from 240 to 70**. A 71% reduction of a mandated feature (§6: "discrete,
view-dependent specular glints") to move a number.

It was entirely transparent about this, and its diagnosis was right. The fault is
**the gate's, and therefore mine**: a single-column sampler cannot distinguish a
horizon seam from a bright specular point. Both are a large one-row jump.

Rewriting the check to require **horizontal coherence** — a real seam steps at the
same y across most of the frame; a glint is an isolated 2–4 px point — the truth
emerges:

```
largest horizontally coherent jump:  17 levels  (14/40 columns agree)
loudest isolated point:              56 levels  (the sparkle)
```

**The defect never existed.** The sparkle reduction has been reverted.

**So the caveat on this whole approach is:** a cheap model given a bad gate will
satisfy it by damaging the product, efficiently and in good faith. Gates transfer
the burden of correctness from the reviewer to the instrument — they do not
remove it.

Honest instrument defect rate on this very document's tooling: **3 of 13 checks in
`spec.mjs` were wrong on first authoring** — the silhouette check passed by
measuring the sky's gradient rather than the fur edge; the horizon check produced
the false positive above; the scrim check asserted on a single darkest pixel and
flaked between runs with no code change. All three were caught, two of them by
agents rather than by me. That is a 23% first-pass defect rate on instruments
written by the person who knew exactly what they were supposed to measure.

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
5. **Verify the instrument before trusting the measurement.** Nine instruments
   lied here — six in the project, three in the gate written to catch them. A
   metric reading *exactly* zero is a red flag, not a result; so is a check that
   has never been seen to fail, and so is one that fails on a single pixel.
   Every check in `spec.mjs` now prints its raw measurement beside its verdict,
   so a wrong threshold is visible rather than authoritative.
6. **Tier the models.** Haiku for specified tooling, Sonnet for integration,
   Opus only where taste or novel shader reasoning is required.
7. **Reference material at specification time.** §4b's error was authored
   before the reference photographs were in hand.

## 7. What still cannot be automated

Aurora curtain structure. Compositional balance. Whether the ears read as a fox
or a rabbit — a distinction the client made instantly and no metric here would
have caught. Gates make review cheaper by removing arithmetic from it; they do
not remove the need for someone with taste to look.

---

## 8. Addendum: one more session of evidence, and it moves the answer

Written after a session that produced eleven substantive fixes across five
owners. It changes §4's conclusion about where the waste is, because the waste
turned out to be more concentrated than §4 estimated.

### The instrument tax dominates, and it is measurable

Of the eleven defects resolved this session, **seven were defects in the
measuring apparatus rather than in the product**:

| defect | what it actually was |
|---|---|
| "the animal's interior is visible" | depth of field; the coat never wrote depth, so DoF resolved coat fringe as the snow behind it |
| "the fur macro gate fails" | the gate's eye-radius estimator, twice — a ring quorum that marched past the eye, then a threshold sitting inside the noise |
| "the nose is too bright at profile" | the probe sampling coat around a pad that stands 5.8 mm proud of its anchor |
| "the eye loses chroma through post" | four animation systems keeping private clocks, so the harness's time rewind moved `ctx.time` and nothing else |
| "the silhouette is hard" (gate reading) | the gate measured post, normalised by a shadowed interior, and used a metric blind to resolved hair |
| "fur is not the cause" (any A/B using `nofur`) | the variant referenced a property that never existed and rendered `base` twice |
| "§8b: overshoot must stay under 18%" | measured without a no-step control; the spring overshoots 0.007% |

The product defects — coat depth in the wrong place, a round-cone ear with a
straight silhouette, a concha carved by a sphere wider than the pinna, a human
cornea-to-globe ratio on a fox — took far less effort to fix than to find,
because finding them meant first establishing that the instrument pointing
elsewhere was wrong.

**So the single highest-leverage intervention is not a faster model, a better
prompt or more parallelism. It is requiring a positive control before a gate
is allowed to assert.** Every gate that has ever been wrong here was wrong in
the same way: it had never been shown to fail on something known-bad. A gate
with a control in the same frame costs one extra render — call it 4% of a
spec run — and would have prevented five of the seven rows above.

### What parallel agents are genuinely good at

The pattern that produced every real find this session: **give the agent the
symptom and the evidence, label your own diagnosis explicitly as a hypothesis,
and tell it that disproving you is a success.** Agents did disprove the
handed-down diagnosis eleven times across the project and were right every
time. The two largest finds of this session — depth of field, and the human
cornea ratio — both came from an agent refusing the brief it was given.

The inverse also held, exactly once and expensively: an agent given a bad gate
and no licence to question it cleared the gate by cutting art-bible snow
sparkle 71%.

### Revised estimate

§5(a)'s "~1% for a marginal defect" stands, but §4's implied route to it was
wrong. Getting there is not mostly about cheaper models or tighter loops. On
this evidence it is roughly:

- **60% instrument discipline** — positive controls, feature-seeking probes,
  one simulation instant per comparison, no private clocks. Mechanical, and
  now written into `AGENTS.md` so each wave does not rediscover it.
- **25% not re-deriving settled facts** — the art bible carried a "short blunt
  muzzle" line for months after §4c superseded it, and `REVIEW.md` was still
  handing it to critics this session.
- **15% everything else**, including model tiering, which §3 already showed is
  a small effect next to these.

### One cost that is irreducible and was underestimated

Session usage limits killed two complete waves of agents mid-flight. The
mitigation that worked was not avoidance but **salvage**: instruct every agent
to commit incrementally, then have the orchestrator recover and land unfinished
work on their behalf. Three agents' final edits survived that way this session,
including a shader change that completed a uniform committed an hour earlier.
Agents that were told to commit as they went lost minutes; the first wave,
which was not, lost everything.
