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

function detectSourceScale(root, viewBox) {
  const width = Number.parseFloat(root.getAttribute('width') || '0');
  if (!viewBox.width || !Number.isFinite(width) || width <= 0) return 1;
  return width / viewBox.width;
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
  const sourceScale = detectSourceScale(root, viewBox);
  if (!(frame.width > 0 && frame.height > 0)) {
    throw new Error('Could not detect a valid 2:1 map frame.');
  }
  return { viewBox, frame, sourceScale };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cropRenderedFrame(renderedImage, metadata) {
  const { viewBox, frame } = metadata;
  const scaleX = renderedImage.width / viewBox.width;
  const scaleY = renderedImage.height / viewBox.height;
  const left = clamp(Math.floor((frame.x - viewBox.x) * scaleX), 0, renderedImage.width - 1);
  const top = clamp(Math.floor((frame.y - viewBox.y) * scaleY), 0, renderedImage.height - 1);
  const right = clamp(Math.ceil((frame.x + frame.width - viewBox.x) * scaleX), left + 1, renderedImage.width);
  const bottom = clamp(Math.ceil((frame.y + frame.height - viewBox.y) * scaleY), top + 1, renderedImage.height);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const pixels = new Uint8ClampedArray(width * height * 4);
  const source = renderedImage.pixels;

  for (let y = 0; y < height; y += 1) {
    const sourceOffset = ((top + y) * renderedImage.width + left) * 4;
    const targetOffset = y * width * 4;
    pixels.set(source.subarray(sourceOffset, sourceOffset + width * 4), targetOffset);
  }

  return {
    width,
    height,
    pixels,
  };
}

export function rasterizeSourceFrame(svgText, metadata, sourceWidth) {
  const zoom = sourceWidth / (metadata.frame.width * metadata.sourceScale);
  const resvg = new Resvg(svgText, {
    fitTo: { mode: 'zoom', value: zoom },
    imageRendering: 0,
    shapeRendering: 2,
    textRendering: 1,
    background: 'rgba(0,0,0,0)',
  });
  const rendered = resvg.render();
  const frameImage = cropRenderedFrame(rendered, metadata);
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
