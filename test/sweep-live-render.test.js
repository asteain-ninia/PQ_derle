import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { geoPeirceQuincuncial } from 'd3-geo-projection';
import {
  buildProjectionLut,
  buildRotationMatrix,
  joinProjectionLut,
  orientationToRotate,
  renderLutFrame,
} from '../src/sweep-live-render.js';
import { estimateBackgroundColor, normalizeLongitude, renderSweepCase } from '../src/sweep-core.js';

const RADIANS = Math.PI / 180;

// 以前の renderSweepCase (画素ごとに d3 の projection.invert を呼ぶ版) をそのまま残した参照実装。
// LUT 経由の描画 (src/sweep-live-render.js) がこれと同じ画素を出すことをテストで確かめる。

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getPixel(sourceImage, x, y, background) {
  if (x < 0 || x >= sourceImage.width || y < 0 || y >= sourceImage.height) {
    return background;
  }
  const offset = (y * sourceImage.width + x) * 4;
  return [
    sourceImage.pixels[offset],
    sourceImage.pixels[offset + 1],
    sourceImage.pixels[offset + 2],
    sourceImage.pixels[offset + 3],
  ];
}

function mixChannel(a, b, t) {
  return a + (b - a) * t;
}

function sampleSourceRgba(sourceImage, lon, lat, background) {
  const lonNormalized = normalizeLongitude(lon);
  const lonFraction = ((((lonNormalized + 180) / 360) % 1) + 1) % 1;
  const latFraction = clamp((90 - lat) / 180, 0, 1);

  const x = lonFraction * sourceImage.width;
  const wrappedX = (((x % sourceImage.width) + sourceImage.width) % sourceImage.width);
  const y = latFraction * Math.max(sourceImage.height - 1, 1);

  const x0 = Math.floor(wrappedX) % sourceImage.width;
  const x1 = (x0 + 1) % sourceImage.width;
  const y0 = clamp(Math.floor(y), 0, sourceImage.height - 1);
  const y1 = clamp(y0 + 1, 0, sourceImage.height - 1);
  const tx = wrappedX - Math.floor(wrappedX);
  const ty = y - y0;

  const c00 = getPixel(sourceImage, x0, y0, background);
  const c10 = getPixel(sourceImage, x1, y0, background);
  const c01 = getPixel(sourceImage, x0, y1, background);
  const c11 = getPixel(sourceImage, x1, y1, background);
  const rgba = [0, 0, 0, 0];

  for (let channel = 0; channel < 4; channel += 1) {
    const top = mixChannel(c00[channel], c10[channel], tx);
    const bottom = mixChannel(c01[channel], c11[channel], tx);
    rgba[channel] = Math.round(mixChannel(top, bottom, ty));
  }

  return rgba;
}

function setPixel(target, width, x, y, rgba) {
  const offset = (y * width + x) * 4;
  target[offset] = rgba[0];
  target[offset + 1] = rgba[1];
  target[offset + 2] = rgba[2];
  target[offset + 3] = rgba[3];
}

function referenceRenderSweepCase(sourceImage, caseDefinition, outputSize) {
  const width = outputSize;
  const height = outputSize;
  const background = sourceImage.background || estimateBackgroundColor(sourceImage);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const projection = geoPeirceQuincuncial()
    .fitExtent(
      [
        [0, 0],
        [width, height],
      ],
      { type: 'Sphere' },
    )
    .rotate([-caseDefinition.centerLon, -caseDefinition.centerLat, caseDefinition.roll]);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const lonLat = projection.invert([x + 0.5, y + 0.5]);
      const pixel = lonLat
        ? sampleSourceRgba(sourceImage, lonLat[0], lonLat[1], background)
        : background;
      setPixel(rgba, width, x, y, pixel);
    }
  }

  return {
    width,
    height,
    pixels: rgba,
  };
}

// 再現できる疑似乱数 (mulberry32)
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toVector([lon, lat]) {
  const cosLat = Math.cos(lat * RADIANS);
  return [Math.cos(lon * RADIANS) * cosLat, Math.sin(lon * RADIANS) * cosLat, Math.sin(lat * RADIANS)];
}

