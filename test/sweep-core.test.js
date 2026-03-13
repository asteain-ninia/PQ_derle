import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSweepCaseFileName,
  enumerateSweepCases,
  estimateSweepCaseCount,
  renderSweepCase,
} from '../src/sweep-core.js';

test('enumerateSweepCases collapses pole longitudes in quarter-turn mode', () => {
  const enumerated = enumerateSweepCases({
    centerLonMin: -180,
    centerLonMax: 180,
    centerLonStep: 90,
    centerLatMin: -90,
    centerLatMax: 90,
    centerLatStep: 90,
    rollStep: 45,
    rollMode: 'quarter-turn',
    outputSize: 32,
  });

  assert.equal(enumerated.lonValues.length, 4);
  assert.equal(enumerated.latValues.length, 3);
  assert.equal(enumerated.rollValues.length, 2);
  assert.equal(enumerated.cases.length, 12);
  assert.equal(estimateSweepCaseCount({
    centerLonMin: -180,
    centerLonMax: 180,
    centerLonStep: 90,
    centerLatMin: -90,
    centerLatMax: 90,
    centerLatStep: 90,
    rollStep: 45,
    rollMode: 'quarter-turn',
    outputSize: 32,
  }), 12);

  const southPoleCases = enumerated.cases.filter((entry) => entry.centerLat === -90);
  const northPoleCases = enumerated.cases.filter((entry) => entry.centerLat === 90);
  assert.deepEqual([...new Set(southPoleCases.map((entry) => entry.centerLon))], [0]);
  assert.deepEqual([...new Set(northPoleCases.map((entry) => entry.centerLon))], [0]);
});

test('enumerateSweepCases keeps full roll span in full-turn mode', () => {
  const enumerated = enumerateSweepCases({
    centerLonMin: -180,
    centerLonMax: 180,
    centerLonStep: 90,
    centerLatMin: -90,
    centerLatMax: 90,
    centerLatStep: 90,
    rollStep: 45,
    rollMode: 'full-turn',
    outputSize: 32,
  });

  assert.equal(enumerated.rollValues.length, 8);
  assert.equal(enumerated.cases.length, 48);
});

test('buildSweepCaseFileName encodes signed angles', () => {
  const fileName = buildSweepCaseFileName(
    { index: 6, centerLon: -135, centerLat: 22.5, roll: 67.5 },
    240,
  );

  assert.equal(fileName, 'case_007_lon_m135_lat_22p5_roll_67p5.png');
});

test('renderSweepCase produces a valid raster for a solid-color source', () => {
  const pixels = new Uint8ClampedArray(4 * 2 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 10;
    pixels[index + 1] = 20;
    pixels[index + 2] = 30;
    pixels[index + 3] = 255;
  }

  const image = renderSweepCase(
    {
      width: 4,
      height: 2,
      pixels,
      background: [10, 20, 30, 255],
    },
    { index: 0, centerLon: 0, centerLat: 0, roll: 0 },
    { outputSize: 8 },
  );

  assert.equal(image.width, 8);
  assert.equal(image.height, 8);
  assert.equal(image.pixels.length, 8 * 8 * 4);

  for (let index = 0; index < image.pixels.length; index += 4) {
    assert.deepEqual(
      Array.from(image.pixels.slice(index, index + 4)),
      [10, 20, 30, 255],
    );
  }
});
