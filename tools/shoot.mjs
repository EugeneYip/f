#!/usr/bin/env node
/**
 * Offline review renderer.
 *
 *   node tools/shoot.mjs                         # all poses, dev server
 *   node tools/shoot.mjs --poses hero,portrait
 *   node tools/shoot.mjs --build                 # verify the production bundle
 *   node tools/shoot.mjs --out shots/wave2 --size 1600x1000 --dsf 2
 *   node tools/shoot.mjs --state walk --settle 4
 *
 * Writes <out>/<pose>.png plus <out>/report.json (stats, console errors,
 * WebGL info). Exit code is non-zero if the page threw or a pose failed, so
 * this doubles as CI.
 */
import { chromium } from 'playwright';
import { createServer, preview, build } from 'vite';
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const USAGE = `
shoot.mjs — render named camera poses in headless Chromium

  --poses a,b,c   poses to render (default: all)
  --out DIR       output directory (default shots/latest) — CLEARED before use
  --size WxH      viewport (default 1280x800)
  --dsf N         device scale factor (default 1.5)
  --settle S      seconds of simulation before the first shot (default 2.5)
  --taa N         renders per pose for TAA convergence (default 18)
  --state NAME    idle|walk|trot|run|sit ...
  --quality NAME  low|medium|high|ultra
  --sun E,A       sun elevation,azimuth in degrees
  --wind S,G      wind speed,gust
  --build         use the production bundle
  --keep          do NOT clear --out first
  --ui            keep the DOM overlay visible (hidden by default)
  --url URL       shoot an already-running server
`.trim();

/**
 * Clear an output directory — but only if it looks like one of ours.
 *
 * This tool used to `rm -rf` whatever `--out` pointed at, with `--out`
 * defaulting to `shots`. A bare invocation therefore destroyed every shot
 * directory in the project. Refuse to delete anything containing entries that
 * are not our own output, and never delete the shots root itself.
 */
async function safeClean(dir) {
  const rel = path.relative(ROOT, dir);
  if (rel === 'shots' || rel === '' || rel.startsWith('..')) {
    console.error(`[shoot] refusing to clear "${rel || dir}" — pass a subdirectory, ` +
      'e.g. --out shots/mywork');
    process.exit(2);
  }
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return;                                   // does not exist yet: nothing to do
  }
  const foreign = entries.filter((e) => !/\.(png|json|jpg|webp)$/i.test(e));
  if (foreign.length) {
    console.error(`[shoot] refusing to clear ${rel}: it holds ${foreign.length} ` +
      `entr${foreign.length === 1 ? 'y' : 'ies'} this tool did not write ` +
      `(${foreign.slice(0, 4).join(', ')}${foreign.length > 4 ? ', …' : ''}). ` +
      'Use --keep, or choose an empty directory.');
    process.exit(2);
  }
  await rm(dir, { recursive: true, force: true });
}

function parseArgs(argv) {
  // NOT 'shots'. This tool deletes its output directory before writing, so a
  // default of 'shots' meant a bare `node tools/shoot.mjs` wiped every shot
  // directory in the project. A critic lost ~190 of them that way, including
  // the gate, spec and audit reports, and shots/ is gitignored so none of it
  // was recoverable.
  const a = { out: 'shots/latest', size: '1280x800', dsf: 1.5, settle: 2.5, taa: 18, timeout: 120000 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--poses') a.poses = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--out') a.out = next();
    else if (k === '--size') a.size = next();
    else if (k === '--dsf') a.dsf = parseFloat(next());
    else if (k === '--settle') a.settle = parseFloat(next());
    else if (k === '--taa') a.taa = parseInt(next(), 10);
    else if (k === '--state') a.state = next();
    else if (k === '--quality') a.quality = next();
    else if (k === '--build') a.build = true;
    else if (k === '--keep') a.keep = true;
    else if (k === '--sun') a.sun = next().split(',').map(Number);
    else if (k === '--wind') a.wind = next().split(',').map(Number);
    else if (k === '--timeout') a.timeout = parseInt(next(), 10);
    else if (k === '--url') a.url = next();
    else if (k === '--ui') a.ui = true;
    else if (k === '--help' || k === '-h') { console.log(USAGE); process.exit(0); }
    else {
      // Silently ignoring an unknown flag is how `--help` ended up running the
      // destructive default path.
      console.error(`[shoot] unknown option: ${k}\n${USAGE}`);
      process.exit(2);
    }
  }
  const [w, h] = a.size.split('x').map(Number);
  a.width = w || 1280; a.height = h || 800;
  return a;
}

