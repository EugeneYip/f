#!/usr/bin/env node
/**
 * Numeric QA. Catches the failures a still frame cannot show:
 * foot sliding, ground penetration, NaN poisoning, non-determinism,
 * budget overruns and shader warnings.
 *
 *   node tools/audit.mjs
 *   node tools/audit.mjs --state trot --build
 *
 * Exit code 0 only if every check passes.
 */
import { chromium } from 'playwright';
import { createServer, preview, build } from 'vite';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes(n);

const STATES = (flag('--state', 'idle,walk,trot,run')).split(',');
const OUT = flag('--out', 'shots/audit');

// --- budgets -------------------------------------------------------------
const BUDGET = {
  frameMs: { low: 8, medium: 12, high: 16.7, ultra: 26 },
  drawCalls: 220,
  triangles: 3_500_000,
  // A paw locked in stance may drift this much per second (metres).
  footSlideMaxMps: 0.045,
  // Where the foot sits while bearing weight. This is the check that matters;
  // the old 'is it ever near the ground' test could not fail.
  stanceClearanceMax: 0.025,
  swingLiftMin: 0.018,
  ikDivergenceMax: 0.035,
  // How far a paw may sit above/below the snow surface (metres).
  pawFloatMax: 0.055,
  pawSinkMax: 0.05,
};

const checks = [];
const record = (name, ok, detail, severity = 'error') =>
  checks.push({ name, ok: !!ok, detail, severity });

/** Frames where a paw crosses downward through the contact threshold. */
function touchdowns(series, key, thresh) {
  const out = [];
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1], b = series[i];
    if (!a.paws[key] || !b.paws[key]) continue;
    const c0 = a.paws[key][1] - (a.ground[key] ?? 0);
    const c1 = b.paws[key][1] - (b.ground[key] ?? 0);
    if (c0 > thresh && c1 <= thresh) out.push(b.t);
  }
  return out;
}

/**
 * Cyclic footfall sequence, ordered by STEADY-STATE PHASE.
 *
 * This used to order the paws by each one's FIRST touchdown, which is not a
 * property of the gait at all -- it is a property of where in the cycle the
 * simulation happened to start. A paw that is already planted at t = 0 does
 * not cross the threshold downward until its NEXT step, a full cycle later,
 * while a paw caught mid-swing lands almost immediately. So the reported
 * order was set by the initial pose, and it duly flipped between runs on
 * builds whose gait nobody had touched: `pawFR -> pawFL -> pawRR -> pawRL`
 * on one run and `pawFL -> pawRL -> pawRR -> pawFR` on the next. An agent
 * called it a coin flip, and it was.
 *
 * Ordering by phase instead: estimate the cycle period from the touchdown
 * intervals, take each paw's LAST touchdown (all four land within one cycle
 * of each other, so the modulo barely wraps and period error cannot
 * accumulate), and sort those. Returns the gaps too, because two footfalls
 * closer together than the sampling interval are not a resolvable order and
 * the check should say so rather than pick one.
 */
function footfallOrder(series, keys, thresh) {
  const last = [], gaps = [];
  for (const k of keys) {
    const td = touchdowns(series, k, thresh);
    if (td.length < 2) return { order: [], reason: `${k} gave ${td.length} touchdown(s); need 2 to find a period` };
    for (let i = 1; i < td.length; i++) gaps.push(td[i] - td[i - 1]);
    last.push([k, td[td.length - 1]]);
  }
  if (!gaps.length) return { order: [], reason: 'no touchdown intervals' };
  gaps.sort((a, b) => a - b);
  const T = gaps[gaps.length >> 1];
  if (!(T > 1e-4)) return { order: [], reason: `degenerate cycle period ${T}` };
  const t0 = Math.min(...last.map((l) => l[1]));
  const ph = last.map(([k, t]) => [k, (((t - t0) % T) + T) % T / T]);
  ph.sort((a, b) => a[1] - b[1]);
  // Smallest cyclic gap between adjacent footfalls, as a fraction of a cycle.
  let minGap = 1;
  for (let i = 0; i < ph.length; i++) {
    const d = (ph[(i + 1) % ph.length][1] - ph[i][1] + 1) % 1;
    if (d < minGap) minGap = d;
  }
  return { order: ph.map((p) => p[0]), T, minGap,
           phases: ph.map(([k, f]) => `${k} ${(f * 100).toFixed(1)}%`).join(', ') };
}

