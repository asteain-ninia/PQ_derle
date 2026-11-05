import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { geoPeirceQuincuncial } from 'd3-geo-projection';
import { geoRotation } from 'd3-geo';
import { transformSvgString } from '../src/transform.js';
import { orientationToRotate } from '../src/sweep-live-render.js';
import { sweepToTransformOrientation, transformToSweepOrientation } from '../src/orientation.js';

const SIDE = 1000;

// sweep / ビューアの写像（src/sweep-live-render.js と同じ: 既定の回転を打ち消した投影 + 向きの回転）
const sweepProjection = geoPeirceQuincuncial().rotate([0, 0, 0]).fitExtent([[0, 0], [SIDE, SIDE]], { type: 'Sphere' });
function sweepPixel(orientation, lonLat) {
  return sweepProjection(geoRotation(orientationToRotate(orientation))(lonLat));
}

// 最終 SVG の写像（src/transform.js と同じ: 既定の回転を残した投影 + 向きの回転）
const transformProjection = geoPeirceQuincuncial().fitExtent([[0, 0], [SIDE, SIDE]], { type: 'Sphere' });
function transformPixel(orientation, lonLat) {
  return transformProjection(geoRotation([-orientation.centerLon, -orientation.centerLat, orientation.roll])(lonLat));
}

// 再現できる疑似乱数（線形合同法）
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function interior([x, y], margin = 20) {
  return x > margin && x < SIDE - margin && y > margin && y < SIDE - margin;
}

test('the same numbers give different maps in sweep and transform (why the conversion exists)', () => {
  const orientation = { centerLon: -143, centerLat: 0, roll: 0 };
  const sweep = sweepPixel(orientation, [-143, 0]);
  const transform = transformPixel(orientation, [-143, 0]);
  assert.ok(Math.hypot(sweep[0] - SIDE / 2, sweep[1] - SIDE / 2) < 1e-6, 'sweep puts the chosen point in the middle');
  assert.ok(Math.hypot(transform[0] - sweep[0], transform[1] - sweep[1]) > 100, 'transform does not');
});

test('sweepToTransformOrientation gives the same map as sweep, point for point', () => {
  const next = random(20261105);
  let compared = 0;
  for (let t = 0; t < 200; t += 1) {
    const sweep = { centerLon: next() * 360 - 180, centerLat: next() * 170 - 85, roll: next() * 360 - 180 };
    const transform = sweepToTransformOrientation(sweep);
    for (let k = 0; k < 40; k += 1) {
      const lonLat = [next() * 360 - 180, next() * 178 - 89];
      const a = sweepPixel(sweep, lonLat);
      if (!interior(a)) continue; // 切れ目の上の点は、どちらの辺に描くかが決まらない
      const b = transformPixel(transform, lonLat);
      assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6, `${JSON.stringify(sweep)} ${lonLat}: ${a} != ${b}`);
      compared += 1;
    }
  }
  assert.ok(compared > 5000);
});

test('transformToSweepOrientation is the inverse', () => {
  const next = random(7);
  for (let t = 0; t < 200; t += 1) {
    const transform = { centerLon: next() * 360 - 180, centerLat: next() * 170 - 85, roll: next() * 360 - 180 };
    const sweep = transformToSweepOrientation(transform);
    for (let k = 0; k < 20; k += 1) {
      const lonLat = [next() * 360 - 180, next() * 178 - 89];
      const a = transformPixel(transform, lonLat);
      if (!interior(a)) continue;
      const b = sweepPixel(sweep, lonLat);
      assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6);
    }
    const back = sweepToTransformOrientation(sweep);
    const lonLat = [12, 34];
    const a = transformPixel(transform, lonLat);
    const b = transformPixel(back, lonLat);
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6);
  }
});

test('the sweep default (-143, 0, 0) is (127, -45, 90) in transform', () => {
  assert.deepEqual(sweepToTransformOrientation({ centerLon: -143, centerLat: 0, roll: 0 }), { centerLon: 127, centerLat: -45, roll: 90 });
});

test('a final SVG made with the converted values puts labels where the sweep does', async () => {
  const sweep = { centerLon: 45, centerLat: -30, roll: 45 };
  const places = [[45, -30], [60, -20], [20, -45], [80, 0], [10, -10]];
  const texts = places
    .map(([lon, lat], i) => `<text id="p${i}" x="${lon + 180}" y="${90 - lat}">p${i}</text>`)
    .join('\n');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="360" height="180" viewBox="0 0 360 180">
  <rect id="frame" x="0" y="0" width="360" height="180" fill="#ddeeff" />
  ${texts}
</svg>`;
  const result = await transformSvgString(svg, { ...sweepToTransformOrientation(sweep), outputSide: SIDE }, { DOMParser, XMLSerializer });
  const document = new DOMParser().parseFromString(result.svgText, 'image/svg+xml');
  const nodes = Array.from(document.getElementsByTagName('text'));
  places.forEach((lonLat, i) => {
    const node = nodes.find((n) => n.getAttribute('id') === `p${i}`);
    assert.ok(node, `p${i} is in the output`);
    const match = /translate\(([-+\d.eE]+)\s+([-+\d.eE]+)\)/.exec(node.getAttribute('transform') || '');
    assert.ok(match);
    const expected = sweepPixel(sweep, lonLat);
    assert.ok(interior(expected));
    assert.ok(Math.hypot(Number(match[1]) - expected[0], Number(match[2]) - expected[1]) < 0.05, `p${i}: ${match[1]},${match[2]} != ${expected}`);
  });
});

test('non-numbers are refused', () => {
  assert.throws(() => sweepToTransformOrientation({ centerLon: 1, centerLat: Number.NaN, roll: 0 }));
  assert.throws(() => transformToSweepOrientation({ centerLon: 1, centerLat: 2 }));
});