function multiply(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

function multiplyTransposed(m, v) {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// 極の近く・日付変更線の近くを必ず含む向きの組
function buildOrientations(random, count) {
  const fixed = [
    { centerLon: 0, centerLat: 0, roll: 0 },
    { centerLon: -143, centerLat: 0, roll: 0 },
    { centerLon: 180, centerLat: 0, roll: 0 },
    { centerLon: -180, centerLat: 12, roll: 33 },
    { centerLon: 179.9999, centerLat: -45, roll: 300 },
    { centerLon: -179.9999, centerLat: 45, roll: 90 },
    { centerLon: 0, centerLat: 90, roll: 0 },
    { centerLon: 37, centerLat: -90, roll: 15 },
    { centerLon: 120, centerLat: 89.9999, roll: 200 },
    { centerLon: -60, centerLat: -89.9999, roll: 359.9 },
  ];
  const randomOnes = Array.from({ length: count }, () => ({
    centerLon: random() * 360 - 180,
    centerLat: random() * 180 - 90,
    roll: random() * 360,
  }));
  return [...fixed, ...randomOnes];
}

function makeProjection(size, rotate) {
  return geoPeirceQuincuncial()
    .fitExtent([[0, 0], [size, size]], { type: 'Sphere' })
    .rotate(rotate);
}

test('buildRotationMatrix は d3 の順方向の回転と一致する (projection.rotate(r) と base の比較)', () => {
  const random = createRandom(1);
  const size = 200;
  const base = makeProjection(size, [0, 0, 0]);
  let maxError = 0;

  for (const orientation of buildOrientations(random, 40)) {
    const rotate = orientationToRotate(orientation);
    const rotated = makeProjection(size, rotate);
    const matrix = buildRotationMatrix(rotate);
    for (let sample = 0; sample < 50; sample += 1) {
      const lonLat = [random() * 360 - 180, random() * 178 - 89];
      // rotated(lonLat) = base(R(lonLat)) なので、R を通した点の base 逆変換どうしを比べる
      const expected = base.invert(rotated(lonLat));
      const actual = multiply(matrix, toVector(lonLat));
      maxError = Math.max(maxError, distance(toVector(expected), actual));
    }
  }

  assert.ok(maxError < 1e-9, `max error ${maxError}`);
});

test('LUT + 逆回転 (転置) は projection.rotate(r).invert と一致する (極・日付変更線の近くを含む)', () => {
  const random = createRandom(2);
  const size = 160;
  const lut = buildProjectionLut(size);
  let maxError = 0;
  let checked = 0;

  for (const orientation of buildOrientations(random, 40)) {
    const rotate = orientationToRotate(orientation);
    const rotated = makeProjection(size, rotate);
    const matrix = buildRotationMatrix(rotate);
    for (let sample = 0; sample < 80; sample += 1) {
      const x = Math.floor(random() * size);
      const y = Math.floor(random() * size);
      const expected = rotated.invert([x + 0.5, y + 0.5]);
      const offset = (y * size + x) * 3;
      const baseVector = [lut.vectors[offset], lut.vectors[offset + 1], lut.vectors[offset + 2]];
      if (!expected) {
        assert.ok(Number.isNaN(baseVector[0]));
        continue;
      }
      const actual = multiplyTransposed(matrix, baseVector);
      maxError = Math.max(maxError, distance(toVector(expected), actual));
      checked += 1;
    }
  }

  assert.ok(checked > 1000);
  // 単位ベクトルの差 1e-9 は角度で約 6e-8 度
  assert.ok(maxError < 1e-9, `max error ${maxError}`);
});

test('geoPeirceQuincuncial は既定で回転を持つので、LUT は rotate([0, 0, 0]) で作る必要がある', () => {
  const preset = geoPeirceQuincuncial().rotate();
  assert.notDeepEqual(preset, [0, 0, 0]);
});

test('行の帯に分けて作った LUT をつないだものは一度に作った LUT と同じ', () => {
  const size = 37;
  const whole = buildProjectionLut(size);
  const parts = [[0, 10], [10, 11], [11, 37]].map(([rowStart, rowEnd]) => buildProjectionLut(size, { rowStart, rowEnd }));
  const joined = joinProjectionLut(size, parts);
  assert.equal(joined.vectors.length, whole.vectors.length);
  for (let index = 0; index < whole.vectors.length; index += 1) {
    assert.ok(Object.is(joined.vectors[index], whole.vectors[index]));
  }
});

function makeSyntheticSource(width, height, seed) {
  const random = createRandom(seed);
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      // 滑らかな成分と雑音を混ぜ、双一次補間の丸めの違いが出やすいようにする
      pixels[offset] = (x * 7 + y * 3) % 256;
      pixels[offset + 1] = Math.floor(random() * 256);
      pixels[offset + 2] = (x * y) % 256;
      pixels[offset + 3] = 200 + (x % 56);
    }
  }
  const image = { width, height, pixels };
  image.background = estimateBackgroundColor(image);
  return image;
}

