#!/usr/bin/env node
/**
 * Render the same pose under several variants so a defect can be attributed
 * to one system instead of argued about.
 *
 *   node tools/ab.mjs --pose profile --variants base,nopost,nodof,nobloom,nobreath
 *
 * Writes <out>/<pose>.<variant>.png. Variants are applied to a freshly
 * settled, paused scene and reverted afterwards, so they don't contaminate
 * each other.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const POSE = flag('--pose', 'profile');
const OUT = flag('--out', 'shots/ab');
const SIZE = flag('--size', '1000x640').split('x').map(Number);
const VARIANTS = flag('--variants', 'base,nopost,nodof').split(',');

/** Each variant returns an undo function, evaluated in the page. */
const APPLY = {
  base:     '() => () => {}',
  nopost:   '(c) => { c.postfx.enabled = false; return () => { c.postfx.enabled = true; }; }',
  nodof:    '(c) => { const d = c.postfx.dof || c.postfx.passes?.dof; const p = d && d.scale; if (d) d.scale = 0; return () => { if (d) d.scale = p; }; }',
  nobloom:  '(c) => { const b = c.postfx.bloom || c.postfx.passes?.bloom; const p = b && b.strength; if (b) b.strength = 0; return () => { if (b) b.strength = p; }; }',
  nobreath: '(c) => { const m = c.breath?.mesh; const v = m && m.visible; if (m) m.visible = false; return () => { if (m) m.visible = v; }; }',
  nofur:    '(c) => { const g = c.fur?.group || c.fur?.shells; const v = g && g.visible; if (g) g.visible = false; return () => { if (g) g.visible = v; }; }',
  nosnow:   '(c) => { const g = c.snowParticles?.points || c.snowParticles?.mesh; const v = g && g.visible; if (g) g.visible = false; return () => { if (g) g.visible = v; }; }',
};

const server = await createServer({ root: ROOT, logLevel: 'error',
  server: { port: 5166, host: '127.0.0.1', strictPort: false } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await chromium.launch({ headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-angle=default', '--disable-gpu-sandbox',
         '--disable-gpu-vsync', '--force-color-profile=srgb'] });
const page = await browser.newPage({ viewport: { width: SIZE[0], height: SIZE[1] }, deviceScaleFactor: 1 });
await page.route('**/*', (r) => /^https?:\/\/(?!127\.0\.0\.1)/.test(r.request().url()) ? r.abort() : r.continue());

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__FOX_READY === true, null, { timeout: 120000, polling: 100 });
await page.evaluate(() => { const D = window.FoxDebug; D.setAdaptive(false); D.setUI(false); D.pause(); D.settle(2.5); });

await mkdir(path.resolve(ROOT, OUT), { recursive: true });
for (const v of VARIANTS) {
  const src = APPLY[v];
  if (!src) { console.error(`unknown variant: ${v}`); continue; }
  const note = await page.evaluate(({ src, POSE }) => {
    const ctx = window.FoxDebug.ctx();
    // eslint-disable-next-line no-eval
    const undo = eval(src)(ctx);
    window.__undo = undo;
    window.FoxDebug.setPose(POSE);
    window.FoxDebug.settle(0.3);
    for (let i = 0; i < 20; i++) window.FoxDebug.render();
    return window.FoxDebug.stats();
  }, { src, POSE });
  await page.screenshot({ path: path.join(ROOT, OUT, `${POSE}.${v}.png`), timeout: 20000 });
  await page.evaluate(() => { try { window.__undo?.(); } catch {} });
  console.log(`${v.padEnd(10)} ${note.drawCalls} calls  ${(note.triangles / 1000) | 0}k tris`);
}
if (errors.length) console.error('ERRORS:', errors.slice(0, 5));
await browser.close(); await server.close();
