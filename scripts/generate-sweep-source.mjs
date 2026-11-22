// 既存の sweep 出力に、ライブ描画用の元画像 (source-equirect.png) を後から足す。
// sweep-peirce.mjs で新しく作った出力には最初から入っているので、これは古い出力向け。
//
//   node scripts/generate-sweep-source.mjs [sweep-dir] [--input=<元 SVG>] [--source-width=<幅>]
//
// source-width を省略すると manifest.json の sourceWidth を使う。それも無い古い manifest では、
// sourceFrame より 1 画素狭い幅を使う (以前は文書全体を描いてから切り出していて、縦横とも指定より
// 1 画素広くなっていた)。大きさがどちらとも合わないときは止まる (違う画像でライブ描画すると PNG と
// 見た目が合わなくなるため)。
// render-cache.json があれば、ケース PNG を描いた元画像の画素とも照合し、違えば止まる (SVG を直した後に
// これだけ走らせると、ライブ描画が古いケース PNG・ランキングと黙って食い違うため。そのときは sweep を
// 走らせ直す)。render-cache.json の無い古い出力では、大きさしか照合できない。
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from './lib/cli-options.mjs';
import { hashSourceImage, readRenderCache } from './lib/sweep-render-cache.mjs';
import {
  SOURCE_IMAGE_FILE_NAME,
  encodePng,
  rasterizeSweepSource,
} from './lib/sweep-source-raster.mjs';

const DEFAULT_SWEEP_DIR = 'out/sweep-full-defaults';

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
  return [frameWidth - 1];
}

// 今の切り出しと同じ大きさか、以前の切り出し (縦と横を別々に切り上げていたので、どちらも 1 画素広いことがある)
// で作った大きさなら一致とみなす。
function matchesFrame(image, expected) {
  if (!expected) return true;
  const fits = (actual, wanted) => wanted === actual || wanted === actual + 1;
  return fits(image.width, expected.width) && fits(image.height, expected.height);
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
    const matches = matchesFrame(image, expected);
    if (matches) {
      sourceImage = image;
      sourceWidth = width;
      break;
    }
    console.warn(`source-width=${width} では ${image.width}x${image.height} になり、manifest の ${expected.width}x${expected.height} と合いません。`);
  }
  if (!sourceImage) {
    throw new Error(
      'manifest の sourceFrame と同じ大きさの元画像を作れませんでした。--source-width を指定するか、'
      + 'npm run sweep で sweep を作り直してください。',
    );
  }

  const renderCache = await readRenderCache(sweepDir);
  if (renderCache) {
    if (renderCache.key.sourceImageSha256 !== hashSourceImage(sourceImage)) {
      throw new Error(
        'この sweep のケース PNG は、今の SVG から作った元画像とは違う画素で描かれています '
        + '(render-cache.json の sourceImageSha256 が合いません)。npm run sweep で作り直してください。',
      );
    }
  } else {
    console.warn('render-cache.json が無いので、元画像の大きさしか照合できません。');
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
