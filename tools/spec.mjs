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
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = flag('--json', 'shots/spec/spec.json');

/**
 * Fingerprint the source tree.
 *
 * Several agents edit this checkout concurrently. A save landing mid-run means
 * the numbers at the end of a run describe different code from the numbers at
 * the start -- and repeated runs are not comparable at all. That has now cost
 * me, a critic and two agents real time, each of us reading a moving target as
 * nondeterminism. Cheap to detect, so detect it.
 */
/**
 * Per-file stamps for the source tree.
 *
 * This used to return one hash for all of `src/`, so a drift report said only
 * that SOMETHING changed. Under five concurrent agents that is nearly useless:
 * an edit to `src/fx/Bloom.js` invalidates a post-side measurement but has
 * nothing to do with a fur silhouette number, and being told to discard both
 * teaches everyone to ignore the warning. Name the files and let the reader
 * judge.
 */
async function fingerprint(dir) {
  const out = new Map();
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!/\.(js|glsl|mjs)$/.test(e.name)) continue;
      const st = await stat(full);
      out.set(path.relative(ROOT, full), `${st.size}:${st.mtimeMs}`);
    }
  };
  await walk(dir);
  return out;
}

/** Files whose stamp differs between two fingerprints. */
function driftedFiles(a, b) {
  const names = new Set([...a.keys(), ...b.keys()]);
  return [...names].filter((n) => a.get(n) !== b.get(n)).sort();
}

const checks = [];
const record = (name, ok, detail, severity = 'error') =>
  checks.push({ name, ok: !!ok, detail, severity });

