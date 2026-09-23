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

/** Cyclic sequence of first touchdowns, e.g. ['pawRL','pawFL','pawRR','pawFR']. */
function footfallOrder(series, keys, thresh) {
  const first = [];
  for (const k of keys) {
    const td = touchdowns(series, k, thresh);
    if (td.length) first.push([k, td[0]]);
  }
  first.sort((a, b) => a[1] - b[1]);
  return first.map((f) => f[0]);
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
        record(`[${state}] ${k} no foot slide`,
          v.maxSlideMps <= BUDGET.footSlideMaxMps,
          `ankle ${v.maxSlideMps} m/s, contact point ${v.anchorSlideMps} m/s ` +
          `(max ${BUDGET.footSlideMaxMps})`);

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
        const got = footfallOrder(out, pawKeys, 0.022);
        record(`[${state}] canid footfall order`,
          cyclicMatch(got, FOOTFALL[state]),
          `got ${got.join(' -> ') || '(no touchdowns detected)'}; ` +
          `want ${FOOTFALL[state].join(' -> ')} (cyclic)`);
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
    report.contended = (msSpread < 0.08 && triSpread > 2) || drift > 0.15;
    if (report.contended) {
      if (drift > 0.15) {
        console.log(`\n  NOTE: the SAME tier measured ${hi.frameMs} ms and ${hi.repeatMs} ms ` +
          `ten seconds apart (${(drift * 100).toFixed(0)}% drift).\n` +
          '        The machine is not quiet. Budgets are not enforced this run.');
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
