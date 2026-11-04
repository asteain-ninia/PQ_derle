// Peirce quincuncial のライブ描画用の純粋な計算部分。Node (sweep) とブラウザ (viewer / Worker) の両方から使う。
//
// 考え方:
//   d3 の projection.rotate(r).invert(p) は geoRotation(r).invert(base.invert(p)) と等しい
//   (base は回転 [0, 0, 0] の同じ投影)。回転に依存しない base.invert(p) を画素ごとの単位ベクトルとして
//   一度だけ表 (LUT) にしておけば、向きを変えるたびに必要なのは 3x3 回転と元画像の参照だけになる。
//
// 注意: geoPeirceQuincuncial は既定で rotate([-90, -90, 45]) を持っているので、base は
// 明示的に rotate([0, 0, 0]) にする必要がある。

import { geoPeirceQuincuncial } from 'd3-geo-projection';

const RADIANS = Math.PI / 180;
const DEGREES = 180 / Math.PI;

function clampUnit(value) {
  return value > 1 ? 1 : value < -1 ? -1 : value;
}

/**
 * d3 の geoRotation([lambda, phi, gamma]) (度) の順方向を 3x3 行列 (行優先) で返す。
 * d3 は「経度方向に lambda 回す → phi / gamma を回す」の合成なので M = PG · Rz(lambda)。
 *   PG の行: [cosφ, 0, -sinφ], [-sinφ sinγ, cosγ, -cosφ sinγ], [sinφ cosγ, sinγ, cosφ cosγ]
 * 逆回転 (projection.invert で使う側) はこの転置になる。
 */
export function buildRotationMatrix(rotate) {
  const lambda = (rotate[0] || 0) * RADIANS;
  const phi = (rotate[1] || 0) * RADIANS;
  const gamma = (rotate.length > 2 ? rotate[2] || 0 : 0) * RADIANS;
  const cl = Math.cos(lambda);
  const sl = Math.sin(lambda);
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  const cg = Math.cos(gamma);
  const sg = Math.sin(gamma);

  // PG
  const a00 = cp; const a01 = 0; const a02 = -sp;
  const a10 = -sp * sg; const a11 = cg; const a12 = -cp * sg;
  const a20 = sp * cg; const a21 = sg; const a22 = cp * cg;

  // PG · Rz(lambda), Rz = [[cl, -sl, 0], [sl, cl, 0], [0, 0, 1]]
  return [
    a00 * cl + a01 * sl, -a00 * sl + a01 * cl, a02,
    a10 * cl + a11 * sl, -a10 * sl + a11 * cl, a12,
    a20 * cl + a21 * sl, -a20 * sl + a21 * cl, a22,
  ];
}

/** sweep / viewer の向き (centerLon, centerLat, roll) を d3 の rotate 値に直す。 */
export function orientationToRotate(orientation) {
  return [-orientation.centerLon, -orientation.centerLat, orientation.roll];
}

/**
 * 画素 (x + 0.5, y + 0.5) ごとに base.invert の結果を単位ベクトルで持つ表を作る。
 * 球の外 (invert が null) は NaN。rowStart / rowEnd で一部の行だけ作ることもできる (Worker で分割・進捗表示用)。
 */
export function buildProjectionLut(size, { rowStart = 0, rowEnd = size, ArrayType = Float64Array } = {}) {
  const projection = geoPeirceQuincuncial()
    .fitExtent([[0, 0], [size, size]], { type: 'Sphere' })
    .rotate([0, 0, 0]);
  const rows = rowEnd - rowStart;
  const vectors = new ArrayType(rows * size * 3);

  let offset = 0;
  for (let y = rowStart; y < rowEnd; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const lonLat = projection.invert([x + 0.5, y + 0.5]);
      if (!lonLat) {
        vectors[offset] = NaN;
        vectors[offset + 1] = NaN;
        vectors[offset + 2] = NaN;
      } else {
        const lon = lonLat[0] * RADIANS;
        const lat = lonLat[1] * RADIANS;
        const cosLat = Math.cos(lat);
        vectors[offset] = Math.cos(lon) * cosLat;
        vectors[offset + 1] = Math.sin(lon) * cosLat;
        vectors[offset + 2] = Math.sin(lat);
      }
      offset += 3;
    }
  }

  return { size, rowStart, rowEnd, vectors };
}

/** 行ごとに作った LUT 片をひとつにまとめる。 */
export function joinProjectionLut(size, parts, ArrayType = Float64Array) {
  const vectors = new ArrayType(size * size * 3);
  for (const part of parts) {
    vectors.set(part.vectors, part.rowStart * size * 3);
  }
  return { size, rowStart: 0, rowEnd: size, vectors };
}

