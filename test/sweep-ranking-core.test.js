import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLandMaskFromRgba,
  buildPeirceDistortionField,
  scoreLandMaskAgainstField,
} from '../src/sweep-ranking-core.js';

function fillRect(mask, size, x0, y0, width, height) {
  for (let y = y0; y < y0 + height; y += 1) {
    for (let x = x0; x < x0 + width; x += 1) {
      mask[(y * size) + x] = 1;
    }
  }
}

test('buildPeirceDistortionField concentrates hotspots near edge singularities', () => {
  const field = buildPeirceDistortionField(48);
  const centerIndex = (24 * 48) + 24;
  const edgeMidIndex = 24;

  assert.equal(field.outputSize, 48);
  assert.ok(field.hotspotThreshold > 0);
  assert.ok(field.clipMax > 0);
  assert.ok(field.distortion[edgeMidIndex] > field.distortion[centerIndex]);
  assert.equal(field.hotspotMask[edgeMidIndex], 1);
});

test('buildLandMaskFromRgba separates a dominant ocean color from land', () => {
  const width = 4;
  const height = 4;
  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    rgba[offset] = 85;
    rgba[offset + 1] = 111;
    rgba[offset + 2] = 181;
    rgba[offset + 3] = 255;
  }

  for (const index of [5, 6, 9, 10]) {
    const offset = index * 4;
    rgba[offset] = 199;
    rgba[offset + 1] = 219;
    rgba[offset + 2] = 122;
  }

  const analysis = buildLandMaskFromRgba(rgba, width, height);

  assert.deepEqual(analysis.oceanColor.map((value) => Math.round(value)), [85, 111, 181]);
  assert.equal(analysis.landPixelCount, 4);
  assert.equal(analysis.landMask[5], 1);
  assert.equal(analysis.landMask[0], 0);
});

test('scoreLandMaskAgainstField ranks center land lower than hotspot land', () => {
  const size = 64;
  const field = buildPeirceDistortionField(size);
  const centerMask = new Uint8Array(size * size);
  const hotspotMask = new Uint8Array(size * size);

  fillRect(centerMask, size, 26, 26, 12, 12);
  fillRect(hotspotMask, size, 26, 0, 12, 8);

  const centerScore = scoreLandMaskAgainstField(centerMask, field);
  const hotspotScore = scoreLandMaskAgainstField(hotspotMask, field);

  assert.ok(centerScore.geoMeanDistortion < hotspotScore.geoMeanDistortion);
  assert.ok(centerScore.visualMeanDistortion < hotspotScore.visualMeanDistortion);
  assert.ok(centerScore.p95Distortion < hotspotScore.p95Distortion);
  assert.ok(centerScore.hotspotCoverage < hotspotScore.hotspotCoverage);
});
