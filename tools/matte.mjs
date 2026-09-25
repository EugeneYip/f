#!/usr/bin/env node
/**
 * matte — TRUE per-pixel coverage of the animal, independent of what is
 * behind it.
 *
 *   node tools/matte.mjs --poses frontal,profile --out shots/matte
 *
 * ## Why this exists
 *
 * Every pixel metric on this project has foundered on the same rock: a white
 * animal against white snow. `|foreground - background|` peaks at 261/765 at
 * the `silhouette` framing, so the 50% contour is not a silhouette, and three
 * separate agents independently failed to build a usable contour metric and
 * said so in their reports. One of them died mid-sentence writing "the only
 * way to get true coat alpha is an isolated matte".
 *
 * This is that matte, and it is exact rather than approximate.
 *
 * ## How
 *
 * Alpha compositing is linear in the backdrop. With the world hidden and the
 * clear colour set to K, every pixel is
 *
 *     I = C_animal + (1 - cov) * K
 *
 * where `cov` is the animal's accumulated coverage -- one minus the product of
 * (1 - alpha) over every shell, card, whisker and lash that covered it.
 * `C_animal` does not depend on K, so rendering twice with two clear colours
 * and subtracting eliminates it entirely:
 *
 *     I1 - I2 = (1 - cov) * (K1 - K2)
 *     cov     = 1 - (I1 - I2) / (K1 - K2)
 *
 * No material is swapped, so the shells keep their per-shell vertex extrusion
 * and the cards keep their orientation -- which is what makes this different
 * from re-materialling the animal flat, and why that approach could never have
 * measured the coat.
 *
 * Writes `<out>/<pose>.matte.png` (coverage as greyscale) and `<out>/matte.json`
 * with per-band contour statistics.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const POSES = flag('--poses', 'frontal,profile').split(',');
const OUT = flag('--out', 'shots/matte');
const SIZE = flag('--size', '1280x800').split('x').map(Number);
const SETTLE = parseFloat(flag('--settle', '2.5'));

// HMR and file watching OFF. Several agents edit this tree at once, and
// a save landing mid-run hot-reloads the page underneath the
// measurement. The AO agent caught it here: two IDENTICAL arms read
// flank 193.66 vs 180.32 and fine 0.921 vs 4.449, purely because
// another agent's module reloaded between them. `shoot.mjs` and
// `spec.mjs` already disable it; these two did not.
const server = await createServer({
  root: ROOT, logLevel: 'error',
  server: { port: 5188, host: '127.0.0.1', strictPort: false, hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-angle=default', '--disable-gpu-sandbox',
         '--disable-gpu-vsync', '--force-color-profile=srgb'],
});
const page = await browser.newPage({
  viewport: { width: SIZE[0], height: SIZE[1] }, deviceScaleFactor: 1,
});
page.route('**/*', (r) => (/^https?:\/\/(?!127\.0\.0\.1)/.test(r.request().url())
  ? r.abort() : r.continue()));
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__FOX_READY === true, null,
  { timeout: 120000, polling: 100 });

