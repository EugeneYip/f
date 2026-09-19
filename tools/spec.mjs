#!/usr/bin/env node
/**
 * Spec-conformance gate.
 *
 *   node tools/spec.mjs
 *   node tools/spec.mjs --json shots/spec/spec.json
 *
 * Checks art-bible invariants NUMERICALLY, in seconds, at zero token cost.
 *
 * Why this exists: a hostile critic pass cost ~320k tokens and 22 minutes and
 * returned 16 blockers. Reviewing them afterwards, most were numerically
 * detectable — "the nose is 5x too bright and decisively blue", "the topline
 * is a dead-straight line", "there are two hard horizontal steps at the
 * horizon", "macro_eye contains no eye". Those are measurements, not opinions.
 * Every check here is one that previously consumed at least one agent round.
 *
 * Features are located by PROJECTING RIG ANCHORS to screen space rather than
 * by hardcoded pixel boxes, so the checks survive anatomy changes — which this
 * project has had many of, and which silently invalidated hardcoded camera
 * poses three separate times.
 *
 * What this cannot do: judge whether the aurora has curtain structure, whether
 * the composition is beautiful, or whether the animal has charm. Those still
 * need eyes. The point is to stop spending eyes on arithmetic.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = flag('--json', 'shots/spec/spec.json');

const checks = [];
const record = (name, ok, detail, severity = 'error') =>
  checks.push({ name, ok: !!ok, detail, severity });

const server = await createServer({
  root: ROOT, logLevel: 'error',
  server: { port: 5133, host: '127.0.0.1', strictPort: false, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-angle=default', '--disable-gpu-sandbox',
         '--disable-gpu-vsync', '--force-color-profile=srgb'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await page.route('**/*', (r) =>
  /^https?:\/\/(?!127\.0\.0\.1)/.test(r.request().url()) ? r.abort() : r.continue());

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`,
  { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__FOX_READY === true, null, { timeout: 120000, polling: 100 });

// --- everything below runs in the page ------------------------------------
const results = await page.evaluate(async () => {
  const D = window.FoxDebug, ctx = D.ctx(), THREE = ctx.THREE;
  D.setAdaptive(false); D.setUI(false); D.pause(); D.settle(2.5);

  const cv = document.createElement('canvas');
  const c2 = cv.getContext('2d', { willReadFrequently: true });

  /** Grab the canvas into a 2D context we can sample. */
  function grab() {
    const src = ctx.renderer.domElement;
    cv.width = src.width; cv.height = src.height;
    c2.drawImage(src, 0, 0);
    return { w: cv.width, h: cv.height };
  }

  /** Mean RGB over a box, plus the fraction of pixels at/above `clipAt`. */
  function sample(x, y, r, clipAt = 250) {
    const x0 = Math.max(0, Math.round(x - r)), y0 = Math.max(0, Math.round(y - r));
    const w = Math.min(cv.width - x0, r * 2), h = Math.min(cv.height - y0, r * 2);
    if (w <= 0 || h <= 0) return null;
    const d = c2.getImageData(x0, y0, w, h).data;
    let R = 0, G = 0, B = 0, n = 0, clipped = 0, minL = 255;
    for (let i = 0; i < d.length; i += 4) {
      R += d[i]; G += d[i + 1]; B += d[i + 2]; n++;
      const L = (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (L >= clipAt) clipped++;
      if (L < minL) minL = L;
    }
    return { r: R / n, g: G / n, b: B / n, n, clipFrac: clipped / n, minL };
  }

  /** Project a rig anchor to backbuffer pixels. */
  function project(name) {
    const a = ctx.fox?.anchors?.[name];
    if (!a) return null;
    a.updateWorldMatrix(true, false);
    const v = new THREE.Vector3().setFromMatrixPosition(a.matrixWorld).project(ctx.camera);
    if (v.z > 1) return null;                       // behind the camera
    return { x: (v.x * 0.5 + 0.5) * cv.width, y: (-v.y * 0.5 + 0.5) * cv.height };
  }

  function renderPose(pose, post = true) {
    if (ctx.postfx) ctx.postfx.enabled = post;
    D.setPose(pose); D.settle(0.3);
    for (let i = 0; i < 18; i++) D.render();
    return grab();
  }

  const out = {};

  // 1. NOSE COLOUR — art bible #171a20 = (23,26,32). Cost a critic round, then
  //    a face-agent round to prove it was post, not the pad.
  for (const post of [false, true]) {
    renderPose('portrait', post);
    const p = project('nose');
    out[`nose_${post ? 'post' : 'raw'}`] = p ? sample(p.x, p.y, 6) : null;
  }

  // 2. EYE PRESENT AND WARM at macro range. macro_eye photographed an empty
  //    socket for many rounds without anyone noticing.
  for (const post of [false, true]) {
    renderPose('macro_eye', post);
    const p = project('eyeR');
    out[`eye_${post ? 'post' : 'raw'}`] = p ? sample(p.x, p.y, 40) : null;
  }

  // 3. COAT NEUTRALITY — §4b: no warm cast, ever. The salmon cast survived
  //    several rounds because the whole-body mean hid it behind the cool
  //    shadow side, so sample the LIT flank specifically.
  renderPose('profile', true);
  {
    const c = project('chest');
    out.coat_lit = c ? sample(c.x, c.y - 30, 24) : null;
  }

  // 4. FRAME FLOOR AND CLIPPING — a grade whose shadow tint peaked at true
  //    black put an absolute floor of B=56 under every pixel including the
  //    night sky. §3 forbids both crushing and veiling.
  renderPose('hero', true);
  {
    const g = grab();
    const d = c2.getImageData(0, 0, g.w, g.h).data;
    let minL = 255, clipped = 0, n = 0, sum = 0, sum2 = 0;
    for (let i = 0; i < d.length; i += 4) {
      const L = (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (L < minL) minL = L;
      if (L >= 252) clipped++;
      sum += L; sum2 += L * L; n++;
    }
    out.frame = { minL, clipFrac: clipped / n, mean: sum / n,
                  sd: Math.sqrt(sum2 / n - (sum / n) ** 2) };
  }

  // 5. HORIZON CONTINUITY — the critic found two stacked hard horizontal
  //    steps where a horizon card butted against terrain and sky. Detectable
  //    as a large single-row luminance jump in a sky-to-ground column.
  renderPose('wide', true);
  {
    const g = grab();
    const x = Math.round(g.w * 0.3);
    const col = c2.getImageData(x, 0, 1, g.h).data;
    let worst = 0, worstY = -1;
    for (let y = 1; y < g.h; y++) {
      const a = (col[(y - 1) * 4] + col[(y - 1) * 4 + 1] + col[(y - 1) * 4 + 2]) / 3;
      const b = (col[y * 4] + col[y * 4 + 1] + col[y * 4 + 2]) / 3;
      const d2 = Math.abs(b - a);
      if (d2 > worst) { worst = d2; worstY = y; }
    }
    out.horizonStep = { worst, y: worstY, height: g.h };
  }

  // 6. SILHOUETTE BREAK-UP — §2.1 and rubric A: a hard mesh edge against the
  //    sky is an automatic fail. Fur breaking the outline produces a GRADUAL
  //    alpha ramp; a bare mesh edge produces a step. Scan rows across the
  //    animal's top contour and measure how many pixels the transition takes.
  renderPose('silhouette', true);
  {
    const g = grab();
    const widths = [];
    for (let x = Math.round(g.w * 0.35); x < Math.round(g.w * 0.62); x += 7) {
      const col = c2.getImageData(x, 0, 1, g.h).data;
      // Walk down from the top; find where luminance first departs from sky
      // and where it stabilises on the animal.
      // Absolute thresholds do not work here: the sky has a large vertical
      // gradient of its own, so "departs from the sky value" fires hundreds of
      // pixels above the animal -- the check passed with a 261 px "transition",
      // i.e. for entirely the wrong reason. Find the STEEPEST gradient in the
      // column (that is the edge), then measure how many pixels around it stay
      // above a fraction of that peak. A bare mesh edge is a 1-2 px step; fur
      // breaking the outline ramps over more.
      const lum = new Float32Array(g.h);
      for (let y = 0; y < g.h; y++) lum[y] = (col[y * 4] + col[y * 4 + 1] + col[y * 4 + 2]) / 3;
      let peak = 0, peakY = -1;
      for (let y = 1; y < g.h; y++) {
        const d2 = Math.abs(lum[y] - lum[y - 1]);
        if (d2 > peak) { peak = d2; peakY = y; }
      }
      if (peak < 4 || peakY < 0) continue;
      const thr = peak * 0.25;
      let up = peakY, dn = peakY;
      while (up > 1 && Math.abs(lum[up] - lum[up - 1]) > thr) up--;
      while (dn < g.h - 1 && Math.abs(lum[dn + 1] - lum[dn]) > thr) dn++;
      widths.push(Math.max(1, dn - up));
    }
    widths.sort((a, b) => a - b);
    out.silhouetteRamp = widths.length
      ? { median: widths[widths.length >> 1], min: widths[0], max: widths[widths.length - 1], n: widths.length }
      : null;
  }

  if (ctx.postfx) ctx.postfx.enabled = true;
  out.initErrors = D.errors();
  return out;
});

await browser.close();
await server.close();

// --- assertions -----------------------------------------------------------
const hex = (c) => c ? `(${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)})` : 'n/a';

record('no init errors', results.initErrors.length === 0, results.initErrors);
record('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5));

// Nose: near-black, blue-leaning. Spec (23,26,32).
const nr = results.nose_raw, np = results.nose_post;
record('nose is near-black (raw)', nr && nr.r < 70, `${hex(nr)} vs spec (23,26,32)`);
record('nose is not warm (raw)', nr && nr.b >= nr.r - 3, `${hex(nr)} — blue channel must not be below red`);
record('nose survives post', np && np.r < 90 && np.b >= np.r - 6,
  `raw ${hex(nr)} -> post ${hex(np)}`, 'warn');

// Eye: present, and warm relative to the cold surround.
const er = results.eye_raw, ep = results.eye_post;
record('eye is warm (raw)', er && er.r - er.b > 6, `${hex(er)} — R-B must exceed 6`);
record('eye keeps its chroma through post', er && ep && (ep.r - ep.b) > (er.r - er.b) * 0.7,
  `raw R-B ${er ? (er.r - er.b).toFixed(1) : '?'} -> post R-B ${ep ? (ep.r - ep.b).toFixed(1) : '?'}`);

// Coat: §4b forbids any warm cast.
const cl = results.coat_lit;
record('lit coat is not warm', cl && cl.r - cl.b < 10, `${hex(cl)} — R-B must stay under 10`);

// Frame: no scrim, no crush, no blowout.
const f = results.frame;
record('no scrim (frame reaches near-black)', f && f.minL < 30, `darkest pixel ${f?.minL}`);
record('highlights not clipped', f && f.clipFrac < 0.01,
  `${((f?.clipFrac ?? 0) * 100).toFixed(2)}% of pixels at/above 252`);
record('frame has contrast', f && f.sd > 35, `sd ${f?.sd.toFixed(1)}`);

// Horizon: no hard step.
const hs = results.horizonStep;
record('no hard horizon step', hs && hs.worst < 45,
  `largest single-row jump ${hs?.worst.toFixed(0)} levels at y=${hs?.y}/${hs?.height}`);

// Silhouette: fur must break the outline, not step.
const sr = results.silhouetteRamp;
record('silhouette breaks up (fur, not a mesh edge)', sr && sr.median >= 3,
  sr ? `median transition ${sr.median}px over ${sr.n} columns (min ${sr.min}, max ${sr.max})`
     : 'could not locate the animal against the sky');

await mkdir(path.resolve(ROOT, path.dirname(OUT)), { recursive: true });
await writeFile(path.resolve(ROOT, OUT), JSON.stringify({ checks, results }, null, 2));

const fails = checks.filter((c) => !c.ok && c.severity === 'error');
const warns = checks.filter((c) => !c.ok && c.severity === 'warn');
console.log(`\n${'='.repeat(64)}\nSPEC: ${checks.length - fails.length - warns.length} pass · ${warns.length} warn · ${fails.length} FAIL\n${'='.repeat(64)}`);
for (const c of checks) {
  if (c.ok) console.log(`  ok    ${c.name}\n        ${typeof c.detail === 'string' ? c.detail : ''}`.trimEnd());
}
for (const c of warns) console.log(`  warn  ${c.name}\n        ${JSON.stringify(c.detail)}`);
for (const c of fails) console.log(`  FAIL  ${c.name}\n        ${JSON.stringify(c.detail)}`);
console.log(`\nfull report → ${OUT}`);
process.exit(fails.length ? 1 : 0);