const CHROME_ARGS = [
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--enable-zero-copy',
  '--disable-gpu-sandbox',
  '--use-angle=default',
  '--disable-dev-shm-usage',
  '--force-color-profile=srgb',
  '--disable-lcd-text',
  '--disable-partial-raster',
  '--js-flags=--max-old-space-size=4096',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
  '--run-all-compositor-stages-before-draw',
  '--disable-new-content-rendering-timeout',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

async function startServer(args) {
  if (args.url) return { url: args.url, close: async () => {} };
  if (args.build) {
    await build({ root: ROOT, logLevel: 'warn' });
    const server = await preview({ root: ROOT, preview: { port: 4173, host: '127.0.0.1' }, logLevel: 'warn' });
    return { url: 'http://127.0.0.1:4173/', close: () => server.close() };
  }
  // HMR and file watching are OFF. Several agents edit this tree at once, and
// a save landing mid-run hot-reloads the page and destroys the execution
// context -- which is indistinguishable from a renderer or driver death.
const server = await createServer({
    root: ROOT, logLevel: 'warn',
    server: { port: 5199, host: '127.0.0.1', strictPort: false, hmr: false, watch: null },
  });
  await server.listen();
  const addr = server.httpServer.address();
  return { url: `http://127.0.0.1:${addr.port}/`, close: () => server.close() };
}

/** Screenshots occasionally lose a race with compositing; one retry is cheap
 *  and turns a flaky red run into a green one. */
async function shotWithRetry(page, file, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await page.screenshot({ path: file, caret: 'hide', timeout: 20000 });
    } catch (e) {
      lastErr = e;
      await page.evaluate(() => window.FoxDebug?.render?.());
    }
  }
  throw lastErr;
}