const srcBefore = await fingerprint(path.join(ROOT, 'src'));
const toolsBefore = await fingerprint(path.join(ROOT, 'tools'));

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
// 1920x1200 rather than 1280x800. The silhouette metric needs its 1.5 mm
// sampling interval to span at least 2 px, and at 1280 the `profile` framing
// gives 0.98 px/mm -- so every contour number taken at the old size was
// measuring the render's resolution rather than the coat. 1920 gives ~1.48
// px/mm, which is the smallest size that clears the bar. 2560 was tried
// first and the page could not even reach ready inside 120 s under
// concurrent agent load, which is not a trade worth making for headroom.
const page = await browser.newPage({ viewport: { width: 1920, height: 1200 }, deviceScaleFactor: 1 });
await page.route('**/*', (r) =>
  /^https?:\/\/(?!127\.0\.0\.1)/.test(r.request().url()) ? r.abort() : r.continue());

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`,
  { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__FOX_READY === true, null, { timeout: 240000, polling: 100 });

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

  const lum0 = (o) => (o ? (o.r + o.g + o.b) / 3 : 0);

  /** World position of a rig anchor, or null. */
  function worldOf(name) {
    const a = ctx.fox?.anchors?.[name];
    if (!a) return null;
    a.updateWorldMatrix(true, false);
    return new THREE.Vector3().setFromMatrixPosition(a.matrixWorld);
  }

  /** Project a rig anchor to backbuffer pixels. */
  function project(name) {
    // Fall back to the BONE of the same name.
    //
    // Only six anchors exist -- nose, eyeL, eyeR, mouth, chest, tailTip -- and
    // this returned null for anything else, silently. Two callers were asking
    // for names that are bones rather than anchors, and both degraded quietly
    // instead of failing:
    //
    //   `hips`     the lit-coat probe walks chest->hips looking for the
    //              brightest point on the trunk. With hips null it took the
    //              fallback branch every time and sampled ONE point 30 px
    //              above the chest -- so the search I added to answer "is this
    //              probe on the shaded side?" has never actually run, and my
    //              report that it "returns the identical value" described a
    //              search that did not happen.
    //   `earTipR`  the macro fur probe's brow reference. With it null the
    //              direction fell back to screen-up, which is only the brow
    //              when the head happens to be level.
    //
    // Debug.js's own `resolvePose` has always fallen back to bones. This did
    // not, and the asymmetry is what hid it.
    const a = ctx.fox?.anchors?.[name] ?? ctx.fox?.bone?.(name);
    if (!a) return null;
    a.updateWorldMatrix(true, false);
    const v = new THREE.Vector3().setFromMatrixPosition(a.matrixWorld).project(ctx.camera);
    if (v.z > 1) return null;                       // behind the camera
    return { x: (v.x * 0.5 + 0.5) * cv.width, y: (-v.y * 0.5 + 0.5) * cv.height };
  }

  /**
   * @param settle seconds of simulation before rendering. MUST be 0 for the
   *   second arm of an A/B: settling advances the sim, so the two arms end up
   *   0.3 s apart in animation and you are comparing different scenes. My nose
   *   A/B was confounded exactly this way -- it reported a 102 -> 61 "erosion"
   *   where a same-state comparison shows 104 -> 0 occlusion.
   * @param frames TAA accumulation. 18 is enough for large features; a small
   *   dark feature against a bright surround is still converging at 18 and
   *   settles by ~36 (hero nose: 133 at 18 frames, 43 at 36).
   */
  /**
   * Reset the simulation to an EXACT, known time.
   *
   * Every renderPose(..., settle) advances the sim, so a block N checks down
   * the file ran at 2.5 + 0.3*N seconds -- and the later a check sat, the
   * further it drifted. At macro framing 0.3 s moves the subject hundreds of
   * pixels. Sweeping sim time 2.8 -> 5.5 on IDENTICAL fur swung one reference
   * measurement from 0.56 to 13.34, a factor of 24, which is how I came to
   * "validate" a threshold against three different numbers and believe all of
   * them. Found by the fur agent.
   */
  const atTime = (t = 2.5) => {
    ctx.time = 0; ctx.frame = 0; ctx.app._accum = 0;
    D.settle(t);
  };

  /**
   * Reset to a deterministic time AND make sure the eyes are open.
   *
   * Fixing the drift exposed the opposite failure: a fixed sim time can be
   * deterministically WRONG. The fox blinks about 28 times a minute, and
   * t = 2.5 s landed mid-blink -- so the "eye is warm" probe sampled an
   * eyelid and read (165,179,195), i.e. blue-white skin, and failed for a
   * reason that had nothing to do with the eye's colour. Advance in small
   * steps until the lids are open before measuring anything ocular.
   */
  const atTimeEyesOpen = (t = 2.5) => {
    atTime(t);
    const closed = () => Math.max(ctx.fox?.blinkL ?? 0, ctx.fox?.blinkR ?? 0);
    for (let i = 0; i < 120 && closed() > 0.08; i++) D.settle(1 / 30);
    return { t: +ctx.time.toFixed(3), blink: +closed().toFixed(3) };
  };

  function renderPose(pose, post = true, settle = 0.3, frames = 36) {
    if (ctx.postfx) ctx.postfx.enabled = post;
    D.setPose(pose);
    if (settle > 0) D.settle(settle);
    for (let i = 0; i < frames; i++) D.render();
    return grab();
  }

  const out = {};

  // 1. NOSE COLOUR — art bible #171a20 = (23,26,32). Cost a critic round, then
  //    a face-agent round to prove it was post, not the pad.
  atTime();
  for (const post of [false, true]) {
    renderPose('portrait', post);
    const p = project('nose');
    out[`nose_${post ? 'post' : 'raw'}`] = p ? sample(p.x, p.y, 6) : null;
  }

  // 2. EYE PRESENT AND WARM at macro range. macro_eye photographed an empty
  //    socket for many rounds without anyone noticing.
  out.eyeProbeAt = atTimeEyesOpen();
  for (const post of [false, true]) {
    renderPose('macro_eye', post, 0);
    const p = project('eyeR');
    // The anchor is the eyeball's CENTRE, but the visible iris sits on the
    // cornea, proud of that centre toward the camera -- so at 0.13 m the
    // projected anchor lands near the eye's edge, and a box centred there
    // averaged iris, pupil and bright skin into (148,165,184): blue-white,
    // failing a "is the iris warm" check for reasons unrelated to the iris.
    // Locate the iris by its warmth instead, then sample tightly.
    if (!p) { out[`eye_${post ? 'post' : 'raw'}`] = null; continue; }
    let best = null;
    for (let dy = -90; dy <= 90; dy += 6) {
      for (let dx = -90; dx <= 90; dx += 6) {
        const c = sample(p.x + dx, p.y + dy, 5);
        if (!c) continue;
        const warmth = c.r - c.b;
        // Require it to be a midtone: the pupil is warm-neutral but black,
        // and blown skin is bright.
        if (c.r < 25 || c.r > 200) continue;
        if (!best || warmth > best.warmth) best = { warmth, dx, dy };
      }
    }
    out[`eye_${post ? 'post' : 'raw'}`] = best
      ? { ...sample(p.x + best.dx, p.y + best.dy, 12), foundAt: [best.dx, best.dy] }
      : sample(p.x, p.y, 12);

    // ...and the MEAN over the iris, which is what the check actually
    // asserts on. The search above is MAX-SEEKING: it hunts a +/-90 px grid
    // for the warmest 5 px patch and samples there, so it reports the
    // warmest thing near the eye whatever the eye is doing. It cannot fail
    // toward grey -- an iris at (58,47,52) would still find its warmest
    // corner and pass. The face agent measured the honest figure two ways
    // and got 40.5 from this probe's own algorithm against 29.7 for a
    // geometry-located annulus mean.
    //
    // Locating stays max-seeking, because finding the iris is exactly what
    // a max is good for; only the MEASUREMENT becomes a mean. The luminance
    // gate is the same one the search uses, and it gates on brightness, not
    // on chroma, so it cannot bias the answer warm.
    if (best) {
      const cx = Math.round(p.x + best.dx), cy = Math.round(p.y + best.dy), R = 24;
      const box = c2.getImageData(Math.max(0, cx - R), Math.max(0, cy - R), R * 2, R * 2).data;
      let R2 = 0, G2 = 0, B2 = 0, n2 = 0;
      for (let yy = 0; yy < R * 2; yy++) {
        for (let xx = 0; xx < R * 2; xx++) {
          const dx2 = xx - R, dy2 = yy - R;
          if (dx2 * dx2 + dy2 * dy2 > R * R) continue;      // disc, not box
          const i = (yy * R * 2 + xx) * 4;
          const r = box[i], g = box[i + 1], b = box[i + 2];
          if (r < 25 || r > 200) continue;                   // pupil / blown skin
          R2 += r; G2 += g; B2 += b; n2++;
        }
      }
      out[`eyeIris_${post ? 'post' : 'raw'}`] =
        n2 > 200 ? { r: R2 / n2, g: G2 / n2, b: B2 / n2, n: n2 } : null;
    }
  }

  // 3. COAT NEUTRALITY — §4b: no warm cast, ever. The salmon cast survived
  //    several rounds because the whole-body mean hid it behind the cool
  //    shadow side, so sample the LIT flank specifically.
  atTime();
  renderPose('profile', true);
  {
    // FIND the lit coat; do not assume the chest anchor is on it.
    //
    // This probe sat 30 px above the `chest` anchor and called whatever it
    // found "lit coat". At `profile` that region can be in shade, and the
    // value it reported -- (137,153,170), B-R 34 -- is almost exactly §3's
    // SHADED fur swatch #b9c7d8 (B-R +31). So the check was plausibly
    // grading shaded coat against a lit standard, which is the third probe
    // this session found measuring the wrong thing. Sample several points
    // along the trunk and take the brightest: that is the lit side by
    // definition, whichever way the sun happens to be.
    const c = project('chest'), h = project('hips');
    if (c && h) {
      let best = null;
      for (let t = 0.0; t <= 1.0; t += 0.125) {
        const x = c.x + (h.x - c.x) * t, y0 = c.y + (h.y - c.y) * t;
        for (const dy of [-70, -50, -30, -10]) {
          const sm = sample(x, y0 + dy, 20);
          if (!sm || !sm.n) continue;
          if (!best || lum0(sm) > lum0(best.sm)) best = { sm, t, dy };
        }
      }
      out.coat_lit = best ? { ...best.sm, atT: +best.t.toFixed(3), atDy: best.dy } : null;
    } else {
      out.coat_lit = c ? sample(c.x, c.y - 30, 24) : null;
    }
    // In-frame snow reference. §4b says the animal is "only slightly brighter
    // than its background"; an absolute luminance target would depend on
    // exposure and sun angle, so compare against the snow in the same frame.
    // Sampled well away from the animal and below the horizon.
    const g0 = grab();
    out.snow_ref = sample(g0.w * 0.12, g0.h * 0.80, 40);
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
  atTime();
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
  atTime();
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

  // 12. FUR AT MACRO RANGE — the scale-ratio metric, designed by the fur agent
  //     after it pointed out that my proposed per-region meanHF would NOT have
  //     caught the defect we were chasing. That defect had two components with
  //     OPPOSITE signs on meanHF — porcelain (no high-frequency energy) and
  //     dither blotches (lots) — so a mean would have been dragged toward
  //     passing by the very artefact under investigation.
  //
  //       fine   = mean |p - blur3(p)|          1-2 px structure  -> hairs
  //       coarse = mean |blur3(p) - blur15(p)|  8-20 px structure -> blotches
  //
  //     Fur concentrates energy at the fine scale; porcelain has neither;
  //     blotches have coarse without fine. One ratio separates all three.
  //
  //     Boxes are placed from projected rig anchors and deliberately OFFSET
  //     OFF THE LID, because bare skin at the lid margin is correct and a box
  //     centred on the eye would legitimately read low. Also its suggestion.
  {
  atTimeEyesOpen();
    renderPose('macro_eye', false, 0);
    const g = grab();
    const img = c2.getImageData(0, 0, g.w, g.h).data;
    const L = (x, y) => {
      const i = ((y | 0) * g.w + (x | 0)) * 4;
      return (img[i] + img[i + 1] + img[i + 2]) / 3;
    };
    const boxAvg = (cx, cy, half) => {
      let sum = 0, n = 0;
      for (let y = cy - half; y <= cy + half; y++)
        for (let x = cx - half; x <= cx + half; x++) {
          if (x < 1 || y < 1 || x >= g.w - 1 || y >= g.h - 1) continue;
          sum += L(x, y); n++;
        }
      return n ? sum / n : 0;
    };
    const scaleDetail = (cx, cy, R) => {
      let fine = 0, coarse = 0, n = 0;
      for (let y = cy - R; y <= cy + R; y += 2) {
        for (let x = cx - R; x <= cx + R; x += 2) {
          if (x < 8 || y < 8 || x >= g.w - 8 || y >= g.h - 8) continue;
          const p = L(x, y);
          const b3 = boxAvg(x, y, 1);
          const b15 = boxAvg(x, y, 7);
          fine += Math.abs(p - b3);
          coarse += Math.abs(b3 - b15);
          n++;
        }
      }
      return n ? { fine: fine / n, coarse: coarse / n,
                   ratio: (fine / n) / Math.max((fine / n) + (coarse / n), 1e-6), n } : null;
    };

    const eye = project('eyeR'), nose = project('nose'), ear = project('earTipR');
    if (eye) {
      // MEASURE the eye's projected radius; do not assume it. A hardcoded 26 px
      // under-estimated it by about 4x (it renders at 102-116 px at this
      // framing), so the "brow" reference probe sat 0.64 eye-radii from centre
      // -- inside the eye. Every number that check produced was eyelid
      // contrast, not fur.
      // Place the probes with PROJECTED GEOMETRY, not a luminance threshold.
      //
      // Two estimators have now failed here. A 75%-bright ring quorum marched
      // past the eye and reported 272 px, putting the brow probe off the top
      // of the frame. Replacing the quorum with a median then returned 0 on
      // two runs in three -- and tracing what the march actually saw explained
      // both at once: the median ring luminance is FLAT at 143-150 from 6 px
      // to 166 px, because the eye ANCHOR is the eyeball's centre while the
      // visible eye sits ~110 px away on the cornea. Every ring was sampling
      // pale coat. With the 150 threshold inside the noise, "finding the
      // radius" was a coin flip, and which side it landed on decided whether
      // the gate ran at all.
      //
      // The camera knows the pixel scale exactly, so ask it. Probe offsets and
      // box sizes are then authored in MILLIMETRES of fox, which is what they
      // always meant: 14 mm from the eye is on the muzzle and the forehead of
      // a real animal, clear of a globe that Eyes.js clamps to <= 20 mm
      // diameter, at every framing and every head angle.
      const eyeW = worldOf('eyeR');
      const camW = ctx.camera.getWorldPosition(new THREE.Vector3());
      const dist = eyeW ? camW.distanceTo(eyeW) : 0;
      const pxPerM = dist > 1e-4
        ? g.h / (2 * dist * Math.tan(ctx.camera.fov * Math.PI / 360))
        : 0;
      out.eyeProbe = { x: Math.round(eye.x), y: Math.round(eye.y), w: g.w, h: g.h,
                       distM: +dist.toFixed(4), pxPerM: Math.round(pxPerM) };
      if (!(pxPerM > 0)) { out.furScale = null; out.eyeRadiusBad = 'no pixel scale'; }
      else {
      const OFFSET_M = 0.014, BOX_HALF_M = 0.003;
      out.eyeRadiusPx = Math.round(0.010 * pxPerM);   // reported for context only
      const dirTo = (p) => {
        const dx = p.x - eye.x, dy = p.y - eye.y, m = Math.hypot(dx, dy) || 1;
        return { x: dx / m, y: dy / m };
      };
      const muzzleDir = nose ? dirTo(nose) : { x: -1, y: 0.3 };
      // The brow reference runs from the eye toward the ear tip: that is the
      // forehead, along the skull, whichever way the head is turned. Screen-up
      // is only the same thing when the head happens to be level.
      const browDir = ear ? dirTo(ear) : { x: 0, y: -1 };
      const box = Math.min(60, Math.max(8, Math.round(BOX_HALF_M * pxPerM)));
      const m = box + 9;                                // scaleDetail skips < 8
      const off = OFFSET_M * pxPerM;
      const place = (dir) => ({
        x: Math.min(g.w - 1 - m, Math.max(m, Math.round(eye.x + dir.x * off))),
        y: Math.min(g.h - 1 - m, Math.max(m, Math.round(eye.y + dir.y * off))),
      });
      const probes = { muzzle: place(muzzleDir), brow: place(browDir) };
      out.furScale = {};
      for (const [name, pt] of Object.entries(probes)) {
        const d = scaleDetail(pt.x, pt.y, box);
        // A probe is only meaningful if it landed on lit coat. If it sits on
        // the eye, in a socket shadow or off the animal entirely, the fine/
        // coarse ratio is measuring something that is not fur -- which is the
        // exact failure that made this check report eyelid contrast for three
        // rounds. Record enough to tell which happened.
        out.furScale[name] = d && {
          ...d, x: pt.x, y: pt.y, box, meanL: boxAvg(pt.x, pt.y, box),
          onCoat: boxAvg(pt.x, pt.y, box) > 90,
        };
      }
      out.furScale.frame = { w: g.w, h: g.h, eyeX: Math.round(eye.x), eyeY: Math.round(eye.y),
                             pxPerM: Math.round(pxPerM), offsetPx: Math.round(off), box };
      }
    }
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

    // Settle ONCE, then render both arms from the identical sim state.
    root.visible = false;
    renderPose(pose, post, 0.3);
    const g = grab();
    const bg = c2.getImageData(0, 0, g.w, g.h).data;

    root.visible = true;
    renderPose(pose, post, 0);          // no settle: same frame, fox added
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
  atTime();
    const m = maskedFrame('silhouette', false);   // raw render: post must not flatter it
    // True coverage for the same pose, so the backdrop can be divided out of
    // the rim rather than counted as if it were fur.
    const mt = matteOf('silhouette');
    const covRim = mt ? mt.cov : null;
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
      let rimSum = 0, rimN = 0, coreSum = 0, coreN = 0, behindSum = 0;
      for (let i = 0; i < W * H; i++) {
        if (!mask[i]) continue;
        const cc = covRim ? covRim[i] : 1;
        if (cc > 0.85) { coreSum += lumAt(fg, i); coreN++; }
        else if (core[i]) { /* eroded core but thin: neither rim nor core */ }
        // `bg` is this exact frame with the animal hidden, so bg at a rim
        // pixel is precisely the radiance the fur is standing in front of.
        //
        // But the RAW rim luminance cannot tell transmission from a GAP. A
        // fringe that is 20% hair and 80% sky reads as the sky and scores a
        // perfect 1.0 — which is why this sat at 0.998 while the critic
        // looked at `silhouette` and found no hot rim on the ruff, tail or
        // ear edges at all. Divide the backdrop back out using the coverage
        // matte, exactly as tools/matte.mjs derives it, and what is left is
        // the fur's OWN radiance:
        //
        //     I = C_fur * cov + bg * (1 - cov)   =>   C_fur = (I - bg(1-cov)) / cov
        //
        // Only pixels with enough coverage to be fur rather than sky are
        // counted; below that the division amplifies noise and the pixel is
        // mostly backdrop anyway.
        else {
          // Select the rim from the MATTE's coverage, not from an erosion of
          // the difference mask. The erosion picks the outermost, faintest
          // halo by construction -- every pixel it selects is below any
          // sensible coverage floor, which is why a 0.12 floor kept exactly
          // zero of them. What transmission wants is genuine PARTIAL fur:
          // thin enough for light to come through, thick enough to be fur.
          const c = covRim ? covRim[i] : 1;
          if (c >= 0.12 && c <= 0.85) {
            const I = lumAt(fg, i), B = lumAt(m.bg, i);
            rimSum += (I - B * (1 - c)) / c;
            behindSum += B;
            rimN++;
          }
        }
      }
      out.transmission = rimN && coreN
        ? { rim: rimSum / rimN, core: coreSum / coreN, ratio: (rimSum / rimN) / (coreSum / coreN),
            behind: behindSum / rimN, seeThrough: (rimSum / rimN) / (behindSum / rimN),
            rimPx: rimN, corePx: coreN, covFloor: 0.12 }
        : { rimPx: rimN, corePx: coreN, covFloor: 0.12, none: true };
    }
  }

  // 8. FUR COVERS CAMERA-FACING SURFACES — the tail was "a flat white blade
  //    with a hair fringe around its perimeter and nothing inside". Measure
  //    high-frequency variance INSIDE the mask, away from the edge.
  {
  atTime();
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
  atTime();
  out.nosePoses = {};
  for (const pose of ['portrait', 'hero', 'silhouette', 'profile']) {
    renderPose(pose, true);
    const postArm = true;
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
    // FIND the pad; do not assume it sits at its anchor.
    //
    // The rhinarium stands ~5.8 mm proud of the anchor, so at a shallow angle
    // the projected anchor lands off the visible pad and the box averages
    // coat. The face agent measured this directly: at `profile` this check
    // reported (100,113,130) and failed, while the darkest 5x5 ON the pad is
    // (12,22,32) -- on spec, and correctly blue-leaning. Widening the box
    // walks the number monotonically toward the coat (r=3 -> 33, r=5 -> 59,
    // r=8 -> 78, r=12 -> 99), which is the signature of a probe measuring its
    // surroundings rather than its subject. Same fault, and same fix, as the
    // iris probe: search for the feature, then sample it.
    //
    // The pad is the darkest thing on the animal, so search darkest-first over
    // a window scaled to the feature.
    const win = Math.max(4, Math.round(widthPx));
    let best = null;
    for (let dy = -win; dy <= win; dy += 2) {
      for (let dx = -win; dx <= win; dx += 2) {
        const c = sample(p.x + dx, p.y + dy, r);
        if (!c || !c.n) continue;
        const L = (c.r + c.g + c.b) / 3;
        if (!best || L < best.L) best = { L, dx, dy, c };
      }
    }
    out.nosePoses[pose] = best
      ? { ...best.c, widthPx: +widthPx.toFixed(1), rad: r, foundAt: [best.dx, best.dy] }
      : { ...sample(p.x, p.y, r), widthPx: +widthPx.toFixed(1), rad: r, foundAt: null };

    // Also measure the pad on the RAW frame.
    //
    // The post-side expectation is not physical at every framing. At
    // `silhouette` the pad is a 15-27 px black disc against 250-level snow
    // with the sun nearly in shot, so bloom veils it exactly as a real lens
    // would -- the face agent measured (2.8, 5.1, 9.2) raw against
    // (105, 110, 118) post at the same pixels. Demanding (23, 26, 32) there
    // asks the render to be wrong. So the PAD'S OWN COLOUR is asserted on the
    // raw frame, and post is reported beside it; annihilation by post is
    // already guarded separately by `nose survives post` at `portrait`.
    renderPose(pose, false);
    const pr = project('nose');
    if (pr) {
      let rb = null;
      for (let dy = -win; dy <= win; dy += 2) {
        for (let dx = -win; dx <= win; dx += 2) {
          const c0 = sample(pr.x + dx, pr.y + dy, r);
          if (!c0 || !c0.n) continue;
          const L = (c0.r + c0.g + c0.b) / 3;
          if (!rb || L < rb.L) rb = { L, c: c0 };
        }
      }
      out.nosePoses[pose].raw = rb ? rb.c : null;
    }
  }

  // 10. PER-REGION SILHOUETTE — a whole-animal median let a good torso mask a
  //     bald head. Split the scan by height band instead.
  {
  atTime();
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

  /**
   * TRUE coverage of the animal, independent of what is behind it.
   *
   * Alpha compositing is linear in the backdrop: with the world hidden and the
   * clear colour K, every pixel is `I = C_animal + (1 - cov) * K`, and
   * `C_animal` does not depend on K. Two clear colours therefore subtract it
   * away exactly. See tools/matte.mjs, which is the standalone version.
   *
   * This replaces the fg-minus-bg mask for silhouette work. That mask peaks at
   * 261/765 on a white animal against snow, which is why three agents and I
   * each failed to build a contour metric on it.
   */
  /* KNOWN DEFECT, not fixed: the matte and the frame it masks are taken at
     DIFFERENT SIM INSTANTS. matteOf establishes its own instant via atTime()
     and renders with no settle; the callers then render the image they mask
     with renderPose, whose default settle is 0.3 s. Fur moves in 0.3 s, so
     edge pixels are classified against a coat that has since shifted. At the
     `silhouette` site it is worse: the image is taken BEFORE matteOf, which
     then resets the clock and settles 2.5 s.

     I tried to fix it by settling a matching 0.3 s inside matteOf. That is
     wrong and I am recording it so nobody repeats it: the two renders are
     SEQUENTIAL, so adding 0.3 s here leaves them exactly as far apart and
     moves everything 0.3 s further down the locomotion path. Spec went from
     34 pass to 18, with `fur macro probes landed on coat`, `aurora structure
     probe is measurable` and `silhouette hardness probe is measurable` all
     reporting they could no longer find the animal.

     The real fix is to let matteOf establish the instant and then render the
     masked image with NO further advance -- renderPose(pose, post, 0) -- and
     to reorder the `silhouette` site so the matte comes first. That needs
     each call site checked individually, which is not safe to do while five
     agents are editing the tree. Reported by the postfx agent. */
  function matteOf(pose) {
    const root = ctx.fox?.root;
    if (!root) return null;
    const world = ctx.scene.children.filter((o) => o !== root && !o.isLight && !o.isCamera);
    const shown = world.map((o) => o.visible);
    const prevBg = ctx.scene.background;
    const prevClear = ctx.renderer.getClearColor(new THREE.Color());
    const prevAlpha = ctx.renderer.getClearAlpha();
    const wasPost = ctx.postfx?.enabled;

    world.forEach((o) => { o.visible = false; });
    ctx.scene.background = null;
    if (ctx.postfx) ctx.postfx.enabled = false;   // post is not linear in K

    atTime();
    D.setPose(pose);
    const shoot = (hex) => {
      ctx.renderer.setClearColor(hex, 1);
      // 20, not 8. The head band was flipping 1.153 / 1.116 across runs on an
      // identical build -- either side of its 1.15 floor -- because eight
      // renders do not converge the fur's stochastic alpha. `shoot.mjs` uses
      // 2 + 18 for exactly this reason, and a gate that decides on TAA noise
      // is not a gate.
      for (let i = 0; i < 20; i++) D.render();
      const g = grab();
      return { d: c2.getImageData(0, 0, g.w, g.h).data, w: g.w, h: g.h };
    };
    const A = shoot(0x000000), B = shoot(0xffffff);

    world.forEach((o, i) => { o.visible = shown[i]; });
    ctx.scene.background = prevBg;
    ctx.renderer.setClearColor(prevClear, prevAlpha);
    if (ctx.postfx) ctx.postfx.enabled = wasPost;

    const W = A.w, H = A.h, cov = new Float32Array(W * H);
    for (let p = 0; p < W * H; p++) {
      const i = p * 4;
      let sum = 0;
      for (let c = 0; c < 3; c++) sum += (B.d[i + c] - A.d[i + c]) / 255;
      cov[p] = Math.max(0, Math.min(1, 1 - sum / 3));
    }
    // The rhinarium's image position, so the contour scans can EXCLUDE it.
    // §4f rule 3 requires the nose leather to be bare, and a bare rhinarium
    // is a clean monotonic crossing -- exactly what the hair-floor scans are
    // built to fail. See matteBands.
    const nose = project('nose');
    return { cov, W, H, nose };
  }

  /**
   * Contour structure on a true coverage matte — ALL FOUR EDGES, in
   * millimetres of fox.
   *
   * Two things were wrong with the first version and both let real defects
   * through.
   *
   * It walked in from the LEFT only, row-wise: one quarter of a four-sided
   * contour, while §4f says "trace the outer contour". The critic re-scanned
   * the same mattes in every direction and found every contour defect in this
   * build living in the unmeasured three quarters — `tail`'s RIGHT edge sits
   * at p10 1.069 with 12.8% of its scans below the floor, while the left-only
   * number for the same animal reported a comfortable pass. A muzzle whose
   * dorsum and underside are both razor-sharp is invisible to a row scan that
   * stops at the first thing it hits.
   *
   * And it counted oscillations per PIXEL, so it was a function of how many
   * pixels the subject happened to occupy: the same coat measured 1.000 at
   * `profile @1280` and 1.195 at `@2560`. Box-filtering to a fifth of the
   * coat's own 7.4 mm tuft scale makes it oscillations per millimetre of
   * animal, which is what "does the outline read as hair" actually means. The
   * interval must span at least 2 px or the filter is a no-op — that is the
   * `resolvable` guard.
   */
  function matteBands(m) {
    if (!m) return null;
    const { cov, W, H } = m;
    const subj = ctx.fox?.root
      ? new THREE.Vector3().setFromMatrixPosition(ctx.fox.root.matrixWorld)
      : new THREE.Vector3();
    const dist = ctx.camera.getWorldPosition(new THREE.Vector3()).distanceTo(subj);
    const pxPerMm = dist > 1e-4
      ? (H / (2 * dist * Math.tan(ctx.camera.fov * Math.PI / 360))) / 1000
      : 0;
    const TUFT_MM = 7.4, SAMPLE_MM = TUFT_MM / 5;
    const step = Math.max(1, Math.round(SAMPLE_MM * pxPerMm));
    const resolvable = step >= 2;

    // Walk inward from an edge; `at(i, k)` is coverage k steps in along scan
    // i. One routine serves all four directions.
    const scan = (n, len, at, skip = null) => {
      const tvs = [], fills = []; let short = 0, dropped = 0;
      for (let i = 0; i < n; i += 2) {
        // Scans crossing the bare rhinarium, which §4f rule 3 requires to be
        // bare. Counted, never silently discarded.
        if (skip && skip(i)) { dropped++; continue; }
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
        const prof = [];
        for (let k = a; k <= b; k += step) {
          let sum = 0, cnt = 0;
          for (let j = k; j < Math.min(k + step, b + 1); j++) { sum += at(i, j); cnt++; }
          prof.push(sum / Math.max(cnt, 1));
        }
        // A SHORT RAMP IS A CLIFF. Score it 1.0; never drop it.
        //
        // This used to drop rows with fewer than six samples as "too short to
        // support the ratio", which sounded careful and was exactly backwards:
        // the hardest edges are precisely the ones with the fewest samples
        // between 2% and 90% coverage, so the filter **systematically deleted
        // the worst defects**. The fur agent found the consequence — a
        // perfectly bare muzzle scored a clean p10 on the handful of rows that
        // survived, because every genuine cliff had been filtered out first.
        //
        // A ramp shorter than two sampling intervals is not an unmeasurable
        // row, it is a monotonic crossing: the worst value the metric can
        // express. Record it as such.
        if (prof.length < 3) { short++; tvs.push(1.0); fills.push(0); continue; }
        // BAND FILL: mean coverage across the 2%-to-90% transition.
        //
        // The tv/net score alone can be passed by making the coat WORSE. The
        // fur agent proved it with ten arms: no arm raises fill and lowers
        // bad%, because tv/net is maximised by hair-gap ALTERNATION and
        // minimised by a monotone ramp -- so a dense pile scores below a
        // sparse spray. Both arms that passed did so by thinning the pile or
        // inflating it into a picket fence of separated guard hairs with grey
        // shell mass between them. It rendered as a mop and was reverted.
        fills.push(prof.reduce((p2, q) => p2 + q, 0) / prof.length);
        let tv = 0;
        for (let k = 0; k < prof.length - 1; k++) tv += Math.abs(prof[k + 1] - prof[k]);
        const net = Math.abs(prof[prof.length - 1] - prof[0]);
        if (net > 0.3) tvs.push(tv / net);
      }
      return { tvs, fills, short, dropped };
    };
    const pct = (a, f) => (a.length
      ? +a.slice().sort((p, q) => p - q)[Math.min(a.length - 1, Math.floor(f * a.length))].toFixed(3)
      : null);

    let top = H, bot = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) if (cov[y * W + x] > 0.5) { if (y < top) top = y; if (y > bot) bot = y; break; }
    if (bot <= top) return null;

    // §4f rule 3 REQUIRES bare nose leather, so scans that cross the
    // rhinarium are being graded against a rule the art direction forbids
    // them to satisfy. Measured by the fur agent: the rhinarium is 3.8% of
    // all left-edge scans and 2.4% of all bottom-edge scans, and accounts for
    // 43-48% of the left edge's failures -- 10 of 19 failing left scans fell
    // within 15 mm of the nose, nearest 4.7 mm. It alone spends more than the
    // whole 2% allowance, so `left`, `bottom` and `body` could not pass as
    // written no matter how good the coat got.
    //
    // Excluded by scan-line index: for the left/right edges a scan line is a
    // row, so drop rows within the rhinarium's radius of the nose's y; for
    // top/bottom it is a column, so drop by x. 15 mm against a 13 mm
    // rhinarium leaves a 1 mm margin each side for the fur-to-leather
    // transition. Every count below reports what it dropped.
    const noseR = 15 * pxPerMm;
    const np = m.nose;
    const dropRow = (y) => !!np && Math.abs(y - np.y) <= noseR;
    const dropCol = (x) => !!np && Math.abs(x - np.x) <= noseR;

    const res = {};
    const bands = {
      head: [top, top + (bot - top) * 0.33],
      body: [top + (bot - top) * 0.33, top + (bot - top) * 0.70],
      legs: [top + (bot - top) * 0.70, bot],
    };
    for (const [name, [y0, y1]] of Object.entries(bands)) {
      const y0i = Math.round(y0) + 1, nb = Math.max(0, Math.round(y1) - 1 - y0i);
      const skipY = (i) => dropRow(y0i + i);
      const L = scan(nb, W, (i, k) => cov[(y0i + i) * W + k], skipY);
      const R = scan(nb, W, (i, k) => cov[(y0i + i) * W + (W - 1 - k)], skipY);
      const tvs = L.tvs.concat(R.tvs), short = L.short + R.short;
      const dropped = L.dropped + R.dropped;
      const usable = tvs.length >= 8 && tvs.length >= short;
      const lp = pct(L.tvs, 0.10), rp = pct(R.tvs, 0.10);
      res[name] = usable && resolvable
        ? { n: tvs.length, shortRows: short, noseDropped: dropped,
            tvMedian: pct(tvs, 0.50), tvP10: pct(tvs, 0.10),
            leftP10: lp, rightP10: rp,
            // The WORSE side is what the gate asserts. A band can be hairy on
            // one side and bare on the other -- `tail`'s legs band reads 3.14
            // left and 1.000 right -- and a combined p10 hides which.
            worstP10: Math.min(lp ?? 99, rp ?? 99),
            pxPerMm: +pxPerMm.toFixed(2), stepPx: step }
        : { unresolvable: !resolvable, tooShort: !usable,
            pxPerMm: +pxPerMm.toFixed(2), n: tvs.length, shortRows: short };
    }
    // Whole-contour edges, so top and bottom are measured at all.
    res.edges = {};
    for (const [e, sc] of Object.entries({
      left:   scan(H, W, (y, k) => cov[y * W + k], dropRow),
      right:  scan(H, W, (y, k) => cov[y * W + (W - 1 - k)], dropRow),
      top:    scan(W, H, (x, k) => cov[k * W + x], dropCol),
      bottom: scan(W, H, (x, k) => cov[(H - 1 - k) * W + x], dropCol),
    })) {
      res.edges[e] = {
        n: sc.tvs.length, noseDropped: sc.dropped,
        fillMedian: pct(sc.fills, 0.50),
        tvP10: pct(sc.tvs, 0.10), tvMedian: pct(sc.tvs, 0.50),
        badFrac: sc.tvs.length
          ? +(sc.tvs.filter((v) => v < 1.15).length / sc.tvs.length).toFixed(3) : null,
      };
    }
    return res;
  }

  // 10b. SILHOUETTE HARDNESS — width is not softness.
  //
  //      Check 10 reports the head's edge ramping over 8 px and passes it,
  //      while the legacy whole-frame check reports a 1 px transition and the
  //      renders plainly show a hard edge. Neither instrument is lying: they
  //      measure DIFFERENT EDGES. The animal has two — a faint wide veil of
  //      outer shells, and inside it the skin mesh's own hard silhouette.
  //      Check 10 walks in from 3% coverage to 80% and calls the distance a
  //      ramp, so a 8 px veil followed by a cliff scores exactly the same as
  //      a genuine 8 px feather. Transition WIDTH cannot tell them apart.
  //
  //      What separates them is the largest single-pixel STEP in coverage.
  //      Fur ramps; bare mesh jumps. Measured as a fraction of interior
  //      coverage, a hairy edge stays under ~0.2 and a mesh edge approaches
  //      the antialiased limit of ~0.5.
  {
  atTime();
    const profileOf = (m) => {
      if (!m) return null;
      const { W, H, fg, bg: bgRef, mask } = m;
      let top = H, bot = 0;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) if (mask[y * W + x]) { if (y < top) top = y; if (y > bot) bot = y; break; }
      if (bot <= top) return null;
      const covAt = (x, y) => {
        const i = (y * W + x) * 4;
        return Math.abs(fg[i] - bgRef[i]) + Math.abs(fg[i + 1] - bgRef[i + 1]) +
               Math.abs(fg[i + 2] - bgRef[i + 2]);
      };
      // A `legs` band, because §4f says trace the WHOLE contour and the
      // body band does not. The critic scanned a foreleg edge and got
      // `173 173 171 156 151 151 150 146 141 136 133 124 119 115 114 112 112
      // 111 111 111 110` -- monotonic over 13 px with not one hair crossing
      // it -- while this check passed the body by 0.034. Each leg is ~5% of
      // the contour against §4f's 2% allowance, so a gate that cannot see
      // them is passing the animal on its best third.
      const bands = {
        head: [top, top + (bot - top) * 0.33],
        body: [top + (bot - top) * 0.33, top + (bot - top) * 0.70],
        legs: [top + (bot - top) * 0.70, bot],
      };
      const res = {};
      for (const [name, [y0, y1]] of Object.entries(bands)) {
        const steps = [];
        for (let y = Math.round(y0) + 2; y < Math.round(y1) - 2; y += 3) {
          let x = 1;
          while (x < W - 1 && !mask[y * W + x]) x++;
          if (x >= W - 2 || x < 8) continue;
          let run = 0;
          while (x + run < W - 2 && mask[y * W + x + run]) run++;
          if (run < 6) continue;
          const probe = Math.min(20, Math.max(4, Math.round(run * 0.6)));
          // Sample the whole transition, starting OUTSIDE the mask: the ramp
          // begins before coverage reaches the mask's 25/765 threshold, and
          // that leading shoulder is exactly what a bare mesh edge lacks.
          const prof = [];
          for (let k = -6; k <= probe; k++)
            prof.push(covAt(Math.max(1, Math.min(W - 2, x + k)), y));
          // Normalise by the ROW'S OWN amplitude, not by coverage at a fixed
          // probe depth.
          //
          // Dividing by `deep` assumed the interior is the brightest part of
          // the transition. At `silhouette` the animal is backlit: the edge is
          // rim-lit and the interior is in shadow, so steps routinely exceeded
          // `deep` and the metric reported values above 1.0 -- up to 2.9 -- for
          // a ratio that is supposed to be a FRACTION of the transition. Two
          // agents independently found the head arm reading ~2.0 with the coat
          // hidden entirely, against this check's own stated expectation that a
          // bare mesh edge approaches 0.5. Amplitude-normalised, the value is
          // bounded in [0,1] by construction and means what it says.
          const lo = Math.min(...prof), hi = Math.max(...prof);
          if (hi - lo < 40) continue;                 // no transition to measure

          // TOTAL VARIATION over NET CHANGE -- not the largest step.
          //
          // Largest-step was the wrong idea and the fur-off control proved it:
          // once real hair resolves, an individual guard hair is 1-2 px wide
          // and produces a full-amplitude single-pixel step against the sky
          // all by itself. So a hairy edge and a bare mesh edge both scored
          // ~0.68 and the control could not tell them apart -- the metric was
          // blind in exactly the way it was built to detect.
          //
          // What actually separates them is not step SIZE but STRUCTURE. A
          // bare mesh edge crosses from background to animal exactly once and
          // monotonically, so its total variation equals its net change and
          // the ratio is 1. A furred edge alternates hair, gap, hair, gap
          // before it saturates, so the path length exceeds the displacement
          // and the ratio climbs above 1. That is the same quantity §4f's
          // prose is describing -- "a broken, hairy outline rather than a
          // smooth curve" -- and it is bounded below by 1 by construction.
          let tv = 0;
          for (let k = 0; k < prof.length - 1; k++) tv += Math.abs(prof[k + 1] - prof[k]);
          const net = Math.abs(prof[prof.length - 1] - prof[0]);
          if (net < 30) continue;
          steps.push(tv / net);
        }
        steps.sort((a, b) => a - b);
        res[name] = steps.length >= 6
          ? { median: +steps[steps.length >> 1].toFixed(3),
              p10: +steps[Math.floor(steps.length * 0.1)].toFixed(3),
              p90: +steps[Math.min(steps.length - 1, Math.floor(steps.length * 0.9))].toFixed(3),
              n: steps.length }
          : null;
      }
      return res;
    };

    // Measured at `frontal`, NOT at `silhouette`.
    //
    // `silhouette` is the artistically important framing and the obvious place
    // to test an outline, but it is unmeasurable by pixel difference: a white
    // animal backlit against bright snow peaks at 261/765 of coverage, so
    // there is barely a signal to find a contour in. Measured both ways, the
    // coat raises the body's structure ratio 1.43x over a fur-off control at
    // `frontal` (2.116 vs 1.476) and 0.99x at `silhouette` (1.071 vs 1.086) --
    // i.e. at `silhouette` the metric cannot tell a full winter coat from bare
    // mesh. The anatomy agent reached the same conclusion independently while
    // trying to build its own furred-silhouette metric.
    out.edgeHardness = profileOf(maskedFrame('frontal', true));
    // The authoritative silhouette measurement, on a TRUE coverage matte, at
    // BOTH framings -- because the choice of framing turned out to matter more
    // than the metric did.
    out.matteProfile = matteBands(matteOf('profile'));
    out.matteFrontal = matteBands(matteOf('frontal'));

    // POSITIVE CONTROL. A new gate that has never been shown to fail on a
    // KNOWN defect is not a gate, it is a number -- that mistake has been made
    // twice on this project already. Hide the coat and the same scan must
    // report a decidedly harder edge; if it does not, this metric cannot see
    // what it claims to see and its verdict above is worthless.
    const coat = [ctx.fur?.shellMesh, ctx.fur?.cardMesh].filter(Boolean);
    if (coat.length) {
      const vis = coat.map((o) => o.visible);
      coat.forEach((o) => { o.visible = false; });
      atTime();
      out.edgeHardnessNoFur = profileOf(maskedFrame('frontal', true));
      coat.forEach((o, i) => { o.visible = vis[i]; });
    } else {
      out.edgeHardnessNoFur = null;
      out.edgeControlMissing = 'ctx.fur.shellMesh / cardMesh not found';
    }
  }

  // 10c. THE FOOT MEETS THE SNOW — measured in the IMAGE, not on a bone.
  //
  //      `audit.mjs` has 76 checks certifying paw contact and every one reads
  //      a bone position. A joint can be perfectly planted while nothing
  //      renders at its position, and that is exactly what shipped: the
  //      anatomy agent measured the drawn coat sitting 44-79 px (up to 48 mm)
  //      BELOW the snow line at every paw, with all 76 checks green.
  //
  //      Worse, the instrument shaped the product. `Locomotion.js` says so in
  //      its own words -- it drives the bone down because "the audit
  //      classifies stance from that BONE at a 22 mm threshold" -- and the
  //      metacarpal rides 17.1 mm above the sole. A tolerance became a design
  //      constraint and buried the foot.
  //
  //      So: find each paw in the coverage matte, find where the terrain
  //      actually is beneath it, and compare. No bone is consulted.
  {
  atTime();
    const m = matteOf('paws');
    if (m) {
      const { cov, W, H } = m;
      out.footGround = {};
      for (const k of ['pawL', 'pawR', 'footL', 'footR']) {
        const b = ctx.fox?.bone?.(k);
        if (!b) { out.footGround[k] = null; continue; }
        b.updateWorldMatrix(true, false);
        const wp = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
        const gy = ctx.terrain?.heightAt ? ctx.terrain.heightAt(wp.x, wp.z) : null;
        if (gy == null) { out.footGround[k] = null; continue; }
        const pg = new THREE.Vector3(wp.x, gy, wp.z).project(ctx.camera);
        const pp = wp.clone().project(ctx.camera);
        if (pg.z > 1 || pp.z > 1) { out.footGround[k] = null; continue; }
        const gpx = (-pg.y * 0.5 + 0.5) * H;
        const ppx = Math.round((pp.x * 0.5 + 0.5) * W);
        let lowest = -1;
        for (let x = Math.max(0, ppx - 12); x <= Math.min(W - 1, ppx + 12); x++)
          for (let y = H - 1; y > 0; y--)
            if (cov[y * W + x] > 0.5) { if (y > lowest) lowest = y; break; }
        const dist = ctx.camera.getWorldPosition(new THREE.Vector3()).distanceTo(wp);
        const pxPerM = H / (2 * dist * Math.tan(ctx.camera.fov * Math.PI / 360));
        out.footGround[k] = lowest < 0 ? null : {
          belowSnowPx: +(lowest - gpx).toFixed(1),
          belowSnowMm: +((lowest - gpx) / pxPerM * 1000).toFixed(1),
        };
      }
    }
  }

  // 10d. HIGHLIGHT CLIPPING ON THE SUBJECT, not over the frame.
  //
  //      The frame-pooled check passed at well under 1% while the portrait
  //      ruff was 16.54% at/above 252 and 7.53% railed at exactly 255 inside
  //      a 250x200 box. Pool over a small block and take the WORST one that
  //      lies on the animal, which is the only place §2.3 cares about.
  {
  atTime();
    const m = matteOf('portrait');
    if (m) {
      renderPose('portrait', true);
      const g = grab();
      const img = c2.getImageData(0, 0, g.w, g.h).data;
      const { cov, W, H } = m;
      const B = 64;
      let worst = null, blocks = 0;
      for (let by = 0; by + B <= Math.min(H, g.h); by += B) {
        for (let bx = 0; bx + B <= Math.min(W, g.w); bx += B) {
          let on = 0, clip = 0, rail = 0, n = 0;
          for (let y = by; y < by + B; y += 2) {
            for (let x = bx; x < bx + B; x += 2) {
              if (cov[y * W + x] < 0.9) continue;      // subject only
              on++;
              const i = (y * g.w + x) * 4;
              const mx = Math.max(img[i], img[i + 1], img[i + 2]);
              if (mx >= 252) clip++;
              if (mx >= 255) rail++;
              n++;
            }
          }
          if (n < (B / 2) * (B / 2) * 0.5) continue;   // mostly off the animal
          blocks++;
          const frac = clip / n;
          if (!worst || frac > worst.worstFrac) {
            worst = { worstFrac: frac, railFrac: rail / n, x: bx, y: by };
          }
        }
      }
      out.subjectClip = worst ? { ...worst, blocks } : null;

      // The coat's SHADED band, for a colour contract that can fail toward
      // grey. Every existing coat-colour check bounds the blue side from
      // ABOVE -- "not warm", "no bluer than the snow" -- so a coat that had
      // lost its colour entirely and gone dead grey passed all of them.
      // REVIEW-5 measured the shaded coat at B-R +11.4 against §3's shaded
      // fur swatch #b9c7d8 (+31) and no instrument in this file could see it.
      //
      // Taken as the darkest 15% of coat pixels INSIDE the coverage matte,
      // so the probe cannot land off the animal, in a socket, or on snow --
      // which is how the macro fur probe spent three rounds grading eyelids.
      const Ls = [];
      for (let y = 0; y < Math.min(H, g.h); y += 2)
        for (let x = 0; x < Math.min(W, g.w); x += 2) {
          if (cov[y * W + x] < 0.9) continue;
          const i = (y * g.w + x) * 4;
          Ls.push(0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2]);
        }
      if (Ls.length > 500) {
        const cut = Ls.slice().sort((a, b) => a - b)[Math.floor(Ls.length * 0.15)];
        let R = 0, G = 0, B2 = 0, n2 = 0;
        for (let y = 0; y < Math.min(H, g.h); y += 2)
          for (let x = 0; x < Math.min(W, g.w); x += 2) {
            if (cov[y * W + x] < 0.9) continue;
            const i = (y * g.w + x) * 4;
            const L = 0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2];
            if (L > cut) continue;
            R += img[i]; G += img[i + 1]; B2 += img[i + 2]; n2++;
          }
        out.coat_shade = n2 ? { r: R / n2, g: G / n2, b: B2 / n2, n: n2 } : null;
      }
    }
  }

  // 11. AURORA STRUCTURE — §7 asks for vertical filaments.
  //
  //     Measured on GREEN EXCESS, not luminance, and only where the aurora
  //     actually is.
  //
  //     The first version took horizontal-over-vertical gradient energy of
  //     LUMINANCE over the top 45% of the frame, and the critic showed it
  //     passing at 1.039 on an aurora that is unambiguously three horizontal
  //     smears. Of course it did: that region contains the sun disc, its glow
  //     column, the stars, and the sky's own strong vertical ramp. The aurora
  //     contributed a small fraction of the gradient energy being divided.
  //
  //     The aurora is the only green thing in the sky, so `G - (R+B)/2`
  //     isolates it almost perfectly, and thresholding that also gives a mask
  //     of where it is. Validated with a positive control: hiding the aurora
  //     group must collapse the mask, or the mask is not finding the aurora.
  {
  atTime();
    const greenField = () => {
      const g = grab();
      const H = Math.round(g.h * 0.45), W = g.w;
      const d = c2.getImageData(0, 0, W, H).data;
      const a = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) {
        const r = d[i * 4], gr = d[i * 4 + 1], b = d[i * 4 + 2];
        a[i] = gr - (r + b) * 0.5;
      }
      return { a, W, H };
    };
    const structure = ({ a, W, H }) => {
      let gx = 0, gy = 0, n = 0, Jxx = 0, Jyy = 0, Jxy = 0;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          if (a[i] < 3) continue;                    // not aurora
          gx += Math.abs(a[i + 1] - a[i]);
          gy += Math.abs(a[i + W] - a[i]);
          // CENTRAL differences for the tensor, not forward ones.
          //
          // Forward differences share the -a[i] term, so on iid noise
          // Jxx = Jyy = 2*sigma^2 and Jxy = +sigma^2 -- which lands at
          // EXACTLY 135 degrees and coherence EXACTLY 0.5. I verified it on
          // pure Gaussian noise through this check's own arithmetic:
          // forward gives 134.9 / 0.508, central gives 7.1 / 0.009.
          //
          // So my coherence floor of 0.5 was precisely what noise alone
          // produces -- vacuous on that side -- and the 128.6 degrees that
          // REVIEW-6 and I both read as "the curtains are diagonal" was
          // partly this bias pulling a noise-dominated field toward 135.
          // The aurora agent found it; the real defect underneath was a
          // screen-locked dither, and correcting the metric does not undo
          // that, but the number was never as clean as either of us wrote.
          const dx = (a[i + 1] - a[i - 1]) * 0.5, dy = (a[i + W] - a[i - W]) * 0.5;
          Jxx += dx * dx; Jyy += dy * dy; Jxy += dx * dy;
          n++;
        }
      }
      // Dominant structure orientation in degrees, 90 = vertical, and
      // coherence in [0,1], 0 = isotropic. The eigenvector of largest
      // eigenvalue points ACROSS the structure, so the structure itself runs
      // 90 degrees off it.
      let orientDeg = null, coherence = null;
      if (n > 0) {
        const xx = Jxx / n, yy = Jyy / n, xy = Jxy / n;
        const gradDeg = 0.5 * Math.atan2(2 * xy, xx - yy) * 180 / Math.PI;
        orientDeg = ((gradDeg + 90) % 180 + 180) % 180;
        coherence = Math.hypot(xx - yy, 2 * xy) / Math.max(xx + yy, 1e-9);
      }
      // Amplitude over the WHOLE SKY, not inside the mask.
      //
      // My first version took the 99th percentile of pixels with green
      // excess > 1 -- i.e. it measured the amplitude of the pixels selected
      // for having amplitude, which cannot fail. It read p99 35.5 and passed
      // on a sky where only **0.004%** of pixels exceed +3 and the sky-wide
      // p99 is **-1.5**. I wrote that check in the same commit as a
      // paragraph criticising exactly this shape of self-reference.
      let peak = 0; const vals = [];
      for (let i = 0; i < W * H; i++) { if (a[i] > peak) peak = a[i]; vals.push(a[i]); }
      vals.sort((p, q) => p - q);
      return n ? { gx: gx / n, gy: gy / n, ratio: (gx / n) / Math.max(gy / n, 1e-4),
                   orientDeg: orientDeg == null ? null : +orientDeg.toFixed(1),
                   coherence: coherence == null ? null : +coherence.toFixed(3),
                   px: n, frac: n / (W * H), peak: +peak.toFixed(1),
                   p99: vals.length ? +vals[Math.floor(vals.length * 0.99)].toFixed(1) : 0 }
                 : { px: 0, frac: 0, peak: +peak.toFixed(1), p99: 0 };
    };

    // Test the aurora at a sun elevation where an aurora can EXIST.
    //
    // The atmosphere agent made the aurora fade out when the sun is up
    // (e364d7f, "an aurora and a +6.6 degree sun cannot both be in the
    // frame"), which is physically right and immediately made this check
    // unmeasurable -- the green mask found 0 px. Asserting on the aurora at
    // the default sun would either demand a physical impossibility or quietly
    // grade an aurora that is correctly absent. Drop the sun below the horizon
    // for this one block and restore it after.
    //
    // Rendered WITH POST. The previous version passed `false`, measuring the
    // raw pre-tonemap buffer -- an image that never ships. It read p99 34.5
    // there while the delivered PNG of the same pose at the same sun measures
    // **p99 -1.5, median -4.50, 0.004% of sky above +3**: AgX and the grade
    // crush the aurora until the sky is net MAGENTA. Post is not a detail
    // here, it is the entire difference between an aurora and no aurora.
    const sunWas = { e: ctx.sky?.sunElevationDeg, a: ctx.sky?.sunAzimuthDeg };
    D.setSun(-6, 140);
    atTime();
    renderPose('aurora', true);
    out.auroraStructure = structure(greenField());
    out.auroraAtSun = -6;

    // Positive control: with the aurora hidden the green mask must collapse.
    const ag = ctx.aurora?.group;
    if (ag) {
      const vis = ag.visible;
      ag.visible = false;
      atTime();
      renderPose('aurora', true);
      out.auroraNoneStructure = structure(greenField());
      ag.visible = vis;
    }
    if (sunWas.e != null) D.setSun(sunWas.e, sunWas.a);
  }

  // 11. THE QUALITY LADDER, which nothing in this repo has ever measured.
  //
  //     REVIEW-6 blocker 9: "`low` is a different, worse animal, and nothing
  //     measures it." It turned out to be worse than that -- at `hero`, `low`
  //     reads as a PLUSHER animal than `high`. Same flank box, same commit:
  //     high put 62.7% of the flank below luminance 160 with sd 45.02, low
  //     put 25.5% there with sd 21.27. A higher tier was delivering large
  //     smooth grey patches that the cheaper tier did not have.
  //
  //     Measured as LOW-FREQUENCY variance, which is the whole point. Raw sd
  //     rises legitimately with tier, because more shells and more cards mean
  //     more hair and more local contrast -- so raw sd would punish the
  //     better coat. Patches are low-frequency and hair is high-frequency, so
  //     box-averaging 16x before taking sd keeps the patches and averages the
  //     hair away.
  //
  //     The box tracks the animal rather than sitting at fixed pixels: it is
  //     centred between the chest and tailTip anchors and scaled by their
  //     separation, so it survives a framing or anatomy change.
  {
    const tierWas = ctx.quality?.tier;
    out.tierCoat = {};
    for (const tier of ['low', 'medium', 'high', 'ultra']) {
      D.setQuality(tier);
      atTime();
      renderPose('hero', true, 0);
      const a = project('chest'), b = project('tailTip');
      if (!a || !b) { out.tierCoat[tier] = null; continue; }
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const span = Math.hypot(b.x - a.x, b.y - a.y);
      const hw = Math.max(24, Math.round(span * 0.30));
      const hh = Math.max(16, Math.round(span * 0.18));
      const g = grab();
      const x0 = Math.max(0, Math.round(cx - hw)), y0 = Math.max(0, Math.round(cy - hh));
      const w = Math.min(g.w - x0, hw * 2), h = Math.min(g.h - y0, hh * 2);
      if (w < 64 || h < 32) { out.tierCoat[tier] = null; continue; }
      const d = c2.getImageData(x0, y0, w, h).data;
      // Box-average into 16x16 cells: hair averages out, patches do not.
      const B = 16, cw = Math.floor(w / B), ch = Math.floor(h / B), cells = [];
      for (let cyi = 0; cyi < ch; cyi++) {
        for (let cxi = 0; cxi < cw; cxi++) {
          let sum = 0;
          for (let yy = 0; yy < B; yy++) {
            for (let xx = 0; xx < B; xx++) {
              const i = ((cyi * B + yy) * w + (cxi * B + xx)) * 4;
              sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            }
          }
          cells.push(sum / (B * B));
        }
      }
      if (cells.length < 12) { out.tierCoat[tier] = null; continue; }
      const mean = cells.reduce((p2, q) => p2 + q, 0) / cells.length;
      const sd = Math.sqrt(cells.reduce((p2, q) => p2 + (q - mean) ** 2, 0) / cells.length);
      out.tierCoat[tier] = { lfSd: +sd.toFixed(2), mean: +mean.toFixed(1), cells: cells.length };
    }
    if (tierWas) D.setQuality(tierWas);
    atTime();
  }

  if (ctx.postfx) ctx.postfx.enabled = true;
  out.initErrors = D.errors();
  return out;
});

