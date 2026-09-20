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
  // Measure the floor with post OFF as the reference, so the check asks
  // "does the grade put a floor under the frame?" rather than asserting an
  // absolute darkness that depends entirely on composition. An invented
  // absolute threshold is how a gate gets satisfied by damaging the product.
  const floorOf = () => {
    const g2 = grab();
    const dd = c2.getImageData(0, 0, g2.w, g2.h).data;
    const h2 = new Uint32Array(256);
    let nn = 0;
    for (let i = 0; i < dd.length; i += 4) {
      h2[Math.round((dd[i] + dd[i + 1] + dd[i + 2]) / 3)]++; nn++;
    }
    let a2 = 0;
    for (let v = 0; v < 256; v++) { a2 += h2[v]; if (a2 >= nn * 0.001) return v; }
    return 255;
  };
  renderPose('hero', false);
  out.floorRaw = floorOf();

  renderPose('hero', true);
  {
    const g = grab();
    const d = c2.getImageData(0, 0, g.w, g.h).data;
    // The first version asserted on the single darkest pixel, which made this
    // check flake between pass and fail with NO code change -- one pixel is
    // noise, and it happened to land on the fox's fur. A low percentile of the
    // luminance histogram answers the same question (does the frame reach
    // near-black, or has the grade put a floor under everything?) without
    // being hostage to a single sample.
    const hist = new Uint32Array(256);
    let clipped = 0, n = 0, sum = 0, sum2 = 0, minL = 255;
    for (let i = 0; i < d.length; i += 4) {
      const L = (d[i] + d[i + 1] + d[i + 2]) / 3;
      hist[Math.round(L)]++;
      if (L < minL) minL = L;
      if (L >= 252) clipped++;
      sum += L; sum2 += L * L; n++;
    }
    let acc = 0, p01 = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.001) { p01 = v; break; } }
    out.frame = { minL, p01, clipFrac: clipped / n, mean: sum / n,
                  sd: Math.sqrt(sum2 / n - (sum / n) ** 2) };
  }

  // 5. HORIZON CONTINUITY — the critic found two stacked hard horizontal
  //    steps where a horizon card butted against terrain and sky. Detectable
  //    as a large single-row luminance jump in a sky-to-ground column.
  renderPose('wide', true);
  {
    const g = grab();
    // A single column CANNOT tell a horizon seam from a snow sparkle: both are
    // a large one-row jump. The first version of this check did exactly that,
    // and an agent handed the failing number duly "fixed" it by cutting the
    // art bible's crystal-glint intensity by 71% -- optimising the metric
    // instead of the intent. The distinguishing property is HORIZONTAL
    // COHERENCE: a card butted against the sky steps at the same y across most
    // of the frame, while a glint is an isolated 2-4 px point.
    const COLS = 40, BAND = 3, AGREE = 0.35;
    const jumps = [];
    for (let i = 0; i < COLS; i++) {
      const x = Math.round((i + 0.5) * g.w / COLS);
      const col = c2.getImageData(x, 0, 1, g.h).data;
      let worst = 0, worstY = -1;
      for (let y = 1; y < g.h; y++) {
        const a = (col[(y - 1) * 4] + col[(y - 1) * 4 + 1] + col[(y - 1) * 4 + 2]) / 3;
        const b = (col[y * 4] + col[y * 4 + 1] + col[y * 4 + 2]) / 3;
        const d2 = Math.abs(b - a);
        if (d2 > worst) { worst = d2; worstY = y; }
      }
      if (worstY > 0) jumps.push({ y: worstY, mag: worst });
    }
    let best = { mag: 0, y: -1, agreeing: 0 };
    for (const c of jumps) {
      const near = jumps.filter((o) => Math.abs(o.y - c.y) <= BAND);
      if (near.length / COLS < AGREE) continue;          // isolated -> a glint
      const coherentMag = Math.min(...near.map((o) => o.mag));
      if (coherentMag > best.mag) best = { mag: coherentMag, y: c.y, agreeing: near.length };
    }
    out.horizonStep = {
      worst: best.mag, y: best.y, agreeing: best.agreeing, cols: COLS, height: g.h,
      loudestIsolated: Math.max(...jumps.map((j) => j.mag)),
    };
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

  // ----------------------------------------------------------------------
  // Checks added from REVIEW-2's "gate gaps" section. Each one encodes a
  // defect that a critic pass had to find by eye, at ~174k tokens a time.
  //
  // They work from a MASK obtained by rendering the pose twice, with the fox
  // hidden and shown, and differencing. That gives a true silhouette without
  // relying on the animal being darker or lighter than its background --
  // which at the backlit `silhouette` framing it is not.
  // ----------------------------------------------------------------------
  function maskedFrame(pose, post = true) {
    const root = ctx.fox?.root;
    if (!root) return null;
    const was = root.visible;

    root.visible = false;
    renderPose(pose, post);
    const g = grab();
    const bg = c2.getImageData(0, 0, g.w, g.h).data;

    root.visible = true;
    renderPose(pose, post);
    grab();
    const fg = c2.getImageData(0, 0, g.w, g.h).data;
    root.visible = was;

    const W = g.w, H = g.h;

    // Differencing alone is NOT a silhouette. Hiding the fox also removes its
    // CAST SHADOW from the snow and changes bloom across the sky, and both
    // exceed any sensible threshold -- so the naive mask claimed rows over the
    // whole frame. Found by the fur agent while replicating the check.
    //
    // Restrict to the animal's projected bounding box, built from its own rig
    // anchors, so shadow and sky changes fall outside it.
    let bx0 = W, by0 = H, bx1 = 0, by1 = 0, any = false;
    for (const key of Object.keys(ctx.fox?.anchors ?? {})) {
      const p2 = project(key);
      if (!p2) continue;
      any = true;
      if (p2.x < bx0) bx0 = p2.x; if (p2.x > bx1) bx1 = p2.x;
      if (p2.y < by0) by0 = p2.y; if (p2.y > by1) by1 = p2.y;
    }
    if (!any) { bx0 = 0; by0 = 0; bx1 = W; by1 = H; }
    // Anchors sit on bone centres, so pad generously for the coat.
    const padX = (bx1 - bx0) * 0.30 + 24, padY = (by1 - by0) * 0.30 + 24;
    bx0 = Math.max(0, bx0 - padX); bx1 = Math.min(W - 1, bx1 + padX);
    by0 = Math.max(0, by0 - padY); by1 = Math.min(H - 1, by1 + padY);

    const mask = new Uint8Array(W * H);
    for (let y = Math.round(by0); y <= Math.round(by1); y++) {
      for (let x = Math.round(bx0); x <= Math.round(bx1); x++) {
        const px = y * W + x, i = px * 4;
        const d = Math.abs(fg[i] - bg[i]) + Math.abs(fg[i + 1] - bg[i + 1]) +
                  Math.abs(fg[i + 2] - bg[i + 2]);
        mask[px] = d > 25 ? 1 : 0;
      }
    }
    return { W, H, fg, bg, mask, bbox: [bx0, by0, bx1, by1] };
  }

  const lumAt = (fg, px) => (fg[px * 4] + fg[px * 4 + 1] + fg[px * 4 + 2]) / 3;

  // 7. BACKLIT TRANSMISSION — §1's signature effect. Compare a thin band just
  //    inside the outline against the body core. Transmissive fur makes the
  //    rim brighter than the core; opaque fur makes them equal.
  {
    const m = maskedFrame('silhouette', false);   // raw render: post must not flatter it
    if (m) {
      const { W, H, fg, mask } = m;
      // Erode by R px to separate rim from core.
      const R = 6;
      const core = new Uint8Array(W * H);
      for (let y = R; y < H - R; y++) {
        for (let x = R; x < W - R; x++) {
          const i = y * W + x;
          if (!mask[i]) continue;
          let all = 1;
          for (let dy = -R; dy <= R && all; dy += R) {
            for (let dx = -R; dx <= R && all; dx += R) {
              if (!mask[(y + dy) * W + (x + dx)]) all = 0;
            }
          }
          core[i] = all;
        }
      }
      let rimSum = 0, rimN = 0, coreSum = 0, coreN = 0;
      for (let i = 0; i < W * H; i++) {
        if (!mask[i]) continue;
        if (core[i]) { coreSum += lumAt(fg, i); coreN++; }
        else { rimSum += lumAt(fg, i); rimN++; }
      }
      out.transmission = rimN && coreN
        ? { rim: rimSum / rimN, core: coreSum / coreN, ratio: (rimSum / rimN) / (coreSum / coreN),
            rimPx: rimN, corePx: coreN }
        : null;
    }
  }

  // 8. FUR COVERS CAMERA-FACING SURFACES — the tail was "a flat white blade
  //    with a hair fringe around its perimeter and nothing inside". Measure
  //    high-frequency variance INSIDE the mask, away from the edge.
  {
    const m = maskedFrame('tail', false);
    if (m) {
      const { W, H, fg, mask } = m;
      let sum = 0, n = 0;
      for (let y = 10; y < H - 10; y += 2) {
        for (let x = 10; x < W - 10; x += 2) {
          const i = y * W + x;
          // Require a solid 9x9 neighbourhood so we are well inside the body.
          let inside = 1;
          for (let dy = -8; dy <= 8 && inside; dy += 8)
            for (let dx = -8; dx <= 8 && inside; dx += 8)
              if (!mask[(y + dy) * W + (x + dx)]) inside = 0;
          if (!inside) continue;
          const c = lumAt(fg, i);
          const local = (lumAt(fg, i - 1) + lumAt(fg, i + 1) +
                         lumAt(fg, i - W) + lumAt(fg, i + W)) / 4;
          sum += Math.abs(c - local); n++;
        }
      }
      out.interiorDetail = n ? { meanHF: sum / n, samples: n } : null;
    }
  }

  // 9. NOSE IN EVERY POSE — spec previously sampled one framing. The nose
  //    measured correct at `portrait` and ~6.5x too bright and warm at `hero`,
  //    because fur layering over the muzzle occludes it at distance.
  out.nosePoses = {};
  for (const pose of ['portrait', 'hero', 'silhouette', 'profile']) {
    renderPose(pose, true);
    const p = project('nose');
    if (!p) { out.nosePoses[pose] = null; continue; }
    // Scale the sample box to the feature. A fixed 10x10 box averaged an
    // 11.9 px nose with its bright surroundings at `hero` and reported 216
    // where the nose itself reads ~165 -- an instrument artefact on top of a
    // real defect, which is the most confusing kind. Estimate the nose's
    // projected size from the camera and sample a box that fits inside it.
    const a = ctx.fox?.anchors?.nose;
    a.updateWorldMatrix(true, false);
    const wpos = new THREE.Vector3().setFromMatrixPosition(a.matrixWorld);
    const dist = ctx.camera.position.distanceTo(wpos);
    const ppm = cv.height / (2 * dist * Math.tan(ctx.camera.fov * Math.PI / 360));
    const widthPx = 0.012 * ppm;                   // the pad is ~12 mm across
    const r = Math.max(1, Math.min(5, Math.floor(widthPx / 3)));
    out.nosePoses[pose] = { ...sample(p.x, p.y, r), widthPx: +widthPx.toFixed(1), rad: r };
  }

  // 10. PER-REGION SILHOUETTE — a whole-animal median let a good torso mask a
  //     bald head. Split the scan by height band instead.
  {
    const m = maskedFrame('silhouette', true);
    if (m) {
      const { W, H, fg, bg: bgRef, mask } = m;
      let top = H, bot = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) if (mask[y * W + x]) { if (y < top) top = y; if (y > bot) bot = y; break; }
      }
      const bands = { head: [top, top + (bot - top) * 0.33], body: [top + (bot - top) * 0.33, bot] };
      out.silhouetteByRegion = {};
      for (const [name, [y0, y1]] of Object.entries(bands)) {
        const widths = [];
        for (let y = Math.round(y0) + 2; y < Math.round(y1) - 2; y += 3) {
          // Walk in from the left until the mask starts; measure how many px
          // the luminance takes to stabilise.
          let x = 1;
          while (x < W - 1 && !mask[y * W + x]) x++;
          if (x >= W - 2) continue;
          // Use the fox-vs-background DIFFERENCE magnitude as a soft coverage
          // signal, not luminance. At `silhouette` the backlit animal is very
          // close in luminance to the sky, so a luminance ramp rejected almost
          // every row (the first version sampled 2 rows for the whole head).
          // The diff magnitude is effectively alpha: it ramps gradually where
          // fur breaks the outline and steps where bare mesh does.
          let ramp = 0;
          const covAt = (xx) => {
            const i2 = (y * W + xx) * 4;
            return Math.abs(fg[i2] - bgRef[i2]) + Math.abs(fg[i2 + 1] - bgRef[i2 + 1]) +
                   Math.abs(fg[i2 + 2] - bgRef[i2 + 2]);
          };
          // Probe depth must adapt: an ear is a thin plate, so a fixed 16 px
          // probe lands back outside it and the row gets rejected. Measure how
          // far the mask actually runs, and probe just inside that.
          let run = 0;
          while (x + run < W - 2 && mask[y * W + x + run]) run++;
          if (run < 4) continue;
          const probe = Math.min(16, Math.max(3, Math.round(run * 0.6)));
          const deep = covAt(Math.min(W - 2, x + probe));
          if (deep < 40) continue;                    // not solidly inside the animal
          for (let k = 0; k <= probe; k++) {
            if (covAt(Math.min(W - 2, x + k)) > deep * 0.8) { ramp = k; break; }
          }
          if (ramp > 0) widths.push(ramp);
        }
        widths.sort((a, b) => a - b);
        out.silhouetteByRegion[name] = widths.length
          ? { median: widths[widths.length >> 1], n: widths.length } : null;
      }
    }
  }

  // 11. AURORA STRUCTURE — §7 asks for vertical filaments. Restraint achieved
  //     by fading the aurora to nothing also passes a brightness test, so
  //     measure the RATIO of horizontal to vertical gradient energy in the sky.
  //     Vertical filaments produce strong horizontal gradients.
  {
    renderPose('aurora', false);
    const g = grab();
    const d = c2.getImageData(0, 0, g.w, Math.round(g.h * 0.45)).data;
    const W = g.w, H = Math.round(g.h * 0.45);
    let gx = 0, gy = 0, n = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const c = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
        const r = (d[(i + 1) * 4] + d[(i + 1) * 4 + 1] + d[(i + 1) * 4 + 2]) / 3;
        const b2 = (d[(i + W) * 4] + d[(i + W) * 4 + 1] + d[(i + W) * 4 + 2]) / 3;
        gx += Math.abs(r - c); gy += Math.abs(b2 - c); n++;
      }
    }
    out.auroraStructure = n ? { gx: gx / n, gy: gy / n, ratio: (gx / n) / Math.max(gy / n, 1e-4) } : null;
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
const floorLift = (f && results.floorRaw != null) ? f.p01 - results.floorRaw : null;
record('post does not put a floor under the frame', floorLift != null && floorLift <= 12,
  `0.1st-percentile luminance ${results.floorRaw} without post -> ${f?.p01} with post ` +
  `(lift ${floorLift}); single darkest pixel ${f?.minL?.toFixed(1)} is not asserted on, ` +
  'it is one sample and it flaked between runs');
