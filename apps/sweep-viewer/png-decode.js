// sweep が書く PNG (8 bit RGBA / RGB、インターレースなし) をそのままの値で読む小さなデコーダ。
//
// canvas の drawImage → getImageData を通すと、半透明の画素は内部で乗算済みアルファにされて値が 1〜2 ずれる。
// 元画像 (source-equirect.png) には端に半透明の列があり、そこがずれると sweep の PNG と一致しなくなるので、
// ここでは DecompressionStream で IDAT を展開し、フィルタを戻して RGBA を得る。
// 対応しない形式のときは null を返し、呼び出し側で canvas 経由に切り替える。

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function chunkType(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** @returns {Promise<{ width: number, height: number, pixels: Uint8ClampedArray } | null>} */
export async function decodePngRgba(arrayBuffer) {
  if (typeof DecompressionStream !== 'function') return null;
  const bytes = new Uint8Array(arrayBuffer);
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return null;
  }

  let offset = 8;
  let header = null;
  const idat = [];
  let idatLength = 0;
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = chunkType(bytes, offset + 4);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: readUint32(data, 0),
        height: readUint32(data, 4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
      idatLength += data.length;
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (!header || header.bitDepth !== 8 || header.interlace !== 0) return null;
  const channels = header.colorType === 6 ? 4 : header.colorType === 2 ? 3 : 0;
  if (!channels) return null;

  const compressed = new Uint8Array(idatLength);
  let position = 0;
  for (const part of idat) {
    compressed.set(part, position);
    position += part.length;
  }
  const raw = await inflate(compressed);

  const { width, height } = header;
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const current = new Uint8Array(stride);
  const previous = new Uint8Array(stride);
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1);
    const filter = raw[rowOffset];
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rowOffset + 1 + x];
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let decoded;
      switch (filter) {
        case 0: decoded = value; break;
        case 1: decoded = value + left; break;
        case 2: decoded = value + up; break;
        case 3: decoded = value + ((left + up) >> 1); break;
        case 4: decoded = value + paeth(left, up, upLeft); break;
        default: return null;
      }
      current[x] = decoded & 0xff;
    }

    const target = y * width * 4;
    if (channels === 4) {
      pixels.set(current, target);
    } else {
      for (let x = 0; x < width; x += 1) {
        pixels[target + x * 4] = current[x * 3];
        pixels[target + x * 4 + 1] = current[x * 3 + 1];
        pixels[target + x * 4 + 2] = current[x * 3 + 2];
        pixels[target + x * 4 + 3] = 255;
      }
    }
    previous.set(current);
  }

  return { width, height, pixels };
}