await browser.close();
await server.close();

// --- assertions -----------------------------------------------------------
const hex = (c) => c ? `(${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)})` : 'n/a';
const lum = (c) => (c ? (c.r + c.g + c.b) / 3 : 0);

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
// Asserted on the iris MEAN, not on the max-seeking probe.
//
// The old bar was R-B > 6 against a max-seeking sample that reported 40.5:
// 13x of slack on a number that could not fall. §3's iris is +79, but the
// face agent showed that comparing the render to it is a category error --
// +79 is an ALBEDO channel difference, and the authored iris already
// exceeds it (uIrisMid 0xd39a44 is R-B 143). The render lands far lower
// because the only light on the eye is a cold sky, the sun being behind
// the animal at every specified framing.
//
// So the bar is calibrated, not sourced, and says so: the face agent's
// geometry-located annulus mean read 29.7 raw, and 22 leaves 26% of
// headroom under it. A grey iris at (58,47,52) fails this and passed the
// old one.
const eir = results.eyeIris_raw;
record('eye is warm (raw)', eir && eir.r - eir.b >= 22,
  `iris MEAN R-B ${eir ? (eir.r - eir.b).toFixed(1) : '?'} over ${eir ? eir.n : 0} px ` +
  `against a calibrated floor of 22. The max-seeking probe beside it reads ` +
  `${er ? (er.r - er.b).toFixed(1) : '?'} — that number hunts the warmest ` +
  `patch within 90 px and therefore cannot fail toward grey, which is why ` +
  `it is no longer the assertion`);
