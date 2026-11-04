// ライブ投影の Worker。担当する行の帯 (rowStart〜rowEnd) について
//   - LUT (base.invert の単位ベクトル表) を作る
//   - CPU 描画のときは、その帯だけを描いて返す
// を受け持つ。複数の Worker で行を分けて並列に動かす。

import { buildProjectionLut, renderLutFrame } from '../../src/sweep-live-render.js';

let source = null;
let background = [0, 0, 0, 0];
const luts = new Map();

function lutKey(size, rowStart, rowEnd) {
  return `${size}:${rowStart}:${rowEnd}`;
}

self.addEventListener('message', (event) => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'source': {
        source = { width: message.width, height: message.height, pixels: message.pixels };
        background = message.background;
        self.postMessage({ type: 'source-ready', id: message.id });
        break;
      }
      case 'build-lut': {
        const { size, rowStart, rowEnd, keep, returnVectors } = message;
        const startedAt = performance.now();
        const lut = buildProjectionLut(size, { rowStart, rowEnd });
        if (keep) luts.set(lutKey(size, rowStart, rowEnd), lut);
        const reply = {
          type: 'lut-ready',
          id: message.id,
          size,
          rowStart,
          rowEnd,
          durationMs: performance.now() - startedAt,
        };
        if (returnVectors) {
          // WebGL 用には float32 で十分 (誤差は元画像で 1e-4 画素程度)
          const vectors = Float32Array.from(lut.vectors);
          reply.vectors = vectors;
          self.postMessage(reply, [vectors.buffer]);
        } else {
          self.postMessage(reply);
        }
        break;
      }
      case 'drop-lut': {
        luts.delete(lutKey(message.size, message.rowStart, message.rowEnd));
        break;
      }
      case 'render': {
        const { size, rowStart, rowEnd, orientation } = message;
        const lut = luts.get(lutKey(size, rowStart, rowEnd));
        if (!lut || !source) throw new Error('LUT or source is not ready.');
        const startedAt = performance.now();
        const pixels = renderLutFrame(lut, source, orientation, background);
        self.postMessage({
          type: 'frame',
          id: message.id,
          size,
          rowStart,
          rowEnd,
          pixels,
          durationMs: performance.now() - startedAt,
        }, [pixels.buffer]);
        break;
      }
      default:
        throw new Error(`Unknown message: ${message.type}`);
    }
  } catch (error) {
    self.postMessage({ type: 'error', id: message.id, message: error.message });
  }
});
