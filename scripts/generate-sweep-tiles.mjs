import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';

const DEFAULT_SWEEP_DIR = path.resolve('out/sweep-full-defaults');
const DEFAULT_OUTPUT_DIR = path.resolve('out/sweep-full-defaults/tiles');
const DEFAULT_TILE_SIZE = 256;

function printUsage() {
  console.log(`Usage:
  node scripts/generate-sweep-tiles.mjs [sweep-dir] [output-dir]
    [--tile-size=${DEFAULT_TILE_SIZE}] [--limit=<count>] [--only-case=<caseId>] [--skip-existing=true|false]
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

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parsePositiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function downscaleHalf(image) {
  const width = Math.max(1, Math.ceil(image.width / 2));
  const height = Math.max(1, Math.ceil(image.height / 2));
  const data = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const totals = [0, 0, 0, 0];
      let count = 0;

      for (let sourceY = y * 2; sourceY < Math.min(image.height, y * 2 + 2); sourceY += 1) {
        for (let sourceX = x * 2; sourceX < Math.min(image.width, x * 2 + 2); sourceX += 1) {
          const sourceOffset = (sourceY * image.width + sourceX) * 4;
          totals[0] += image.data[sourceOffset];
          totals[1] += image.data[sourceOffset + 1];
          totals[2] += image.data[sourceOffset + 2];
          totals[3] += image.data[sourceOffset + 3];
          count += 1;
        }
      }

      const targetOffset = (y * width + x) * 4;
      data[targetOffset] = Math.round(totals[0] / count);
      data[targetOffset + 1] = Math.round(totals[1] / count);
      data[targetOffset + 2] = Math.round(totals[2] / count);
      data[targetOffset + 3] = Math.round(totals[3] / count);
    }
  }

  return { width, height, data };
}

function buildPyramid(image, tileSize) {
  const levels = [image];

  while (levels[0].width > tileSize || levels[0].height > tileSize) {
    levels.unshift(downscaleHalf(levels[0]));
  }

  return levels.map((level, z) => ({
    z,
    width: level.width,
    height: level.height,
    cols: Math.ceil(level.width / tileSize),
    rows: Math.ceil(level.height / tileSize),
    data: level.data,
  }));
}

function cropTile(level, startX, startY, width, height) {
  const data = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const sourceOffset = ((startY + y) * level.width + startX) * 4;
    const targetOffset = y * width * 4;
    level.data.copy(data, targetOffset, sourceOffset, sourceOffset + width * 4);
  }

  return { width, height, data };
}

function encodePng(image) {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = image.data;
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

async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.help === 'true') {
    printUsage();
    return;
  }

  const sweepDir = path.resolve(positional[0] || DEFAULT_SWEEP_DIR);
  const outputDir = path.resolve(positional[1] || DEFAULT_OUTPUT_DIR);
  const tileSize = parsePositiveInteger(options['tile-size'], DEFAULT_TILE_SIZE, 'tile-size');
  const limit = options.limit === undefined ? null : parsePositiveInteger(options.limit, 0, 'limit');
  const onlyCase = options['only-case'] === undefined ? null : parsePositiveInteger(options['only-case'], 0, 'only-case');
  const skipExisting = parseBoolean(options['skip-existing'], true);
  const sourceManifestPath = path.join(sweepDir, 'manifest.json');
  const sourceManifest = JSON.parse(await fs.readFile(sourceManifestPath, 'utf8'));

  let cases = sourceManifest.cases || [];
  if (onlyCase !== null) {
    cases = cases.filter((entry) => Number(entry.caseId) === onlyCase);
  }
  if (limit !== null) {
    cases = cases.slice(0, limit);
  }

  const casePad = String(sourceManifest.caseCount || cases.length || 1).length;
  await ensureDir(outputDir);

  const manifestCases = [];
  let writtenTiles = 0;
  let skippedTiles = 0;

  for (const entry of cases) {
    const imagePath = path.join(sweepDir, entry.png);
    const image = PNG.sync.read(await fs.readFile(imagePath));
    const pyramid = buildPyramid(image, tileSize);
    const tileRoot = `case_${String(entry.caseId).padStart(casePad, '0')}`;

    for (const level of pyramid) {
      for (let tileY = 0; tileY < level.rows; tileY += 1) {
        for (let tileX = 0; tileX < level.cols; tileX += 1) {
          const tileWidth = Math.min(tileSize, level.width - tileX * tileSize);
          const tileHeight = Math.min(tileSize, level.height - tileY * tileSize);
          const tile = cropTile(level, tileX * tileSize, tileY * tileSize, tileWidth, tileHeight);
          const tilePath = path.join(outputDir, tileRoot, String(level.z), String(tileX), `${tileY}.png`);
          if (skipExisting && await fileExists(tilePath)) {
            skippedTiles += 1;
            continue;
          }
          await ensureDir(path.dirname(tilePath));
          await fs.writeFile(tilePath, encodePng(tile));
          writtenTiles += 1;
        }
      }
    }

    manifestCases.push({
      caseId: Number(entry.caseId),
      centerLon: entry.centerLon,
      centerLat: entry.centerLat,
      roll: entry.roll,
      label: entry.label,
      png: entry.png,
      width: image.width,
      height: image.height,
      tileRoot,
      tileSize,
      maxZoom: pyramid.length - 1,
      levels: pyramid.map((level) => ({
        z: level.z,
        width: level.width,
        height: level.height,
        cols: level.cols,
        rows: level.rows,
      })),
    });

    console.log(`[tile] case ${entry.caseId} -> ${tileRoot}`);
  }

  const tileManifest = {
    generatedAt: new Date().toISOString(),
    sourceSweepDir: sweepDir,
    sourceManifest: path.relative(outputDir, sourceManifestPath).replaceAll('\\', '/'),
    tileSize,
    caseCount: manifestCases.length,
    writtenTiles,
    skippedTiles,
    cases: manifestCases,
  };

  await fs.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(tileManifest, null, 2), 'utf8');
  console.log(JSON.stringify({
    sweepDir,
    outputDir,
    caseCount: manifestCases.length,
    tileSize,
    writtenTiles,
    skippedTiles,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  printUsage();
  process.exitCode = 1;
});