record('eye keeps its chroma through post', er && ep && (ep.r - ep.b) > (er.r - er.b) * 0.7,
  `raw R-B ${er ? (er.r - er.b).toFixed(1) : '?'} -> post R-B ${ep ? (ep.r - ep.b).toFixed(1) : '?'}`);

// The quality ladder: a more expensive tier must not look WORSE.
//
// Nothing in this repo measured any tier but `high` until now, which is how
// `low` came to read as a plusher animal than `high` without anyone noticing.
// Low-frequency variance over the flank is the patch metric -- hair is
// high-frequency and averages away under the 16x box, patches do not.
//
// The bound is one-sided and generous (1.3x plus 2 levels of slack): a richer
// coat legitimately carries MORE structure, and the point is not to force the
// tiers to match but to catch a higher tier developing large smooth blotches
// a cheaper one does not have.
const tc = results.tierCoat || {};
const tcLow = tc.low, tcHigh = tc.high;
record('a dearer tier does not look worse',
  !!(tcLow && tcHigh) && tcHigh.lfSd <= tcLow.lfSd * 1.3 + 2,
  tcLow && tcHigh
    ? `flank low-frequency sd by tier — low ${tcLow.lfSd}, medium ` +
      `${tc.medium ? tc.medium.lfSd : '?'}, high ${tcHigh.lfSd}, ultra ` +
      `${tc.ultra ? tc.ultra.lfSd : '?'} (${tcHigh.cells} cells). high must ` +
      `stay under low x1.3 + 2 = ${(tcLow.lfSd * 1.3 + 2).toFixed(2)}. This is ` +
      `PATCHINESS, not detail: the 16x box average removes hair and keeps ` +
      `blotches, so a richer coat is not penalised for carrying more structure`
    : 'tier ladder not measured — that is a failure, not a pass');