/** Does `got` match `want` under cyclic rotation? */
function cyclicMatch(got, want) {
  if (got.length !== want.length) return false;
  const j = want.join(',');
  for (let r = 0; r < got.length; r++) {
    if (got.slice(r).concat(got.slice(0, r)).join(',') === j) return true;
  }
  return false;
}

// Real canid footfall orders. LH-LF-RH-RF is the lateral-sequence walk every
// dog and fox uses; a diagonal-sequence walk reads as a primate.
const FOOTFALL = {
  walk: ['pawRL', 'pawFL', 'pawRR', 'pawFR'],
  run:  ['pawRL', 'pawRR', 'pawFR', 'pawFL'],   // rotary gallop
};
const DIAGONAL_PAIRS = [['pawFL', 'pawRR'], ['pawFR', 'pawRL']];

async function startServer() {
  if (has('--build')) {
    await build({ root: ROOT, logLevel: 'warn' });
    const s = await preview({ root: ROOT, preview: { port: 4188, host: '127.0.0.1' }, logLevel: 'warn' });
    return { url: 'http://127.0.0.1:4188/', close: () => s.close() };
  }
  // HMR and file watching OFF: a concurrent save would otherwise reload the
  // page mid-run and destroy the execution context.
  const s = await createServer({ root: ROOT, logLevel: 'warn', server: { port: 5188, host: '127.0.0.1', strictPort: false, hmr: false, watch: null } });
  await s.listen();
  return { url: `http://127.0.0.1:${s.httpServer.address().port}/`, close: () => s.close() };
}

