import { geoPeirceQuincuncial } from 'd3-geo-projection';

const EPSILON = 1e-12;
const DEFAULT_HISTOGRAM_BINS = 2048;

export const DEFAULT_RANKING_ANALYSIS_OPTIONS = {
  derivativeStep: 1,
  hotspotQuantile: 0.9,
  clipQuantile: 0.995,
  colorQuantizationBits: 4,
  opaqueAlphaMin: 160,
  oceanToleranceFactor: 0.42,
  oceanToleranceMin: 22,
  oceanToleranceMax: 40,
  histogramBins: DEFAULT_HISTOGRAM_BINS,
  hotspotMaskAlpha: 208,
  highlightAlphaMin: 34,
  highlightAlphaMax: 220,
};

export const DEFAULT_RANKING_METRICS = [
  {
    key: 'geoMeanDistortion',
    label: 'Geo Mean',
    format: 'fixed3',
    description: '地表面積補正つき平均歪み',
  },
  {
    key: 'visualMeanDistortion',
    label: 'Visual Mean',
    format: 'fixed3',
    description: '投影後の見た目ベース平均歪み',
  },
  {
    key: 'p95Distortion',
    label: 'P95',
    format: 'fixed3',
    description: '陸地上位 5% の歪み境界',
  },
  {
    key: 'hotspotCoverage',
    label: 'Hotspot %',
    format: 'percent1',
    description: '高歪み帯に入る陸地の面積比率',
  },
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function quantileFromSorted(sortedValues, quantile) {
  if (!sortedValues.length) return 0;
  const index = clamp(Math.round((sortedValues.length - 1) * quantile), 0, sortedValues.length - 1);
  return sortedValues[index];
}

function mixColor(from, to, t) {
  return [
    Math.round(from[0] + ((to[0] - from[0]) * t)),
    Math.round(from[1] + ((to[1] - from[1]) * t)),
    Math.round(from[2] + ((to[2] - from[2]) * t)),
  ];
}

function lonLatToUnitVector(lon, lat) {
  const lambda = (lon * Math.PI) / 180;
  const phi = (lat * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  return [
    cosPhi * Math.cos(lambda),
    cosPhi * Math.sin(lambda),
    Math.sin(phi),
  ];
}

function vectorSubtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vectorScale(vector, scalar) {
  return [vector[0] * scalar, vector[1] * scalar, vector[2] * scalar];
}

function vectorDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function buildProjection(outputSize) {
  return geoPeirceQuincuncial()
    .fitExtent(
      [
        [0, 0],
        [outputSize, outputSize],
      ],
      { type: 'Sphere' },
    );
}

export function buildPeirceDistortionField(outputSize, options = {}) {
  const settings = { ...DEFAULT_RANKING_ANALYSIS_OPTIONS, ...options };
  const projection = buildProjection(outputSize);
  const areaScale = new Float32Array(outputSize * outputSize);
  const logAreaScale = new Float32Array(outputSize * outputSize);
  const normalizedDistortion = new Float32Array(outputSize * outputSize);
  const hotspotMask = new Uint8Array(outputSize * outputSize);
  const validLogArea = [];
  const step = Math.max(1, Number(settings.derivativeStep) || 1);

  for (let y = 0; y < outputSize; y += 1) {
    for (let x = 0; x < outputSize; x += 1) {
      const leftX = clamp(x - step, 0, outputSize - 1) + 0.5;
      const rightX = clamp(x + step, 0, outputSize - 1) + 0.5;
      const topY = clamp(y - step, 0, outputSize - 1) + 0.5;
      const bottomY = clamp(y + step, 0, outputSize - 1) + 0.5;
      const centerX = x + 0.5;
      const centerY = y + 0.5;
      const leftLonLat = projection.invert([leftX, centerY]);
      const rightLonLat = projection.invert([rightX, centerY]);
      const topLonLat = projection.invert([centerX, topY]);
      const bottomLonLat = projection.invert([centerX, bottomY]);

      if (!leftLonLat || !rightLonLat || !topLonLat || !bottomLonLat) {
        continue;
      }

      const dx = Math.max(EPSILON, rightX - leftX);
      const dy = Math.max(EPSILON, bottomY - topY);
      const dvx = vectorScale(
        vectorSubtract(
          lonLatToUnitVector(rightLonLat[0], rightLonLat[1]),
          lonLatToUnitVector(leftLonLat[0], leftLonLat[1]),
        ),
        1 / dx,
      );
      const dvy = vectorScale(
        vectorSubtract(
          lonLatToUnitVector(bottomLonLat[0], bottomLonLat[1]),
          lonLatToUnitVector(topLonLat[0], topLonLat[1]),
        ),
        1 / dy,
      );

      const g11 = vectorDot(dvx, dvx);
      const g22 = vectorDot(dvy, dvy);
      const g12 = vectorDot(dvx, dvy);
      const determinant = Math.max(EPSILON, (g11 * g22) - (g12 * g12));
      const nextLogArea = -0.5 * Math.log(determinant);
      const index = y * outputSize + x;
      areaScale[index] = Math.exp(nextLogArea);
      logAreaScale[index] = nextLogArea;
      validLogArea.push(nextLogArea);
    }
  }

  validLogArea.sort((a, b) => a - b);
  const medianLogAreaScale = quantileFromSorted(validLogArea, 0.5);
  const distortionValues = validLogArea.map((value) => Math.abs(value - medianLogAreaScale)).sort((a, b) => a - b);
  const hotspotThreshold = quantileFromSorted(distortionValues, settings.hotspotQuantile);
  const clipMax = Math.max(EPSILON, quantileFromSorted(distortionValues, settings.clipQuantile));
  const maxDistortion = distortionValues[distortionValues.length - 1] || clipMax;

  for (let index = 0; index < logAreaScale.length; index += 1) {
    const distortion = Math.abs(logAreaScale[index] - medianLogAreaScale);
    normalizedDistortion[index] = clamp(distortion / clipMax, 0, 1);
    hotspotMask[index] = distortion >= hotspotThreshold ? 1 : 0;
  }

  return {
    outputSize,
    settings,
    areaScale,
    logAreaScale,
    medianLogAreaScale,
    maxDistortion,
    hotspotThreshold,
    clipMax,
    distortion: Float32Array.from(logAreaScale, (value) => Math.abs(value - medianLogAreaScale)),
    normalizedDistortion,
    hotspotMask,
  };
}

function encodeQuantizedKey(red, green, blue, bits) {
  const shift = 8 - bits;
  return [
    red >> shift,
    green >> shift,
    blue >> shift,
  ].join('|');
}

function colorDistance(red, green, blue, target) {
  return Math.hypot(red - target[0], green - target[1], blue - target[2]);
}

export function estimateOceanColor(rgba, width, height, options = {}) {
  const settings = { ...DEFAULT_RANKING_ANALYSIS_OPTIONS, ...options };
  const bins = new Map();

  for (let index = 0; index < width * height; index += 1) {
    const pixelOffset = index * 4;
    const alpha = rgba[pixelOffset + 3];
    if (alpha < settings.opaqueAlphaMin) continue;
    const red = rgba[pixelOffset];
    const green = rgba[pixelOffset + 1];
    const blue = rgba[pixelOffset + 2];
    const key = encodeQuantizedKey(
      red,
      green,
      blue,
      settings.colorQuantizationBits,
    );
    const entry = bins.get(key) || {
      count: 0,
      red: 0,
      green: 0,
      blue: 0,
    };
    entry.count += 1;
    entry.red += red;
    entry.green += green;
    entry.blue += blue;
    bins.set(key, entry);
  }

  if (!bins.size) {
    return {
      oceanColor: [85, 111, 181],
      oceanTolerance: settings.oceanToleranceMin,
    };
  }

  const rankedBins = [...bins.values()].sort((a, b) => b.count - a.count);
  const dominant = rankedBins[0];
  const oceanColor = [
    dominant.red / dominant.count,
    dominant.green / dominant.count,
    dominant.blue / dominant.count,
  ];

  let nearestDistance = Infinity;
  for (const entry of rankedBins.slice(1, 10)) {
    const averageColor = [
      entry.red / entry.count,
      entry.green / entry.count,
      entry.blue / entry.count,
    ];
    nearestDistance = Math.min(
      nearestDistance,
      colorDistance(
        averageColor[0],
        averageColor[1],
        averageColor[2],
        oceanColor,
      ),
    );
  }

  const oceanTolerance = clamp(
    Number.isFinite(nearestDistance)
      ? nearestDistance * settings.oceanToleranceFactor
      : settings.oceanToleranceMin,
    settings.oceanToleranceMin,
    settings.oceanToleranceMax,
  );

  return {
    oceanColor,
    oceanTolerance,
  };
}

export function buildLandMaskFromRgba(rgba, width, height, options = {}) {
  const settings = { ...DEFAULT_RANKING_ANALYSIS_OPTIONS, ...options };
  const { oceanColor, oceanTolerance } = estimateOceanColor(rgba, width, height, settings);
  const landMask = new Uint8Array(width * height);
  let landPixelCount = 0;

  for (let index = 0; index < width * height; index += 1) {
    const pixelOffset = index * 4;
    const alpha = rgba[pixelOffset + 3];
    if (alpha < settings.opaqueAlphaMin) continue;
    const isLand = colorDistance(
      rgba[pixelOffset],
      rgba[pixelOffset + 1],
      rgba[pixelOffset + 2],
      oceanColor,
    ) > oceanTolerance;
    if (!isLand) continue;
    landMask[index] = 1;
    landPixelCount += 1;
  }

  return {
    landMask,
    landPixelCount,
    landRatio: landPixelCount / (width * height),
    oceanColor,
    oceanTolerance,
  };
}

function buildHistogramQuantile(histogram, total, valueRange, quantile) {
  if (total <= 0) return 0;
  const target = total * quantile;
  let cumulative = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    cumulative += histogram[index];
    if (cumulative >= target) {
      return (index / (histogram.length - 1)) * valueRange;
    }
  }
  return valueRange;
}

export function scoreLandMaskAgainstField(landMask, field, options = {}) {
  const settings = { ...DEFAULT_RANKING_ANALYSIS_OPTIONS, ...options };
  const histogram = new Uint32Array(settings.histogramBins || DEFAULT_HISTOGRAM_BINS);
  const range = Math.max(EPSILON, field.maxDistortion);
  let landPixelCount = 0;
  let visualDistortionSum = 0;
  let geoDistortionSum = 0;
  let geoWeightSum = 0;
  let geoHotspotSum = 0;

  for (let index = 0; index < landMask.length; index += 1) {
    if (!landMask[index]) continue;
    const distortion = field.distortion[index];
    const areaScale = Math.max(EPSILON, field.areaScale[index]);
    const geographicWeight = 1 / areaScale;
    const histogramIndex = clamp(
      Math.round((distortion / range) * (histogram.length - 1)),
      0,
      histogram.length - 1,
    );

    landPixelCount += 1;
    visualDistortionSum += distortion;
    geoDistortionSum += distortion * geographicWeight;
    geoWeightSum += geographicWeight;
    if (field.hotspotMask[index]) {
      geoHotspotSum += geographicWeight;
    }
    histogram[histogramIndex] += 1;
  }

  return {
    landPixelCount,
    visualMeanDistortion: landPixelCount ? visualDistortionSum / landPixelCount : 0,
    geoMeanDistortion: geoWeightSum ? geoDistortionSum / geoWeightSum : 0,
    p95Distortion: buildHistogramQuantile(histogram, landPixelCount, range, 0.95),
    hotspotCoverage: geoWeightSum ? geoHotspotSum / geoWeightSum : 0,
  };
}

function rampHeatColor(value) {
  if (value <= 0.5) {
    return mixColor([244, 214, 117], [238, 114, 52], value / 0.5);
  }
  return mixColor([238, 114, 52], [183, 31, 64], (value - 0.5) / 0.5);
}

export function buildFieldHeatmapRgba(field) {
  const pixels = new Uint8ClampedArray(field.outputSize * field.outputSize * 4);
  for (let index = 0; index < field.normalizedDistortion.length; index += 1) {
    const normalized = field.normalizedDistortion[index];
    const [red, green, blue] = rampHeatColor(normalized);
    const pixelOffset = index * 4;
    pixels[pixelOffset] = red;
    pixels[pixelOffset + 1] = green;
    pixels[pixelOffset + 2] = blue;
    pixels[pixelOffset + 3] = 255;
  }
  return pixels;
}

export function buildFieldMaskRgba(field, options = {}) {
  const settings = { ...DEFAULT_RANKING_ANALYSIS_OPTIONS, ...options };
  const pixels = new Uint8ClampedArray(field.outputSize * field.outputSize * 4);

  for (let index = 0; index < field.hotspotMask.length; index += 1) {
    if (!field.hotspotMask[index]) continue;
    const pixelOffset = index * 4;
    pixels[pixelOffset] = 237;
    pixels[pixelOffset + 1] = 40;
    pixels[pixelOffset + 2] = 96;
    pixels[pixelOffset + 3] = settings.hotspotMaskAlpha;
  }

  return pixels;
}

export function buildLandHotspotOverlayRgba(landMask, field, options = {}) {
  const settings = { ...DEFAULT_RANKING_ANALYSIS_OPTIONS, ...options };
  const pixels = new Uint8ClampedArray(field.outputSize * field.outputSize * 4);

  for (let index = 0; index < landMask.length; index += 1) {
    if (!landMask[index] || !field.hotspotMask[index]) continue;
    const normalized = field.normalizedDistortion[index];
    const pixelOffset = index * 4;
    pixels[pixelOffset] = 237;
    pixels[pixelOffset + 1] = 40;
    pixels[pixelOffset + 2] = 96;
    pixels[pixelOffset + 3] = Math.round(settings.hotspotMaskAlpha * (0.6 + normalized * 0.4));
  }

  return pixels;
}

export function buildWeightedLandHighlightRgba(landMask, field, options = {}) {
  const settings = { ...DEFAULT_RANKING_ANALYSIS_OPTIONS, ...options };
  const pixels = new Uint8ClampedArray(field.outputSize * field.outputSize * 4);

  for (let index = 0; index < landMask.length; index += 1) {
    if (!landMask[index]) continue;
    const normalized = field.normalizedDistortion[index];
    if (normalized <= 0.04) continue;
    const [red, green, blue] = rampHeatColor(normalized);
    const pixelOffset = index * 4;
    pixels[pixelOffset] = red;
    pixels[pixelOffset + 1] = green;
    pixels[pixelOffset + 2] = blue;
    pixels[pixelOffset + 3] = Math.round(
      settings.highlightAlphaMin
      + ((settings.highlightAlphaMax - settings.highlightAlphaMin) * normalized),
    );
  }

  return pixels;
}