// Coat: §4b forbids any warm cast.
const cl = results.coat_lit, sn = results.snow_ref;
record('lit coat is not warm', cl && cl.r - cl.b < 10, `${hex(cl)} — R-B must stay under 10`);
// This check used to be the whole of the coat's colour contract, and it
// asserted ONE side of neutrality. A coat at B-R = +59 -- a mid-blue, 43%
// darker than the snow beside it -- passed cleanly for rounds while the
// critic and the user both described the animal as an ice carving. A gate
// that can only fail warm is not a neutrality gate.
// Measured against the SNOW's own cast, not against an absolute.
//
// An absolute B-R bound was the wrong test and I nearly acted on it. Measured
// off the render: the coat's brightest 2% reads B-R +9, properly neutral; its
// median reads +31; and THE SNOW READS +17. The whole scene carries a cool
// twilight cast, so an absolute threshold condemns the coat for the sky's
// colour. Snow is the one surface in frame we know to be white, which makes
// it the reference -- the same in-frame-calibration trick that fixed the
// macro fur probe. A scattering coat will pick up slightly more sky than
// packed snow does, so allow a margin, but not much.
record('coat is no bluer than the snow it stands on',
  cl && sn && (cl.b - cl.r) - (sn.b - sn.r) <= 10,
  `coat B-R ${cl ? (cl.b - cl.r).toFixed(0) : '?'} against snow B-R ` +
  `${sn ? (sn.b - sn.r).toFixed(0) : '?'} — excess ` +
  `${cl && sn ? ((cl.b - cl.r) - (sn.b - sn.r)).toFixed(0) : '?'}, want <= 10. ` +
  `§3 puts LIT fur at #fdfcfa; the coat's own highlights measure B-R +9, so ` +
  `this is about the BULK of the coat reading cool, not the shading model`);