const main = async () => {
  const args = parseArgs(process.argv);
  const outDir = path.resolve(ROOT, args.out);
  if (!args.keep) await safeClean(outDir);
  await mkdir(outDir, { recursive: true });

  const server = await startServer(args);
  console.log(`[shoot] serving ${server.url}${args.build ? ' (production build)' : ''}`);

  const browser = await chromium.launch({ args: CHROME_ARGS, headless: true });
  const page = await browser.newPage({
    viewport: { width: args.width, height: args.height },
    deviceScaleFactor: args.dsf,
    colorScheme: 'dark',
  });

  // Hermetic: the project rule is "no CDN fetches, everything generated in
  // code". Blocking off-origin requests both enforces that and stops an
  // unresolvable external load from stalling screenshot stabilisation.
  const blockedRequests = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (/^https?:\/\//.test(url) && !url.startsWith(server.url) && !url.startsWith('http://127.0.0.1')) {
      blockedRequests.push(url);
      return route.abort();
    }
    return route.continue();
  });

  const consoleErrors = [];
  const consoleWarnings = [];
  page.on('console', (m) => {
    const t = m.type();
    const text = m.text();
    if (t === 'error') consoleErrors.push(text);
    else if (t === 'warning') consoleWarnings.push(text);
  });
  page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR: ${e.message}\n${e.stack ?? ''}`));
  page.on('requestfailed', (r) => {
    const f = r.failure();
    if (f && !/net::ERR_ABORTED/.test(f.errorText)) {
      consoleErrors.push(`REQUESTFAILED ${r.url()} — ${f.errorText}`);
    }
  });

  const report = { ok: false, url: server.url, build: !!args.build, poses: {},
                   errors: consoleErrors, warnings: consoleWarnings, blockedRequests };

  try {
    await page.goto(server.url, { waitUntil: 'load', timeout: args.timeout });

    report.gpu = await page.evaluate(() => {
      try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2');
        if (!gl) return { webgl2: false };
        const d = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          webgl2: true,
          vendor: d ? gl.getParameter(d.UNMASKED_VENDOR_WEBGL) : '?',
          renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?',
          maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
          maxSamples: gl.getParameter(gl.MAX_SAMPLES),
          colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
          floatBlend: !!gl.getExtension('EXT_float_blend'),
          textureFilterAniso: !!gl.getExtension('EXT_texture_filter_anisotropic'),
        };
      } catch (e) { return { error: String(e) }; }
    });
    console.log(`[shoot] gpu: ${report.gpu.renderer ?? report.gpu.error ?? 'unknown'}`);

    await page.waitForFunction(() => window.__FOX_READY === true, null,
      { timeout: args.timeout, polling: 120 });
    console.log('[shoot] scene ready');

    // Take determinism into our own hands.
    await page.evaluate(async (a) => {
      const D = window.FoxDebug;
      D.setAdaptive(false);
      if (!a.ui) D.setUI(false);
      if (a.quality) D.setQuality(a.quality);
      D.pause();
      if (a.sun) D.setSun(a.sun[0], a.sun[1]);
      if (a.wind) D.setWind(a.wind[0], a.wind[1]);
      if (a.state) D.setState(a.state);
      // Let springs, fur and terrain targets reach steady state.
      D.settle(a.settle);
    }, args);

    const poseNames = args.poses ?? Object.keys(await page.evaluate(() => window.FoxDebug.poses));

    for (const name of poseNames) {
      const t0 = Date.now();
      try {
        const info = await page.evaluate(async ({ name, taa }) => {
          const D = window.FoxDebug;
          D.setPose(name);
          // A short settle so any camera-dependent LOD/streaming resolves,
          // then repeated renders so TAA / stochastic alpha converge.
          D.settle(0.35);
          for (let i = 0; i < taa; i++) D.render();
          return D.stats();
        }, { name, taa: args.taa });

        const file = path.join(outDir, `${name}.png`);
        // No `animations: 'disabled'` — that makes Playwright wait on
        // document.fonts.ready and on CSS animations (the loading screen has
        // one), which hung roughly 1 run in 3. We already own determinism:
        // the render loop is paused and we drive frames by hand.
        await shotWithRetry(page, file);
        if (info.renderFrameDropped) {
          consoleErrors.push(`renderFrame from [${info.renderFrameClaimed.join(', ')}] ` +
            'threw and was disabled — this frame is an UNPOST-PROCESSED fallback');
        }
        // Guard the invariant the critic caught: identical settings must
        // produce identical buffer sizes, or review images are not comparable.
        const bufKey = `${info.buffer?.width}x${info.buffer?.height}`;
        if (report.bufferSize && report.bufferSize !== bufKey) {
          consoleErrors.push(`buffer size changed mid-run: ${report.bufferSize} -> ${bufKey} ` +
            '(adaptive resolution leaked into a review run)');
        }
        report.bufferSize = bufKey;
        report.poses[name] = { ok: true, ms: Date.now() - t0, ...info };
        console.log(`[shoot] ${name.padEnd(12)} ${info.drawCalls} calls, ${(info.triangles / 1000).toFixed(0)}k tris`);
      } catch (e) {
        report.poses[name] = { ok: false, error: String(e) };
        console.error(`[shoot] ${name} FAILED: ${e.message}`);
      }
    }

    // Unpaused perf probe: real frame times at each tier.
    report.perf = await page.evaluate(async () => {
      const D = window.FoxDebug;
      const out = {};
      for (const tier of ['low', 'medium', 'high', 'ultra']) {
        D.setQuality(tier);
        D.setPose('hero');
        for (let i = 0; i < 6; i++) { D.step(1 / 60); D.render(); }
        const t0 = performance.now();
        const N = 30;
        for (let i = 0; i < N; i++) { D.step(1 / 60); D.render(); }
        out[tier] = +((performance.now() - t0) / N).toFixed(2);
      }
      return out;
    });

    report.ok = consoleErrors.length === 0 &&
      Object.values(report.poses).every((p) => p.ok);
  } catch (e) {
    report.fatal = String(e.stack ?? e);
    console.error('[shoot] FATAL', e);
  } finally {
    await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
    await server.close();
  }

  console.log(`[shoot] ${report.ok ? 'OK' : 'PROBLEMS'} — ${Object.keys(report.poses).length} poses → ${args.out}/`);
  if (consoleErrors.length) {
    console.error(`[shoot] ${consoleErrors.length} console error(s):`);
    for (const e of consoleErrors.slice(0, 12)) console.error('   ' + e.split('\n')[0]);
  }
  process.exit(report.ok ? 0 : 1);
};

main();
