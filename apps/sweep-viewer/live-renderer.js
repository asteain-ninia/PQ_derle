// ブラウザ側のライブ投影。
//
// - 元画像 (sweep が使った正距円筒ラスタの PNG) を読み込む
// - LUT (画素ごとの base.invert 単位ベクトル) は Worker 群で行を分けて作る
// - 描画は WebGL2 (LUT を float テクスチャにし、回転と双一次補間をシェーダーで行う) が既定。
//   WebGL2 が使えないときは CPU (Worker 群が sweep-live-render.js の renderLutFrame で行の帯を描く) に落とす。
//   CPU 経路は sweep の PNG と画素単位で一致し、WebGL 経路は float32 の丸めで ±1 程度ずれることがある。

import { estimateBackgroundColor } from '../../src/sweep-core.js';
import { buildRotationMatrix, orientationToRotate } from '../../src/sweep-live-render.js';
import { decodePngRgba } from './png-decode.js';

const MAX_WORKERS = 4;
const CPU_INTERACTIVE_BUDGET_MS = 14;

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

// sampleSourceRgba (src/sweep-core.js) と同じ規則で元画像を参照する。
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uLut;
uniform sampler2D uSource;
uniform mat3 uInverseRotation;
uniform int uSize;
uniform ivec2 uSourceSize;
uniform vec4 uBackground;
// 描く先の正方形 (GL 座標、左下原点) と、180° 回すかどうか。
// 本体は uTileOrigin = 0, uTileSize = uSize。3x3 preview では 1 マスずつ描く。
uniform vec2 uTileOrigin;
uniform float uTileSize;
uniform bool uRotate180;
out vec4 outColor;

const float DEGREES = 57.29577951308232;

