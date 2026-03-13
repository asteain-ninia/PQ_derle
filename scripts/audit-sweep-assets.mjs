import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_SWEEP_DIR = path.resolve('out/sweep-full-defaults');

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const sweepDir = path.resolve(process.argv[2] || DEFAULT_SWEEP_DIR);
  const manifestPath = path.join(sweepDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const missing = [];

  for (const entry of manifest.cases || []) {
    const pngPath = path.join(sweepDir, entry.png);
    if (!await fileExists(pngPath)) {
      missing.push({
        caseId: Number(entry.caseId),
        centerLon: entry.centerLon,
        centerLat: entry.centerLat,
        roll: entry.roll,
        png: entry.png,
      });
    }
  }

  console.log(JSON.stringify({
    sweepDir,
    manifestPath,
    caseCount: manifest.caseCount || manifest.cases.length,
    missingCount: missing.length,
    missing: missing.slice(0, 100),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
