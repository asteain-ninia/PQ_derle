// sweep の出力ディレクトリにある各ケース PNG を、何から描いたかの記録 (render-cache.json)。
// skip-existing は「ファイルがある」だけでなく、この記録の描画条件が今回と一致し、
// 記録にそのファイル名が載っているときだけ再利用する。
// 条件が変わると古い PNG が残ったまま manifest や元画像だけ新しくなり、
// viewer のライブ描画・ケース画像・ランキングが食い違うため。
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildProjectionLut } from '../../src/sweep-live-render.js';

export const RENDER_CACHE_FILE_NAME = 'render-cache.json';
const RENDER_CACHE_FORMAT = 1;

// 画素に効くコード。投影の LUT と元画像の補間はここにある。
const RENDERER_SOURCE_FILES = [
  new URL('../../src/sweep-core.js', import.meta.url),
  new URL('../../src/sweep-live-render.js', import.meta.url),
];

function sha256(...chunks) {
  const hash = createHash('sha256');
  for (const chunk of chunks) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function typedArrayBytes(array) {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

/** 元画像 (フィルタ → ラスタ化 → フレーム切り出し後) の寸法と画素のハッシュ。 */
export function hashSourceImage(sourceImage) {
  return sha256(
    `${sourceImage.width}x${sourceImage.height}\n`,
    typedArrayBytes(sourceImage.pixels),
  );
}

// 依存ライブラリ (d3-geo-projection) の結果が変わったことを拾うための小さな LUT の大きさ。
// 出力の大きさとは別にする (output-size の変更を「描画処理の変更」と表示しないため)
const RENDERER_PROBE_LUT_SIZE = 32;

/**
 * 描画処理のハッシュ。描画コードの本文と、決まった大きさの投影 LUT (d3-geo-projection の結果) から作る。
 * コードはコメントだけの変更でも変わったとみなす (古い画像を使い続けるより作り直す方を選ぶ)。
 */
export async function hashRenderer() {
  const sources = await Promise.all(RENDERER_SOURCE_FILES.map((url) => fs.readFile(url)));
  return sha256(...sources, typedArrayBytes(buildProjectionLut(RENDERER_PROBE_LUT_SIZE).vectors));
}

/**
 * 各ケースの画素を決める条件。ケースの向き (lon / lat / roll) はファイル名に入っているので含めない。
 * sourceImageSha256 は入力 SVG・source-width に加えて、sweep 用のフィルタ (sweep-source-svg.js) や
 * resvg の版の違いも拾う。inputSvgSha256 は理由を表示するために別に持つ。
 */
export function buildRenderKey({ svgText, sourceWidth, sourceImage, outputSize, rendererSha256 }) {
  return {
    outputSize,
    sourceWidth,
    inputSvgSha256: sha256(svgText),
    sourceImageSha256: hashSourceImage(sourceImage),
    rendererSha256,
  };
}

const KEY_LABELS = {
  outputSize: 'output-size',
  sourceWidth: 'source-width',
  inputSvgSha256: '入力 SVG の内容',
  sourceImageSha256: '元画像 (source-equirect.png) の画素',
  rendererSha256: '描画処理 (src/sweep-core.js・src/sweep-live-render.js・投影 LUT)',
};

function formatKeyValue(value) {
  if (value === undefined) return '(記録なし)';
  if (typeof value === 'string' && value.length === 64) return value.slice(0, 12);
  return String(value);
}

/** 前回の記録と今回の条件の違いを、人が読める理由の一覧にする。一致すれば空配列。 */
export function describeRenderKeyMismatch(previousKey, nextKey) {
  if (!previousKey) return [];
  const reasons = [];
  for (const field of Object.keys(KEY_LABELS)) {
    if (previousKey[field] !== nextKey[field]) {
      reasons.push(`${KEY_LABELS[field]}: ${formatKeyValue(previousKey[field])} → ${formatKeyValue(nextKey[field])}`);
    }
  }
  return reasons;
}

/** 記録を読む。無い・壊れている・形式が違うときは null (全部作り直す側に倒す)。 */
export async function readRenderCache(outputDir) {
  let text;
  try {
    text = await fs.readFile(path.join(outputDir, RENDER_CACHE_FILE_NAME), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed?.format !== RENDER_CACHE_FORMAT || !parsed.key || !Array.isArray(parsed.files)) {
      return null;
    }
    return { key: parsed.key, files: new Set(parsed.files) };
  } catch {
    return null;
  }
}

/** 記録を書く。途中で落ちても壊れたファイルが残らないよう、一時ファイルに書いてから置き換える。 */
export async function writeRenderCache(outputDir, key, files) {
  const targetPath = path.join(outputDir, RENDER_CACHE_FILE_NAME);
  const temporaryPath = `${targetPath}.tmp`;
  const body = {
    format: RENDER_CACHE_FORMAT,
    key,
    files: [...files].sort(),
  };
  await fs.writeFile(temporaryPath, JSON.stringify(body, null, 2), 'utf8');
  await fs.rename(temporaryPath, targetPath);
}

/**
 * 今回再利用してよいファイル名の集合と、使わない理由を決める。
 * skipExisting が false なら何も再利用しない。
 */
export function planRenderCacheReuse(previousCache, nextKey, skipExisting) {
  if (!skipExisting) {
    return { reusable: new Set(), reasons: [] };
  }
  if (!previousCache) {
    return { reusable: new Set(), reasons: ['描画条件の記録 (render-cache.json) が無い'] };
  }
  const reasons = describeRenderKeyMismatch(previousCache.key, nextKey);
  if (reasons.length) {
    return { reusable: new Set(), reasons };
  }
  return { reusable: new Set(previousCache.files), reasons: [] };
}
