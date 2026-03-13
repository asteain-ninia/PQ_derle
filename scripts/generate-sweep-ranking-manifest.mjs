import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  buildLandMaskFromRgba,
  buildPeirceDistortionField,
  DEFAULT_RANKING_ANALYSIS_OPTIONS,
  DEFAULT_RANKING_METRICS,
  scoreLandMaskAgainstField,
} from '../src/sweep-ranking-core.js';

const DEFAULT_SWEEP_DIR = path.resolve('out/sweep-full-defaults');
const DEFAULT_INPUT_FILE = 'manifest.json';
const DEFAULT_OUTPUT_FILE = 'ranking-manifest.json';

function printUsage() {
  console.log(`Usage:
  node scripts/generate-sweep-ranking-manifest.mjs [sweep-dir]
    [--input=${DEFAULT_INPUT_FILE}] [--output=${DEFAULT_OUTPUT_FILE}] [--limit=<count>]
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

function parsePositiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function roundMetrics(metrics) {
  return Object.fromEntries(
    Object.entries(metrics)
      .filter(([key]) => key !== 'landPixelCount')
      .map(([key, value]) => [key, Number(value.toFixed(6))]),
  );
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.help === 'true') {
    printUsage();
    return;
  }

  const sweepDir = path.resolve(positional[0] || DEFAULT_SWEEP_DIR);
  const inputPath = path.resolve(sweepDir, options.input || DEFAULT_INPUT_FILE);
  const outputPath = path.resolve(sweepDir, options.output || DEFAULT_OUTPUT_FILE);
  const limit = options.limit === undefined ? null : parsePositiveInteger(options.limit, 0, 'limit');
  const sourceManifest = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  const sourceCases = Array.isArray(sourceManifest.cases) ? sourceManifest.cases : [];
  const cases = limit === null ? sourceCases : sourceCases.slice(0, limit);

  if (!cases.length) {
    throw new Error('No sweep cases found in manifest.');
  }

  const outputSize = Number(sourceManifest.options?.outputSize) || 320;
  const analysisOptions = {
    derivativeStep: DEFAULT_RANKING_ANALYSIS_OPTIONS.derivativeStep,
    hotspotQuantile: DEFAULT_RANKING_ANALYSIS_OPTIONS.hotspotQuantile,
    clipQuantile: DEFAULT_RANKING_ANALYSIS_OPTIONS.clipQuantile,
    colorQuantizationBits: DEFAULT_RANKING_ANALYSIS_OPTIONS.colorQuantizationBits,
    opaqueAlphaMin: DEFAULT_RANKING_ANALYSIS_OPTIONS.opaqueAlphaMin,
    oceanToleranceFactor: DEFAULT_RANKING_ANALYSIS_OPTIONS.oceanToleranceFactor,
    oceanToleranceMin: DEFAULT_RANKING_ANALYSIS_OPTIONS.oceanToleranceMin,
    oceanToleranceMax: DEFAULT_RANKING_ANALYSIS_OPTIONS.oceanToleranceMax,
    histogramBins: DEFAULT_RANKING_ANALYSIS_OPTIONS.histogramBins,
  };
  const distortionField = buildPeirceDistortionField(outputSize, analysisOptions);
  const analyzedCases = [];

  for (let index = 0; index < cases.length; index += 1) {
    const entry = cases[index];
    const imagePath = path.join(sweepDir, entry.png);
    const image = PNG.sync.read(await fs.readFile(imagePath));

    if (image.width !== outputSize || image.height !== outputSize) {
      throw new Error(`Unexpected image size for ${entry.png}: ${image.width}x${image.height}`);
    }

    const landAnalysis = buildLandMaskFromRgba(image.data, image.width, image.height, analysisOptions);
    const metrics = scoreLandMaskAgainstField(landAnalysis.landMask, distortionField, analysisOptions);

    analyzedCases.push({
      caseId: Number(entry.caseId),
      centerLon: Number(entry.centerLon),
      centerLat: Number(entry.centerLat),
      roll: Number(entry.roll),
      label: entry.label,
      png: entry.png,
      landPixelCount: landAnalysis.landPixelCount,
      landRatio: Number(landAnalysis.landRatio.toFixed(6)),
      oceanColor: landAnalysis.oceanColor.map((value) => Number(value.toFixed(3))),
      oceanTolerance: Number(landAnalysis.oceanTolerance.toFixed(3)),
      metrics: roundMetrics(metrics),
    });

    console.log(`[rank ${index + 1}/${cases.length}] ${entry.label}`);
  }

  const rankingManifest = {
    generatedAt: new Date().toISOString(),
    sweepDir,
    sourceManifestPath: inputPath,
    sourceGeneratedAt: sourceManifest.generatedAt || null,
    inputFile: sourceManifest.inputFile || null,
    caseCount: analyzedCases.length,
    sourceCaseCount: sourceManifest.caseCount || sourceCases.length,
    outputSize,
    defaultSortMetric: 'geoMeanDistortion',
    analysisOptions,
    metrics: DEFAULT_RANKING_METRICS,
    distortionField: {
      hotspotThreshold: Number(distortionField.hotspotThreshold.toFixed(6)),
      clipMax: Number(distortionField.clipMax.toFixed(6)),
      maxDistortion: Number(distortionField.maxDistortion.toFixed(6)),
      medianLogAreaScale: Number(distortionField.medianLogAreaScale.toFixed(6)),
    },
    cases: analyzedCases,
  };

  await fs.writeFile(outputPath, JSON.stringify(rankingManifest, null, 2), 'utf8');
  console.log(JSON.stringify({
    sweepDir,
    inputPath,
    outputPath,
    caseCount: analyzedCases.length,
    outputSize,
    defaultSortMetric: rankingManifest.defaultSortMetric,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  printUsage();
  process.exitCode = 1;
});