void main() {
  vec2 local = gl_FragCoord.xy - uTileOrigin;
  // LUT は上の行から並んでいるので y を反転する
  ivec2 texel = ivec2(floor(vec2(local.x, uTileSize - local.y) * (float(uSize) / uTileSize)));
  texel = clamp(texel, ivec2(0), ivec2(uSize - 1));
  if (uRotate180) texel = ivec2(uSize - 1) - texel;
  vec4 base = texelFetch(uLut, texel, 0);
  if (base.w < 0.5) {
    outColor = uBackground;
    return;
  }

  vec3 rotated = uInverseRotation * base.xyz;
  float lon = atan(rotated.y, rotated.x) * DEGREES;
  float lat = asin(clamp(rotated.z, -1.0, 1.0)) * DEGREES;
  float lonFraction = fract((lon + 180.0) / 360.0);
  float latFraction = clamp((90.0 - lat) / 180.0, 0.0, 1.0);
  int width = uSourceSize.x;
  int height = uSourceSize.y;
  float sx = lonFraction * float(width);
  float sy = latFraction * float(max(height - 1, 1));
  float fx = floor(sx);
  int x0 = int(fx) % width;
  int x1 = (x0 + 1) % width;
  int y0 = clamp(int(floor(sy)), 0, height - 1);
  int y1 = min(y0 + 1, height - 1);
  float tx = sx - fx;
  float ty = sy - float(y0);

  vec4 c00 = texelFetch(uSource, ivec2(x0, y0), 0) * 255.0;
  vec4 c10 = texelFetch(uSource, ivec2(x1, y0), 0) * 255.0;
  vec4 c01 = texelFetch(uSource, ivec2(x0, y1), 0) * 255.0;
  vec4 c11 = texelFetch(uSource, ivec2(x1, y1), 0) * 255.0;
  vec4 top = c00 + (c10 - c00) * tx;
  vec4 bottom = c01 + (c11 - c01) * tx;
  outColor = floor(top + (bottom - top) * ty + 0.5) / 255.0;
}
`;

function now() {
  return performance.now();
}

async function loadSourceImage(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`元画像を読めませんでした (${response.status} ${response.statusText}): ${url}`);
  }
  const buffer = await response.arrayBuffer();
  // まずは値をそのまま読む (半透明の画素も sweep と同じ値になる)
  const decoded = await decodePngRgba(buffer).catch(() => null);
  if (decoded) {
    decoded.background = estimateBackgroundColor(decoded);
    decoded.exactDecode = true;
    return decoded;
  }

  // 対応しない PNG は canvas 経由で読む (半透明の画素は乗算済みアルファの丸めで少しずれる)
  const bitmap = await createImageBitmap(new Blob([buffer]), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(bitmap.width, bitmap.height)
    : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
  const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  context.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const image = {
    width: imageData.width,
    height: imageData.height,
    pixels: imageData.data,
  };
  image.background = estimateBackgroundColor(image);
  image.exactDecode = false;
  return image;
}

function splitRows(size, parts) {
  const bands = [];
  const base = Math.floor(size / parts);
  let extra = size % parts;
  let rowStart = 0;
  for (let index = 0; index < parts; index += 1) {
    const rows = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
    if (rows > 0) bands.push({ rowStart, rowEnd: rowStart + rows });
    rowStart += rows;
  }
  return bands;
}

class WorkerPool {
  constructor(count) {
    this.workers = [];
    this.pending = new Map();
    this.nextId = 1;
    for (let index = 0; index < count; index += 1) {
      const worker = new Worker(new URL('./live-worker.js', import.meta.url), { type: 'module' });
      worker.addEventListener('message', (event) => this.handleMessage(event.data));
      worker.addEventListener('error', (event) => this.handleWorkerError(event));
      this.workers.push(worker);
    }
  }

  handleMessage(message) {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.type === 'error') entry.reject(new Error(message.message));
    else entry.resolve(message);
  }

  handleWorkerError(event) {
    const error = new Error(event.message || 'Worker error');
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  request(workerIndex, message, transfer = []) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.workers[workerIndex].postMessage({ ...message, id }, transfer);
    });
  }

  get size() {
    return this.workers.length;
  }

  terminate() {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
  }
}

/** Worker から返った LUT の帯 (xyz, 球の外は NaN) を RGBA32F テクスチャ用 (w = 1 なら球の内側) にまとめる */
function lutTextureData(size, bands) {
  const data = new Float32Array(size * size * 4);
  for (const band of bands) {
    const { vectors, rowStart } = band;
    const count = vectors.length / 3;
    let target = rowStart * size * 4;
    for (let index = 0; index < count; index += 1) {
      const x = vectors[index * 3];
      if (x === x) {
        data[target] = x;
        data[target + 1] = vectors[index * 3 + 1];
        data[target + 2] = vectors[index * 3 + 2];
        data[target + 3] = 1;
      }
      target += 4;
    }
  }
  return data;
}

function compileShader(gl, type, sourceText) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, sourceText);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

function getGlRendererName(gl) {
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
}

// GPU が無く WebGL がソフトウェア実装で動いている環境 (SwiftShader / llvmpipe など)
const SOFTWARE_GL_PATTERN = /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i;

class GlBackend {
  constructor(canvas, source, { allowSoftware = true } = {}) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 を使えません');
    this.rendererName = getGlRendererName(gl);
    if (!allowSoftware && SOFTWARE_GL_PATTERN.test(this.rendererName)) {
      // ソフトウェア WebGL は CPU 上で 1 スレッドで動き、表示のたびに読み戻しも起きるので、Worker 並列の CPU 描画の方が速い
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      const error = new Error(`WebGL2 がソフトウェア実装です (${this.rendererName})`);
      error.isSoftwareGl = true;
      throw error;
    }
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (source.width > maxTextureSize || source.height > maxTextureSize) {
      throw new Error(`元画像 ${source.width}x${source.height} が MAX_TEXTURE_SIZE ${maxTextureSize} を超えています`);
    }

    this.kind = 'webgl2';
    this.gl = gl;
    this.canvas = canvas;
    this.source = source;
    this.lutSize = 0;

    const program = gl.createProgram();
    gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);

    this.uniforms = {
      lut: gl.getUniformLocation(program, 'uLut'),
      source: gl.getUniformLocation(program, 'uSource'),
      inverseRotation: gl.getUniformLocation(program, 'uInverseRotation'),
      size: gl.getUniformLocation(program, 'uSize'),
      tileOrigin: gl.getUniformLocation(program, 'uTileOrigin'),
      tileSize: gl.getUniformLocation(program, 'uTileSize'),
      rotate180: gl.getUniformLocation(program, 'uRotate180'),
      sourceSize: gl.getUniformLocation(program, 'uSourceSize'),
      background: gl.getUniformLocation(program, 'uBackground'),
    };

    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    this.sourceTexture = this.createTexture(1);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8, source.width, source.height, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(source.pixels.buffer, source.pixels.byteOffset, source.pixels.byteLength),
    );
    this.lutTexture = this.createTexture(0);

    gl.uniform1i(this.uniforms.lut, 0);
    gl.uniform1i(this.uniforms.source, 1);
    gl.uniform2i(this.uniforms.sourceSize, source.width, source.height);
    gl.uniform4f(
      this.uniforms.background,
      source.background[0] / 255,
      source.background[1] / 255,
      source.background[2] / 255,
      source.background[3] / 255,
    );
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`WebGL error ${error}`);
  }

  createTexture(unit) {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /** LUT をテクスチャにする。data は lutTextureData() の結果 */
  uploadLut(size, data) {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, size, 0, gl.RGBA, gl.FLOAT, data);
    gl.uniform1i(this.uniforms.size, size);
    this.lutSize = size;
  }

  setCanvasSize(width, height) {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  /** tiles: [{ x, y, size, rotate180 }] (x, y は左上原点のデバイス画素) */
  draw(orientation, tiles = null) {
    const { gl } = this;
    // buildRotationMatrix は行優先の順回転 M。uniformMatrix3fv は列優先で読むので、そのまま渡すと M^T (= 逆回転) になる。
    gl.uniformMatrix3fv(this.uniforms.inverseRotation, false, buildRotationMatrix(orientationToRotate(orientation)));
    const list = tiles || [{ x: 0, y: 0, size: this.canvas.width, rotate180: false }];
    for (const tile of list) {
      const originY = this.canvas.height - tile.y - tile.size;
      gl.viewport(tile.x, originY, tile.size, tile.size);
      gl.uniform2f(this.uniforms.tileOrigin, tile.x, originY);
      gl.uniform1f(this.uniforms.tileSize, tile.size);
      gl.uniform1i(this.uniforms.rotate180, tile.rotate180 ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  /** 検証用: いま描かれている画素を上の行から順に返す */
  readPixels() {
    const { gl } = this;
    const size = this.canvas.width;
    const flipped = new Uint8Array(size * size * 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
    const pixels = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      pixels.set(flipped.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
    }
    return { size, pixels };
  }

  /** 計測用: GPU の処理が終わるまで待つ */
  finish() {
    const pixel = new Uint8Array(4);
    this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixel);
  }
}

class CpuBackend {
  constructor(canvas) {
    this.kind = 'cpu';
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.scratch = document.createElement('canvas');
    this.scratchContext = this.scratch.getContext('2d');
  }

  present(size, imageData) {
    this.lastFrame = { size, pixels: imageData.data };
    if (this.canvas.width !== this.displaySize) {
      this.canvas.width = this.displaySize;
      this.canvas.height = this.displaySize;
    }
    if (size === this.displaySize) {
      this.context.putImageData(imageData, 0, 0);
      return;
    }
    // ドラッグ中の低解像度フレームは拡大して表示する
    if (this.scratch.width !== size) {
      this.scratch.width = size;
      this.scratch.height = size;
    }
    this.scratchContext.putImageData(imageData, 0, 0);
    this.context.imageSmoothingEnabled = true;
    // 元画像の透明・半透明の画素が前のフレームに重なって残らないよう、先に消す
    this.context.clearRect(0, 0, this.displaySize, this.displaySize);
    this.context.drawImage(this.scratch, 0, 0, this.displaySize, this.displaySize);
  }
}

async function initBackend(mode, source, pool) {
  if (mode !== 'cpu') {
    const canvas = document.createElement('canvas');
    try {
      return { canvas, backend: new GlBackend(canvas, source, { allowSoftware: mode === 'webgl' }) };
    } catch (error) {
      if (mode === 'webgl') throw error;
      const log = error.isSoftwareGl ? console.info : console.warn;
      log('[live] WebGL2 を使わず CPU 描画にします:', error.message);
    }
  }

  // getContext('webgl2') を試したキャンバスには 2D を取れないことがあるので作り直す
  const canvas = document.createElement('canvas');
  const backend = new CpuBackend(canvas);
  // CPU 描画では各 Worker が元画像の写しを持つ
  await Promise.all(pool.workers.map((_, index) => pool.request(index, {
    type: 'source',
    width: source.width,
    height: source.height,
    pixels: source.pixels,
    background: source.background,
  })));
  return { canvas, backend };
}

/**
 * ライブ描画器を作る。
 *   sourceUrl: 元画像 PNG の URL
 *   mode: 'auto' | 'webgl' | 'cpu'
 * 返り値の canvas を画面に置き、setDisplaySize → render(orientation, { interactive }) で使う。
 */
export async function createLiveRenderer({ sourceUrl, mode = 'auto', onFrame = () => {}, debugTiming = false }) {
  const timings = { sourceLoadMs: 0, lutBuilds: [], frames: [] };
  let startedAt = now();
  const source = await loadSourceImage(sourceUrl);
  timings.sourceLoadMs = now() - startedAt;

  const workerCount = Math.max(1, Math.min(MAX_WORKERS, (navigator.hardwareConcurrency || 2) - 1));
  const pool = new WorkerPool(workerCount);

  let canvas;
  let backend;
  try {
    ({ canvas, backend } = await initBackend(mode, source, pool));
  } catch (error) {
    pool.terminate();
    throw error;
  }
  canvas.className = 'sqv-motion-canvas';

  // 3x3 tiling preview。WebGL のときは preview 用のキャンバスにも別の WebGL コンテキストを作って直接描く
  // (本体の WebGL キャンバスを 2D キャンバスへ drawImage すると、GPU からの読み戻しが毎フレーム起きるため)。
  const preview = {
    canvas: null,
    backend: null,
    context2d: null,
    tiles: [], // [{ column, row, rotate180 }]
    columns: 0,
    rows: 0,
    cellSize: 0,
  };

  const state = {
    displaySize: 0,
    lutData: null, // WebGL: 直近の LUT テクスチャデータ (preview にも渡す)
    lutSizes: new Set(), // CPU: Worker に残している LUT の辺長
    lutJob: null,
    renderBusy: false,
    pendingRender: null,
    waiters: [],
    lastFullFrameMs: null,
    lastOrientation: null,
    destroyed: false,
  };

  async function buildLut(size) {
    const bands = splitRows(size, pool.size);
    const buildStartedAt = now();
    const replies = await Promise.all(bands.map((band, index) => pool.request(index, {
      type: 'build-lut',
      size,
      rowStart: band.rowStart,
      rowEnd: band.rowEnd,
      keep: backend.kind === 'cpu',
      returnVectors: backend.kind === 'webgl2',
    })));
    timings.lutBuilds.push({ size, workers: bands.length, durationMs: now() - buildStartedAt });
    return replies;
  }

  // CPU の描画解像度: 表示サイズそのもの (上限 640)。ドラッグ中は、全解像度の 1 枚が
  // CPU_INTERACTIVE_BUDGET_MS に収まっていればそのまま、収まらなければ半分の解像度で描く。
  function cpuSizes(displaySize) {
    const full = Math.min(displaySize, 640);
    const half = Math.max(64, Math.round(full / 2));
    const fullIsFast = state.lastFullFrameMs !== null && state.lastFullFrameMs <= CPU_INTERACTIVE_BUDGET_MS;
    return { full, half, interactive: fullIsFast ? full : half };
  }

  async function ensureLut(displaySize) {
    if (backend.kind === 'webgl2') {
      if (backend.lutSize === displaySize) return;
      const replies = await buildLut(displaySize);
      if (state.displaySize !== displaySize) return; // 途中で大きさが変わった
      const data = lutTextureData(displaySize, replies);
      state.lutData = { size: displaySize, data };
      backend.uploadLut(displaySize, data);
      backend.setCanvasSize(displaySize, displaySize);
      preview.backend?.uploadLut(displaySize, data);
      return;
    }

    const { full, half } = cpuSizes(displaySize);
    state.lastFullFrameMs = null;
    for (const size of [half, full]) {
      if (!state.lutSizes.has(size)) {
        await buildLut(size);
        state.lutSizes.add(size);
      }
    }
    // 使わなくなった大きさの LUT は Worker から捨てる
    if (state.displaySize !== displaySize) return;
    for (const size of [...state.lutSizes]) {
      if (size === half || size === full) continue;
      state.lutSizes.delete(size);
      splitRows(size, pool.size).forEach((band, index) => {
        pool.workers[index].postMessage({ type: 'drop-lut', size, rowStart: band.rowStart, rowEnd: band.rowEnd });
      });
    }
  }

  async function renderCpu(orientation, interactive) {
    const { full, interactive: small } = cpuSizes(state.displaySize);
    const size = interactive ? small : full;
    if (!state.lutSizes.has(size)) return;
    const frameStartedAt = now();
    const bands = splitRows(size, pool.size);
    const replies = await Promise.all(bands.map((band, index) => pool.request(index, {
      type: 'render',
      size,
      rowStart: band.rowStart,
      rowEnd: band.rowEnd,
      orientation,
    })));
    const imageData = new ImageData(size, size);
    for (const reply of replies) {
      imageData.data.set(reply.pixels, reply.rowStart * size * 4);
    }
    backend.displaySize = full;
    backend.present(size, imageData);
    const durationMs = now() - frameStartedAt;
    if (size === full) state.lastFullFrameMs = durationMs;
    const info = { backend: 'cpu', size, interactive, durationMs, orientation };
    info.previewMs = drawPreview(orientation);
    onFrame(info);
    timings.frames.push(info);
  }

  function renderGl(orientation, interactive) {
    if (!backend.lutSize) return;
    const frameStartedAt = now();
    backend.draw(orientation);
    if (debugTiming) backend.finish();
    const durationMs = now() - frameStartedAt;
    const info = { backend: 'webgl2', size: backend.lutSize, interactive, durationMs, orientation };
    info.previewMs = drawPreview(orientation);
    onFrame(info);
    timings.frames.push(info);
  }

  function previewTileRects() {
    return preview.tiles.map((tile) => ({
      x: tile.column * preview.cellSize,
      y: tile.row * preview.cellSize,
      size: preview.cellSize,
      rotate180: tile.rotate180,
    }));
  }

  function drawPreview(orientation) {
    if (!preview.canvas || !preview.cellSize) return 0;
    const startedAt = now();
    if (preview.backend) {
      if (preview.backend.lutSize) preview.backend.draw(orientation, previewTileRects());
    } else {
      const context = preview.context2d;
      context.imageSmoothingEnabled = true;
      // 透明な画素に前の向きの絵が残らないよう、毎回消してから描く
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, preview.canvas.width, preview.canvas.height);
      for (const rect of previewTileRects()) {
        context.setTransform(1, 0, 0, 1, rect.x, rect.y);
        if (rect.rotate180) {
          context.translate(rect.size, rect.size);
          context.rotate(Math.PI);
        }
        context.drawImage(canvas, 0, 0, rect.size, rect.size);
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
    }
    return now() - startedAt;
  }

  async function pump() {
    if (state.renderBusy || state.destroyed) return;
    state.renderBusy = true;
    try {
      while (state.pendingRender && !state.destroyed) {
        const { orientation, interactive } = state.pendingRender;
        const waiters = state.waiters;
        state.pendingRender = null;
        state.waiters = [];
        try {
          if (backend.kind === 'webgl2') {
            renderGl(orientation, interactive);
          } else {
            await renderCpu(orientation, interactive);
          }
          for (const waiter of waiters) waiter.resolve();
        } catch (error) {
          for (const waiter of waiters) waiter.reject(error);
        }
      }
    } finally {
      state.renderBusy = false;
    }
  }

  const renderer = {
    canvas,
    get backend() {
      return backend.kind;
    },
    get displaySize() {
      return state.displaySize;
    },
    /** 実際に描いている解像度 (CPU は上限があるので表示サイズより小さいことがある) */
    get renderSize() {
      return backend.kind === 'webgl2' ? state.displaySize : cpuSizes(state.displaySize).full;
    },
    source,
    workerCount: pool.size,
    timings,

    /** 描画解像度 (デバイス画素) を決める。LUT がなければ Worker で作る。 */
    async setDisplaySize(displaySize) {
      const size = Math.max(16, Math.round(displaySize));
      if (size === state.displaySize) return state.lutJob;
      state.displaySize = size;
      const job = ensureLut(size).then(() => {
        if (state.lastOrientation && state.displaySize === size) {
          renderer.render(state.lastOrientation, { interactive: false });
        }
      });
      state.lutJob = job;
      return job;
    },

    /**
     * 最新の向きだけを描く (CPU 描画が追いつかないときは途中の向きを捨てる)。
     * 返す Promise は、この向き (または後から来た向き) が描かれたときに解決する。
     */
    render(orientation, { interactive = false } = {}) {
      state.lastOrientation = orientation;
      state.pendingRender = { orientation, interactive };
      const done = new Promise((resolve, reject) => {
        state.waiters.push({ resolve, reject });
      });
      pump().catch((error) => console.error('[live] render failed:', error));
      return done;
    },

    /**
     * 3x3 tiling preview を描くキャンバスを渡す。tiles: [{ column, row, rotate180 }]
     * 以後、本体を描くたびに preview も描く。
     */
    attachPreview(previewCanvas, tiles) {
      preview.canvas = previewCanvas;
      preview.tiles = tiles;
      preview.columns = Math.max(...tiles.map((tile) => tile.column)) + 1;
      preview.rows = Math.max(...tiles.map((tile) => tile.row)) + 1;
      if (backend.kind === 'webgl2') {
        try {
          preview.backend = new GlBackend(previewCanvas, source);
          if (state.lutData) preview.backend.uploadLut(state.lutData.size, state.lutData.data);
        } catch (error) {
          console.warn('[live] preview 用の WebGL2 を作れないので 2D で描きます:', error.message);
          preview.backend = null;
        }
      }
      if (!preview.backend) preview.context2d = previewCanvas.getContext('2d');
      return preview.backend ? 'webgl2' : '2d';
    },

    /** preview の 1 マスの大きさ (デバイス画素) */
    setPreviewCellSize(cellSize) {
      preview.cellSize = Math.max(1, Math.round(cellSize));
      const width = preview.cellSize * preview.columns;
      const height = preview.cellSize * preview.rows;
      if (preview.backend) {
        preview.backend.setCanvasSize(width, height);
      } else if (preview.canvas) {
        if (preview.canvas.width !== width) preview.canvas.width = width;
        if (preview.canvas.height !== height) preview.canvas.height = height;
      }
      if (state.lastOrientation) drawPreview(state.lastOrientation);
    },

    /** 検証用: 直近のフレームの画素 (上の行から、RGBA) */
    readPixels() {
      return backend.kind === 'webgl2' ? backend.readPixels() : backend.lastFrame;
    },

    destroy() {
      state.destroyed = true;
      pool.terminate();
    },
  };

  return renderer;
}
