// sweep 用の元画像 (正距円筒フレーム) を SVG から resvg でラスタ化する。
// sweep-peirce.mjs と generate-sweep-source.mjs で共用し、両者が同じ画素を使うようにする。
import { Resvg } from '@resvg/resvg-js';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { PNG } from 'pngjs';
import { estimateBackgroundColor } from '../../src/sweep-core.js';
import { prepareSweepSourceSvg } from '../../src/sweep-source-svg.js';

export const DEFAULT_SOURCE_WIDTH = 3072;
// sweep 出力ディレクトリに置く元画像のファイル名 (viewer のライブ描画が読む)
export const SOURCE_IMAGE_FILE_NAME = 'source-equirect.png';

function localName(node) {
  return node.localName || node.nodeName;
}

function parseFloatList(value) {
  if (!value) return [];
  const matches = value.match(/[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g);
  return matches ? matches.map(Number) : [];
}

function getViewBox(root) {
  const values = parseFloatList(root.getAttribute('viewBox'));
  if (values.length === 4) {
    return { x: values[0], y: values[1], width: values[2], height: values[3] };
  }

  return {
    x: 0,
    y: 0,
    width: Number.parseFloat(root.getAttribute('width') || '0') || 0,
    height: Number.parseFloat(root.getAttribute('height') || '0') || 0,
  };
}

function findMapFrame(root) {
  const rects = Array.from(root.getElementsByTagName('rect'));
  let best = null;
  for (const rect of rects) {
    const x = Number.parseFloat(rect.getAttribute('x') || '0');
    const y = Number.parseFloat(rect.getAttribute('y') || '0');
    const width = Number.parseFloat(rect.getAttribute('width') || '0');
    const height = Number.parseFloat(rect.getAttribute('height') || '0');
    if (!(width > 0 && height > 0)) continue;
    const ratioPenalty = Math.abs(width / height - 2);
    const score = width * height - ratioPenalty * 1000000;
    if (!best || score > best.score) {
      best = { score, x, y, width, height };
    }
  }

  if (best) return best;
  const viewBox = getViewBox(root);
  return {
    score: viewBox.width * viewBox.height,
    x: viewBox.x,
    y: viewBox.y,
    width: viewBox.width,
    height: viewBox.height,
  };
}

export function parseSvgMetadata(svgText) {
  const document = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const root = document.documentElement;
  if (!root || localName(root) !== 'svg') {
    throw new Error('Input is not a valid SVG document.');
  }
  const parserErrors = document.getElementsByTagName('parsererror');
  if (parserErrors.length > 0) {
    throw new Error('SVG parsing failed.');
  }

  const viewBox = getViewBox(root);
  const frame = findMapFrame(root);
  if (!(frame.width > 0 && frame.height > 0)) {
    throw new Error('Could not detect a valid 2:1 map frame.');
  }
  return { viewBox, frame };
}

// viewBox をフレームそのものにして、フレームがちょうど sourceWidth 画素の幅になるよう描く。
// 文書全体を描いてから切り出すと、フレームの縁が画素の境に乗らず、両端に半透明の列が付いて幅も 1 画素
// 増える (経度 180° の所に淡い線が出る)。
function rasterizeSourceFrame(svgText, metadata, sourceWidth) {
  const { frame } = metadata;
  const document = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const root = document.documentElement;
  root.setAttribute('viewBox', `${frame.x} ${frame.y} ${frame.width} ${frame.height}`);
  root.setAttribute('width', String(frame.width));
  root.setAttribute('height', String(frame.height));
  root.setAttribute('preserveAspectRatio', 'none');
  const resvg = new Resvg(new XMLSerializer().serializeToString(document), {
    fitTo: { mode: 'width', value: Math.round(sourceWidth) },
    imageRendering: 0,
    shapeRendering: 2,
    textRendering: 1,
    background: 'rgba(0,0,0,0)',
  });
  const rendered = resvg.render();
  const frameImage = {
    width: rendered.width,
    height: rendered.height,
    pixels: new Uint8ClampedArray(rendered.pixels),
  };
  return {
    ...frameImage,
    background: estimateBackgroundColor(frameImage),
  };
}

export function encodePng(image) {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.pixels);
  return PNG.sync.write(png);
}

export function decodePng(buffer) {
  const png = PNG.sync.read(buffer);
  return {
    width: png.width,
    height: png.height,
    pixels: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length),
  };
}

/** 元 SVG の文字列から、sweep と同じ手順 (フィルタ → ラスタ化 → フレーム切り出し) で元画像を作る。 */
export function rasterizeSweepSource(svgText, sourceWidth = DEFAULT_SOURCE_WIDTH) {
  const metadata = parseSvgMetadata(svgText);
  const filteredSvgText = prepareSweepSourceSvg(svgText, { DOMParser, XMLSerializer });
  return rasterizeSourceFrame(filteredSvgText, metadata, sourceWidth);
}