/**
 * LUT と向きから 1 枚描く。sampleSourceRgba (sweep-core) と同じ規則で元画像を双一次補間する:
 *   x = ((lon + 180) / 360 の小数部) * width (横は巻き戻し)、y = (90 - lat) / 180 * (height - 1) (縦は端で止める)
 * 球の外は background。
 *
 * source: { width, height, pixels: RGBA 配列 }
 * target: 書き込み先 (Uint8ClampedArray, size * size * 4)。省略時は新しく作る。
 */
export function renderLutFrame(lut, source, orientation, background, target) {
  const { size, vectors } = lut;
  const rowStart = lut.rowStart || 0;
  const rowEnd = lut.rowEnd ?? size;
  const output = target || new Uint8ClampedArray(size * (rowEnd - rowStart) * 4);
  const m = buildRotationMatrix(orientationToRotate(orientation));
  // 逆回転 = 転置
  const r00 = m[0]; const r01 = m[3]; const r02 = m[6];
  const r10 = m[1]; const r11 = m[4]; const r12 = m[7];
  const r20 = m[2]; const r21 = m[5]; const r22 = m[8];
  const srcW = source.width;
  const srcH = source.height;
  const src = source.pixels;
  const yScale = Math.max(srcH - 1, 1);
  const srcW2 = srcW * 2;
  const bg0 = background[0]; const bg1 = background[1]; const bg2 = background[2]; const bg3 = background[3];
  const rows = rowEnd - rowStart;

  for (let row = 0; row < rows; row += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (row * size + x) * 3;
      const vx = vectors[i];
      let c0 = bg0; let c1 = bg1; let c2 = bg2; let c3 = bg3;

      if (vx === vx) {
        const vy = vectors[i + 1];
        const vz = vectors[i + 2];
        const px = r00 * vx + r01 * vy + r02 * vz;
        const py = r10 * vx + r11 * vy + r12 * vz;
        const pz = r20 * vx + r21 * vy + r22 * vz;
        let lon = Math.atan2(py, px) * DEGREES;
        const lat = Math.asin(clampUnit(pz)) * DEGREES;

        // --- sampleSourceRgba と同じ値になる手順 (剰余演算は値域が分かっているので同値な加減算に置き換え) ---
        // normalizeLongitude: atan2 の結果は [-180, 180] なので -180 だけ 180 に寄せればよい
        if (lon <= -180) lon += 360;
        // ((((lon + 180) / 360) % 1) + 1) % 1
        let lonFraction = (lon + 180) / 360;
        if (lonFraction >= 1) lonFraction -= 1;
        lonFraction = (lonFraction + 1) - 1;
        let latFraction = (90 - lat) / 180;
        latFraction = latFraction < 0 ? 0 : latFraction > 1 ? 1 : latFraction;
        // ((x % w) + w) % w  (x は [0, w))
        const shifted = lonFraction * srcW + srcW;
        const wrappedX = shifted >= srcW2 ? shifted - srcW2 : shifted - srcW;
        const sy = latFraction * yScale;
        const fx = Math.floor(wrappedX);
        const x0 = fx === srcW ? 0 : fx;
        const x1 = x0 + 1 === srcW ? 0 : x0 + 1;
        let y0 = Math.floor(sy);
        y0 = y0 < 0 ? 0 : y0 > srcH - 1 ? srcH - 1 : y0;
        const y1 = y0 + 1 > srcH - 1 ? srcH - 1 : y0 + 1;
        const tx = wrappedX - fx;
        const ty = sy - y0;
        const o00 = (y0 * srcW + x0) * 4;
        const o10 = (y0 * srcW + x1) * 4;
        const o01 = (y1 * srcW + x0) * 4;
        const o11 = (y1 * srcW + x1) * 4;

        let top = src[o00] + (src[o10] - src[o00]) * tx;
        let bottom = src[o01] + (src[o11] - src[o01]) * tx;
        c0 = Math.round(top + (bottom - top) * ty);
        top = src[o00 + 1] + (src[o10 + 1] - src[o00 + 1]) * tx;
        bottom = src[o01 + 1] + (src[o11 + 1] - src[o01 + 1]) * tx;
        c1 = Math.round(top + (bottom - top) * ty);
        top = src[o00 + 2] + (src[o10 + 2] - src[o00 + 2]) * tx;
        bottom = src[o01 + 2] + (src[o11 + 2] - src[o01 + 2]) * tx;
        c2 = Math.round(top + (bottom - top) * ty);
        top = src[o00 + 3] + (src[o10 + 3] - src[o00 + 3]) * tx;
        bottom = src[o01 + 3] + (src[o11 + 3] - src[o01 + 3]) * tx;
        c3 = Math.round(top + (bottom - top) * ty);
      }

      const o = (row * size + x) * 4;
      output[o] = c0;
      output[o + 1] = c1;
      output[o + 2] = c2;
      output[o + 3] = c3;
    }
  }

  return output;
}