const result = await page.evaluate(async ({ POSES, SETTLE }) => {
  const D = window.FoxDebug, ctx = D.ctx();
  D.setAdaptive(false); D.setUI(false); D.pause();

  const cv = document.createElement('canvas');
  const c2 = cv.getContext('2d', { willReadFrequently: true });
  const grab = () => {
    const s = ctx.renderer.domElement;
    cv.width = s.width; cv.height = s.height;
    c2.drawImage(s, 0, 0);
    return c2.getImageData(0, 0, cv.width, cv.height).data;
  };

  // Everything that is NOT the animal, hidden so the clear colour is the only
  // thing behind the coat.
  //
  // Enumerated from the scene graph rather than from named handles. The first
  // version reached for `ctx.terrain.mesh`, `ctx.sky.mesh` and friends, found
  // four objects out of eight, and every pixel came back at coverage 1.000 --
  // because with an opaque sky still behind it, I1 and I2 are identical and
  // the subtraction says "fully covered" everywhere. Lights are excluded
  // because hiding a light changes the animal's shading; the maths does not
  // care what colour the animal is, but a black animal makes the PNG useless
  // to look at.
  const root = ctx.fox?.root;
  const world = ctx.scene.children.filter((o) =>
    o !== root && !o.isLight && o.visible !== undefined && !o.isCamera);

  const out = { poses: {}, hidden: world.length };
  const renderer = ctx.renderer;
  const prevClear = renderer.getClearColor(new ctx.THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevEnv = ctx.scene.environment, prevBg = ctx.scene.background;
  const prevPost = ctx.postfx?.enabled;

  const shown = world.map((o) => o.visible);
  world.forEach((o) => { o.visible = false; });
  ctx.scene.background = null;
  if (ctx.postfx) ctx.postfx.enabled = false;   // post is not linear in K

  for (const pose of POSES) {
    ctx.time = 0; ctx.frame = 0; ctx.app._accum = 0;
    D.settle(SETTLE);
    D.setPose(pose);

    const shoot = (hex) => {
      renderer.setClearColor(hex, 1);
      for (let i = 0; i < 8; i++) D.render();
      return grab();
    };
    const I1 = shoot(0x000000);
    const I2 = shoot(0xffffff);

    const W = cv.width, H = cv.height;
    const cov = new Float32Array(W * H);
    for (let p = 0; p < W * H; p++) {
      const i = p * 4;
      // (I1 - I2) = (1 - cov) * (K1 - K2); K1 - K2 = -255 per channel.
      let s = 0;
      for (let c = 0; c < 3; c++) s += (I2[i + c] - I1[i + c]) / 255;
      cov[p] = Math.max(0, Math.min(1, 1 - s / 3));
    }

    // Contour statistics, in three height bands, walking in from the left.
    let top = H, bot = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) if (cov[y * W + x] > 0.5) { if (y < top) top = y; if (y > bot) bot = y; break; }
    }
    const bands = bot > top ? {
      head: [top, top + (bot - top) * 0.33],
      body: [top + (bot - top) * 0.33, top + (bot - top) * 0.70],
      legs: [top + (bot - top) * 0.70, bot],
    } : {};
    const stats = {};

    /**
     * Walk inward from one edge and measure the fringe.
     *
     * `at(i, j)` returns coverage j steps in from the edge along scan i, so
     * one routine serves all four directions.
     */
    const scan = (n, len, at) => {
      const tvs = [], ramps = [];
      for (let i = 0; i < n; i += 2) {
        // SKIP SCANS THAT START ALREADY COVERED.
        //
        // If the animal leaves the frame, the first sample on that scan is
        // already inside it: there is no fringe to measure, the ramp has zero
        // length, and the cliff rule then scores it 1.0. At `portrait` that
        // made the right and bottom edges report p10 1.000 with 48% and 64%
        // "below the hair floor" purely because the subject is cropped. The
        // cliff rule is right for a hard edge and wrong for a frame boundary,
        // and telling them apart is this one line.
        if (at(i, 0) > 0.02) continue;
        let a = 0;
        while (a < len - 1 && at(i, a) < 0.02) a++;
        if (a >= len - 2) continue;
        let b = a;
        while (b < len - 1 && at(i, b) < 0.90) b++;
        if (b >= len - 2) continue;
        // A SHORT RAMP IS A CLIFF -- score it 1.0, never drop it. The
        // hardest edges have the fewest samples between 2% and 90% coverage,
        // so any "too few samples to measure" filter deletes exactly the
        // defects this exists to find. See the longer note in spec.mjs.
        if (b - a < 2) { tvs.push(1.0); ramps.push(b - a); continue; }
        let tv = 0;
        for (let k = a; k < b; k++) tv += Math.abs(at(i, k + 1) - at(i, k));
        const net = Math.abs(at(i, b) - at(i, a));
        if (net > 0.3) { tvs.push(tv / net); ramps.push(b - a); }
      }
      return { tvs, ramps };
    };

    const pct = (arr, f) => (arr.length
      ? +arr.slice().sort((p, q) => p - q)[Math.min(arr.length - 1, Math.floor(f * arr.length))].toFixed(3)
      : null);

    // ALL FOUR EDGES.
    //
    // This used to walk in from the LEFT only, row-wise -- one quarter of the
    // contour -- and §4f says "trace the outer contour". The critic re-scanned
    // the same mattes in all four directions and found every contour defect in
    // this build living in the unmeasured three quarters: `tail`'s RIGHT edge
    // has 11.3% of its scans at tv 1.000 with a 1 px ramp, while the left-only
    // number for the same animal reported a comfortable pass. A muzzle whose
    // dorsum and underside are both razor-sharp is invisible to a row scan
    // that stops at the first thing it hits.
    const edges = {
      left:   scan(H, W, (y, k) => cov[y * W + k]),
      right:  scan(H, W, (y, k) => cov[y * W + (W - 1 - k)]),
      top:    scan(W, H, (x, k) => cov[k * W + x]),
      bottom: scan(W, H, (x, k) => cov[(H - 1 - k) * W + x]),
    };
    stats.edges = {};
    for (const [e, { tvs, ramps }] of Object.entries(edges)) {
      stats.edges[e] = {
        n: tvs.length,
        tvP10: pct(tvs, 0.10), tvMedian: pct(tvs, 0.50),
        rampMedianPx: pct(ramps, 0.50),
        badFrac: tvs.length ? +(tvs.filter((v) => v < 1.15).length / tvs.length).toFixed(3) : null,
      };
    }

    for (const [name, [y0, y1]] of Object.entries(bands)) {
      const y0i = Math.round(y0) + 1, y1i = Math.round(y1) - 1;
      const nb = Math.max(0, y1i - y0i);
      const L = scan(nb, W, (i, k) => cov[(y0i + i) * W + k]);
      const R = scan(nb, W, (i, k) => cov[(y0i + i) * W + (W - 1 - k)]);
      const tvs = L.tvs.concat(R.tvs), ramps = L.ramps.concat(R.ramps);
      stats[name] = {
        n: ramps.length,
        rampMedianPx: pct(ramps, 0.50),
        tvMedian: pct(tvs, 0.50),
        tvP10: pct(tvs, 0.10),
        // Reported separately, because a band can be hairy on one side and
        // bare on the other and a combined p10 hides which.
        leftP10: pct(L.tvs, 0.10), rightP10: pct(R.tvs, 0.10),
      };
    }
    // Coverage histogram: how much of the animal is a soft fringe?
    let solid = 0, fringe = 0, any = 0;
    for (let p = 0; p < W * H; p++) {
      if (cov[p] > 0.02) any++;
      if (cov[p] > 0.98) solid++;
      else if (cov[p] > 0.05) fringe++;
    }
    out.poses[pose] = {
      ...stats, W, H,
      coveragePx: any, solidPx: solid, fringePx: fringe,
      fringeShare: any ? +(fringe / any).toFixed(3) : null,
    };
    // Return the matte itself as a data URL so the caller can write a PNG.
    const oc = document.createElement('canvas');
    oc.width = W; oc.height = H;
    const octx = oc.getContext('2d');
    const img = octx.createImageData(W, H);
    for (let p = 0; p < W * H; p++) {
      const v = Math.round(cov[p] * 255);
      img.data[p * 4] = v; img.data[p * 4 + 1] = v; img.data[p * 4 + 2] = v; img.data[p * 4 + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    out.poses[pose].png = oc.toDataURL('image/png');
  }

  world.forEach((o, i) => { o.visible = shown[i]; });
  ctx.scene.background = prevBg; ctx.scene.environment = prevEnv;
  renderer.setClearColor(prevClear, prevAlpha);
  if (ctx.postfx) ctx.postfx.enabled = prevPost;
  return out;
}, { POSES, SETTLE });

await mkdir(path.resolve(ROOT, OUT), { recursive: true });
for (const [pose, d] of Object.entries(result.poses)) {
  const b64 = d.png.split(',')[1];
  await writeFile(path.join(ROOT, OUT, `${pose}.matte.png`), Buffer.from(b64, 'base64'));
  delete d.png;
  const f = (v) => (v == null ? '—' : v);
  console.log(`${pose.padEnd(11)} coverage ${d.coveragePx}px  fringe share ${f(d.fringeShare)}`);
  for (const band of ['head', 'body', 'legs']) {
    const b = d[band];
    if (b) console.log(`  ${band.padEnd(6)} ramp ${f(b.rampMedianPx)}px  tv ${f(b.tvMedian)}  ` +
      `p10 ${f(b.tvP10)} (L ${f(b.leftP10)} / R ${f(b.rightP10)})  n=${b.n}`);
  }
  for (const e of ['left', 'right', 'top', 'bottom']) {
    const b = d.edges?.[e];
    if (b) console.log(`  ${e.padEnd(6)} p10 ${f(b.tvP10)}  median ${f(b.tvMedian)}  ` +
      `ramp ${f(b.rampMedianPx)}px  ${((b.badFrac ?? 0) * 100).toFixed(1)}% below 1.15  n=${b.n}`);
  }
}
await writeFile(path.join(ROOT, OUT, 'matte.json'), JSON.stringify(result, null, 2));
if (errors.length) { console.error('ERRORS:', errors.slice(0, 5)); process.exitCode = 1; }
console.log(`\nmatte -> ${OUT}/  (${result.hidden} world objects hidden)`);
await browser.close(); await server.close();
