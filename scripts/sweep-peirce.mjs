import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_SWEEP_OPTIONS,
  buildSweepCaseFileName,
  enumerateSweepCases,
  formatSweepCaseLabel,
  renderSweepCase,
} from '../src/sweep-core.js';
import {
  DEFAULT_SOURCE_WIDTH,
  encodePng,
  parseSvgMetadata,
  rasterizeSweepSource,
  SOURCE_IMAGE_FILE_NAME,
} from './lib/sweep-source-raster.mjs';
import {
  buildRenderKey,
  hashRenderer,
  planRenderCacheReuse,
  readRenderCache,
  writeRenderCache,
} from './lib/sweep-render-cache.mjs';

// 描画済みファイルの記録 (render-cache.json) を書き出す間隔 (ケース数)。途中で落ちても、ここまでは再利用できる
const RENDER_CACHE_FLUSH_INTERVAL = 25;

function printUsage() {
  console.log(`Usage:
  npm run sweep -- <input.svg> <output-dir> [--lon-step=15] [--lat-step=15] [--roll-step=15]
    [--roll-mode=quarter-turn|full-turn] [--output-size=${DEFAULT_SWEEP_OPTIONS.outputSize}] [--source-width=${DEFAULT_SOURCE_WIDTH}]
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
  parseSvgMetadata(svgText); // dry-run でも入力の妥当性だけは確かめる
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
  const sourceWidth = parseNumberOption(options['source-width'], DEFAULT_SOURCE_WIDTH);
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
  const sourceImage = rasterizeSweepSource(svgText, sourceWidth);
  // viewer のライブ描画用に、各ケースを描いたのと同じ元画像を残す
  await fs.writeFile(path.join(outputDir, SOURCE_IMAGE_FILE_NAME), encodePng(sourceImage));

  // 既存の PNG は、前回の描画条件 (出力の大きさ・元画像・描画処理) が今回と同じときだけ再利用する
  const renderKey = buildRenderKey({
    svgText,
    sourceWidth,
    sourceImage,
    outputSize: enumerated.options.outputSize,
    rendererSha256: await hashRenderer(),
  });
  const caseFiles = cases.map((caseDefinition) => buildSweepCaseFileName(caseDefinition, cases.length));
  const { reusable, reasons } = planRenderCacheReuse(await readRenderCache(outputDir), renderKey, skipExisting);
  if (reasons.length) {
    let existingCount = 0;
    for (const fileName of caseFiles) {
      if (await fileExists(path.join(outputDir, fileName))) existingCount += 1;
    }
    if (existingCount > 0) {
      console.log(`既存の PNG ${existingCount} 件は今回の描画条件と一致すると確かめられないので作り直します:`);
      for (const reason of reasons) console.log(`  - ${reason}`);
    }
  }
  // 記録は「今回の条件で描いたと確かめられたファイル」だけにする。
  // 条件が変わったときは先に空にしておき、途中で落ちても古い PNG を今回の条件のものと取り違えないようにする
  const cachedFiles = new Set();
  for (const fileName of reusable) {
    if (await fileExists(path.join(outputDir, fileName))) cachedFiles.add(fileName);
  }
  await writeRenderCache(outputDir, renderKey, cachedFiles);

  const manifestCases = [];
  const startedAt = Date.now();
  let renderedCount = 0;
  let skippedCount = 0;
  let unflushedCount = 0;

  for (let index = 0; index < cases.length; index += 1) {
    const caseDefinition = cases[index];
    const fileName = caseFiles[index];
    const filePath = path.join(outputDir, fileName);
    const label = formatSweepCaseLabel(caseDefinition);
    if (skipExisting && cachedFiles.has(fileName)) {
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
    cachedFiles.add(fileName);
    unflushedCount += 1;
    if (unflushedCount >= RENDER_CACHE_FLUSH_INTERVAL) {
      await writeRenderCache(outputDir, renderKey, cachedFiles);
      unflushedCount = 0;
    }
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

  await writeRenderCache(outputDir, renderKey, cachedFiles);

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
    sourceWidth,
    sourceImage: {
      png: SOURCE_IMAGE_FILE_NAME,
      width: sourceImage.width,
      height: sourceImage.height,
      background: sourceImage.background,
    },
    options: enumerated.options,
    sourceFilter: {
      hideText: true,
      hideGraticule: true,
      hideBoundaries: true,
      hideStrokes: true,
    },
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
