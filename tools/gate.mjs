#!/usr/bin/env node
/**
 * Consolidated ship/no-ship gate.
 *
 *   node tools/gate.mjs            # dev server
 *   node tools/gate.mjs --build    # production bundle (adds the vite-build check)
 *   node tools/gate.mjs --quick    # trims TAA/settle/gait states for a faster, lower-confidence pass
 *
 * Answers one question -- is this shippable right now? -- by running
 * tools/shoot.mjs and tools/audit.mjs as subprocesses and applying
 * ship/no-ship thresholds to the report.json / audit.json they already
 * write. This file owns no rendering or measurement logic of its own: those
 * two tools are the only code that ever opens a browser, and each is the
 * single source of truth for how its own numbers are computed. Duplicating
 * that logic here would give us two places that could quietly disagree
 * about what "passes" means, so this tool only ever reads their JSON.
 *
 * Two checks below still need gate.mjs to apply its OWN judgement to
 * numbers that already exist in that JSON:
 *   - audit.mjs treats a draw-call/triangle overrun as severity 'warn' (a
 *     render-quality regression, not by itself a reason to block an
 *     exploratory build), so it does not fail audit.mjs's own exit code.
 *     A ship gate wants sharper teeth than the tool wants for itself, so
 *     BUDGET below re-asserts both as hard failures -- no new measurement,
 *     just a stricter reading of numbers that were measured either way.
 *   - shoot.mjs already detects a mid-run buffer-size change (adaptive
 *     resolution leaking into a review run) and folds it into its generic
 *     error list. DETERMINISM re-derives the same fact independently,
 *     straight from each pose's recorded buffer size, so it gets its own
 *     labelled group instead of hiding inside "console errors".
 *
 * shoot.mjs and audit.mjs run SEQUENTIALLY, never concurrently: each
 * launches its own Chromium against the same GPU, and audit.mjs's own
 * "contended" warning exists precisely because a second renderer stealing
 * the GPU mid-measurement makes frame-time numbers meaningless.
 *
 * Writes shots/gate/{report.json, audit.json, gate.json, <pose>.png}.
 * Exit code is non-zero if any group fails.
 */
import { spawn } from 'node:child_process';
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = 'shots/gate';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const BUILD = has('--build');
const QUICK = has('--quick');

// Mirrors audit.mjs's BUDGET.drawCalls / BUDGET.triangles, but kept as
// gate.mjs's own constants -- not imported -- because this tool enforces
// them differently (hard failure here vs. warn there). See file header.
const MAX_DRAW_CALLS = 220;
const MAX_TRIANGLES = 3_500_000;

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const firstLine = (s) => String(s ?? '').replace(ANSI_RE, '').split('\n')[0];
const tailLines = (s, n = 20) =>
  String(s ?? '').replace(ANSI_RE, '').trim().split('\n').filter(Boolean).slice(-n);
const cap = (list, n = 10) =>
  list.length > n ? [...list.slice(0, n), `...and ${list.length - n} more`] : list;

/** Run a child process to completion, streaming its output live (indented,
 *  so it reads as "inside" the gate step that requested it) while also
 *  buffering everything so a failure can be explained after the fact. */
function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT });
    let buf = '';
    let carry = '';
    const wire = (stream, sink) => stream.on('data', (chunk) => {
      buf += chunk;
      const text = carry + chunk.toString();
      const lines = text.split('\n');
      carry = lines.pop();
      for (const line of lines) sink(`  | ${line}`);
    });
    wire(child.stdout, (l) => console.log(l));
    wire(child.stderr, (l) => console.error(l));
    child.on('close', (code) => resolve({ code, output: buf }));
    child.on('error', (err) => resolve({ code: -1, output: `${buf}\n${err}` }));
  });
}

async function readJSON(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return null; }
}

