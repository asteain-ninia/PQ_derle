import fs from 'node:fs/promises';
import path from 'node:path';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { transformSvgString } from '../src/transform.js';
import { sweepToTransformOrientation } from '../src/orientation.js';
import { parseArgs, parseBoolean, parseNumberOption } from './lib/cli-options.mjs';

function printUsage() {
  console.log(`Usage:
  npm run transform -- <input.svg> <output.svg> [--center-lon=-143] [--center-lat=0] [--roll=0]
    [--lon0=-143] [--sample-step=3] [--path-precision=0.35] [--side=<output-side>] [--from-sweep]

  --from-sweep: center-lon / center-lat / roll を sweep・ビューア・ランキングの向きとして読み、
                最終 SVG で同じ地図になる向きへ読み替えてから変換します。
`);
}

function formatOrientation({ centerLon, centerLat, roll }) {
  return `--center-lon=${centerLon} --center-lat=${centerLat} --roll=${roll}`;
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (positional.length < 2) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const [inputPath, outputPath] = positional;
  const sourceSvg = await fs.readFile(inputPath, 'utf8');
  const centerLon = parseNumberOption(options['center-lon'], parseNumberOption(options.lon0, -143));
  let orientation = {
    centerLon,
    centerLat: parseNumberOption(options['center-lat'], 0),
    roll: parseNumberOption(options.roll, 0),
  };
  if (parseBoolean(options['from-sweep'], false)) {
    const sweepOrientation = orientation;
    orientation = sweepToTransformOrientation(sweepOrientation);
    console.error(`sweep の向き ${formatOrientation(sweepOrientation)} を、最終 SVG の向き ${formatOrientation(orientation)} として変換します。`);
  }
  const result = await transformSvgString(
    sourceSvg,
    {
      ...orientation,
      lon0: orientation.centerLon,
      sampleStep: parseNumberOption(options['sample-step'], 3),
      pathPrecision: parseNumberOption(options['path-precision'], 0.35),
      outputSide: parseNumberOption(options.side, null),
    },
    { DOMParser, XMLSerializer },
  );

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, result.svgText, 'utf8');
  console.log(JSON.stringify(result.stats, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
