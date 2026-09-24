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
  // Skips the DoF PASSES, rather than zeroing their scale.
  //
  // Setting `scale = 0` left all six passes running and only removed the
  // blur, so this variant measured **+0.5 ms** against DoF's real cost of
  // about -1.9 -- it was more expensive than the thing it claimed to remove.
  // Found by the postfx agent while attributing frame time. `_skip` is
  // PostFX's own pass bypass, which is what the per-pass A/B in that agent's
  // own work uses.
  nodof:    '(c) => { const s = c.postfx?.system?._skip; if (!s) throw new Error("nodof: postfx.system._skip not found"); const had = s.dof; s.dof = true; return () => { s.dof = had; }; }',
  nobloom:  '(c) => { const b = c.postfx.bloom || c.postfx.passes?.bloom; const p = b && b.strength; if (b) b.strength = 0; return () => { if (b) b.strength = p; }; }',
  nobreath: '(c) => { const m = c.breath?.mesh; const v = m && m.visible; if (m) m.visible = false; return () => { if (m) m.visible = v; }; }',
  // `c.fur.group` and `c.fur.shells` have never existed -- FurSystem adds
  // `shellMesh` and `cardMesh` straight to fox.root. This variant was a silent
  // no-op that rendered identically to `base`, so every "fur is not the cause"
  // conclusion drawn from it was drawn from the same image twice.
  nofur:    '(c) => { const m = [c.fur?.shellMesh, c.fur?.cardMesh].filter(Boolean); if (!m.length) throw new Error("nofur: no coat meshes on ctx.fur"); const v = m.map(o => o.visible); m.forEach(o => { o.visible = false; }); return () => m.forEach((o, i) => { o.visible = v[i]; }); }',
  // Hide the SKIN and keep the coat. The inverse of `nofur`, and the decisive
  // test for "is the hard silhouette the skin poking through the coat, or the
  // coat's own outer shell?" -- a question three agents have now asked without
  // being able to answer it.
  //
  // Hides the skin MESH ONLY, via layers rather than `visible`.
  //
  // `visible = false` was wrong and confounded every conclusion drawn from
  // this variant, including my own "the skin is visible through the coat".
  // `Fox.js:132` does `skinnedMesh.add(rig.rootBone)`, and three's
  // `projectObject` returns early on an invisible object -- so hiding the
  // skin also hid every bone-parented thing on the animal: both eyes, the
  // whiskers, the nose pad, the lip line and the ears. Found by the face
  // agent. Layers do NOT cull children: `projectObject` tests
  // `object.layers` to decide whether to draw THAT object and recurses
  // regardless, so layer 31 removes the skin and leaves the rig alone.
  noskin:   '(c) => { const m = c.fox?.skinnedMesh; if (!m) throw new Error("noskin: ctx.fox.skinnedMesh not found"); const had = m.layers.mask; m.layers.set(31); return () => { m.layers.mask = had; }; }',
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
let rootAt = null;
// Indexed, because a repeated variant used to overwrite its own png. That
// matters precisely when you repeat one deliberately: a self-test of three
// identical arms produced ONE file and silently hid whether they matched.
let armIdx = 0;
for (const v of VARIANTS) {
  const armTag = `${String(armIdx++).padStart(2, '0')}.${v}`;
  const src = APPLY[v];
  if (!src) { console.error(`unknown variant: ${v}`); continue; }
  const note = await page.evaluate(({ src, POSE }) => {
    const ctx = window.FoxDebug.ctx();
    // eslint-disable-next-line no-eval
    const undo = eval(src)(ctx);
    window.__undo = undo;
    window.FoxDebug.setPose(POSE);
    // NO settle here. This used to be `settle(0.3)` INSIDE the per-variant
    // loop, so variant k rendered at 2.5 + 0.3(k+1) seconds and a four-arm
    // A/B compared four frames 0.3 s apart in animation. That is the same
    // confound that once made a nose A/B report a 102 -> 61 "erosion" where
    // a same-state comparison showed 104 -> 0 occlusion -- an A/B tool that
    // silently varies the scene between arms is worse than no A/B tool.
    // Render advances no time, so the arms are now the same instant.
    //
    // RESET TAA FIRST, or arm k is a blend of itself over every arm before
    // it. TAA resolves with uAlpha = 1/(n+1) and lets n run to 250 while the
    // scene is static, so without a reset arm 2 is a 1/50 blend over arm 1's
    // converged image and arm 6 is 1/251 -- the history is never dropped
    // between arms. The face agent demonstrated it with three IDENTICAL
    // arms, 48 frames each, same masked pixels: 135.8 / 110.9 / 99.4. The
    // number tracked the arm's POSITION, and a tint arm's green was still
    // visible three arms later. With the reset: 67.1 / 67.1 / 67.1, bit
    // identical.
    //
    // Contamination can only SHRINK a difference, so past POSITIVE results
    // still stand and past NULL results would mean nothing.
    //
    // MEASURED, and this tool turns out NOT to have been affected: three
    // identical arms differ by 254 and 198 px of 2.3M (max 12 levels) WITH
    // the reset, and 238 and 177 px WITHOUT it -- indistinguishable. The
    // reason is that each arm calls setPose, and setPose treats a pose
    // change as a hard cut and already calls postfx.reset(). So this tool
    // was protected INCIDENTALLY, by a line in Debug.js written for an
    // unrelated reason, which nobody maintaining either file would know to
    // preserve. That is why the call below stays and why it THROWS rather
    // than optional-chaining: the protection is now explicit and local.
    //
    // Note the residual: identical arms are NOT bit-identical here. ~250 px
    // and 12 levels is this tool's noise floor; a difference smaller than
    // that is not a difference.
    const _pf = window.FoxDebug.ctx().postfx;
    if (!_pf || typeof _pf.reset !== 'function') {
      throw new Error('ab: postfx.reset() is missing — without it every arm ' +
        'after the first is a TAA blend over its predecessors, and a null ' +
        'result from this tool would be meaningless. Refusing to measure.');
    }
    _pf.reset();
    for (let i = 0; i < 22; i++) window.FoxDebug.render();
    return { ...window.FoxDebug.stats(), root: window.FoxDebug.probe?.()?.root ?? null };
  }, { src, POSE });
  await page.screenshot({ path: path.join(ROOT, OUT, `${POSE}.${armTag}.png`), timeout: 20000 });
  await page.evaluate(() => { try { window.__undo?.(); } catch {} });
  // Enforce it: arms that are not the same instant are not an A/B.
  if (note.root) {
    if (rootAt) {
      const d = Math.hypot(note.root[0] - rootAt[0], note.root[1] - rootAt[1],
                           note.root[2] - rootAt[2]);
      if (d > 1e-5) {
        console.error(`[ab] FATAL: the animal moved ${(d * 1000).toFixed(2)} mm between ` +
          `arms (base at ${rootAt}, ${v} at ${note.root}). These arms are ` +
          'different instants; the comparison is meaningless.');
        process.exitCode = 3;
      }
    } else rootAt = note.root;
  }
  console.log(`${v.padEnd(10)} ${note.drawCalls} calls  ${(note.triangles / 1000) | 0}k tris`);
}
if (errors.length) console.error('ERRORS:', errors.slice(0, 5));
await browser.close(); await server.close();