record('highlights not clipped', f && f.clipFrac < 0.01,
  `${((f?.clipFrac ?? 0) * 100).toFixed(2)}% of pixels at/above 252`);
record('frame has contrast', f && f.sd > 35, `sd ${f?.sd.toFixed(1)}`);

// Horizon: no hard step.
const hs = results.horizonStep;
record('no hard horizon step', hs && hs.agreeing >= 4 && hs.worst < 45,
  `largest HORIZONTALLY COHERENT jump ${hs?.worst.toFixed(0)} levels at y=${hs?.y} ` +
  `(${hs?.agreeing}/${hs?.cols} columns agree); loudest isolated point ` +
  `${hs?.loudestIsolated?.toFixed(0)} — isolated points are sparkle, not seams` +
  (hs && hs.agreeing < 4 ? ' [INCONCLUSIVE: no coherent edge found at all]' : ''));

// --- checks added from REVIEW-2's "gate gaps" -----------------------------

// Backlit transmission (§1's signature effect). Measured on the RAW render so
// post cannot flatter it.
const tr = results.transmission;
record('backlit fur transmits (rim brighter than core)', tr && tr.ratio >= 1.12,
  tr ? `rim ${tr.rim.toFixed(1)} / core ${tr.core.toFixed(1)} = ${tr.ratio.toFixed(3)} ` +
       `(want >= 1.12; 1.0 means opaque fur)` : 'could not mask the animal');

