import { geoPeirceQuincuncial } from 'd3-geo-projection';

const DEFAULT_BACKGROUND = [0, 0, 0, 0];
const EPSILON = 1e-9;

export const DEFAULT_SWEEP_OPTIONS = {
  centerLonMin: -180,
  centerLonMax: 180,
  centerLonStep: 15,
  centerLatMin: -90,
  centerLatMax: 90,
  centerLatStep: 15,
  rollStep: 15,
  rollMode: 'quarter-turn',
  outputSize: 320,
  dedupePolarCenters: true,
};

function roundAngle(value) {
  return Number(value.toFixed(6));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeLongitude(lon) {
  let normalized = lon;
  while (normalized <= -180) normalized += 360;
  while (normalized > 180) normalized -= 360;
  return normalized;
}

function requirePositiveNumber(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
}

function requireFiniteNumber(name, value) {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
}

function buildLinearSequence(min, max, step, inclusiveEnd) {
  const values = [];
  if (inclusiveEnd) {
    for (let value = min; value <= max + EPSILON; value += step) {
      values.push(roundAngle(value));
    }
    if (Math.abs(values[values.length - 1] - max) > EPSILON) {
      values.push(roundAngle(max));
    }
    return values;
  }

  for (let value = min; value < max - EPSILON; value += step) {
    values.push(roundAngle(value));
  }
  return values;
}

function buildWrappedSequence(span, step) {
  const values = [];
  for (let value = 0; value < span - EPSILON; value += step) {
    values.push(roundAngle(value));
  }
  return values.length ? values : [0];
}

export function normalizeSweepOptions(options = {}) {
  const merged = { ...DEFAULT_SWEEP_OPTIONS, ...options };
  const rollMode = merged.rollMode === 'full-turn' ? 'full-turn' : 'quarter-turn';
  requireFiniteNumber('centerLonMin', merged.centerLonMin);
  requireFiniteNumber('centerLonMax', merged.centerLonMax);
  requireFiniteNumber('centerLatMin', merged.centerLatMin);
  requireFiniteNumber('centerLatMax', merged.centerLatMax);
  requirePositiveNumber('centerLonStep', merged.centerLonStep);
  requirePositiveNumber('centerLatStep', merged.centerLatStep);
  requirePositiveNumber('rollStep', merged.rollStep);
  requirePositiveNumber('outputSize', merged.outputSize);

  if (merged.centerLonMin >= merged.centerLonMax) {
    throw new Error('centerLonMin must be smaller than centerLonMax.');
  }
  if (merged.centerLatMin > merged.centerLatMax) {
    throw new Error('centerLatMin must be smaller than or equal to centerLatMax.');
  }

  return {
    ...merged,
    rollMode,
    rollSpan: rollMode === 'quarter-turn' ? 90 : 360,
    outputSize: Math.max(8, Math.round(merged.outputSize)),
  };
}

export function enumerateSweepCases(options = {}) {
  const normalizedOptions = normalizeSweepOptions(options);
  const lonValues = buildLinearSequence(
    normalizedOptions.centerLonMin,
    normalizedOptions.centerLonMax,
    normalizedOptions.centerLonStep,
    false,
  );
  const latValues = buildLinearSequence(
    normalizedOptions.centerLatMin,
    normalizedOptions.centerLatMax,
    normalizedOptions.centerLatStep,
    true,
  );
  const rollValues = buildWrappedSequence(normalizedOptions.rollSpan, normalizedOptions.rollStep);
  const cases = [];
  let index = 0;

  for (const centerLat of latValues) {
    const isPole = normalizedOptions.dedupePolarCenters && Math.abs(Math.abs(centerLat) - 90) <= EPSILON;
    const activeLonValues = isPole ? [0] : lonValues;
    for (const centerLon of activeLonValues) {
      for (const roll of rollValues) {
        cases.push({
          index,
          centerLon,
          centerLat,
          roll,
        });
        index += 1;
      }
    }
  }

  return {
    options: normalizedOptions,
    lonValues,
    latValues,
    rollValues,
    cases,
  };
}

export function estimateSweepCaseCount(options = {}) {
  return enumerateSweepCases(options).cases.length;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function estimateBackgroundColor(sourceImage) {
  const { pixels, width, height } = sourceImage;
  if (!pixels || !width || !height) return DEFAULT_BACKGROUND;

  const sampleRadius = Math.max(1, Math.min(8, Math.floor(Math.min(width, height) / 20)));
  const samples = [[], [], [], []];
  const corners = [
    [0, 0],
    [Math.max(0, width - sampleRadius), 0],
    [0, Math.max(0, height - sampleRadius)],
    [Math.max(0, width - sampleRadius), Math.max(0, height - sampleRadius)],
  ];

  for (const [startX, startY] of corners) {
    for (let y = startY; y < Math.min(height, startY + sampleRadius); y += 1) {
      for (let x = startX; x < Math.min(width, startX + sampleRadius); x += 1) {
        const offset = (y * width + x) * 4;
        for (let channel = 0; channel < 4; channel += 1) {
          samples[channel].push(pixels[offset + channel]);
        }
      }
    }
  }

  return samples.map((channel) => Math.round(median(channel)));
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

export function renderSweepCase(sourceImage, caseDefinition, options = {}) {
  const normalizedOptions = normalizeSweepOptions(options);
  const width = normalizedOptions.outputSize;
  const height = normalizedOptions.outputSize;
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

function formatAngleText(value) {
  return Number(value.toFixed(4)).toString();
}

function angleToToken(value) {
  const rounded = Number(value.toFixed(4));
  const magnitude = Math.abs(rounded).toFixed(4).replace(/\.?0+$/, '').replace('.', 'p');
  return rounded < 0 ? `m${magnitude}` : magnitude;
}

export function buildSweepCaseFileName(caseDefinition, totalCount, extension = 'png') {
  const pad = String(Math.max(1, totalCount)).length;
  const caseNumber = String(caseDefinition.index + 1).padStart(pad, '0');
  return [
    `case_${caseNumber}`,
    `lon_${angleToToken(caseDefinition.centerLon)}`,
    `lat_${angleToToken(caseDefinition.centerLat)}`,
    `roll_${angleToToken(caseDefinition.roll)}`,
  ].join('_') + `.${extension}`;
}

export function formatSweepCaseLabel(caseDefinition) {
  return `lon=${formatAngleText(caseDefinition.centerLon)} lat=${formatAngleText(caseDefinition.centerLat)} roll=${formatAngleText(caseDefinition.roll)}`;
}