// ... and the other side of the same contract: a coat that has gone GREY.
// §3's shaded fur swatch #b9c7d8 is B-R +31. The floor is 60% of that,
// because the scene's exposure and the sun's own colour legitimately move
// it, but dead neutral is not a lighting choice, it is a missing one. The
// ceiling stops an overcorrection into ice-blue: the bulk coat read +59 for
// rounds while the critic and the user both called the animal an ice carving.
const cs = results.coat_shade;
record('the coat keeps its colour in shadow',
  cs && (cs.b - cs.r) >= 18.6 && (cs.b - cs.r) <= 50,
  `shaded coat (darkest 15% inside the coverage matte, ${cs ? cs.n : 0} px) ` +
  `B-R ${cs ? (cs.b - cs.r).toFixed(1) : '?'}, wanted 18.6 to 50 against §3's ` +
  `shaded swatch #b9c7d8 at +31. Every other coat-colour check here bounds ` +
  `blue from ABOVE only, so a coat going dead grey passed all of them`);
record('lit coat is nearly as bright as the snow', cl && sn &&
  lum(cl) >= lum(sn) * 0.80,
  `coat ${hex(cl)} L=${cl ? lum(cl).toFixed(0) : '?'} against snow ${hex(sn)} ` +
  `L=${sn ? lum(sn).toFixed(0) : '?'} — ratio ${cl && sn ? (lum(cl) / lum(sn)).toFixed(2) : '?'}, ` +
  `want >= 0.80. §4b: "against snow the animal is only slightly brighter than ` +
  `its background", so far darker is as wrong as far brighter`);

// Frame: no scrim, no crush, no blowout.
const f = results.frame;
const floorLift = (f && results.floorRaw != null) ? f.p01 - results.floorRaw : null;
record('post does not put a floor under the frame', floorLift != null && floorLift <= 12,
  `0.1st-percentile luminance ${results.floorRaw} without post -> ${f?.p01} with post ` +
  `(lift ${floorLift}); single darkest pixel ${f?.minL?.toFixed(1)} is not asserted on, ` +
  'it is one sample and it flaked between runs');
// Frame-pooled clipping cannot see the subject.
//
// §2.3 cares about the ANIMAL blowing out, and a whole-frame fraction
// drowns it: the critic measured the portrait ruff at **16.54% of pixels at
// or above 252 and 7.53% railed at exactly 255** inside a 250x200 box while
// this check read well under 1% over the frame and passed. A local maximum
// is the quantity; a global mean is not.
record('highlights not clipped (frame)', f && f.clipFrac < 0.01,
  `${((f?.clipFrac ?? 0) * 100).toFixed(2)}% of pixels at/above 252 over the ` +
  `whole frame — see the subject-local check below, which is the one §2.3 wants`);
{
  const sc = results.subjectClip;
  record('highlights not clipped (on the animal)', sc && sc.worstFrac < 0.03,
    sc ? `worst 64x64 block on the subject: ${(sc.worstFrac * 100).toFixed(2)}% ` +
         `at/above 252 and ${(sc.railFrac * 100).toFixed(2)}% railed at exactly 255 ` +
         `(want < 3%), of ${sc.blocks} blocks sampled inside the coverage ` +
         `matte. Worst block was at ${sc.x},${sc.y}, but that is a MAXIMUM ` +
         `over ${sc.blocks} blocks -- extremum statistics. An identical build ` +
         `measured 54.85 / 55.40 / 54.89 across three runs with the location ` +
         `moving between (896,1024) and (1344,512), so do not quote the ` +
         `coordinate as if it named a feature`
       : 'subject clip probe produced no blocks — a failure, not a pass');
}
// UNSOURCED THRESHOLD, and I could not source it. ART_DIRECTION.md has no
// frame-contrast spec at all -- 35 appears nowhere but here. Worse, the only
// lever that reaches it is exposure, and the postfx agent swept it: sd 32.2
// at exposure x1.00, 33.4 at x0.85, 34.7 at x0.70, 36.6 at x0.50, so clearing
// 35 needs roughly x0.75 against §3's stated "exposure ~1.0". A check that
// can only be satisfied by contradicting the art direction is a check with a
// wrong number in it, not a render defect.
//
// It is also a whole-FRAME standard deviation on a composition that is
// deliberately most sky and snow, with §168 asking for aerial perspective to
// flatten the distance and §4b asking for the animal to sit only slightly
// brighter than its background. It substantially measures the art direction's
// own choices.
//
// Left FAILING rather than quietly relaxed or deleted: I have no sourced
// number to replace it with, and moving a bar because the build misses it is
// how a gate stops meaning anything. This needs an art-direction decision.
record('frame has contrast', f && f.sd > 35,
  `sd ${f?.sd.toFixed(1)} against an UNSOURCED floor of 35 — see the comment ` +
  `above this check: reaching it requires exposure ~0.75 against §3's ~1.0`);

// Horizon: no hard step.
const hs = results.horizonStep;
// NO COHERENT EDGE IS THE GOOD OUTCOME, not an inconclusive one.
//
// The predicate required `agreeing >= 4` before it would pass, so a horizon
// with no detectable step at all FAILED — and then said so in its own
// message, "[INCONCLUSIVE: no coherent edge found]". The critic measured the
// horizon independently at a 0.83-1.77 level maximum single-row jump and
// called this a false alarm inflating the failure count. It was right: a
// check whose success condition is "I found a seam, but a small one" cannot
// report the absence of a seam.
record('no hard horizon step', !!hs && (hs.agreeing < 4 || hs.worst < 45),
  `largest HORIZONTALLY COHERENT jump ${hs?.worst.toFixed(0)} levels at y=${hs?.y} ` +
  `(${hs?.agreeing}/${hs?.cols} columns agree); loudest isolated point ` +
  `${hs?.loudestIsolated?.toFixed(0)} — isolated points are sparkle, not seams` +
  (hs && hs.agreeing < 4 ? ' — no coherent edge found, which is the PASS ' +
    'condition: there is no seam to measure' : ''));

// --- checks added from REVIEW-2's "gate gaps" -----------------------------

