import fs from 'node:fs/promises';
import path from 'node:path';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { transformSvgString } from '../src/transform.js';

function printUsage() {
  console.log(`Usage:
  npm run transform -- <input.svg> <output.svg> [--lon0=81] [--sample-step=3] [--path-precision=0.35] [--side=4249.288]
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

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (positional.length < 2) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const [inputPath, outputPath] = positional;
  const sourceSvg = await fs.readFile(inputPath, 'utf8');
  const result = await transformSvgString(
    sourceSvg,
    {
      lon0: options.lon0 ? Number(options.lon0) : 81,
      sampleStep: options['sample-step'] ? Number(options['sample-step']) : 3,
      pathPrecision: options['path-precision'] ? Number(options['path-precision']) : 0.35,
      outputSide: options.side ? Number(options.side) : null,
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
