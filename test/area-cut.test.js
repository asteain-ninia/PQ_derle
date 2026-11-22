import test from 'node:test';
import assert from 'node:assert/strict';
import { geoRotation } from 'd3-geo';
import { geoPeirceQuincuncial } from 'd3-geo-projection';
import {
  createPeirceCutFrame,
  planarRegionSphereFraction,
  projectOrientedAreaRing,
  projectSphericalAreaRing,
} from '../src/transform.js';

// 塗りの輪を、正方形の縁 (球面上の 4 本の切れ目) で切ってから閉じる処理の試験。
// 輪は「極の座標」(正方形の中央が北極、四隅が南極) で作り、内側を右手に見る向きで渡す。

const SIDE = 360;
const base = geoPeirceQuincuncial().fitExtent([[0, 0], [SIDE, SIDE]], { type: 'Sphere' });
const projection = geoPeirceQuincuncial().scale(base.scale()).translate(base.translate()).preclip((stream) => stream);
const frame = createPeirceCutFrame(projection, SIDE);

function densify(points, step = 0.25) {
  const output = [];
  for (let index = 0; index < points.length; index += 1) {
    const [x0, y0] = points[index];
    const [next, y1] = points[(index + 1) % points.length];
    const x1 = x0 + ((((next - x0) % 360) + 540) % 360) - 180; // 経度は近い向きに進む
    const count = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let k = 0; k < count; k += 1) output.push([x0 + ((x1 - x0) * k) / count, y0 + ((y1 - y0) * k) / count]);
  }
  return output;
}

function polarRing(points) {
  return densify(points).map((point) => frame.polarToOriented(point));
}

// 極を囲まない輪は、極の座標の平面で測った割合をそのまま使える。
function project(points, sphereFraction = planarRegionSphereFraction(densify(points))) {
  return projectSphericalAreaRing(polarRing(points), projection, frame, SIDE, sphereFraction);
}

// 緯度 lat より極側の冠が球面に占める割合
function capFraction(lat) {
  return (1 - Math.sin(Math.abs(lat) * Math.PI / 180)) / 2;
}

function area(polygon) {
  let sum = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const [x1, y1] = polygon[index];
    const [x2, y2] = polygon[(index + 1) % polygon.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2);
}

function fraction({ polygons, holed }) {
  const filled = polygons.reduce((sum, polygon) => sum + area(polygon), 0)
    + (holed ? SIDE * SIDE - area(holed[1]) : 0);
  return filled / (SIDE * SIDE);
}

function touchesEdge(polygon) {
  return polygon.some(([x, y]) => Math.min(x, y, SIDE - x, SIDE - y) < 1e-6);
}

test('the four cuts sit on the eight half edges of the square', () => {
  assert.equal(frame.cutLongitudes.length, 4);
  const halfEdges = frame.halfEdges.flat().map((halfEdge) => halfEdge.index).sort((a, b) => a - b);
  assert.deepEqual(halfEdges, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('a small square straddling a cut becomes two small pieces on the edge', () => {
  for (const lon of frame.cutLongitudes) {
    // 経度を右・緯度を上に見て時計回り (内側が右)。
    const square = [[lon - 2, -28], [lon + 2, -28], [lon + 2, -32], [lon - 2, -32]];
    const result = project(square);
    assert.equal(result.holed, null);
    assert.equal(result.polygons.length, 2, `cut ${lon}`);
    assert.ok(result.polygons.every(touchesEdge));
    // 切れ目の両側は同じ辺の左右の半分に描く。端点が反対側の半分に飛ぶと、縁に沿う筋になる。
    const halves = result.polygons.map((polygon) => new Set(polygon
      .filter(([x, y]) => Math.min(x, y, SIDE - x, SIDE - y) < 1e-6)
      .map((point) => Math.floor(frame.perimeterPosition(point) / (SIDE / 2)))));
    assert.ok(halves.every((set) => set.size === 1), `cut ${lon}`);
    assert.notDeepEqual([...halves[0]], [...halves[1]]);
    assert.ok(fraction(result) < 0.01, `cut ${lon}: ${fraction(result)}`);
    // 自分と交わる輪への備え (逆向きと比べる処理) を通さなくても小さく閉じる。時計回りに閉じる向きそのものが正しい。
    assert.ok(fraction(projectOrientedAreaRing(polarRing(square), projection, frame, SIDE)) < 0.01);
  }
});

test('a thin sliver poking across a cut and back does not fill the square', () => {
  const lon = frame.cutLongitudes[1];
  // 行って戻るだけの細い輪 (自分と交わる)。向きの決まらない輪でも、正方形を一周して閉じてはならない。
  const sliver = [[lon - 6, -33], [lon + 0.05, -32.9], [lon - 6, -33.0001], [lon - 0.5, -32.95]];
  for (const ring of [sliver, [...sliver].reverse()]) {
    const result = project(ring);
    assert.ok(fraction(result) < 0.001, `${fraction(result)}`);
  }
});

test('a ring around the corners (the south pole) becomes four corner pieces', () => {
  // 南極のまわりを東へ回る輪は、右手 (南) に南極がある。
  const result = project(Array.from({ length: 72 }, (_, index) => [-180 + index * 5, -75]), capFraction(-75));
  assert.equal(result.polygons.length, 4);
  const corners = [[0, 0], [SIDE, 0], [SIDE, SIDE], [0, SIDE]];
  for (const corner of corners) {
    assert.ok(result.polygons.some((polygon) => polygon.some((point) => point[0] === corner[0] && point[1] === corner[1])), `corner ${corner}`);
  }
  assert.ok(fraction(result) < 0.2);
});

test('a ring around the centre is a disc, and the same ring reversed is the square with a hole', () => {
  const circle = Array.from({ length: 72 }, (_, index) => [180 - index * 5, 60]);
  const disc = project(circle, capFraction(60));
  assert.equal(disc.polygons.length, 1);
  assert.equal(disc.holed, null);
  assert.ok(fraction(disc) < 0.3);

  const holed = project([...circle].reverse(), 1 - capFraction(60));
  assert.equal(holed.polygons.length, 0);
  assert.ok(holed.holed);
  assert.ok(Math.abs(fraction(holed) + fraction(disc) - 1) < 0.01);
});

test('a ring whose edge runs along a cut and through a corner stays small', () => {
  // この向きでは元の地図の経度 180° の線が、切れ目 2 本 (南極で向かい合う) に重なる。箱の東の辺はその上を走り、
  // 南極 (正方形の隅) をちょうど通る。切れ目の上の頂点を寄せる側が並びの途中で食い違うと、輪が切れ目を
  // ジグザグにまたぎ、正方形の 6 割を塗っていた。
  const rotate = geoRotation([-180, -85, 0]);
  const box = [];
  for (let lon = 60; lon < 180; lon += 1) box.push([lon, 0]);
  for (let lat = 0; lat > -40; lat -= 1) box.push([180, lat]);
  for (let lon = 180; lon > 60; lon -= 1) box.push([lon, -40]);
  for (let lat = -40; lat < 0; lat += 1) box.push([60, lat]);
  const result = projectOrientedAreaRing(box.map((point) => rotate(point)), projection, frame, SIDE);
  const expected = planarRegionSphereFraction(box);
  assert.ok(Math.abs(fraction(result) - expected) < 0.05, `${fraction(result)} vs ${expected}`);
});