// Backlit transmission (§1's signature effect). Measured on the RAW render so
// post cannot flatter it.
const tr = results.transmission;
// Rim-versus-CORE cannot see the failure this check exists to catch.
//
// The critic measured the backlit rim at (153,146,142) against snow at
// (218,218,218) -- 32% DARKER than the light it is supposedly transmitting --
// while this check reported a comfortable 1.09, because the core was darker
// still. A ratio between two dark things says nothing about whether light is
// getting through. What matters is the rim against what is BEHIND it: fur
// that transmits approaches the radiance of its backdrop and nearly
// disappears into it, which is the whole look §1 is asking for.
record('backlit fur is lit THROUGH, not just less dark than its core',
  !!(tr && tr.seeThrough != null && tr.seeThrough >= 0.80),
  tr && tr.seeThrough != null ? `rim ${tr.rim.toFixed(1)} against a backdrop of ${tr.behind.toFixed(1)} ` +
       `= ${tr.seeThrough.toFixed(3)} (want >= 0.80; 1.0 would be fur as bright ` +
       `as the sky behind it). Rim/core is ${tr.ratio.toFixed(3)} and is now ` +
       `reported only — it compared two dark things and passed at 1.09 while ` +
       `the rim was 32% darker than the snow`
     + `. NOTE this is the RAW render: at 244 against a 197 backdrop both sit ` +
       `near the top of the range, so a tonemapper can compress the lift to ` +
       `nothing. REVIEW-5 looked at the POST frame and reported no visible hot ` +
       `rim on ruff, tail or ear edges. Both can be true, and if they are the ` +
       `defect is in the grade, not the coat`
     : `UNMEASURABLE: ${tr?.rimPx ?? 0} rim pixels cleared the ${tr?.covFloor ?? '?'} ` +
       `coverage floor. If that is zero the rim is almost entirely sky seen ` +
       `through gaps, which is itself the finding — there is no fur there to ` +
       `transmit anything.`);
record('[reported, not asserted] rim/core luminance ratio', true,
  tr && tr.ratio != null ? `rim ${tr.rim.toFixed(1)} / core ${tr.core.toFixed(1)} = ${tr.ratio.toFixed(3)} ` +
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
  record(`nose pad is near-black at ${pose}`, c?.raw && c.raw.r < 60,
    `RAW ${hex(c?.raw)} vs spec (23,26,32); after post the same pixels read ` +
    `${hex(c)} — sampled r=${c?.rad ?? '?'}px in a ${c?.widthPx ?? '?'}px ` +
    `feature. Asserted on the raw frame because bloom legitimately veils a ` +
    `15-27 px black disc against 250-level snow at backlit framings, which is ` +
    `what a real lens does; post-side annihilation is guarded by ` +
    `\`nose survives post\``,
    'error');
}

// Aurora structure. Restraint achieved by fading it to nothing also passes a
// brightness test, so measure whether the sky's gradient energy runs
// vertically (filaments) or horizontally (a banded smear).
const au = results.auroraStructure;
// UNVALIDATED: passes at 1.048 while a critic called the aurora a
// structureless horizontal smear. Warn only until the disagreement is settled.
const aun = results.auroraNoneStructure;
if (!au || !au.px || !aun) {
  record('aurora structure probe is measurable', false,
    `green-excess mask found ${au?.px ?? 0} px` +
    (aun ? '' : ' and no fur-off control was taken') +
    ' — an aurora that the mask cannot find is either absent or not green');
} else if (!(au.px > Math.max(aun.px * 4, 200))) {
  // The control is what makes the mask trustworthy: hiding the aurora must
  // collapse it. Without this, the first version of the check passed at
  // 1.039 on three flat horizontal smears, because it was measuring the
  // sun, the stars and the sky's own vertical ramp.
  record('aurora structure probe isolates the aurora', false,
    `green mask holds ${au.px} px with the aurora shown and ${aun.px} px with ` +
    `it hidden — the mask must collapse by 4x or it is not finding the aurora`);
} else {
  // AMPLITUDE FIRST. Shape is meaningless if the signal is invisible.
  //
  // This check asserted a gradient RATIO and nothing else, so it certified
  // the aurora as structured while the critic measured the sky in 32 px
  // boxes and found **0 of 1782 cells above +3 green excess, a most-green
  // cell of -0.51 and a median of -4.61** -- net magenta. §3's aurora core
  // `#7dffc4` is green excess **+94.5**. A ratio of two small numbers is
  // still a ratio.
  //
  // The floor is 12: an order of magnitude under the spec's core, because
  // the core is the brightest filament and most of a curtain is far fainter,
  // but comfortably above the +3 the critic could not find anywhere.
  record('aurora is actually visible', au.p99 >= 5,
    `green excess across the WHOLE SKY: 99th percentile ${au.p99}, peak ` +
    `${au.peak}, against §3's aurora core #7dffc4 at +94.5 and a floor of 5. ` +
    `Measured sky-wide rather than inside the green mask, because a ` +
    `percentile of the pixels selected for being green cannot fail -- that ` +
    `version read 35.5 on a sky where 0.004% of pixels exceed +3`);
  // This asserted gx/gy >= 0.85 and reported 1.266, which the REVIEW-6 critic
  // correctly called a lying check: a field at 1.27:1 is essentially
  // ISOTROPIC, and a ratio floor below 1 can only fail on extreme HORIZONTAL
  // banding. It said nothing at all about whether anything was vertical. It
  // certified the word in its own name.
  //
  // Replaced with the structure tensor of the same field, which is what
  // actually knows about orientation. The critic measured Jxx 1.156, Jyy
  // 0.994, Jxy 0.355 over n = 86915 -- a dominant structure orientation of
  // 128.6 degrees, i.e. 51 off vertical, and a coherence of only 0.34. The
  // curtains render as a diagonal string of soft blobs.
  //
  // Both bounds are needed and neither alone is enough: an isotropic field
  // has a meaningless orientation that will sometimes land near vertical by
  // chance, and a strongly coherent field can be coherently diagonal.
  const orientOff = au.orientDeg == null ? null : Math.abs(au.orientDeg - 90);
  record('aurora has vertical filament structure',
    orientOff != null && orientOff <= 25 && au.coherence >= 0.5,
    `structure tensor of GREEN EXCESS inside the aurora: dominant ` +
    `orientation ${au.orientDeg} deg (90 = vertical, want within 25), ` +
    `coherence ${au.coherence} (0 = isotropic, want >= 0.5). Old gx/gy ` +
    `ratio ${au.ratio.toFixed(3)} for reference -- that number could not ` +
    `fail on isotropy, which is why it is no longer the assertion. Mask ` +
    `${au.px} px against ${aun.px} px with the aurora hidden`);
}

// Per-region silhouette. The whole-animal median let a good torso mask a bald
// head -- and the old scan locked onto the horizon in 20 of 50 columns.
// Fur at macro range, calibrated WITHIN the frame against a region we agree
// reads well (the ruff) rather than against a threshold I invented.
// Calibrated WITHIN the frame rather than against a threshold I invented: the
// BROW is the reference, because it demonstrably carries hair detail and sits
// on the same head under the same light at the same scale. A ruff probe would
// be better still, but earTipR does not project at 0.13 m and a screen-space
// fallback landed off-canvas — an in-frame reference that works beats an
// out-of-frame one that is more principled.
const fs = results.furScale;
if (!fs || !fs.brow || !fs.muzzle) {
  // A null probe used to make both record() calls disappear, so the report
  // came back with 22 checks instead of 24 and nobody noticed the gate had
  // silently removed itself. An unmeasurable probe is a failure, not a pass.
  const fr = fs?.frame;
  record('fur macro probe is measurable', false,
    results.eyeRadiusBad != null
      ? `implausible eye radius ${results.eyeRadiusBad}px — eye clipped or off-frame`
      : `probe returned no samples (eyeRadiusPx=${results.eyeRadiusPx ?? '?'}` +
        (fr ? `, eye at ${fr.eyeX},${fr.eyeY} in ${fr.w}x${fr.h}` : '') +
        `, muzzle=${fs?.muzzle ? 'ok' : 'null'}, brow=${fs?.brow ? 'ok' : 'null'})`);
} else if (!fs.muzzle.onCoat || !fs.brow.onCoat) {
  // A probe that landed on the eye, in a socket shadow, or off the animal
  // measures something that is not fur and will happily report a number.
  // That is precisely how this check spent three rounds grading eyelids.
  record('fur macro probes landed on coat', false,
    `muzzle mean luminance ${fs.muzzle.meanL.toFixed(0)} at ${fs.muzzle.x},${fs.muzzle.y}; ` +
    `brow ${fs.brow.meanL.toFixed(0)} at ${fs.brow.x},${fs.brow.y} (want > 90 — ` +
    `below that the probe is not on lit coat)`);
} else {
  const ref = fs.brow.fine;
  const floor = ref * 0.35;
  record('fur reads as hair at macro: muzzle',
    fs.muzzle.fine >= floor && fs.muzzle.ratio >= 0.30,
    `muzzle fine ${fs.muzzle.fine.toFixed(2)} against a floor of ${floor.toFixed(2)} ` +
    `(35% of the brow's ${ref.toFixed(2)}); coarse ${fs.muzzle.coarse.toFixed(2)}, ` +
    `fine-share ${fs.muzzle.ratio.toFixed(2)} (want >= 0.30 — a low share means ` +
    'blotches rather than hair)');
  // The muzzle floor above is RELATIVE to the brow, so on its own the pair
  // cannot see a global loss of coat detail: halve the fine detail everywhere
  // and the floor halves with it. That made this an instrument that could
  // only catch the muzzle falling behind the rest of the face, never the
  // whole face going smooth -- which is the defect the critic actually
  // reported. The absolute floor below is what closes that, and it is a hard
  // check rather than a warn for the same reason.
  //
  // THRESHOLD PROVENANCE, and a warning about it: 6.0 was calibrated as 49%
  // of a 12.28 measured before the AgX soft shoulder landed -- on a frame
  // whose worst subject block was 67.97% at/above 252 and 29.00% railed at
  // exactly 255. Clipping manufactures hard edges, and hard edges read as
  // fine detail, so much of that 12.28 was the blow-out itself.
  //
  // I then read 0.43 off one run and concluded the brow was bare. THAT WAS
  // A BAD RUN, and the fur agent was right to refuse to recalibrate against
  // it: it could not reproduce 0.43 outside spec, reading 2.53 to 5.1 on the
  // same pose, same box, same metric, and it noted spec's own frame had the
  // brow box at meanL 142.9 against the muzzle box at 202.8 -- a 60-level
  // gap between two boxes on the same coat, which says the box had landed in
  // shadow. The run also had two agents editing the tree mid-measurement.
  //
  // On a quiet tree the same region reads 13.34 and passes. 6.0 therefore
  // stands as calibrated, at 45% of that. What remains true from the visual
  // read is narrower than what I claimed: the CHEEK AND JOWL still read as a
  // smooth grey-blue mass, which the fur agent confirmed independently and
  // traced to the shells rather than the cards.
  record('macro reference region carries hair detail', ref >= 6.0,
    `brow fine ${ref.toFixed(2)} against an absolute floor of 6.0, coarse ` +
    `${fs.brow.coarse.toFixed(2)}, fine-share ${fs.brow.ratio.toFixed(2)}`);
}

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
// The DRAWN foot against the DRAWN snow.
{
  const fg = results.footGround ?? {};
  const seen = Object.entries(fg).filter(([, v]) => v);
  if (!seen.length) {
    record('the drawn foot meets the drawn snow', false,
      'no paw could be located in the coverage matte at `paws` — a failure, ' +
      'not a pass. An unmeasurable foot is exactly the condition under which ' +
      '76 bone-space checks certified a foot buried 48 mm below the snow');
  } else {
    // The ceiling is DERIVED, not picked. My first attempt was a flat 15 mm
    // and it was wrong for a reason worth recording: the coat legitimately
    // hangs below the sole by its own depth, so a paw resting exactly ON the
    // snow still shows coat below the line. `FUR[R.pawFront]` is 9.5 mm, and
    // a 3.5 kg animal on powder genuinely sinks — §6 requires that it does.
    // Allowing 15 mm of sink on top of the 9.5 mm of coat gives 25 mm.
    //
    // What this must still catch is the defect that shipped: 44-79 px, up to
    // **48 mm**, which is the ankle under the snow and the leg amputated by
    // the ground plane, certified green by all 76 bone-space checks.
    const CEILING_MM = 25;
    const worst = seen.reduce((a, b) => (b[1].belowSnowMm > a[1].belowSnowMm ? b : a));
    record('the drawn foot meets the drawn snow', worst[1].belowSnowMm <= CEILING_MM,
      seen.map(([k, v]) => `${k} ${v.belowSnowMm}mm`).join(', ') +
      ` — worst ${worst[0]} at ${worst[1].belowSnowMm}mm below the projected ` +
      `snow line (max ${CEILING_MM}mm = 9.5mm of paw coat + 15mm of ` +
      `legitimate sink). Measured on the coverage matte against ` +
      `ctx.terrain.heightAt; no bone consulted`);
  }
}

