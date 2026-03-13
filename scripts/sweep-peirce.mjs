import fs from 'node:fs/promises';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { DOMParser } from '@xmldom/xmldom';
import { PNG } from 'pngjs';
import {
  DEFAULT_SWEEP_OPTIONS,
  buildSweepCaseFileName,
  enumerateSweepCases,
  estimateBackgroundColor,
  formatSweepCaseLabel,
  renderSweepCase,
} from '../src/sweep-core.js';

function printUsage() {
  console.log(`Usage:
  npm run sweep -- <input.svg> <output-dir> [--lon-step=15] [--lat-step=15] [--roll-step=15]
    [--roll-mode=quarter-turn|full-turn] [--output-size=128] [--source-width=1024]
    [--lon-min=-180] [--lon-max=180] [--lat-min=-90] [--lat-max=90]
    [--skip-existing=true|false] [--html=true|false] [--limit=<count>] [--dry-run]
`);
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, rawValue] = arg.slice(2).split('=');
      options[key] = rawValue ?? 'true';
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function parseBoolean(value, defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseNumberOption(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
  return parsed;
}

function localName(node) {
  return node.localName || node.nodeName;
}

function parseFloatList(value) {
  if (!value) return [];
  const matches = value.match(/[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g);
  return matches ? matches.map(Number) : [];
}

function getViewBox(root) {
  const values = parseFloatList(root.getAttribute('viewBox'));
  if (values.length === 4) {
    return { x: values[0], y: values[1], width: values[2], height: values[3] };
  }

  return {
    x: 0,
    y: 0,
    width: Number.parseFloat(root.getAttribute('width') || '0') || 0,
    height: Number.parseFloat(root.getAttribute('height') || '0') || 0,
  };
}

function findMapFrame(root) {
  const rects = Array.from(root.getElementsByTagName('rect'));
  let best = null;
  for (const rect of rects) {
    const x = Number.parseFloat(rect.getAttribute('x') || '0');
    const y = Number.parseFloat(rect.getAttribute('y') || '0');
    const width = Number.parseFloat(rect.getAttribute('width') || '0');
    const height = Number.parseFloat(rect.getAttribute('height') || '0');
    if (!(width > 0 && height > 0)) continue;
    const ratioPenalty = Math.abs(width / height - 2);
    const score = width * height - ratioPenalty * 1000000;
    if (!best || score > best.score) {
      best = { score, x, y, width, height };
    }
  }

  if (best) return best;
  const viewBox = getViewBox(root);
  return {
    score: viewBox.width * viewBox.height,
    x: viewBox.x,
    y: viewBox.y,
    width: viewBox.width,
    height: viewBox.height,
  };
}

function detectSourceScale(root, viewBox) {
  const width = Number.parseFloat(root.getAttribute('width') || '0');
  if (!viewBox.width || !Number.isFinite(width) || width <= 0) return 1;
  return width / viewBox.width;
}

function parseSvgMetadata(svgText) {
  const document = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const root = document.documentElement;
  if (!root || localName(root) !== 'svg') {
    throw new Error('Input is not a valid SVG document.');
  }
  const parserErrors = document.getElementsByTagName('parsererror');
  if (parserErrors.length > 0) {
    throw new Error('SVG parsing failed.');
  }

  const viewBox = getViewBox(root);
  const frame = findMapFrame(root);
  const sourceScale = detectSourceScale(root, viewBox);
  if (!(frame.width > 0 && frame.height > 0)) {
    throw new Error('Could not detect a valid 2:1 map frame.');
  }
  return { viewBox, frame, sourceScale };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cropRenderedFrame(renderedImage, metadata) {
  const { viewBox, frame } = metadata;
  const scaleX = renderedImage.width / viewBox.width;
  const scaleY = renderedImage.height / viewBox.height;
  const left = clamp(Math.floor((frame.x - viewBox.x) * scaleX), 0, renderedImage.width - 1);
  const top = clamp(Math.floor((frame.y - viewBox.y) * scaleY), 0, renderedImage.height - 1);
  const right = clamp(Math.ceil((frame.x + frame.width - viewBox.x) * scaleX), left + 1, renderedImage.width);
  const bottom = clamp(Math.ceil((frame.y + frame.height - viewBox.y) * scaleY), top + 1, renderedImage.height);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const pixels = new Uint8ClampedArray(width * height * 4);
  const source = renderedImage.pixels;

  for (let y = 0; y < height; y += 1) {
    const sourceOffset = ((top + y) * renderedImage.width + left) * 4;
    const targetOffset = y * width * 4;
    pixels.set(source.subarray(sourceOffset, sourceOffset + width * 4), targetOffset);
  }

  return {
    width,
    height,
    pixels,
  };
}

function rasterizeSourceFrame(svgText, metadata, sourceWidth) {
  const zoom = sourceWidth / (metadata.frame.width * metadata.sourceScale);
  const resvg = new Resvg(svgText, {
    fitTo: { mode: 'zoom', value: zoom },
    imageRendering: 0,
    shapeRendering: 2,
    textRendering: 1,
    background: 'rgba(0,0,0,0)',
  });
  const rendered = resvg.render();
  const frameImage = cropRenderedFrame(rendered, metadata);
  return {
    ...frameImage,
    background: estimateBackgroundColor(frameImage),
  };
}

function encodePng(image) {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.pixels);
  return PNG.sync.write(png);
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function formatManifestCsv(cases) {
  const header = ['case_id', 'center_lon', 'center_lat', 'roll', 'png'];
  const rows = cases.map((entry) => [
    entry.caseId,
    entry.centerLon,
    entry.centerLat,
    entry.roll,
    entry.png,
  ]);
  return [header, ...rows]
    .map((row) => row.map((value) => JSON.stringify(String(value))).join(','))
    .join('\n') + '\n';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function buildHtmlIndex(manifest) {
  const cards = manifest.cases
    .map(
      (entry) => `
        <article class="card">
          <img loading="lazy" src="${encodeURI(entry.png)}" width="${manifest.options.outputSize}" height="${manifest.options.outputSize}" alt="${escapeHtml(entry.label)}" />
          <p>${escapeHtml(entry.label)}</p>
        </article>`,
    )
    .join('');

  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Peirce Sweep Gallery</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "Segoe UI", "Yu Gothic UI", sans-serif;
        background: #eef3f6;
        color: #10202b;
      }
      body {
        margin: 0;
        padding: 24px;
        background:
          radial-gradient(circle at top left, rgba(71, 136, 160, 0.15), transparent 34%),
          linear-gradient(180deg, #f7fafb 0%, #e6edf2 100%);
      }
      main {
        max-width: 1400px;
        margin: 0 auto;
      }
      h1 {
        margin: 0 0 8px;
      }
      .meta {
        margin: 0 0 20px;
        color: #33505e;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 14px;
      }
      .card {
        margin: 0;
        padding: 12px;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.86);
        box-shadow: 0 10px 30px rgba(31, 57, 70, 0.08);
      }
      img {
        display: block;
        width: 100%;
        height: auto;
        border-radius: 12px;
        background: #dbe8ef;
      }
      p {
        margin: 10px 0 0;
        font-size: 13px;
        line-height: 1.4;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Peirce Sweep Gallery</h1>
      <p class="meta">
        ${escapeHtml(manifest.inputFile)} / ${manifest.caseCount} cases / output ${manifest.options.outputSize}px /
        lon step ${manifest.options.centerLonStep} / lat step ${manifest.options.centerLatStep} / roll step ${manifest.options.rollStep}
      </p>
      <section class="grid">${cards}</section>
    </main>
  </body>
</html>
`;
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (positional.length < 2) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const [inputPath, outputDir] = positional;
  const svgText = await fs.readFile(inputPath, 'utf8');
  const metadata = parseSvgMetadata(svgText);
  const sweepOptions = {
    ...DEFAULT_SWEEP_OPTIONS,
    centerLonMin: parseNumberOption(options['lon-min'], DEFAULT_SWEEP_OPTIONS.centerLonMin),
    centerLonMax: parseNumberOption(options['lon-max'], DEFAULT_SWEEP_OPTIONS.centerLonMax),
    centerLonStep: parseNumberOption(options['lon-step'] ?? options['center-lon-step'], DEFAULT_SWEEP_OPTIONS.centerLonStep),
    centerLatMin: parseNumberOption(options['lat-min'], DEFAULT_SWEEP_OPTIONS.centerLatMin),
    centerLatMax: parseNumberOption(options['lat-max'], DEFAULT_SWEEP_OPTIONS.centerLatMax),
    centerLatStep: parseNumberOption(options['lat-step'] ?? options['center-lat-step'], DEFAULT_SWEEP_OPTIONS.centerLatStep),
    rollStep: parseNumberOption(options['roll-step'], DEFAULT_SWEEP_OPTIONS.rollStep),
    rollMode: options['roll-mode'] || DEFAULT_SWEEP_OPTIONS.rollMode,
    outputSize: parseNumberOption(options['output-size'], DEFAULT_SWEEP_OPTIONS.outputSize),
    dedupePolarCenters: parseBoolean(options['dedupe-poles'], DEFAULT_SWEEP_OPTIONS.dedupePolarCenters),
  };
  const sourceWidth = parseNumberOption(options['source-width'], 1024);
  if (!(sourceWidth > 0)) {
    throw new Error('source-width must be a positive number.');
  }
  const limit = options.limit !== undefined ? Math.max(0, Math.floor(parseNumberOption(options.limit, 0))) : null;
  const dryRun = parseBoolean(options['dry-run'], false);
  const skipExisting = parseBoolean(options['skip-existing'], true);
  const writeHtml = parseBoolean(options.html, true);
  const enumerated = enumerateSweepCases(sweepOptions);
  const cases = limit === null ? enumerated.cases : enumerated.cases.slice(0, limit);

  const summary = {
    inputPath,
    outputDir,
    caseCount: cases.length,
    outputSize: enumerated.options.outputSize,
    sourceWidth,
    rollMode: enumerated.options.rollMode,
    lonValues: enumerated.lonValues.length,
    latValues: enumerated.latValues.length,
    rollValues: enumerated.rollValues.length,
  };

  if (dryRun) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  await fs.mkdir(outputDir, { recursive: true });
  const sourceImage = rasterizeSourceFrame(svgText, metadata, sourceWidth);
  const manifestCases = [];
  const startedAt = Date.now();
  let renderedCount = 0;
  let skippedCount = 0;

  for (let index = 0; index < cases.length; index += 1) {
    const caseDefinition = cases[index];
    const fileName = buildSweepCaseFileName(caseDefinition, cases.length);
    const filePath = path.join(outputDir, fileName);
    const label = formatSweepCaseLabel(caseDefinition);
    if (skipExisting && await fileExists(filePath)) {
      skippedCount += 1;
      manifestCases.push({
        caseId: caseDefinition.index + 1,
        centerLon: caseDefinition.centerLon,
        centerLat: caseDefinition.centerLat,
        roll: caseDefinition.roll,
        label,
        png: fileName,
      });
      continue;
    }

    const image = renderSweepCase(sourceImage, caseDefinition, enumerated.options);
    await fs.writeFile(filePath, encodePng(image));
    renderedCount += 1;
    manifestCases.push({
      caseId: caseDefinition.index + 1,
      centerLon: caseDefinition.centerLon,
      centerLat: caseDefinition.centerLat,
      roll: caseDefinition.roll,
      label,
      png: fileName,
    });
    console.log(`[${index + 1}/${cases.length}] ${label}`);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    inputFile: path.basename(inputPath),
    inputPath,
    caseCount: cases.length,
    renderedCount,
    skippedCount,
    sourceFrame: {
      width: sourceImage.width,
      height: sourceImage.height,
    },
    options: enumerated.options,
    cases: manifestCases,
  };

  await fs.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await fs.writeFile(path.join(outputDir, 'manifest.csv'), formatManifestCsv(manifestCases), 'utf8');
  if (writeHtml) {
    await fs.writeFile(path.join(outputDir, 'index.html'), buildHtmlIndex(manifest), 'utf8');
  }

  console.log(JSON.stringify({
    ...summary,
    renderedCount,
    skippedCount,
    sourceFrameWidth: sourceImage.width,
    sourceFrameHeight: sourceImage.height,
    durationMs: Date.now() - startedAt,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