// Fur must cover camera-facing surfaces, not just the outline. The tail was
// "a flat white blade with a hair fringe around its perimeter and nothing
// inside" -- which an edge-only check cannot see.
const idt = results.interiorDetail;
// UNVALIDATED: this passes at 2.74 while a critic reading the same frame
// called the tail "a flat white blade with nothing inside". Until the
// disagreement is resolved, warn rather than gate -- an unvalidated check that
// fails is noise, and one that passes is worse.
record('[unvalidated] fur covers camera-facing surfaces', idt && idt.meanHF >= 1.2,
  idt ? `mean high-frequency detail inside the tail mask ${idt.meanHF.toFixed(2)} levels ` +
        `over ${idt.samples} samples (want >= 1.2)` : 'could not mask the tail', 'warn');

// The nose measured correct at portrait and ~6.5x too bright at hero, because
// fur layering over the muzzle occludes it at distance. One framing was not
// enough.
for (const [pose, c] of Object.entries(results.nosePoses ?? {})) {
  record(`nose stays dark at ${pose}`, c && c.r < 95,
    `${hex(c)} vs spec (23,26,32) — sampled r=${c?.rad ?? '?'}px ` +
    `in a ${c?.widthPx ?? '?'}px feature`,
    // Was a warning at distance while we believed the coat was occluding it.
    // The raw render is now measured EXACTLY on spec at hero (23,26,32) and
    // the post chain is what breaks it, so this is a real regression gate.
    'error');
}