// Silhouette HARDNESS, validated against a fur-off control in the same frame.
const eh = results.edgeHardness ?? {}, ehn = results.edgeHardnessNoFur ?? {};
{
  // The BODY band is the one that means something. The head band spans the
  // notch between the ears, so its contour crosses background several times
  // by construction -- bare mesh already reads a 3.9 ratio there against the
  // body's 1.5, and the coat only lifts it to 4.5. Reported, not asserted.
  const ctl = ehn.body, sub = eh.body;
  if (!sub || !ctl) {
    record('silhouette hardness probe is measurable', false,
      `coat ${sub ? 'ok' : 'null'}, fur-off control ${ctl ? 'ok' : 'null'} — ` +
      `an unvalidated hardness number is not evidence`);
  } else if (!(sub.median > ctl.median * 1.25)) {
    // The control is the whole point. A bare mesh edge crosses once and
    // monotonically, so it sits near 1.0; if the coat does not raise the
    // ratio well above that, this scan is not reading the coat at all.
    record('silhouette structure probe detects a known-bare edge', false,
      `coated ${sub.median} vs fur-off control ${ctl.median} — the coat must ` +
      `raise the ratio at least 1.25x above bare mesh or the metric is blind`);
  }

  // DE-NESTED from the hardness probe's `else`, which used to swallow every
  // check below it.
  //
  // The seven matte and contour checks lived inside `else` of the
  // `silhouette hardness probe` chain, so whenever that probe failed --
  // either because it could not measure, or because the coat did not raise
  // the ratio 1.25x above bare mesh -- ALL SEVEN SILENTLY DISAPPEARED. It
  // failed at 1.765 against a required 1.783 and the run came back with 34
  // checks instead of 43. I spent two rounds blaming a degraded render and
  // my own edits for checks that were simply never reached.
  //
  // This is the failure AGENTS.md names -- "never let a check disappear when
  // it cannot measure" -- and I had already fixed one instance of it this
  // session in `source tree stable`. A gating check whose failure deletes
  // its dependants is worse than no gate: it goes quiet exactly when
  // something is wrong.
  {
    // --- the authoritative version, on a true coverage matte -------------
    //
    // Everything above this line measures a foreground-minus-background mask,
    // which on a white animal against snow peaks at 261/765 -- so it is a
    // proxy, and it has now been wrong in four distinct ways. `matteOf`
    // recovers coverage exactly (see tools/matte.mjs), which means the metric
    // finally works at ANY framing, and that exposed the last mistake: I
    // moved this gate to `frontal` because it separated cleanly from its
    // control, and `frontal` is simply the animal's best angle.
    //
    //              ramp   tv      p10
    //    frontal   13px  2.308   1.384      passes comfortably
    //    profile    5px  1.216   1.000      a perfectly monotonic crossing
    //
    // So `profile` is asserted and `frontal` is reported. The floor stays at
    // 1.15 for the same reason as before -- 1.0 is bare mesh by construction.
    for (const band of ['head', 'body', 'legs']) {
      const v = results.matteProfile?.[band];
      const f = results.matteFrontal?.[band];
      record(`matte silhouette is hair at profile: ${band}`,
        !!(v && v.worstP10 != null && v.worstP10 >= 1.15),
        v && v.worstP10 != null ? `WORSE SIDE ${v.worstP10} (left ${v.leftP10}, ` +
            `right ${v.rightP10}); combined path length over net crossing ${v.tvP10} at the 10th ` +
            `percentile (median ${v.tvMedian}) ` +
            `over ${v.n} scans, of which ${v.shortRows} were CLIFFS scored 1.0 ` +
            `(a ramp under two sampling intervals is a monotonic crossing, not ` +
            `an unmeasurable row). Sampled every 1.5mm — a fifth of the coat's ` +
            `own 7.4mm tuft scale (${v.stepPx}px at ` +
            `${v.pxPerMm}px/mm). 1.0 means the fringe does not oscillate at ` +
            `that scale. Same band at \`frontal\` reads ${f?.tvP10 ?? 'n/a'}`
          : v?.unresolvable
            ? `UNRESOLVABLE at ${v.pxPerMm} px/mm — the 1.5 mm sampling ` +
              `interval lands under 2 px, so the box filter is a no-op and ` +
              `this reverts to counting pixels. Raise the harness viewport; ` +
              `do not tune the coat to this number`
            : 'too few usable rows in this band to measure — that is a ' +
              'failure, not a pass');
    }

    // Whole-contour edges. §4f says trace the OUTER CONTOUR, and the band
    // scans above only see left and right. The top and bottom were never
    // measured at all until the critic scanned them and found the muzzle's
    // dorsum and underside both razor-sharp.
    for (const e of ['left', 'right', 'top', 'bottom']) {
      const ed = results.matteProfile?.edges?.[e];
      // TWO conditions, because the tv/net score alone can be passed by
      // making the coat worse.
      //
      // The fur agent ran ten arms and located every failing scan rather
      // than tuning against the percentage. No arm raises band fill and
      // lowers bad%: tv/net is maximised by hair-gap ALTERNATION and
      // minimised by a monotone ramp, so a DENSE PILE SCORES BELOW A SPARSE
      // SPRAY. `uCardDuty 0.60` passed by thinning the pile; `uCardFloor
      // .022 + len 1.40` passed by inflating coverage 18% into a picket
      // fence of long separated guard hairs with grey shell mass between
      // them. That one was rendered, looked like a mop, and was reverted.
      // Both arms that made the fringe genuinely FULLER scored worse.
      //
      // So the fill floor is a gaming guard, not a quality target: 0.40 sits
      // under the measured base (0.429-0.508 across the four edges) and over
      // the thinned arm (0.390). CALIBRATED, not sourced.
      //
      // DO NOT TUNE THE COAT AGAINST THESE FOUR CHECKS. They point at a real
      // defect -- the fur agent traced every failing scan to the dorsal
      // topline, the throat/belly and the chest front, i.e. the regions with
      // the shallowest transition band (26 px top and 40 px bottom against
      // 84 px on the tail side) -- but the defect is coat DEPTH in the
      // length map, which is anatomy's, not card distribution.
      const fillOk = ed && ed.fillMedian != null && ed.fillMedian >= 0.40;
      record(`contour has no bare run at profile: ${e}`,
        !!(ed && ed.badFrac != null && ed.badFrac <= 0.02 && fillOk),
        ed ? `${((ed.badFrac ?? 0) * 100).toFixed(1)}% of ${ed.n} scans below the ` +
             `1.15 hair floor (p10 ${ed.tvP10}, median ${ed.tvMedian}) — §4f allows ` +
             `2%, AND band fill ${ed.fillMedian} against a floor of 0.40 ` +
             `(${fillOk ? 'fill ok' : 'FILL TOO LOW — the pile has been thinned'}). ` +
             `${ed.noseDropped ?? 0} scans excluded as rhinarium, which §4f ` +
             `rule 3 requires to be BARE: before this exclusion the nose alone ` +
             `was 3.8% of left-edge scans against a 2% budget. Note tv/net ` +
             `rewards a sparse spray over a dense pile — do not tune the coat ` +
             `against this number; see the comment above the check`
           : 'edge not measured');
    }

    // Floor of 1.15 is derived, not tuned to pass: the fur-off control's own
    // 10th percentile is 1.054, and 1.15 sits clearly above a single monotonic
    // crossing while staying well under the coated reading. It is asserted on
    // the 10th percentile rather than the median because §4f's test is about
    // the WORST stretch of contour, not the typical one.
    if (eh.legs && ehn.legs) {
      record('[superseded, reported] frontal mask silhouette: legs', true,
        `outline path length over net crossing, 10th percentile ${eh.legs.p10} ` +
        `(median ${eh.legs.median}) over ${eh.legs.n} rows — want >= 1.15. The ` +
        `fur-off control on the same frame reads p10 ${ehn.legs.p10}. A bare ` +
        `leg reads ~1.0: one monotonic crossing, no hair. CAVEAT: measured at ` +
        `\`frontal\`, where the lower body is partly behind the ruff, so this ` +
        `band may be reading chest fur rather than leg. The critic scanned a ` +
        `foreleg at \`profile\` and found a clean monotonic ramp; if that ` +
        `disagrees with this number, believe the critic`);
    } else {
      record('silhouette is hair, not a curve: legs', false,
        'the leg band produced too few usable rows to measure — that is a ' +
        'failure, not a pass; a band that cannot be measured cannot be cleared');
    }
    // SUPERSEDED by the matte bands above, and demonstrably broken: the legs
    // arm reads a coated p10 of 1.000 against its own fur-off control at
    // 1.047 -- the coat scoring WORSE than bare mesh, which is not physically
    // possible. It measures a foreground-minus-background mask, which peaks
    // at 261/765 on a white animal against snow; `matteOf` recovers coverage
    // exactly and needs no such proxy. Reported, not asserted.
    record('[superseded, reported] frontal mask silhouette: body', true,
      `outline path length over net crossing, 10th percentile ${sub.p10} ` +
      `(median ${sub.median}) over ${sub.n} rows — want >= 1.15. 1.0 is a ` +
      `single monotonic crossing, i.e. bare mesh; the fur-off control on the ` +
      `same frame reads p10 ${ctl.p10} / median ${ctl.median}`);
    if (eh.head) {
      record('[reported, not asserted] head outline structure', true,
        `head ratio median ${eh.head.median} (p10 ${eh.head.p10}) over ` +
        `${eh.head.n} rows, against a fur-off control of ${ehn.head?.median} — ` +
        `the band spans the notch between the ears, so multiple crossings are ` +
        `inherent and the absolute value is not comparable to the body's`);
    }
  }
}

const sr = results.silhouetteRamp;
// Kept as a REPORTED NUMBER, not an assertion. This check and the per-region
// one contradicted each other for three rounds (1 px versus 8 px) and the
// disagreement was resolved by realising they measure different edges, not by
// either being wrong. Silhouette hardness above now asserts the thing both of
// them were groping at, and it is validated against a fur-off control. Two
// unreliable proxies for a quantity a third instrument measures directly are
// noise in the report, and a failing check nobody trusts teaches everyone to
// skim the report.
record('[reported, not asserted] whole-frame silhouette ramp', true,
  sr ? `median transition ${sr.median}px over ${sr.n} columns (min ${sr.min}, ` +
       `max ${sr.max}) — width only; see silhouette hardness for ramp vs cliff`
     : 'could not locate the animal against the sky');

// ALWAYS recorded, pass or fail.
//
// This used to live inside `if (drifted.length)`, so on a clean run there
// was no entry at all -- the report came back with 41 checks and a
// contaminated one returned 42. That is exactly the failure AGENTS.md names,
// "never let a check disappear when it cannot measure", in the one check
// that exists to protect every other number in the file. I had also told
// three separate agents to "check it on every run", which was impossible:
// on a good run there was nothing to check. Found by the REVIEW-6 critic.
//
// It also fingerprinted `src/` only, so an agent editing tools/audit.mjs
// during a run was invisible, and spec.mjs could be edited under itself.
const srcAfter = await fingerprint(path.join(ROOT, 'src'));
const toolsAfter = await fingerprint(path.join(ROOT, 'tools'));
const drifted = driftedFiles(srcBefore, srcAfter)
  .concat(driftedFiles(toolsBefore, toolsAfter));
record('source tree stable during the run', drifted.length === 0,
  drifted.length
    ? `${drifted.length} file(s) changed while measuring: ${drifted.slice(0, 8).join(', ')}` +
      (drifted.length > 8 ? `, +${drifted.length - 8} more` : '') +
      '. Another agent is editing. Numbers above that depend on these files ' +
      'describe two different builds; judge per check rather than discarding ' +
      'the whole run.'
    : `no file under src/ or tools/ changed during the run ` +
      `(${srcBefore.size} + ${toolsBefore.size} files fingerprinted), so the ` +
      `numbers above all describe one build`);

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
