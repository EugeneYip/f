#!/usr/bin/env node
/**
 * Composite PNG screenshots into a contact sheet.
 *
 *   node tools/sheet.mjs --in shots/v5 --out shots/v5/sheet.png --cols 2
 *   node tools/sheet.mjs --in shots/review --cols 4 --width 2400
 *
 * Renders a grid of images with labels, preserving aspect ratios and
 * ensuring readability against both light and dark content.
 */
import { chromium } from 'playwright';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const a = { cols: 4, width: 2400 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--in') a.in = next();
    else if (k === '--out') a.out = next();
    else if (k === '--cols') a.cols = parseInt(next(), 10);
    else if (k === '--width') a.width = parseInt(next(), 10);
  }
  if (!a.in) {
    console.error('[sheet] --in is required');
    process.exit(1);
  }
  if (!a.out) {
    const inDir = path.basename(path.resolve(a.in));
    a.out = path.join(a.in, 'sheet.png');
  }
  return a;
}

async function getPNGFiles(dir) {
  try {
    const files = await readdir(dir);
    const pngs = files
      .filter((f) => /\.png$/i.test(f) && f !== 'sheet.png')
      .sort();
    return pngs;
  } catch (e) {
    console.error(`[sheet] failed to read directory ${dir}: ${e.message}`);
    process.exit(1);
  }
}

async function imageToBase64(filePath) {
  const buffer = await readFile(filePath);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

async function getImageDimensions(filePath) {
  const buffer = await readFile(filePath);
  // PNG header: 16 bytes of signature + IHDR chunk with width (4B) and height (4B) at bytes 16-24
  if (buffer.length < 24) throw new Error('Invalid PNG file');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

function generateHTML(images, cols, totalWidth, cellSize) {
  const rows = Math.ceil(images.length / cols);
  const totalHeight = rows * cellSize;
  const padding = Math.round(cellSize * 0.05);
  const labelHeight = Math.round(cellSize * 0.12);

  const imageElements = images
    .map(
      ({ name, src, aspectRatio }) => `
    <div class="cell">
      <div class="image-container">
        <img src="${src}" alt="${name}" style="aspect-ratio: ${aspectRatio}">
      </div>
      <div class="label">${name}</div>
    </div>
  `
    )
    .join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a1220;
      width: ${totalWidth}px;
      height: ${totalHeight}px;
      display: flex;
      flex-wrap: wrap;
      align-content: flex-start;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .cell {
      width: ${cellSize}px;
      height: ${cellSize}px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: relative;
    }
    .image-container {
      width: calc(100% - ${padding * 2}px);
      height: calc(100% - ${labelHeight + padding}px);
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .image-container img {
      max-width: 100%;
      max-height: 100%;
      width: auto;
      height: auto;
      display: block;
    }
    .label {
      width: 100%;
      height: ${labelHeight}px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: ${Math.round(cellSize * 0.08)}px;
      font-weight: 500;
      color: #fff;
      text-shadow:
        -1px -1px 0 rgba(10, 18, 32, 0.8),
         1px -1px 0 rgba(10, 18, 32, 0.8),
        -1px  1px 0 rgba(10, 18, 32, 0.8),
         1px  1px 0 rgba(10, 18, 32, 0.8),
         0px -2px 0 rgba(10, 18, 32, 0.8),
         0px  2px 0 rgba(10, 18, 32, 0.8),
        -2px  0px 0 rgba(10, 18, 32, 0.8),
         2px  0px 0 rgba(10, 18, 32, 0.8);
      text-align: center;
      padding: 0 ${padding}px;
      word-break: break-word;
      background: rgba(10, 18, 32, 0.5);
      flex-shrink: 0;
    }
  </style>
</head>
<body>
  ${imageElements}
</body>
</html>`;
}

const main = async () => {
  const args = parseArgs(process.argv);
  const inDir = path.resolve(args.in);
  const outFile = path.resolve(args.out);

  // Get PNG files sorted alphabetically
  const pngFiles = await getPNGFiles(inDir);
  if (pngFiles.length === 0) {
    console.error(`[sheet] no PNG files found in ${inDir}`);
    process.exit(1);
  }

  console.log(`[sheet] found ${pngFiles.length} images`);

  // Calculate grid dimensions
  const cols = args.cols;
  const rows = Math.ceil(pngFiles.length / cols);
  const cellSize = Math.round(args.width / cols);
  const totalHeight = cellSize * rows;

  console.log(`[sheet] grid: ${cols}x${rows} cells, ${cellSize}px each`);

  // Load images and convert to base64
  const images = [];
  for (const file of pngFiles) {
    const filePath = path.join(inDir, file);
    const name = path.basename(file, '.png');
    const dims = await getImageDimensions(filePath);
    const aspectRatio = dims.width / dims.height;
    const src = await imageToBase64(filePath);
    images.push({ name, src, aspectRatio });
  }

  // Generate HTML
  const html = generateHTML(images, cols, args.width, cellSize);

  // Launch browser and screenshot
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: args.width, height: totalHeight },
    deviceScaleFactor: 1,
  });

  try {
    await page.setContent(html);
    await page.screenshot({ path: outFile, fullPage: true });
    console.log(`[sheet] wrote ${outFile}`);
    console.log(`[sheet] ${cols} cols × ${rows} rows = ${pngFiles.length} images`);
  } finally {
    await browser.close();
  }

  process.exit(0);
};

main().catch((e) => {
  console.error('[sheet] ERROR:', e.message);
  process.exit(1);
});
