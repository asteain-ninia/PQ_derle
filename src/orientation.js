import { geoRotation } from 'd3-geo';
import { geoPeirceQuincuncial } from 'd3-geo-projection';

// sweep（総当たり・ビューア・ランキング）と最終 SVG（transform）は、同じ centerLon / centerLat / roll でも
// 別の向きになる。
//
// - sweep:     投影の既定の回転を rotate([0, 0, 0]) で打ち消し、geoRotation([-lon, -lat, roll]) だけをかける
//              （src/sweep-live-render.js）。指定した (lon, lat) が正方形の中央に来る。
// - transform: 投影の既定の回転 [-90, -90, 45] を残したまま、その手前に geoRotation([-lon, -lat, roll]) を
//              かける（src/transform.js の buildProjection / orientLonLat）。
//
// 最終 SVG の向きの決め方は変えず、sweep で選んだ向きを transform の値へ読み替える関数をここに置く。
// sweep の写像 P0∘Rs と transform の写像 P0∘D∘Rt が一致するのは Rt = D⁻¹∘Rs のときなので、
// D⁻¹∘Rs を geoRotation([-lon, -lat, roll]) の形に分解する。

const DEFAULT_ROTATION = geoPeirceQuincuncial().rotate();
const defaultRotation = geoRotation(DEFAULT_ROTATION);

const RAD = Math.PI / 180;

function toVector([lon, lat]) {
  const l = lon * RAD;
  const p = lat * RAD;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
}

function normalizeDegrees(value) {
  let v = ((value + 180) % 360 + 360) % 360 - 180;
  if (v === -180) v = 180;
  return v;
}

function cleanNumber(value) {
  const rounded = Math.round(value * 1e9) / 1e9;
  return Object.is(rounded, -0) ? 0 : rounded;
}

// 回転 rotate（球面上の点 → 点）を geoRotation([-lon, -lat, roll]) の形に分解する。
// geoRotation([λ, φ, γ]) は (-λ, -φ) を (0, 0) へ移し、そのあと (0, 0) を通る軸のまわりに γ だけ回す。
function decomposeRotation(rotate, invert) {
  const [centerLon, centerLat] = invert([0, 0]);
  const base = geoRotation([-centerLon, -centerLat, 0]);
  // base で (0, 45) に来る点が、rotate ではどこへ行くか。その差が roll（y-z 平面での角度の差）になる。
  const probe = base.invert([0, 45]);
  const before = toVector([0, 45]);
  const after = toVector(rotate(probe));
  const roll = (Math.atan2(after[2], after[1]) - Math.atan2(before[2], before[1])) / RAD;
  return {
    centerLon: cleanNumber(normalizeDegrees(centerLon)),
    centerLat: cleanNumber(centerLat),
    roll: cleanNumber(normalizeDegrees(roll)),
  };
}

function requireOrientation(orientation) {
  for (const key of ['centerLon', 'centerLat', 'roll']) {
    if (!Number.isFinite(orientation?.[key])) {
      throw new Error(`${key} must be a finite number.`);
    }
  }
}

/** sweep で選んだ向きを、最終 SVG（transform）で同じ地図になる向きへ読み替える。 */
export function sweepToTransformOrientation(orientation) {
  requireOrientation(orientation);
  const sweep = geoRotation([-orientation.centerLon, -orientation.centerLat, orientation.roll]);
  return decomposeRotation(
    (point) => defaultRotation.invert(sweep(point)),
    (point) => sweep.invert(defaultRotation(point)),
  );
}

/** 最終 SVG（transform）の向きを、sweep・ビューアで同じ地図になる向きへ読み替える。 */
export function transformToSweepOrientation(orientation) {
  requireOrientation(orientation);
  const transform = geoRotation([-orientation.centerLon, -orientation.centerLat, orientation.roll]);
  return decomposeRotation(
    (point) => defaultRotation(transform(point)),
    (point) => transform.invert(defaultRotation.invert(point)),
  );
}

export { DEFAULT_ROTATION as PEIRCE_DEFAULT_ROTATION };

/** sweep の向きを、最終 SVG（npm run transform）にそのまま渡せる引数の文字列にする。 */
export function formatTransformArguments(sweepOrientation, digits = 2) {
  const { centerLon, centerLat, roll } = sweepToTransformOrientation(sweepOrientation);
  const format = (value) => {
    const text = value.toFixed(digits).replace(/\.?0+$/, '');
    return text === '-0' ? '0' : text;
  };
  return `--center-lon=${format(centerLon)} --center-lat=${format(centerLat)} --roll=${format(roll)}`;
}