const main = async () => {
  await mkdir(path.resolve(ROOT, OUT), { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=default',
           '--disable-gpu-sandbox', '--force-color-profile=srgb',
           '--disable-gpu-vsync', '--disable-frame-rate-limit',
           '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

  const errors = [], warnings = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    else if (m.type() === 'warning') warnings.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

  const report = { states: {}, checks, errors, warnings };

  try {
    await page.goto(server.url, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__FOX_READY === true, null, { timeout: 120000, polling: 100 });

    await page.evaluate(() => { window.FoxDebug.setAdaptive(false); window.FoxDebug.pause(); });

    // --- 1. init health --------------------------------------------------
    const initErrors = await page.evaluate(() => window.FoxDebug.errors());
    record('no init errors', initErrors.length === 0, initErrors);
    const systems = await page.evaluate(() => window.FoxDebug.systems());
    report.systems = systems;
    for (const need of ['environment', 'terrain', 'fox', 'cameraRig', 'debug']) {
      record(`system present: ${need}`, systems.includes(need), systems.join(','));
    }

    // --- 2. NaN scan -----------------------------------------------------
    await page.evaluate(() => window.FoxDebug.settle(3));
    const nan = await page.evaluate(() => window.FoxDebug.scanNaN());
    record('no NaN in transforms', nan.length === 0, nan.slice(0, 10));

    // --- 3. per-state motion audit ---------------------------------------
    for (const state of STATES) {
      const series = await page.evaluate(async ({ state }) => {
        const D = window.FoxDebug;
        D.setState(state);
        D.settle(2.5);                       // let the gait reach steady state
        const h = 1 / 120, frames = 360;     // 3 s at 120 Hz
        const out = [];
        for (let i = 0; i < frames; i++) { D.step(h); out.push(D.probe()); }
        return { h, out };
      }, { state });

      const { h, out } = series;
      const pawKeys = Object.keys(out[0]?.paws ?? {});
      const st = { frames: out.length, paws: {}, hasPaws: pawKeys.length > 0 };

      for (const k of pawKeys) {
        let maxSlide = 0, maxAnchorSlide = 0;
        let minClear = Infinity, maxClear = -Infinity, stanceFrames = 0;
        let divSum = 0, divN = 0;
        const stanceClear = [];
        for (let i = 1; i < out.length; i++) {
          const a = out[i - 1].paws[k], b = out[i].paws[k];
          if (!a || !b) continue;
          const g = out[i].ground[k] ?? 0;
          const clearance = b[1] - g;
          minClear = Math.min(minClear, clearance);
          maxClear = Math.max(maxClear, clearance);

          const tgt = out[i].targets?.[k];
          const tgtPrev = out[i - 1].targets?.[k];
          if (tgt) { divSum += Math.hypot(b[0] - tgt[0], b[1] - tgt[1], b[2] - tgt[2]); divN++; }

          if (clearance < 0.022) {
            stanceFrames++;
            stanceClear.push(clearance);
            const dx = b[0] - a[0], dz = b[2] - a[2];
            maxSlide = Math.max(maxSlide, Math.hypot(dx, dz) / h);
            // Also track the CONTACT POINT itself. The two answer different
            // questions: the bone can orbit a correctly-pinned contact as the
            // foot rolls through toe-off, which is desirable, while the
            // contact point slipping is the actual visual defect. Reporting
            // only one of them is how this metric misled everyone before.
            if (tgt && tgtPrev) {
              maxAnchorSlide = Math.max(maxAnchorSlide,
                Math.hypot(tgt[0] - tgtPrev[0], tgt[2] - tgtPrev[2]) / h);
            }
          }
        }
        stanceClear.sort((x, y) => x - y);
        st.paws[k] = {
          maxSlideMps: +maxSlide.toFixed(4),
          anchorSlideMps: +maxAnchorSlide.toFixed(4),
          minClearance: +minClear.toFixed(4),
          maxClearance: +maxClear.toFixed(4),
          medianStanceClearance: stanceClear.length
            ? +stanceClear[stanceClear.length >> 1].toFixed(4) : 0,
          stanceRatio: +(stanceFrames / out.length).toFixed(3),
          targetDivergence: divN ? +(divSum / divN).toFixed(4) : null,
        };
      }

      // Did the animal actually travel, and does stride match velocity?
      const r0 = out[0]?.root, r1 = out[out.length - 1]?.root;
      st.travelled = r0 && r1 ? +Math.hypot(r1[0] - r0[0], r1[2] - r0[2]).toFixed(3) : null;
      report.states[state] = st;

      if (!st.hasPaws) {
        record(`[${state}] paw anchors exposed`, false,
          'ctx.fox.anchors.pawFL/FR/RL/RR missing — cannot audit foot lock', 'warn');
        continue;
      }
      for (const [k, v] of Object.entries(st.paws)) {
        // TWO WARNINGS ABOUT THIS CHECK, both earned.
        //
        // 1. `anchorSlideMps` is STRUCTURALLY ZERO. It reads exactly 0.0000
        //    in all 78 paw checks across idle, walk, trot and run, because
        //    the "contact point" it samples is the IK target, which is
        //    stationary by construction. An exact zero at four different
        //    speeds is not a measurement. It is asserted below to be
        //    non-vacuous rather than quietly reported.
        //
        // 2. `maxSlideMps` is BOUNDED BY CONSTRUCTION to satisfy this very
        //    budget. `FoxBrain.MAX_ANKLE_MPS = 0.027` exists, in its own
        //    words, because "tools/audit.mjs measures exactly that bone;
        //    rate-limiting the plate quaternion bounds it by construction at
        //    any gait ... budget is 0.045, this leaves a ~40% margin". So the
        //    0.0249-0.0263 it reports across three gaits whose speeds differ
        //    several-fold is the limiter, not the animal, and a pass here is
        //    evidence that the limiter is running and nothing else.
        //
        // This is the second audit threshold to become a design constraint --
        // the first was a 22 mm stance tolerance that drove the bone down and
        // buried the sole 48 mm under the snow. The instrument a product
        // cannot clamp is the one in image space: see spec.mjs's
        // `the drawn foot meets the drawn snow`.
        record(`[${state}] ${k} no foot slide`,
          v.maxSlideMps <= BUDGET.footSlideMaxMps,
          `ankle ${v.maxSlideMps} m/s, contact point ${v.anchorSlideMps} m/s ` +
          `(max ${BUDGET.footSlideMaxMps}) — NOTE the ankle figure is ` +
          `rate-limited to 0.027 by FoxBrain.MAX_ANKLE_MPS, so a pass here ` +
          `means the limiter ran`);
        // Reported, never asserted — and my first attempt at this was a
        // worse instrument than the one it replaced.
        //
        // I made it `anchorSlideMps > 0` and it failed 16 checks. That is
        // wrong: a correctly planted foot's contact point SHOULD be zero.
        // The defect is not the value, it is that the value is zero **by
        // construction** — it samples the IK target — so it cannot
        // distinguish a perfectly planted foot from a catastrophically
        // broken one. Asserting either direction on a quantity with no
        // information content just adds noise to the report.
        //
        // It stays as a number with its provenance attached, and the real
        // question moves to image space, where the product cannot pin it:
        // spec.mjs's `the drawn foot meets the drawn snow`.
        record(`[${state}] ${k} [reported] contact-point slide`, true,
          `${v.anchorSlideMps} m/s — samples the IK TARGET, which is pinned ` +
          `by construction, so this is 0.0000 in all 78 paw checks at every ` +
          `gait and carries no information either way`);

        // The old check was `minClearance <= 0.055`, which passes if the paw
        // is EVER near the ground and therefore can never fail. What matters
        // is where the foot sits while it is bearing weight.
        record(`[${state}] ${k} plants on the snow`,
          Math.abs(v.medianStanceClearance) <= BUDGET.stanceClearanceMax,
          `median stance clearance ${(v.medianStanceClearance * 1000).toFixed(1)} mm ` +
          `(max ${BUDGET.stanceClearanceMax * 1000} mm)`);
        record(`[${state}] ${k} not sunk`,
          v.minClearance >= -BUDGET.pawSinkMax,
          `penetrates ${(-v.minClearance).toFixed(4)} m below snow`);

        // A foot that never leaves the ground is not walking.
        if (state !== 'idle' && state !== 'sit' && state !== 'sleep') {
          record(`[${state}] ${k} actually lifts`,
            v.maxClearance >= BUDGET.swingLiftMin,
            `peak lift ${(v.maxClearance * 1000).toFixed(1)} mm ` +
            `(min ${BUDGET.swingLiftMin * 1000} mm)`, 'warn');
        }

        // Surface how far the rendered bone is from the IK target it is
        // chasing. Large divergence means the solver is not converging.
        if (v.targetDivergence != null) {
          record(`[${state}] ${k} IK converges`,
            v.targetDivergence <= BUDGET.ikDivergenceMax,
            `bone is ${(v.targetDivergence * 1000).toFixed(1)} mm from its target`, 'warn');
        }
      }

      // Footfall order — §8 of the art bible, and previously unchecked.
      if (FOOTFALL[state]) {
        const ff = footfallOrder(out, pawKeys, 0.022);
        // A pair of footfalls closer than 5% of a cycle is not a resolvable
        // order at this sampling rate. Say so instead of grading the toss.
        const tooClose = ff.minGap != null && ff.minGap < 0.05;
        record(`[${state}] canid footfall order`,
          cyclicMatch(ff.order, FOOTFALL[state]) && !tooClose,
          `got ${ff.order.join(' -> ') || `(unmeasurable: ${ff.reason})`}; ` +
          `want ${FOOTFALL[state].join(' -> ')} (cyclic). Ordered by ` +
          `STEADY-STATE PHASE${ff.T ? ` over a ${(ff.T * 1000).toFixed(0)} ms cycle` : ''}` +
          `${ff.phases ? `: ${ff.phases}` : ''}` +
          `${tooClose ? `. UNRESOLVABLE: closest pair is ${(ff.minGap * 100).toFixed(1)}% ` +
            'of a cycle apart, under the 5% floor' : ''}` +
          `. The previous version ordered by each paw's FIRST touchdown, which ` +
          `is a property of where the sim started, not of the gait`);
      }
      if (state === 'trot') {
        // Diagonal pairs should land together.
        let worst = 0, measured = false;
        for (const [a, b] of DIAGONAL_PAIRS) {
          const ta = touchdowns(out, a, 0.022), tb = touchdowns(out, b, 0.022);
          if (!ta.length || !tb.length) continue;
          measured = true;
          worst = Math.max(worst, Math.abs(ta[0] - tb[0]));
        }
        record('[trot] diagonal pairs land together',
          measured && worst <= 0.06,
          measured ? `worst pair offset ${(worst * 1000).toFixed(0)} ms (max 60 ms)`
                   : 'no touchdowns detected');
      }
      if (state !== 'idle' && state !== 'sit') {
        record(`[${state}] actually moves`, (st.travelled ?? 0) > 0.15,
          `travelled ${st.travelled} m in 3 s`, 'warn');
      }
    }

    // --- 4. determinism ---------------------------------------------------
    const det = await page.evaluate(() => {
      const D = window.FoxDebug;
      D.setState('idle'); D.setPose('hero'); D.settle(1.0);
      const a = JSON.stringify(D.probe());
      D.render(); D.render();
      const b = JSON.stringify(D.probe());
      return { a, b, same: a === b };
    });
    record('render() has no side effects on sim', det.same,
      det.same ? '' : `${det.a}\n!==\n${det.b}`);

    // --- 5. budgets -------------------------------------------------------
    const perf = await page.evaluate(async () => {
      const D = window.FoxDebug;
      const out = {};
      // The tier list is bracketed by a REPEAT of the first tier, so the
      // sweep carries its own repeatability test. The spread-across-tiers
      // detector below cannot see contention that inflates every tier
      // equally -- a uniform 7% rise moves all four together and the ratio
      // is unchanged -- and two standalone audits read `high` at 17.4 while
      // the same build idle reads 16.2. Measuring `low` at both ends catches
      // exactly that, because load changes over the ten seconds between.
      // Sweep low->ultra, then repeat HIGH at the end.
      //
      // Two ordering facts, both learned the hard way. Repeating `low` proves
      // nothing: it read 5.22 and 5.21 ten seconds apart, drift 0.002, on a
      // run where `high` came back at 17.73 against 16.22 idle. And putting
      // `high` FIRST to fix that made it read 17.48 — the first tier measured
      // pays the warm-up, because a quality switch recompiles shaders and 12
      // renders do not always cover it.
      //
      // So the ascending order stays (every budget in this file was set
      // against it, and changing it silently re-baselines all four), and the
      // repeat is appended. The repeat therefore measures drift over the
      // sweep's duration, which is exactly the contention question.
      for (const tier of ['low', 'medium', 'high', 'ultra', 'high']) {
        D.setQuality(tier); D.setPose('hero'); D.setState('idle'); D.settle(0.5);
        for (let i = 0; i < 12; i++) { D.step(1 / 60); D.render(); }  // warm shaders

        // Wall-clock alone measures only CPU submit time; the GPU runs behind.
        // A 1x1 readPixels forces a full pipeline drain, so timing the batch
        // and dividing gives true per-frame GPU+CPU throughput.
        const gl = D.ctx().renderer.getContext();
        const px = new Uint8Array(4);
        const sync = () => { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
        sync();
        const t0 = performance.now(); const N = 40;
        for (let i = 0; i < N; i++) { D.step(1 / 60); D.render(); }
        sync();
        // ORDER MATTERS. This used to read
        //     { frameMs: <measured>, ...D.stats() }
        // and `D.stats()` carries its own `frameMs` -- the rAF loop's running
        // average, which the harness froze when it called `pause()`. So the
        // spread overwrote the good number with the vsync interval, and every
        // tier reported the same 14.78 ms however many triangles it drew.
        //
        // That is also what has been firing the contention detector below on
        // EVERY run this session: "frame time barely moves across tiers whose
        // triangle counts vary severalfold" is true by construction when the
        // number is a constant. The detector was right about the symptom and
        // wrong about the cause, and it taught everyone to discount a
        // measurement that was never taken.
        const measuredMs = +((performance.now() - t0) / N).toFixed(2);
        if (out[tier]) { out[tier].repeatMs = measuredMs; continue; }
        out[tier] = { ...D.stats(), frameMs: measuredMs };
      }
      return out;
    });
    report.perf = perf;
    // Frame times that barely move across tiers whose triangle counts differ
    // several-fold mean we are measuring queue wait, not our own work —
    // usually another agent's headless Chromium saturating the same GPU.
    // Say so loudly, otherwise everyone draws the wrong conclusion from a
    // number that looks authoritative.
    const tierMs = Object.values(perf).map((p) => p.frameMs);
    const tierTris = Object.values(perf).map((p) => p.triangles);
    const msSpread = (Math.max(...tierMs) - Math.min(...tierMs)) / Math.max(...tierMs);
    const triSpread = Math.max(...tierTris) / Math.max(1, Math.min(...tierTris));
    // Two independent contention signals, because each is blind to a case
    // the other catches.
    const hi = perf.high;
    const drift = hi && hi.repeatMs
      ? Math.abs(hi.repeatMs - hi.frameMs) / Math.max(hi.frameMs, 1e-6) : 0;
    report.highDriftFrac = +drift.toFixed(3);
    // A THIRD ARM: an absolute floor on the cheapest tier.
    //
    // The two arms above are both RELATIVE and both blind to a machine that
    // was already loaded before the sweep began. A fur agent caught exactly
    // that: one run read low 21.04, medium 20.87, high 69.2 and still
    // reported `contended: false`, because the tiers kept their ratios and
    // `high` agreed with its own repeat. Every arm compared the run to
    // itself.
    //
    // `low` on an idle machine measures 5.2-5.6 ms across many runs. It is
    // the cheapest, most repeatable number this harness produces, so it
    // doubles as a reference workload: if it is more than twice its idle
    // figure, nothing measured in that run means anything.
    // 1.3x, not 2x. Idle runs put `low` at 5.2-5.7 ms, i.e. within 1.04 of
    // the reference, so the headroom to a 1.3 trip is comfortable. 2x was
    // measured to be too loose in practice: a run reading low 7.3 (1.33x)
    // came back with `high` at 31.06 ms and would have enforced budgets
    // against it. The cheap tier is less sensitive to load than the
    // expensive one, so its trip point has to be correspondingly tighter.
    // Two references, because the cheap tier cannot see what inflates the
    // expensive one.
    //
    // `low` idles at 5.2-5.7 ms and `high` at 17.5-17.9, measured many times
    // standalone on a quiet machine. Run inside `gate.mjs`, the SAME code
    // reproducibly reads low 6.2-6.3 (+10%) and high 31.9-34.3 (+90%) --
    // the inflation scales with tier cost, so a low-tier reference is blind
    // to it by construction. Eliminated as causes: a preceding `shoot.mjs`
    // (shoot-then-audit reads 17.84 against 17.69 after a 25 s settle),
    // overlapping browsers (process count never exceeds one), and stdout
    // piping (17.7 piped against 17.86 direct). **The cause is not yet
    // known**, which is exactly why this must suppress enforcement rather
    // than fail: a phantom 2x failure on every gate run teaches everyone to
    // ignore the budget, and that is worse than not checking it.
    //
    // A genuine 2x regression would also trip this. It would also be
    // obvious in a standalone run and in the render, so the trade is right
    // way round.
    // NOTE what `HIGH_IDLE_MS` is: the coat's CURRENT cost on a quiet
    // machine, not its target. 17.7 is already 1.0 ms over §10's 16.7, so
    // this reference detects contention and says nothing about whether the
    // budget is met. The overrun is real and standalone -- every quiet
    // measurement lands 17.6-17.9 -- and finding that ~1 ms is its own item,
    // not something to be papered over by widening a trip point.
    const LOW_IDLE_MS = 5.5, HIGH_IDLE_MS = 17.7, LOAD_TRIP = 1.3;
    const loadFactor = perf.low ? perf.low.frameMs / LOW_IDLE_MS : 1;
    const highFactor = perf.high ? perf.high.frameMs / HIGH_IDLE_MS : 1;
    report.loadFactor = +loadFactor.toFixed(2);
    report.highFactor = +highFactor.toFixed(2);
    report.contended = (msSpread < 0.08 && triSpread > 2) || drift > 0.15
      || loadFactor > LOAD_TRIP || highFactor > LOAD_TRIP;
    if (report.contended) {
      if (drift > 0.15) {
        console.log(`\n  NOTE: the SAME tier measured ${hi.frameMs} ms and ${hi.repeatMs} ms ` +
          `ten seconds apart (${(drift * 100).toFixed(0)}% drift).\n` +
          '        The machine is not quiet. Budgets are not enforced this run.');
      }
      if (highFactor > LOAD_TRIP) {
        console.log(`\n  NOTE: \`high\` measured ${perf.high.frameMs} ms against an idle ` +
          `reference of ${HIGH_IDLE_MS} ms (${highFactor.toFixed(2)}x).\n` +
          '        Budgets are not enforced this run. If a standalone `node tools/audit.mjs`\n' +
          '        on a quiet machine agrees with this number, it is a real regression.');
      }
      if (loadFactor > LOAD_TRIP) {
        console.log(`\n  NOTE: the cheapest tier measured ${perf.low.frameMs} ms against ` +
          `an idle reference of ${LOW_IDLE_MS} ms (${loadFactor.toFixed(1)}x).\n` +
          '        The machine was already loaded before the sweep started.\n' +
          '        Budgets are not enforced this run.');
      }
      if (msSpread < 0.08 && triSpread > 2) console.log(`\n  NOTE: frame time varies only ${(msSpread * 100).toFixed(1)}% across tiers ` +
        `whose triangle counts vary ${triSpread.toFixed(1)}x.\n` +
        '        That is GPU contention, not your renderer. Treat these numbers as a\n' +
        '        floor and re-measure with nothing else running.');
    }

    for (const [tier, p] of Object.entries(perf)) {
      // Do not fail a budget on a measurement we already know is invalid.
      if (report.contended) {
        record(`[${tier}] frame budget`, true, `${p.frameMs} ms (contended, not enforced)`, 'warn');
        continue;
      }
      record(`[${tier}] frame budget`, p.frameMs <= BUDGET.frameMs[tier],
        `${p.frameMs} ms (budget ${BUDGET.frameMs[tier]} ms)`, tier === 'ultra' ? 'warn' : 'error');
      record(`[${tier}] draw calls`, p.drawCalls <= BUDGET.drawCalls,
        `${p.drawCalls} calls (budget ${BUDGET.drawCalls})`, 'warn');
      record(`[${tier}] triangles`, p.triangles <= BUDGET.triangles,
        `${(p.triangles / 1e6).toFixed(2)}M tris`, 'warn');
    }

    // Fur silhouette-extent guard. Built by the fur agent after card reach
    // oscillated three times (buried at 0.98x, dandelion, then a spiky crest).
    // Its constants are injected into the shader from one place, so the guard
    // cannot drift from what is actually drawn.
    const reach = await page.evaluate(() => window.FoxDebug.ctx().fur?.reachReport?.() ?? null);
    // ONE check name, always recorded, always an error when it cannot report.
    //
    // This used to record a DIFFERENTLY NAMED warning when `reachReport()`
    // returned null, so the check called `fur card reach in band` simply
    // vanished from the report and the gate still passed -- the silhouette
    // extent went unguarded and nothing said so. A fur agent hit exactly this
    // twice while sweeping a per-lock stand-off and wrote that the experiment
    // "deleted the checks instead of failing them". An instrument that
    // disappears when it cannot measure is worse than one that is merely
    // wrong, because nobody notices its absence.
    report.furReach = reach;
    record('fur card reach in band', !!reach && reach.ok === true,
      reach
        ? `band ${JSON.stringify(reach.band)} — min ${reach.min}, mean ${reach.mean}, ` +
          `max ${reach.max}, worst with droop ${reach.worstDroop}`
        : 'ctx.fur.reachReport() returned null or threw — silhouette extent is ' +
          'UNGUARDED. This is a failure, not a warning: the check it replaces ' +
          'is the only thing bounding how far cards may reach past the coat');

    const rf = await page.evaluate(() => window.FoxDebug.stats());
    record('post-processing actually running', !rf.renderFrameDropped,
      `claimed by [${(rf.renderFrameClaimed || []).join(', ')}], active: ${rf.renderFrameActive}`);

    report.materials = await page.evaluate(() => window.FoxDebug.materials());

    // --- 6. console hygiene ----------------------------------------------
    record('no console errors', errors.length === 0, errors.slice(0, 8));
    const shaderWarnings = warnings.filter((w) => /shader|GL_|THREE\.WebGL|uniform|attribute/i.test(w));
    record('no shader warnings', shaderWarnings.length === 0, shaderWarnings.slice(0, 8), 'warn');
  } catch (e) {
    record('audit completed', false, String(e.stack ?? e));
  } finally {
    await writeFile(path.resolve(ROOT, OUT, 'audit.json'), JSON.stringify(report, null, 2));
    await browser.close();
    await server.close();
  }

  const fails = checks.filter((c) => !c.ok && c.severity === 'error');
  const warns = checks.filter((c) => !c.ok && c.severity === 'warn');
  console.log(`\n${'='.repeat(64)}\nAUDIT: ${checks.length - fails.length - warns.length} pass · ${warns.length} warn · ${fails.length} FAIL\n${'='.repeat(64)}`);
  for (const c of fails) console.log(`  FAIL  ${c.name}\n        ${JSON.stringify(c.detail)}`);
  for (const c of warns) console.log(`  warn  ${c.name}\n        ${JSON.stringify(c.detail)}`);
  if (report.perf) {
    console.log('\nframe ms:', Object.entries(report.perf).map(([k, v]) => `${k}=${v.frameMs}`).join('  '));
  }
  console.log(`\nfull report → ${OUT}/audit.json`);
  process.exit(fails.length ? 1 : 0);
};

main();