const main = async () => {
  const t0 = Date.now();
  await rm(path.resolve(ROOT, OUT), { recursive: true, force: true });
  await mkdir(path.resolve(ROOT, OUT), { recursive: true });

  console.log(`[gate] mode: ${BUILD ? 'production build' : 'dev server'}${QUICK ? ', quick' : ''}`);
  if (QUICK) {
    console.log('[gate] --quick trims TAA/settle and audit gait states for speed -- '
      + 'treat a quick PASS as "safe to keep iterating", not as a ship signal.');
  }

  // --- 1. Production build ------------------------------------------------
  let buildGroup;
  let buildFailed = false;
  if (!BUILD) {
    buildGroup = { name: 'Production build', skipped: true, ok: true,
      summary: 'skipped -- pass --build to include', notes: [], failures: [] };
  } else {
    console.log('\n[gate] vite build...');
    // This is the project's own build script (package.json: "build": "vite
    // build"), run once here as an unambiguous, standalone pass/fail signal.
    // shoot.mjs and audit.mjs both rebuild AGAIN internally when given
    // --build -- neither has a "serve the existing dist/" mode, and adding
    // one would be new shared logic outside their existing contracts. We
    // pay for three builds under --build rather than invent that.
    const res = await run('npm', ['run', 'build']);
    const ok = res.code === 0;
    buildFailed = !ok;
    buildGroup = { name: 'Production build', ok, notes: [],
      failures: ok ? [] : [`vite build exited ${res.code}`, ...tailLines(res.output)] };
  }

  let renderGroup, detGroup, auditGroup, budgetGroup;

  if (buildFailed) {
    const skip = (name) => ({ name, skipped: true, ok: true, notes: [], failures: [],
      summary: 'skipped -- production build failed' });
    renderGroup = skip('Render health');
    auditGroup = skip('Numeric audit');
    budgetGroup = skip('Budget');
    detGroup = skip('Determinism');
  } else {
    // --- 2. Render health (tools/shoot.mjs) --------------------------------
    console.log('\n[gate] shoot.mjs...');
    const shootArgs = ['tools/shoot.mjs', '--out', OUT];
    if (BUILD) shootArgs.push('--build');
    // TAA sample count and settle time only affect how visually converged
    // the PNGs are; gate.mjs never looks at pixels, only at report.json's
    // error counts and stats, so trimming them is free speed under --quick.
    if (QUICK) shootArgs.push('--taa', '8', '--settle', '1.2');
    const shootRes = await run('node', shootArgs);
    const reportData = await readJSON(path.resolve(ROOT, OUT, 'report.json'));
    const poseEntries = reportData ? Object.entries(reportData.poses || {}) : [];

    if (!reportData) {
      renderGroup = { name: 'Render health', ok: false, notes: [],
        failures: [`shoot.mjs exited ${shootRes.code} without writing report.json`,
          ...tailLines(shootRes.output)] };
      detGroup = { name: 'Determinism', ok: false, notes: [],
        failures: ['no data -- shoot.mjs did not produce report.json'] };
    } else {
      const failures = [];
      if (reportData.fatal) failures.push(`harness fatal error: ${firstLine(reportData.fatal)}`);
      if (poseEntries.length === 0) failures.push('no poses were rendered');
      for (const [name, p] of poseEntries) {
        if (!p.ok) failures.push(`pose ${name} failed to render: ${firstLine(p.error)}`);
        else if (p.renderFrameDropped) {
          failures.push(`pose ${name}: renderFrameDropped=true (claimed by [${(p.renderFrameClaimed || []).join(', ')}]) `
            + '-- the post-processing chain threw and silently fell back to an unprocessed frame');
        }
      }
      for (const e of reportData.errors || []) failures.push(`console error: ${firstLine(e)}`);
      for (const w of reportData.warnings || []) failures.push(`console warning: ${firstLine(w)}`);

      const okPoses = poseEntries.filter(([, p]) => p.ok).length;
      renderGroup = { name: 'Render health', ok: failures.length === 0, notes: [],
        failures: cap(failures),
        summary: `${okPoses}/${poseEntries.length} poses rendered, `
          + `${(reportData.errors || []).length} console error(s), `
          + `${(reportData.warnings || []).length} warning(s)` };

      // --- 5. Determinism (same data, independent question) ---------------
      const sizes = poseEntries.map(([name, p]) => [name, `${p.buffer?.width}x${p.buffer?.height}`]);
      const distinct = [...new Set(sizes.map(([, k]) => k))];
      const detFailures = [];
      if (sizes.length === 0) detFailures.push('no poses to compare');
      else if (distinct.length > 1) {
        detFailures.push('buffer size changed mid-run (adaptive resolution leaked in): '
          + sizes.map(([n, k]) => `${n}=${k}`).join(', '));
      }
      detGroup = { name: 'Determinism', ok: detFailures.length === 0, notes: [], failures: detFailures,
        summary: distinct.length === 1 ? `buffer ${distinct[0]} across all ${sizes.length} poses` : undefined };
    }

    // --- 3. Numeric audit (tools/audit.mjs) --------------------------------
    console.log('\n[gate] audit.mjs...');
    const auditArgs = ['tools/audit.mjs', '--out', OUT];
    if (BUILD) auditArgs.push('--build');
    // idle+walk already exercise foot-slide/clearance/NaN/perf on every paw;
    // trot/run add footfall-order and diagonal-pair checks on top, roughly
    // doubling this section's cost for coverage --quick is trading away.
    if (QUICK) auditArgs.push('--state', 'idle,walk');
    const auditRes = await run('node', auditArgs);
    const auditData = await readJSON(path.resolve(ROOT, OUT, 'audit.json'));

    if (!auditData) {
      auditGroup = { name: 'Numeric audit', ok: false, notes: [],
        failures: [`audit.mjs exited ${auditRes.code} without writing audit.json`,
          ...tailLines(auditRes.output)] };
    } else {
      const checks = auditData.checks || [];
      const errFails = checks.filter((c) => !c.ok && c.severity === 'error');
      const warnFails = checks.filter((c) => !c.ok && c.severity === 'warn');
      const notes = warnFails.map((c) => `warn: ${c.name} -- ${JSON.stringify(c.detail)}`);
      if (auditData.contended) {
        notes.push('GPU contention detected during audit -- frame-time budgets were not '
          + 'enforced this run (see audit.json). Re-run alone for a trustworthy number.');
      }
      auditGroup = { name: 'Numeric audit', ok: errFails.length === 0, notes: cap(notes),
        failures: cap(errFails.map((c) => `${c.name}: ${JSON.stringify(c.detail)}`)),
        summary: `${checks.length - errFails.length - warnFails.length}/${checks.length} `
          + `checks passed (${warnFails.length} warn)` };
    }

    // --- 4. Budget (draw calls / triangles; no new measurement) ------------
    const measurements = [];
    for (const [name, p] of poseEntries) {
      if (p.ok) measurements.push({ source: `pose:${name}`, drawCalls: p.drawCalls, triangles: p.triangles });
    }
    for (const [tier, p] of Object.entries(auditData?.perf || {})) {
      measurements.push({ source: `tier:${tier}`, drawCalls: p.drawCalls, triangles: p.triangles });
    }
    const budgetFailures = [];
    for (const m of measurements) {
      if (m.drawCalls > MAX_DRAW_CALLS) {
        budgetFailures.push(`${m.source}: ${m.drawCalls} draw calls > budget ${MAX_DRAW_CALLS}`);
      }
      if (m.triangles > MAX_TRIANGLES) {
        budgetFailures.push(`${m.source}: ${(m.triangles / 1e6).toFixed(2)}M triangles `
          + `> budget ${(MAX_TRIANGLES / 1e6).toFixed(1)}M`);
      }
    }
    if (measurements.length === 0) {
      budgetFailures.push('no measurements available -- both report.json and audit.json are missing/empty');
    }
    budgetGroup = { name: 'Budget', ok: budgetFailures.length === 0, notes: [], failures: budgetFailures,
      summary: measurements.length
        ? `max ${Math.max(...measurements.map((m) => m.drawCalls))} draw calls (budget ${MAX_DRAW_CALLS}), `
          + `max ${(Math.max(...measurements.map((m) => m.triangles)) / 1e6).toFixed(2)}M triangles `
          + `(budget ${(MAX_TRIANGLES / 1e6).toFixed(1)}M), across ${measurements.length} measurement(s)`
        : undefined };
  }

  // --- report ---------------------------------------------------------------
  const groups = [buildGroup, renderGroup, auditGroup, budgetGroup, detGroup];
  const applicable = groups.filter((g) => !g.skipped);
  const passed = applicable.filter((g) => g.ok);
  const totalFailures = applicable.reduce((n, g) => n + (g.ok ? 0 : g.failures.length), 0);
  const ok = applicable.length > 0 && passed.length === applicable.length;
  const durationMs = Date.now() - t0;

  console.log(`\n${'='.repeat(70)}\nGATE SUMMARY\n${'='.repeat(70)}`);
  for (const g of groups) {
    const label = g.skipped ? 'SKIP' : g.ok ? 'PASS' : 'FAIL';
    console.log(`\n${label}  ${g.name}`);
    if (g.summary) console.log(`      ${g.summary}`);
    for (const n of g.notes || []) console.log(`      note: ${n}`);
    for (const f of g.failures || []) console.log(`      FAIL: ${f}`);
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`GATE: ${ok ? 'PASS' : 'FAIL'}   (${passed.length}/${applicable.length} groups, `
    + `${totalFailures} failures, ${Math.round(durationMs / 1000)}s)`);

  const gateResult = {
    ok,
    mode: { build: BUILD, quick: QUICK },
    timestamp: new Date().toISOString(),
    durationMs,
    groups: groups.map((g) => ({
      name: g.name,
      status: g.skipped ? 'skipped' : g.ok ? 'pass' : 'fail',
      summary: g.summary ?? null,
      notes: g.notes ?? [],
      failures: g.failures ?? [],
    })),
    counts: { groups: applicable.length, groupsPassed: passed.length, failures: totalFailures },
  };
  await writeFile(path.resolve(ROOT, OUT, 'gate.json'), JSON.stringify(gateResult, null, 2));
  console.log(`full report -> ${OUT}/gate.json`);

  process.exit(ok ? 0 : 1);
};

// Unlike shoot.mjs/audit.mjs, this is the terminal step in the pipeline --
// there is no reviewer downstream to notice a silent hang or an uncaught
// rejection, so an unexpected internal failure must still resolve to a
// clean, non-zero exit rather than a dangling process.
main().catch((e) => {
  console.error('[gate] FATAL', e?.stack ?? String(e));
  process.exit(1);
});
