import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { decodePngRgba } from '../apps/sweep-viewer/png-decode.js';

function makeImage(width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = (x * 13 + y * 7) % 256;
      data[offset + 1] = (x * y) % 256;
      data[offset + 2] = (x ^ y) % 256;
      // 半透明の画素を含める (canvas 経由だと値が変わる画素)
      data[offset + 3] = x % 5 === 0 ? 255 : (x * 31 + y) % 256;
    }
  }
  return data;
}

test('decodePngRgba は pngjs が書いた RGBA PNG をそのままの値で読む (半透明の画素を含む)', async () => {
  const width = 67;
  const height = 41;
  const png = new PNG({ width, height });
  png.data = makeImage(width, height);
  const decoded = await decodePngRgba(PNG.sync.write(png));
  assert.ok(decoded);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual(Buffer.from(decoded.pixels), png.data);
});

test('decodePngRgba は RGB PNG も読み、アルファを 255 にする', async () => {
  const width = 20;
  const height = 9;
  const png = new PNG({ width, height, colorType: 2 });
  png.data = makeImage(width, height);
  const encoded = PNG.sync.write(png, { colorType: 2 });
  // pngjs は RGB で書くときにアルファを背景と合成するので、期待値は pngjs で読み戻した値にする
  const expected = PNG.sync.read(encoded).data;
  const decoded = await decodePngRgba(encoded);
  assert.ok(decoded);
  assert.deepEqual(Buffer.from(decoded.pixels), expected);
  for (let index = 0; index < width * height; index += 1) {
    assert.equal(decoded.pixels[index * 4 + 3], 255);
  }
});

test('decodePngRgba は PNG でないものに null を返す', async () => {
  assert.equal(await decodePngRgba(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer), null);
});
