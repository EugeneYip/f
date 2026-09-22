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

const server = await createServer({
  root: ROOT, logLevel: 'error',
  server: { port: 5188, host: '127.0.0.1', strictPort: false },
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
    for (const [name, [y0, y1]] of Object.entries(bands)) {
      const ramps = [], tvs = [];
      for (let y = Math.round(y0) + 1; y < Math.round(y1) - 1; y += 2) {
        let x = 0;
        while (x < W - 1 && cov[y * W + x] < 0.02) x++;
        if (x >= W - 2) continue;
        let xi = x;
        while (xi < W - 1 && cov[y * W + xi] < 0.90) xi++;
        if (xi >= W - 2) continue;
        ramps.push(xi - x);                       // px from 2% to 90% coverage
        let tv = 0;
        for (let k = x; k < xi; k++) tv += Math.abs(cov[y * W + k + 1] - cov[y * W + k]);
        const net = Math.abs(cov[y * W + xi] - cov[y * W + x]);
        if (net > 0.3) tvs.push(tv / net);
      }
      const med = (a) => (a.length ? a.slice().sort((p, q) => p - q)[a.length >> 1] : null);
      stats[name] = {
        n: ramps.length,
        rampMedianPx: med(ramps),
        tvMedian: tvs.length ? +med(tvs).toFixed(3) : null,
        tvP10: tvs.length ? +tvs.slice().sort((p, q) => p - q)[Math.floor(tvs.length * 0.1)].toFixed(3) : null,
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
    if (b) console.log(`  ${band.padEnd(5)} ramp ${f(b.rampMedianPx)}px  tv ${f(b.tvMedian)} (p10 ${f(b.tvP10)})  n=${b.n}`);
  }
}
await writeFile(path.join(ROOT, OUT, 'matte.json'), JSON.stringify(result, null, 2));
if (errors.length) { console.error('ERRORS:', errors.slice(0, 5)); process.exitCode = 1; }
console.log(`\nmatte -> ${OUT}/  (${result.hidden} world objects hidden)`);
await browser.close(); await server.close();