function countDifferences(a, b) {
  assert.equal(a.length, b.length);
  let differentBytes = 0;
  let maxDelta = 0;
  for (let index = 0; index < a.length; index += 1) {
    const delta = Math.abs(a[index] - b[index]);
    if (delta) {
      differentBytes += 1;
      maxDelta = Math.max(maxDelta, delta);
    }
  }
  return { differentBytes, maxDelta };
}

test('renderLutFrame は以前の renderSweepCase (画素ごとの d3 invert) と画素単位で一致する', () => {
  const random = createRandom(3);
  const source = makeSyntheticSource(721, 361, 4);
  const size = 96;
  const lut = buildProjectionLut(size);

  for (const orientation of buildOrientations(random, 10)) {
    const expected = referenceRenderSweepCase(source, orientation, size).pixels;
    const actual = renderLutFrame(lut, source, orientation, source.background);
    assert.deepEqual(countDifferences(expected, actual), { differentBytes: 0, maxDelta: 0 }, JSON.stringify(orientation));
  }
});

test('renderSweepCase (LUT 版) は参照実装と一致し、大きさを変えても LUT を作り直す', () => {
  const source = makeSyntheticSource(400, 200, 5);
  for (const [size, orientation] of [
    [48, { centerLon: -143, centerLat: 0, roll: 0 }],
    [64, { centerLon: 75, centerLat: -30, roll: 45 }],
    [48, { centerLon: 10, centerLat: 60, roll: 15 }],
  ]) {
    const expected = referenceRenderSweepCase(source, orientation, size).pixels;
    const actual = renderSweepCase(source, orientation, { outputSize: size }).pixels;
    assert.deepEqual(countDifferences(expected, actual), { differentBytes: 0, maxDelta: 0 });
  }
});

test('実際の地図 (小さめにラスタ化) でも LUT 描画と参照実装が一致する', async () => {
  const svgPath = new URL('../イラレ出界図.svg', import.meta.url);
  if (!fs.existsSync(svgPath)) return;
  const { rasterizeSweepSource } = await import('../scripts/lib/sweep-source-raster.mjs');
  const source = rasterizeSweepSource(fs.readFileSync(svgPath, 'utf8'), 512);
  const size = 80;
  const lut = buildProjectionLut(size);
  for (const orientation of [
    { centerLon: -143, centerLat: 0, roll: 0 },
    { centerLon: 60, centerLat: -60, roll: 30 },
    { centerLon: 180, centerLat: 89.5, roll: 271 },
  ]) {
    const expected = referenceRenderSweepCase(source, orientation, size).pixels;
    const actual = renderLutFrame(lut, source, orientation, source.background);
    assert.deepEqual(countDifferences(expected, actual), { differentBytes: 0, maxDelta: 0 });
  }
});

test('roll を +90° すると投影図は反時計回りに 90° 回る (viewer の 90° 補完の向き)', () => {
  const source = makeSyntheticSource(360, 180, 6);
  const size = 64;
  const lut = buildProjectionLut(size);
  const base = renderLutFrame(lut, source, { centerLon: 40, centerLat: 20, roll: 10 }, source.background);
  const turned = renderLutFrame(lut, source, { centerLon: 40, centerLat: 20, roll: 100 }, source.background);

  const counterClockwise = new Uint8ClampedArray(base.length);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // 反時計回り 90°: 出力 (x, y) ← 元 (size - 1 - y, x)
      const from = (x * size + (size - 1 - y)) * 4;
      counterClockwise.set(base.subarray(from, from + 4), (y * size + x) * 4);
    }
  }

  // 数値誤差でごくまれに 1 段ずれるのは許す
  const { maxDelta } = countDifferences(counterClockwise, turned);
  assert.ok(maxDelta <= 2, `max delta ${maxDelta}`);
});
