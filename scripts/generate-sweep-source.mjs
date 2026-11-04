// 既存の sweep 出力に、ライブ描画用の元画像 (source-equirect.png) を後から足す。
// sweep-peirce.mjs で新しく作った出力には最初から入っているので、これは古い出力向け。
//
//   node scripts/generate-sweep-source.mjs [sweep-dir] [--input=<元 SVG>] [--source-width=<幅>]
//
// source-width を省略すると manifest.json の sourceWidth を使う。それも無い古い manifest では
// sourceFrame の大きさに一致する幅を探す (resvg のフレーム切り出しは幅 + 1 画素になることが多い)。
// 一致しないときは止まる (違う画像でライブ描画すると PNG と見た目が合わなくなるため)。
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  SOURCE_IMAGE_FILE_NAME,
  encodePng,
  rasterizeSweepSource,
} from './lib/sweep-source-raster.mjs';

const DEFAULT_SWEEP_DIR = 'out/sweep-full-defaults';

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

function candidateWidths(manifest, explicitWidth) {
  if (explicitWidth !== undefined) {
    const width = Number(explicitWidth);
    if (!(width > 0)) throw new Error('source-width must be a positive number.');
    return [width];
  }
  if (Number(manifest.sourceWidth) > 0) return [Number(manifest.sourceWidth)];
  const frameWidth = Number(manifest.sourceFrame?.width);
  if (!(frameWidth > 0)) {
    throw new Error('manifest に sourceWidth も sourceFrame もありません。--source-width を指定してください。');
  }
  return [frameWidth - 1, frameWidth];
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const sweepDir = path.resolve(positional[0] || DEFAULT_SWEEP_DIR);
  const manifestPath = path.join(sweepDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const inputPath = path.resolve(options.input || manifest.inputPath || manifest.inputFile);
  const svgText = await fs.readFile(inputPath, 'utf8');
  const expected = manifest.sourceFrame;

  let sourceImage = null;
  let sourceWidth = null;
  for (const width of candidateWidths(manifest, options['source-width'])) {
    const image = rasterizeSweepSource(svgText, width);
    const matches = !expected || (image.width === expected.width && image.height === expected.height);
    if (matches) {
      sourceImage = image;
      sourceWidth = width;
      break;
    }
    console.warn(`source-width=${width} では ${image.width}x${image.height} になり、manifest の ${expected.width}x${expected.height} と合いません。`);
  }
  if (!sourceImage) {
    throw new Error('manifest の sourceFrame と同じ大きさの元画像を作れませんでした。--source-width を指定してください。');
  }

  const outputPath = path.join(sweepDir, SOURCE_IMAGE_FILE_NAME);
  await fs.writeFile(outputPath, encodePng(sourceImage));
  console.log(JSON.stringify({
    inputPath,
    outputPath,
    sourceWidth,
    width: sourceImage.width,
    height: sourceImage.height,
    background: sourceImage.background,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
