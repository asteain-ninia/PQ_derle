import fs from 'node:fs/promises';
import path from 'node:path';
import { buildViewerManifest } from '../apps/sweep-viewer/viewer-assets.js';

const DEFAULT_SWEEP_DIR = path.resolve('out/sweep-full-defaults');
const DEFAULT_INPUT_FILE = 'manifest.json';
const DEFAULT_OUTPUT_FILE = 'viewer-manifest.json';

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

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const sweepDir = path.resolve(positional[0] || DEFAULT_SWEEP_DIR);
  const inputPath = path.resolve(sweepDir, options.input || DEFAULT_INPUT_FILE);
  const outputPath = path.resolve(sweepDir, options.output || DEFAULT_OUTPUT_FILE);
  const sourceManifest = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  const viewerManifest = buildViewerManifest(sourceManifest);

  await fs.writeFile(outputPath, JSON.stringify(viewerManifest, null, 2), 'utf8');
  console.log(JSON.stringify({
    inputPath,
    outputPath,
    sourceCaseCount: sourceManifest.caseCount || sourceManifest.cases.length,
    viewerCaseCount: viewerManifest.caseCount,
    expandedByRotation: Boolean(viewerManifest.viewerAssets?.expandedByRotation),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
