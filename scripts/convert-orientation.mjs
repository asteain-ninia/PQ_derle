import { sweepToTransformOrientation, transformToSweepOrientation } from '../src/orientation.js';

// sweep（総当たり・ビューア・ランキング）と最終 SVG（transform）では、同じ centerLon / centerLat / roll でも
// 地図の向きが違う。片方の値を、もう片方で同じ地図になる値へ読み替えて表示する。

function printUsage() {
  console.log(`Usage:
  npm run convert-orientation -- --center-lon=<lon> --center-lat=<lat> --roll=<roll> [--to=transform|sweep]

  --to=transform（既定）: sweep・ビューア・ランキングの向きを、最終 SVG（npm run transform / Web 画面）の向きへ読み替えます。
  --to=sweep:             最終 SVG の向きを、sweep・ビューアの向きへ読み替えます。
`);
}

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, rawValue] = arg.slice(2).split('=');
    options[key] = rawValue ?? 'true';
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const to = options.to ?? 'transform';
if (options.help || !['transform', 'sweep'].includes(to) || options['center-lon'] === undefined) {
  printUsage();
  process.exitCode = options.help ? 0 : 1;
} else {
  const input = {
    centerLon: Number(options['center-lon']),
    centerLat: Number(options['center-lat'] ?? 0),
    roll: Number(options.roll ?? 0),
  };
  const output = to === 'transform' ? sweepToTransformOrientation(input) : transformToSweepOrientation(input);
  console.log(`--center-lon=${output.centerLon} --center-lat=${output.centerLat} --roll=${output.roll}`);
}