// Aurora structure. Restraint achieved by fading it to nothing also passes a
// brightness test, so measure whether the sky's gradient energy runs
// vertically (filaments) or horizontally (a banded smear).
const au = results.auroraStructure;
// UNVALIDATED: passes at 1.048 while a critic called the aurora a
// structureless horizontal smear. Warn only until the disagreement is settled.
record('[unvalidated] aurora has vertical filament structure', au && au.ratio >= 0.85,
  au ? `horizontal/vertical gradient energy ${au.ratio.toFixed(3)} ` +
       `(gx ${au.gx.toFixed(2)}, gy ${au.gy.toFixed(2)}; < 0.85 means horizontal banding)`
     : 'n/a', 'warn');

// Per-region silhouette. The whole-animal median let a good torso mask a bald
// head -- and the old scan locked onto the horizon in 20 of 50 columns.
const sbr = results.silhouetteByRegion ?? {};
for (const [region, v] of Object.entries(sbr)) {
  record(`silhouette breaks up: ${region}`, v && v.median >= 3,
    v ? `median ramp ${v.median}px over ${v.n} rows (want >= 3; 1-2px is a bare mesh edge)`
      : 'no rows sampled');
}

// Retained for comparison only -- the fur agent demonstrated this one is
// unreliable here (2/1/2 px across identical runs, 20/50 columns locking onto
// the horizon rather than the animal, and no change when TAA is toggled
// despite an obvious visual difference). Superseded by the per-region check
// above, which masks the animal properly. Kept as a warning so the number
// stays visible without gating on it.
const sr = results.silhouetteRamp;
record('[legacy, unreliable] whole-frame silhouette ramp', sr && sr.median >= 3,
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
