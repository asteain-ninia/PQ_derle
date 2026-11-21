import { geoContains, geoPath, geoRotation } from 'd3-geo';
import { geoPeirceQuincuncial } from 'd3-geo-projection';
import { SVGPathData } from 'svg-pathdata';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0];
const GEOMETRY_TAGS = new Set(['path', 'rect', 'polygon', 'line', 'polyline', 'circle', 'ellipse']);
const DEFINITION_TAGS = new Set([
  'defs',
  'style',
  'metadata',
  'title',
  'desc',
  'clipPath',
  'mask',
  'pattern',
  'linearGradient',
  'radialGradient',
  'stop',
  'filter',
  'marker',
  'symbol',
]);
const GEOMETRY_ATTRIBUTES = new Set([
  'd',
  'x',
  'y',
  'width',
  'height',
  'rx',
  'ry',
  'cx',
  'cy',
  'r',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
  'transform',
]);
const STYLE_PROPERTIES = new Set([
  'display',
  'fill',
  'fill-opacity',
  'fill-rule',
  'opacity',
  'stroke',
  'stroke-opacity',
  'visibility',
]);
const INHERITED_STYLE_PROPERTIES = new Set([
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-opacity',
  'visibility',
]);
const INITIAL_STYLE_DECLARATIONS = {
  display: 'inline',
  fill: '#000',
  'fill-opacity': '1',
  'fill-rule': 'nonzero',
  opacity: '1',
  stroke: 'none',
  'stroke-opacity': '1',
  visibility: 'visible',
};
const GENERATED_GRATICULE_LATITUDES = [60, 30, 0, -30, -60];
const GENERATED_GRATICULE_LONGITUDES = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150, 180];
const GRATICULE_SAMPLE_STEP = 0.25;

function getDomImpl(domImpl = {}) {
  const DOMParserImpl = domImpl.DOMParser || globalThis.DOMParser;
  const XMLSerializerImpl = domImpl.XMLSerializer || globalThis.XMLSerializer;
  if (!DOMParserImpl || !XMLSerializerImpl) {
    throw new Error('DOMParser/XMLSerializer are not available in this environment.');
  }
  return { DOMParserImpl, XMLSerializerImpl };
}

function localName(node) {
  return node.localName || node.nodeName;
}

function parseFloatList(value) {
  if (!value) return [];
  const matches = value.match(/[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g);
  return matches ? matches.map(Number) : [];
}

function parseStyleDeclarations(cssText) {
  const declarations = {};
  if (!cssText) return declarations;
  for (const chunk of cssText.split(';')) {
    const separator = chunk.indexOf(':');
    if (separator === -1) continue;
    const property = chunk.slice(0, separator).trim().toLowerCase();
    const value = chunk.slice(separator + 1).trim();
    if (!STYLE_PROPERTIES.has(property) || !value) continue;
    declarations[property] = value.replace(/\s*!important\s*$/i, '').trim();
  }
  return declarations;
}

function parseStylesheet(root) {
  const styleNodes = Array.from(root.getElementsByTagNameNS(SVG_NS, 'style'));
  const rules = [];
  let order = 0;

  for (const styleNode of styleNodes) {
    const cssText = (styleNode.textContent || '').replace(/\/\*[\s\S]*?\*\//g, '');
    const ruleRegex = /([^{}]+)\{([^}]*)\}/g;
    let match = ruleRegex.exec(cssText);
    while (match) {
      const [, selectorText, declarationText] = match;
      const declarations = parseStyleDeclarations(declarationText);
      if (Object.keys(declarations).length) {
        for (const rawSelector of selectorText.split(',')) {
          const selector = rawSelector.trim();
          let type = null;
          let name = '';
          let specificity = 0;

          if (/^\.[A-Za-z_][\w-]*$/.test(selector)) {
            type = 'class';
            name = selector.slice(1);
            specificity = 10;
          } else if (/^#[A-Za-z_][\w-]*$/.test(selector)) {
            type = 'id';
            name = selector.slice(1);
            specificity = 100;
          } else if (/^[A-Za-z][\w-]*$/.test(selector)) {
            type = 'tag';
            name = selector.toLowerCase();
            specificity = 1;
          }

          if (type) {
            rules.push({
              type,
              name,
              declarations,
              specificity,
              order,
            });
          }
        }
      }
      order += 1;
      match = ruleRegex.exec(cssText);
    }
  }

  return { rules };
}

function formatNumber(value, digits = 6) {
  if (!Number.isFinite(value)) return '0';
  const formatted = value.toFixed(digits).replace(/\.?0+$/, '');
  return formatted === '-0' ? '0' : formatted;
}

function normalizeLongitude(lon) {
  let normalized = lon;
  while (normalized <= -180) normalized += 360;
  while (normalized > 180) normalized -= 360;
  return normalized;
}

function normalizeLongitudeInclusive(lon) {
  let normalized = lon;
  while (normalized < -180) normalized += 360;
  while (normalized > 180) normalized -= 360;
  if (normalized === -0) return 0;
  return normalized;
}

function clampLatitude(lat) {
  if (!Number.isFinite(lat)) return 0;
  if (lat <= -90) return -90;
  if (lat >= 90) return 90;
  return lat;
}

function parseOpacity(value, fallback = 1) {
  const parsed = Number.parseFloat(value ?? '');
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return 0;
  if (parsed >= 1) return 1;
  return parsed;
}

function matrixMultiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function applyMatrix(matrix, point) {
  return [
    matrix[0] * point[0] + matrix[2] * point[1] + matrix[4],
    matrix[1] * point[0] + matrix[3] * point[1] + matrix[5],
  ];
}

function isIdentityMatrix(matrix) {
  return matrix.every((value, index) => value === IDENTITY_MATRIX[index]);
}

function parseTransform(transformValue) {
  if (!transformValue) return IDENTITY_MATRIX;
  let matrix = IDENTITY_MATRIX;
  const transformRegex = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let match = transformRegex.exec(transformValue);
  while (match) {
    const [, name, rawArgs] = match;
    const values = parseFloatList(rawArgs);
    let next = IDENTITY_MATRIX;
    switch (name) {
      case 'matrix':
        if (values.length >= 6) next = values.slice(0, 6);
        break;
      case 'translate': {
        const tx = values[0] || 0;
        const ty = values[1] || 0;
        next = [1, 0, 0, 1, tx, ty];
        break;
      }
      case 'scale': {
        const sx = values[0] ?? 1;
        const sy = values[1] ?? sx;
        next = [sx, 0, 0, sy, 0, 0];
        break;
      }
      case 'rotate': {
        const angle = ((values[0] || 0) * Math.PI) / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        if (values.length >= 3) {
          const [_, cx, cy] = values;
          next = matrixMultiply(
            matrixMultiply([1, 0, 0, 1, cx, cy], [cos, sin, -sin, cos, 0, 0]),
            [1, 0, 0, 1, -cx, -cy],
          );
        } else {
          next = [cos, sin, -sin, cos, 0, 0];
        }
        break;
      }
      case 'skewX': {
        const angle = ((values[0] || 0) * Math.PI) / 180;
        next = [1, 0, Math.tan(angle), 1, 0, 0];
        break;
      }
      case 'skewY': {
        const angle = ((values[0] || 0) * Math.PI) / 180;
        next = [1, Math.tan(angle), 0, 1, 0, 0];
        break;
      }
      default:
        break;
    }
    matrix = matrixMultiply(matrix, next);
    match = transformRegex.exec(transformValue);
  }
  return matrix;
}

function getViewBox(root) {
  const values = parseFloatList(root.getAttribute('viewBox'));
  if (values.length === 4) {
    return { x: values[0], y: values[1], width: values[2], height: values[3] };
  }
  const width = parseFloat(root.getAttribute('width') || '0') || 0;
  const height = parseFloat(root.getAttribute('height') || '0') || 0;
  return { x: 0, y: 0, width, height };
}

function findMapFrame(root) {
  const rects = Array.from(root.getElementsByTagNameNS(SVG_NS, 'rect'));
  let best = null;
  for (const rect of rects) {
    const x = parseFloat(rect.getAttribute('x') || '0');
    const y = parseFloat(rect.getAttribute('y') || '0');
    const width = parseFloat(rect.getAttribute('width') || '0');
    const height = parseFloat(rect.getAttribute('height') || '0');
    if (!(width > 0 && height > 0)) continue;
    const ratio = width / height;
    const ratioPenalty = Math.abs(ratio - 2);
    const score = width * height - ratioPenalty * 1000000;
    if (!best || score > best.score) {
      best = {
        score,
        element: rect,
        x,
        y,
        width,
        height,
      };
    }
  }
  if (best) return best;
  const viewBox = getViewBox(root);
  return {
    score: viewBox.width * viewBox.height,
    element: null,
    x: viewBox.x,
    y: viewBox.y,
    width: viewBox.width,
    height: viewBox.height,
  };
}

function detectSourceScale(root, viewBox) {
  const width = parseFloat(root.getAttribute('width') || '0');
  if (!viewBox.width || !Number.isFinite(width) || width <= 0) return 1;
  return width / viewBox.width;
}

function buildProjection(side, precision) {
  const projection = geoPeirceQuincuncial()
    .precision(precision)
    .fitExtent(
      [
        [0, 0],
        [side, side],
      ],
      { type: 'Sphere' },
    );
  const pathBuilder = geoPath(projection);
  if (typeof pathBuilder.digits === 'function') {
    pathBuilder.digits(6);
  }
  // 塗りは切れ目で自分で切ってから投影するので、南極のまわりを丸く切り取る d3 の既定の切り方を外した投影を使う。
  const areaProjection = geoPeirceQuincuncial()
    .precision(precision)
    .scale(projection.scale())
    .translate(projection.translate())
    .preclip((stream) => stream);
  return { projection, pathBuilder, areaProjection, cutFrame: createPeirceCutFrame(areaProjection, side) };
}

function sourcePointToOriginalLonLat(point, context) {
  const lon = ((point[0] - context.frame.x) / context.frame.width) * 360 - 180;
  const lat = 90 - ((point[1] - context.frame.y) / context.frame.height) * 180;
  return [lon, lat];
}

function orientLonLat(lonLat, context) {
  const rotated = context.rotation ? context.rotation(lonLat) : lonLat;
  if (!rotated || !Number.isFinite(rotated[0]) || !Number.isFinite(rotated[1])) {
    return null;
  }
  return [
    normalizeLongitudeInclusive(rotated[0]),
    clampLatitude(rotated[1]),
  ];
}

function sourcePointToLonLat(point, context) {
  return orientLonLat(sourcePointToOriginalLonLat(point, context), context);
}

function lonLatToFramePoint(lonLat, context) {
  const lon = normalizeLongitudeInclusive(lonLat[0]);
  return [
    context.frame.x + ((lon + 180) / 360) * context.frame.width,
    context.frame.y + ((90 - clampLatitude(lonLat[1])) / 180) * context.frame.height,
  ];
}

function framePointToLonLat(point, context) {
  return [
    normalizeLongitudeInclusive(((point[0] - context.frame.x) / context.frame.width) * 360 - 180),
    clampLatitude(90 - ((point[1] - context.frame.y) / context.frame.height) * 180),
  ];
}

function sourcePointToFramePoint(point, context) {
  const lonLat = sourcePointToLonLat(point, context);
  return lonLat ? lonLatToFramePoint(lonLat, context) : null;
}

function transformSubpathToFrame(subpath, context) {
  return {
    ...subpath,
    points: subpath.points
      .map((point) => sourcePointToFramePoint(point, context))
      .filter(Boolean),
  };
}

function distance(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function cubicPoint(p0, p1, p2, p3, t) {
  const inv = 1 - t;
  return [
    inv ** 3 * p0[0] + 3 * inv ** 2 * t * p1[0] + 3 * inv * t ** 2 * p2[0] + t ** 3 * p3[0],
    inv ** 3 * p0[1] + 3 * inv ** 2 * t * p1[1] + 3 * inv * t ** 2 * p2[1] + t ** 3 * p3[1],
  ];
}

function densifySegment(points, maxStep) {
  if (points.length < 2) return points;
  const output = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const segments = Math.max(1, Math.ceil(distance(start, end) / maxStep));
    for (let step = 1; step <= segments; step += 1) {
      output.push(lerp(start, end, step / segments));
    }
  }
  return output;
}

function densifyCubic(p0, p1, p2, p3, maxStep) {
  const controlLength = distance(p0, p1) + distance(p1, p2) + distance(p2, p3);
  const segments = Math.max(8, Math.ceil(controlLength / maxStep));
  const output = [p0];
  for (let step = 1; step <= segments; step += 1) {
    output.push(cubicPoint(p0, p1, p2, p3, step / segments));
  }
  return output;
}

function unwrapPeriodicX(points, period) {
  if (!points.length) return points;
  const output = [[points[0][0], points[0][1]]];
  let offset = 0;
  let previousX = points[0][0];
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index];
    const delta = current[0] + offset - previousX;
    if (delta > period / 2) offset -= period;
    else if (delta < -period / 2) offset += period;
    const unwrappedX = current[0] + offset;
    output.push([unwrappedX, current[1]]);
    previousX = unwrappedX;
  }
  return output;
}

function closeCoordinateRing(coordinates) {
  if (!coordinates.length) return coordinates;
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return coordinates;
  return [...coordinates, first];
}

function closeProjectedPath(pathData) {
  const trimmed = pathData.trim();
  if (!trimmed) return '';
  if (/[zZ]\s*$/.test(trimmed)) return trimmed;
  const segments = trimmed.match(/[Mm][^Mm]*/g) || [trimmed];
  return segments
    .map((segment) => {
      const segmentTrimmed = segment.trim();
      return segmentTrimmed ? `${segmentTrimmed}Z` : '';
    })
    .filter(Boolean)
    .join('');
}

function isWorldBoundarySubpath(pathData, side) {
  const tolerance = Math.max(0.01, side * 1e-6);
  const minimumBoundaryArea = side * side * 0.9;
  const commands = new SVGPathData(pathData).toAbs().commands;
  const points = [];

  for (const command of commands) {
    if (command.type === SVGPathData.MOVE_TO || command.type === SVGPathData.LINE_TO) {
      points.push([command.x, command.y]);
    }
  }

  if (points.length < 4) return false;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let area = 0;

  for (let index = 0; index < points.length; index += 1) {
    const [x, y] = points[index];
    const [nextX, nextY] = points[(index + 1) % points.length];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    area += x * nextY - nextX * y;
  }

  return (
    minX <= tolerance
    && minY <= tolerance
    && Math.abs(maxX - side) <= tolerance
    && Math.abs(maxY - side) <= tolerance
    && Math.abs(area / 2) >= minimumBoundaryArea
  );
}

function stripWorldBoundarySubpaths(pathData, side) {
  const segments = pathData.match(/[Mm][^Mm]*/g) || [];
  if (!segments.length) return pathData;
  const keptSegments = segments.filter((segment) => !isWorldBoundarySubpath(segment, side));
  return keptSegments.join('');
}

function snapEdgeCoordinate(value, side, tolerance) {
  if (Math.abs(value) <= tolerance) return 0;
  if (Math.abs(value - side) <= tolerance) return side;
  return value;
}

function snapPointToSquare(point, side, tolerance = 0.05) {
  return [
    snapEdgeCoordinate(point[0], side, tolerance),
    snapEdgeCoordinate(point[1], side, tolerance),
  ];
}

function pointsEqual(a, b, tolerance = 1e-6) {
  return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;
}

function dedupeSequentialPoints(points, tolerance = 1e-6) {
  if (!points.length) return points;
  const output = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    if (!pointsEqual(output[output.length - 1], points[index], tolerance)) {
      output.push(points[index]);
    }
  }
  return output;
}

function countDistinctPoints(points, tolerance = 1e-6) {
  const distinct = [];
  for (const point of points) {
    if (!distinct.some((candidate) => pointsEqual(candidate, point, tolerance))) {
      distinct.push(point);
    }
  }
  return distinct.length;
}

function computeSignedPolygonArea(points) {
  if (points.length < 3) return 0;
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[(index + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

function hasRenderablePolygon(points, areaTolerance = 1e-4, pointTolerance = 1e-6) {
  const deduped = dedupeSequentialPoints(points, pointTolerance);
  if (deduped.length < 3) return false;
  if (countDistinctPoints(deduped, pointTolerance) < 3) return false;
  return Math.abs(computeSignedPolygonArea(deduped)) > areaTolerance;
}

function buildPathDataFromPoints(points, close = false) {
  const deduped = dedupeSequentialPoints(points);
  if (!deduped.length) return '';
  let pathData = `M${formatNumber(deduped[0][0])} ${formatNumber(deduped[0][1])}`;
  for (let index = 1; index < deduped.length; index += 1) {
    pathData += `L${formatNumber(deduped[index][0])} ${formatNumber(deduped[index][1])}`;
  }
  if (close) pathData += 'Z';
  return pathData;
}

function distanceToSquareBoundary(point, side) {
  return Math.min(
    Math.abs(point[0]),
    Math.abs(point[0] - side),
    Math.abs(point[1]),
    Math.abs(point[1] - side),
  );
}

function getBoundaryEdgesForPoint(point, side, tolerance = 0.5) {
  const edges = [];
  if (Math.abs(point[0]) <= tolerance) edges.push('left');
  if (Math.abs(point[0] - side) <= tolerance) edges.push('right');
  if (Math.abs(point[1]) <= tolerance) edges.push('top');
  if (Math.abs(point[1] - side) <= tolerance) edges.push('bottom');
  return edges;
}

function shouldSplitProjectedOpenJump(start, end, side, boundaryTolerance = 0.5) {
  const jumpThreshold = Math.max(24, side * 0.05);
  if (distance(start, end) < jumpThreshold) return false;
  if (distanceToSquareBoundary(start, side) > boundaryTolerance) return false;
  if (distanceToSquareBoundary(end, side) > boundaryTolerance) return false;

  const startEdges = getBoundaryEdgesForPoint(start, side, boundaryTolerance);
  const endEdges = getBoundaryEdgesForPoint(end, side, boundaryTolerance);
  return startEdges.some((edge) => endEdges.includes(edge));
}

function normalizeProjectedOpenPath(pathData, side, boundaryTolerance = 0.5, endpointSnapTolerance = 0.5) {
  if (!pathData) return '';
  const commands = new SVGPathData(pathData).toAbs().commands;
  const parts = [];
  let current = [];

  const flushCurrent = () => {
    if (current.length < 2) {
      current = [];
      return;
    }
    const normalized = current.map((point, index) => {
      if (index === 0 || index === current.length - 1) {
        return snapPointToSquare(point, side, endpointSnapTolerance);
      }
      return point;
    });
    const part = buildPathDataFromPoints(normalized, false);
    if (part) parts.push(part);
    current = [];
  };

  for (const command of commands) {
    if (command.type === SVGPathData.MOVE_TO) {
      flushCurrent();
      current = [[command.x, command.y]];
      continue;
    }
    if (command.type !== SVGPathData.LINE_TO || !Number.isFinite(command.x) || !Number.isFinite(command.y)) {
      continue;
    }

    const point = [command.x, command.y];
    const previous = current[current.length - 1];
    if (!previous) {
      current = [point];
      continue;
    }

    if (shouldSplitProjectedOpenJump(previous, point, side, boundaryTolerance)) {
      current[current.length - 1] = snapPointToSquare(previous, side, endpointSnapTolerance);
      flushCurrent();
      current = [snapPointToSquare(point, side, endpointSnapTolerance)];
      continue;
    }

    current.push(point);
  }

  flushCurrent();
  return parts.join('');
}

function buildProjectedOpenLinePath(coordinates, context) {
  if (coordinates.length < 2) return '';
  const projected = context.pathBuilder({ type: 'LineString', coordinates }) || '';
  return normalizeProjectedOpenPath(projected, context.side);
}

function parseProjectedPathSubpaths(pathData) {
  if (!pathData) return [];
  const commands = new SVGPathData(pathData).toAbs().commands;
  const subpaths = [];
  let current = null;

  for (const command of commands) {
    if (command.type === SVGPathData.MOVE_TO) {
      current = {
        points: [[command.x, command.y]],
        closed: false,
      };
      subpaths.push(current);
      continue;
    }
    if (!current) continue;
    if (command.type === SVGPathData.LINE_TO && Number.isFinite(command.x) && Number.isFinite(command.y)) {
      current.points.push([command.x, command.y]);
    } else if (command.type === SVGPathData.CLOSE_PATH) {
      current.closed = true;
    }
  }

  return subpaths;
}

function explodePathDataToAtomicParts(pathData) {
  const subpaths = parseProjectedPathSubpaths(pathData);
  if (!subpaths.length) return pathData ? [pathData] : [];
  return subpaths
    .map((subpath) => buildPathDataFromPoints(subpath.points, subpath.closed))
    .filter(Boolean);
}

function parsePoints(pointsValue) {
  const values = parseFloatList(pointsValue);
  const points = [];
  for (let index = 0; index < values.length - 1; index += 2) {
    points.push([values[index], values[index + 1]]);
  }
  return points;
}

function sampleGeometry(element, matrix, options) {
  const tag = localName(element);
  if (tag === 'path') {
    const commands = new SVGPathData(element.getAttribute('d') || '')
      .toAbs()
      .normalizeHVZ(true, true, true)
      .normalizeST()
      .qtToC()
      .aToC().commands;
    const subpaths = [];
    let currentPoints = [];
    let currentPoint = null;
    for (const command of commands) {
      if (command.type === SVGPathData.MOVE_TO) {
        if (currentPoints.length) {
          subpaths.push({ points: currentPoints, closed: false });
        }
        currentPoint = applyMatrix(matrix, [command.x, command.y]);
        currentPoints = [currentPoint];
      } else if (command.type === SVGPathData.LINE_TO) {
        const endPoint = applyMatrix(matrix, [command.x, command.y]);
        const densified = densifySegment([currentPoint, endPoint], options.sampleStep);
        currentPoints.push(...densified.slice(1));
        currentPoint = endPoint;
      } else if (command.type === SVGPathData.CURVE_TO) {
        const p1 = applyMatrix(matrix, [command.x1, command.y1]);
        const p2 = applyMatrix(matrix, [command.x2, command.y2]);
        const p3 = applyMatrix(matrix, [command.x, command.y]);
        const densified = densifyCubic(currentPoint, p1, p2, p3, options.sampleStep);
        currentPoints.push(...densified.slice(1));
        currentPoint = p3;
      } else if (command.type === SVGPathData.CLOSE_PATH) {
        if (currentPoints.length) {
          subpaths.push({ points: currentPoints, closed: true });
        }
        currentPoints = [];
        currentPoint = null;
      }
    }
    if (currentPoints.length) {
      subpaths.push({ points: currentPoints, closed: false });
    }
    return subpaths;
  }

  if (tag === 'rect') {
    const x = parseFloat(element.getAttribute('x') || '0');
    const y = parseFloat(element.getAttribute('y') || '0');
    const width = parseFloat(element.getAttribute('width') || '0');
    const height = parseFloat(element.getAttribute('height') || '0');
    const corners = [
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height],
      [x, y],
    ].map((point) => applyMatrix(matrix, point));
    return [{ points: densifySegment(corners, options.sampleStep), closed: true }];
  }

  if (tag === 'polygon' || tag === 'polyline') {
    const points = parsePoints(element.getAttribute('points') || '').map((point) => applyMatrix(matrix, point));
    if (!points.length) return [];
    const closed = tag === 'polygon';
    const shapedPoints = closed ? [...points, points[0]] : points;
    return [{ points: densifySegment(shapedPoints, options.sampleStep), closed }];
  }

  if (tag === 'line') {
    const points = [
      [parseFloat(element.getAttribute('x1') || '0'), parseFloat(element.getAttribute('y1') || '0')],
      [parseFloat(element.getAttribute('x2') || '0'), parseFloat(element.getAttribute('y2') || '0')],
    ].map((point) => applyMatrix(matrix, point));
    return [{ points: densifySegment(points, options.sampleStep), closed: false }];
  }

  if (tag === 'circle' || tag === 'ellipse') {
    const cx = parseFloat(element.getAttribute('cx') || '0');
    const cy = parseFloat(element.getAttribute('cy') || '0');
    const rx = tag === 'circle' ? parseFloat(element.getAttribute('r') || '0') : parseFloat(element.getAttribute('rx') || '0');
    const ry = tag === 'circle' ? parseFloat(element.getAttribute('r') || '0') : parseFloat(element.getAttribute('ry') || '0');
    const segments = Math.max(48, Math.ceil((2 * Math.PI * Math.max(rx, ry)) / options.sampleStep));
    const points = [];
    for (let index = 0; index <= segments; index += 1) {
      const angle = (index / segments) * Math.PI * 2;
      points.push(
        applyMatrix(matrix, [
          cx + Math.cos(angle) * rx,
          cy + Math.sin(angle) * ry,
        ]),
      );
    }
    return [{ points, closed: true }];
  }

  return [];
}

function copyAttributes(source, target, skip = new Set()) {
  for (const attribute of Array.from(source.attributes || [])) {
    if (skip.has(attribute.name)) continue;
    if (attribute.namespaceURI === XMLNS_NS) {
      target.setAttributeNS(XMLNS_NS, attribute.name, attribute.value);
    } else if (attribute.namespaceURI) {
      target.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
    } else {
      target.setAttribute(attribute.name, attribute.value);
    }
  }
}

function matchesStyleRule(element, rule) {
  if (rule.type === 'tag') {
    return localName(element).toLowerCase() === rule.name;
  }
  if (rule.type === 'id') {
    return element.getAttribute('id') === rule.name;
  }
  if (rule.type === 'class') {
    const className = element.getAttribute('class') || '';
    return className.split(/\s+/).includes(rule.name);
  }
  return false;
}

function applyCascadeDeclarations(target, declarations, specificity, order) {
  for (const [property, value] of Object.entries(declarations)) {
    const current = target[property];
    if (!current || specificity > current.specificity || (specificity === current.specificity && order >= current.order)) {
      target[property] = { value, specificity, order };
    }
  }
}

function resolveNodeStyle(element, parentStyle, stylesheet) {
  const cascaded = {};

  for (const property of STYLE_PROPERTIES) {
    const inheritedValue = INHERITED_STYLE_PROPERTIES.has(property) ? parentStyle?.[property] : undefined;
    cascaded[property] = {
      value: inheritedValue ?? INITIAL_STYLE_DECLARATIONS[property],
      specificity: -1,
      order: -1,
    };
  }

  const presentationDeclarations = {};
  for (const property of STYLE_PROPERTIES) {
    const value = element.getAttribute(property);
    if (value) {
      presentationDeclarations[property] = value.trim();
    }
  }
  applyCascadeDeclarations(cascaded, presentationDeclarations, 0, -1);

  for (const rule of stylesheet.rules) {
    if (matchesStyleRule(element, rule)) {
      applyCascadeDeclarations(cascaded, rule.declarations, rule.specificity, rule.order);
    }
  }

  applyCascadeDeclarations(
    cascaded,
    parseStyleDeclarations(element.getAttribute('style') || ''),
    1000,
    Number.MAX_SAFE_INTEGER,
  );

  const style = {};
  for (const property of STYLE_PROPERTIES) {
    style[property] = cascaded[property]?.value ?? INITIAL_STYLE_DECLARATIONS[property];
  }

  style.displayVisible = (parentStyle?.displayVisible ?? true) && style.display !== 'none';
  style.effectiveOpacity = (parentStyle?.effectiveOpacity ?? 1) * parseOpacity(style.opacity, 1);
  return style;
}

function hasVisibleFill(style) {
  if (!style?.displayVisible) return false;
  if ((style.visibility || 'visible') === 'hidden') return false;
  if (style.effectiveOpacity <= 0) return false;
  if (parseOpacity(style['fill-opacity'], 1) <= 0) return false;
  const fillValue = (style.fill || '').trim().toLowerCase();
  return Boolean(fillValue) && fillValue !== 'none';
}

function hasVisibleStroke(style) {
  if (!style?.displayVisible) return false;
  if ((style.visibility || 'visible') === 'hidden') return false;
  if (style.effectiveOpacity <= 0) return false;
  if (parseOpacity(style['stroke-opacity'], 1) <= 0) return false;
  const strokeValue = (style.stroke || '').trim().toLowerCase();
  return Boolean(strokeValue) && strokeValue !== 'none';
}

function replaceNode(node, replacement) {
  const parent = node.parentNode;
  if (!parent) return;
  parent.replaceChild(replacement, node);
}

function replaceNodeWithMany(node, replacements) {
  if (!replacements.length) return;
  if (replacements.length === 1) {
    replaceNode(node, replacements[0]);
    return;
  }

  const parent = node.parentNode;
  if (!parent) return;
  const nextSibling = node.nextSibling;
  for (const replacement of replacements) {
    parent.insertBefore(replacement, nextSibling);
  }
  parent.removeChild(node);
}

function findDirectChildByLocalName(node, name) {
  return Array.from(node.childNodes || []).find(
    (child) => child.nodeType === 1 && localName(child) === name,
  ) || null;
}

function getTextAnchor(element) {
  const xValues = parseFloatList(element.getAttribute('x'));
  const yValues = parseFloatList(element.getAttribute('y'));
  if (xValues.length && yValues.length) {
    return [xValues[0], yValues[0]];
  }
  return [0, 0];
}

function isBackgroundRect(element, context) {
  return element === context.frame.element;
}

function getPolarSpanInfo(subpath, context) {
  const tolerance = Math.max(1, context.frame.width * 0.002);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of subpath.points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const spansWidth = minX <= context.frame.x + tolerance && maxX >= context.frame.x + context.frame.width - tolerance;
  const touchesSouth = maxY >= context.frame.y + context.frame.height - tolerance;
  const touchesNorth = minY <= context.frame.y + tolerance;
  return {
    tolerance,
    minX,
    maxX,
    minY,
    maxY,
    spansWidth,
    touchesSouth,
    touchesNorth,
  };
}

function isPolarSpanningOpenAreaSubpath(subpath, context) {
  if (subpath.closed) return false;
  const span = getPolarSpanInfo(subpath, context);
  return span.spansWidth && (span.touchesSouth || span.touchesNorth);
}

// ---- 塗りの投影 -------------------------------------------------------------------------------
// Peirce quincuncial の正方形の縁は、球面上では南極から赤道へ伸びる 4 本の切れ目 (半分の子午線) になる。
// 塗りの輪は球面上でこの切れ目と交わる所で切り、切った鎖をそれぞれ投影してから、正方形の周に沿って
// 時計回りに次の鎖の始まりへつないで閉じる。輪の内側を右手に見て回る向きに揃えてあるので、閉じる向きは
// いつも時計回りでよい (片ごとに短い方を選ぶと、切れ目をまたぐ塗りが正方形を横切って閉じてしまう)。
//
// 「極の座標」は、投影の中心 (北極) を極に、正方形の四隅 (南極) を反対の極に取った球面座標で、
// 切れ目はこの座標で、南半球の 4 本の子午線 (createPeirceCutFrame の cutLongitudes) になる。
const RADIANS = Math.PI / 180;
const CUT_NUDGE = 1e-7;

function toVector([lon, lat]) {
  const l = lon * RADIANS;
  const p = lat * RADIANS;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
}

function toLonLat([x, y, z]) {
  return [Math.atan2(y, x) / RADIANS, Math.asin(Math.max(-1, Math.min(1, z / Math.hypot(x, y, z)))) / RADIANS];
}

export function createPeirceCutFrame(projection, side) {
  // 投影の既定の回転の後で (0, 0) が正方形の中央、(180, 0) が四隅に来る。これを北極・南極に移す。
  const projectionRotation = geoRotation(projection.rotate());
  const toPolarRotation = geoRotation([0, -90]);
  const orientedToPolar = (lonLat) => toPolarRotation.invert(projectionRotation(lonLat));
  const polarToOriented = (lonLat) => projectionRotation.invert(toPolarRotation(lonLat));

  // 正方形の辺の中点 (切れ目の先端) を逆投影して、切れ目の経度を求める。
  const raw = geoPeirceQuincuncial().rotate([0, 0, 0]).fitExtent([[-1, -1], [1, 1]], { type: 'Sphere' });
  const cutLongitudes = [[0, -1], [1, 0], [0, 1], [-1, 0]]
    .map((point) => toPolarRotation.invert(raw.invert(point.map((value) => value * (1 - 1e-9))))[0])
    .sort((a, b) => a - b);

  const corners = [[0, 0], [side, 0], [side, side], [0, side]];
  const perimeterPosition = ([x, y]) => {
    // 時計回り (上の辺を右へ、右の辺を下へ……) に増える周上の位置。
    const distances = [Math.abs(y), Math.abs(x - side), Math.abs(y - side), Math.abs(x)];
    const edge = distances.indexOf(Math.min(...distances));
    if (edge === 0) return x;
    if (edge === 1) return side + y;
    if (edge === 2) return side * 3 - x;
    return (side * 4 - y) % (side * 4);
  };
  const snapToEdge = ([x, y]) => {
    const distances = [Math.abs(y), Math.abs(x - side), Math.abs(y - side), Math.abs(x)];
    const edge = distances.indexOf(Math.min(...distances));
    const clamp = (value) => Math.max(0, Math.min(side, value));
    if (edge === 0) return [clamp(x), 0];
    if (edge === 1) return [side, clamp(y)];
    if (edge === 2) return [clamp(x), side];
    return [0, clamp(y)];
  };

  // 切れ目 k の片側 (経度が増える側 +1・減る側 -1) が、周のどの半辺に乗り、緯度が上がると周上の位置が
  // 増えるか減るかを、切れ目の途中の 2 点を投影して決めておく。交点の並びは、この半辺の番号と緯度だけで
  // 決めるので、投影した座標の丸めに左右されない。
  const halfEdges = cutLongitudes.map((lon) => [-1, 1].map((sign) => {
    const sample = (lat) => perimeterPosition(projection(polarToOriented([lon + sign * 1e-4, lat])));
    const low = sample(-60);
    const high = sample(-30);
    return { index: Math.floor(low / (side / 2)), increasing: high > low };
  }));

  return { orientedToPolar, polarToOriented, cutLongitudes, halfEdges, corners, perimeterPosition, snapToEdge };
}

// 極の座標で、点 a から b への大円の弧が切れ目と交わる所を、a からの割合の順に返す。
function findCutCrossings(a, b, frame) {
  const crossings = [];
  const va = toVector(a);
  const vb = toVector(b);
  frame.cutLongitudes.forEach((lon, cut) => {
    const l = lon * RADIANS;
    const normal = [-Math.sin(l), Math.cos(l), 0];
    const sa = normal[0] * va[0] + normal[1] * va[1];
    const sb = normal[0] * vb[0] + normal[1] * vb[1];
    if ((sa < 0) === (sb < 0)) return;
    const t = sa / (sa - sb);
    const point = [va[0] + (vb[0] - va[0]) * t, va[1] + (vb[1] - va[1]) * t, va[2] + (vb[2] - va[2]) * t];
    if (point[2] >= 0) return;
    if (Math.cos(l) * point[0] + Math.sin(l) * point[1] < 0) return;
    crossings.push({ t, cut, lat: toLonLat(point)[1], from: sa < 0 ? -1 : 1, to: sb < 0 ? -1 : 1 });
  });
  return crossings.sort((x, y) => x.t - y.t);
}

// 切れ目のちょうど上や南極にある頂点は、どちらの縁に描くかが決まらないので、隣の頂点の側へわずかに寄せる。
function moveVerticesOffCuts(ring, frame) {
  const sideOf = (point) => {
    let best = null;
    frame.cutLongitudes.forEach((lon, cut) => {
      const delta = normalizeLongitude(point[0] - lon);
      if (point[1] < 0 && Math.abs(delta) < CUT_NUDGE && (!best || Math.abs(delta) < Math.abs(best.delta))) {
        best = { cut, delta };
      }
    });
    return best;
  };
  const moved = ring.map((point) => [point[0], Math.max(point[1], -90 + CUT_NUDGE)]);
  for (let index = 0; index < moved.length; index += 1) {
    const onCut = sideOf(moved[index]);
    if (!onCut) continue;
    const lon = frame.cutLongitudes[onCut.cut];
    let sign = 0;
    for (let offset = 1; offset < moved.length && !sign; offset += 1) {
      for (const neighbor of [moved[(index + offset) % moved.length], moved[(index - offset + moved.length) % moved.length]]) {
        const delta = normalizeLongitude(neighbor[0] - lon);
        if (Math.abs(delta) >= CUT_NUDGE * 4) {
          sign = Math.sign(delta);
          break;
        }
      }
    }
    moved[index] = [lon + (sign || 1) * CUT_NUDGE * 2, moved[index][1]];
  }
  return moved;
}

function projectLine(projection, coordinates) {
  const points = [];
  const stream = projection.stream({
    point(x, y) {
      points.push([x, y]);
    },
    lineStart() {},
    lineEnd() {},
    polygonStart() {},
    polygonEnd() {},
    sphere() {},
  });
  stream.lineStart();
  for (const [lon, lat] of coordinates) stream.point(lon, lat);
  stream.lineEnd();
  return points;
}

function crossingKey(crossing, side, frame) {
  // 周上の位置の代わりに使う、時計回りに増える値。半辺ごとに 90 刻みで、半辺の中は緯度で並べる。
  const halfEdge = frame.halfEdges[crossing.cut][side < 0 ? 0 : 1];
  const along = crossing.lat + 90;
  return halfEdge.index * 90 + (halfEdge.increasing ? along : 90 - along);
}

function crossingPoint(crossing, side, frame) {
  const lon = frame.cutLongitudes[crossing.cut] + side * CUT_NUDGE;
  return frame.polarToOriented([lon, Math.max(crossing.lat, -90 + CUT_NUDGE)]);
}

/**
 * 経度・緯度の平面で輪が囲む領域が、球面に占める割合。∬cosφ dφdλ = ∮ sinφ dλ (グリーンの定理) で、輪の向きにも
 * 輪が自分と交わるかにもよらず、平面での面積に応じた値になる。地図の下端 (φ = -90) を通る極の輪も正しく測る。
 */
export function planarRegionSphereFraction(lonLatPoints) {
  let sum = 0;
  for (let index = 0; index < lonLatPoints.length; index += 1) {
    const [lon0, lat0] = lonLatPoints[index];
    const [lon1, lat1] = lonLatPoints[(index + 1) % lonLatPoints.length];
    sum += (lon1 - lon0) * RADIANS * (Math.sin(lat0 * RADIANS) + Math.sin(lat1 * RADIANS)) / 2;
  }
  return Math.abs(sum) / (4 * Math.PI);
}

/**
 * 向きを決めた後の球面座標 (経度・緯度) の輪を、塗りとして正方形へ投影する。輪は内側を右手に見る向き
 * (d3 の多角形の外周の向き) で、sphereFraction はその内側が球面に占める割合 (planarRegionSphereFraction)。
 * 返すのは、別々の path にしてよい閉じた多角形の一覧と、輪の外側が正方形の縁を全部含むときの
 * 「正方形から輪をくり抜いた」一つの path。
 */
export function projectSphericalAreaRing(ring, projection, frame, side, sphereFraction) {
  // 自分と交わる細い輪 (行って戻るだけの筋など) は、切れ目の所の向きが輪全体の向きと食い違い、時計回りに
  // 閉じると正方形を一周してしまう。正方形に占める割合が球面に占める割合から大きく離れたら、逆向きの輪の
  // 結果 (補集合) と比べて近い方を採る。自分と交わらない輪では、両者の差は投影の面積の歪みの分しかない。
  const result = projectOrientedAreaRing(ring, projection, frame, side);
  const squareFraction = projectedAreaFraction(result, side);
  if (Math.abs(squareFraction - sphereFraction) <= 0.25) return result;
  const reversed = projectOrientedAreaRing([...ring].reverse(), projection, frame, side);
  const reversedFraction = projectedAreaFraction(reversed, side);
  return Math.abs(reversedFraction - sphereFraction) < Math.abs(squareFraction - sphereFraction) ? reversed : result;
}

function projectedAreaFraction({ polygons, holed }, side) {
  let area = polygons.reduce((sum, polygon) => sum + Math.abs(computeSignedPolygonArea(polygon)), 0);
  if (holed) area += side * side - Math.abs(computeSignedPolygonArea(holed[1]));
  return area / (side * side);
}

// 輪を切れ目で切り、周に沿って時計回りに閉じる本体。自分と交わる輪への備えを通さない (試験で閉じる向きを確かめるために公開する)。
export function projectOrientedAreaRing(ring, projection, frame, side) {
  const polar = moveVerticesOffCuts(ring.map((point) => frame.orientedToPolar(point)), frame);
  const closedPolar = pointsEqual(polar[0], polar[polar.length - 1], 0) ? polar.slice(0, -1) : polar;
  if (closedPolar.length < 3) return { polygons: [], holed: null };

  // 輪を切れ目で切って鎖にする。鎖は (入る交点, 輪の頂点…, 出る交点)。
  const events = [];
  for (let index = 0; index < closedPolar.length; index += 1) {
    const a = closedPolar[index];
    const b = closedPolar[(index + 1) % closedPolar.length];
    for (const crossing of findCutCrossings(a, b, frame)) events.push({ index, crossing });
  }

  const toOriented = (point) => frame.polarToOriented(point);
  if (!events.length) {
    const projected = projectLine(projection, [...closedPolar, closedPolar[0]].map(toOriented));
    if (!hasRenderablePolygon(projected, side * side * 1e-12)) return { polygons: [], holed: null };
    const southPole = frame.polarToOriented([0, -90]);
    const outsideContainsCorners = geoContains({ type: 'Polygon', coordinates: [[...ring, ring[0]]] }, southPole);
    if (!outsideContainsCorners) return { polygons: [projected], holed: null };
    return { polygons: [], holed: [frame.corners, projected] };
  }

  // events は (辺の番号, 辺の上の割合) の順。交点 order の次の鎖は、その辺の終わりの頂点から、次の交点が乗る
  // 辺の始まりの頂点まで。最後の交点からは輪を一周して最初の交点へ戻る。
  const n = closedPolar.length;
  const chains = events.map((event, order) => {
    const next = events[(order + 1) % events.length];
    let count = (next.index - event.index + n) % n;
    if (count === 0 && order === events.length - 1) count = n;
    const points = [crossingPoint(event.crossing, event.crossing.to, frame)];
    for (let step = 1; step <= count; step += 1) {
      points.push(toOriented(closedPolar[(event.index + step) % n]));
    }
    points.push(crossingPoint(next.crossing, next.crossing.from, frame));
    return {
      projected: projectLine(projection, points),
      startKey: crossingKey(event.crossing, event.crossing.to, frame),
      endKey: crossingKey(next.crossing, next.crossing.from, frame),
    };
  });

  return { polygons: rejoinChainsAlongSquare(chains, frame), holed: null };
}

function rejoinChainsAlongSquare(chains, frame) {
  const period = 8 * 90;
  const cornerKeys = [0, 2, 4, 6].map((halfEdge) => halfEdge * 90);
  const forward = (from, to) => ((to - from) % period + period) % period;
  const used = new Set();
  const polygons = [];

  for (let first = 0; first < chains.length; first += 1) {
    if (used.has(first)) continue;
    const points = [];
    let current = first;
    while (!used.has(current)) {
      used.add(current);
      const chain = chains[current];
      points.push(...chain.projected.slice(1, -1));
      points.push(frame.snapToEdge(chain.projected[chain.projected.length - 1]));
      // 出た所から時計回りに、いちばん近い鎖の始まりへ進む。
      let next = first;
      let best = Infinity;
      chains.forEach((candidate, index) => {
        if (used.has(index) && index !== first) return;
        const distance = forward(chain.endKey, candidate.startKey);
        if (distance < best) {
          best = distance;
          next = index;
        }
      });
      cornerKeys
        .map((key, corner) => ({ corner, distance: forward(chain.endKey, key) }))
        .filter(({ distance }) => distance > 0 && distance < best)
        .sort((a, b) => a.distance - b.distance)
        .forEach(({ corner }) => points.push(frame.corners[corner]));
      points.push(frame.snapToEdge(chains[next].projected[0]));
      current = next;
    }
    if (hasRenderablePolygon(points, 1e-12)) polygons.push(points);
  }
  return polygons;
}

function shouldProjectSubpathAsArea(element, subpath, style, context) {
  if (subpath.points.length < 3 || !hasVisibleFill(style)) return false;
  if (!hasVisibleStroke(style)) return true;
  // 線も持つ塗りは、閉じていれば輪郭線として描く。開いたまま地図の幅いっぱいに渡って南北の端に触れるもの
  // (極を囲む塗り) だけは塗りとして描く。
  const tag = localName(element);
  return !subpath.closed && (tag === 'path' || tag === 'polyline') && isPolarSpanningOpenAreaSubpath(subpath, context);
}

// 元の正距円筒の平面での塗りの輪を、球面の多角形として投影する。平面で反時計回り (経度を右・緯度を上に
// 取ったとき) の輪は内側が左にあるので、内側が右に来るよう逆にしてから向きの回転をかける。極を囲む輪
// (地図の幅いっぱいに渡る輪) も、この向きで極の側が内側になる。
function buildProjectedAreaParts(points, context) {
  const original = points.map((point) => sourcePointToOriginalLonLat(point, context));
  const planarArea = computeSignedPolygonArea(original);
  if (!planarArea) return [];
  // 地図の上端・下端に乗る頂点は球面では極の 1 点に重なり、経度が意味を持たない。極を囲む輪は極を通らなくても
  // 囲む向きで決まるので、極の上の頂点は輪から外す。
  const wound = (planarArea > 0 ? [...original].reverse() : original)
    .filter(([, lat]) => Math.abs(lat) < 90 - 1e-9);
  const ring = dedupeSequentialPoints(wound.map((lonLat) => orientLonLat(lonLat, context)).filter(Boolean), 1e-12);
  if (ring.length < 3) return [];
  const { polygons, holed } = projectSphericalAreaRing(
    ring,
    context.areaProjection,
    context.cutFrame,
    context.side,
    planarRegionSphereFraction(original),
  );
  const parts = polygons.map((polygon) => buildPathDataFromPoints(polygon, true)).filter(Boolean);
  if (holed) {
    parts.push({ pathData: holed.map((polygon) => buildPathDataFromPoints(polygon, true)).join(''), fillRule: 'evenodd' });
  }
  return parts;
}

function buildProjectedPath(element, matrix, style, context) {
  const subpaths = sampleGeometry(element, matrix, context.options);
  const parts = [];

  for (const subpath of subpaths) {
    if (!subpath.points.length) continue;
    if (shouldProjectSubpathAsArea(element, subpath, style, context)) {
      parts.push(...buildProjectedAreaParts(subpath.points, context));
      continue;
    }

    const orientedSubpath = transformSubpathToFrame(subpath, context);
    if (!orientedSubpath.points.length) continue;
    const points = unwrapPeriodicX(orientedSubpath.points, context.frame.width);
    const coordinates = points.map((point) => framePointToLonLat(point, context));
    if (subpath.closed) {
      if (coordinates.length < 3) continue;
      const ring = closeCoordinateRing(coordinates);
      const projected = context.pathBuilder({ type: 'LineString', coordinates: ring }) || '';
      const closedProjected = stripWorldBoundarySubpaths(closeProjectedPath(projected), context.side);
      if (closedProjected) parts.push(closedProjected);
    } else if (coordinates.length >= 2) {
      const projected = buildProjectedOpenLinePath(coordinates, context);
      if (projected) parts.push(projected);
    }
  }

  return parts;
}

function replaceGeometryNode(element, matrix, style, context) {
  if (isBackgroundRect(element, context)) {
    const rect = context.document.createElementNS(SVG_NS, 'rect');
    copyAttributes(element, rect, new Set(['x', 'y', 'width', 'height', 'transform']));
    rect.setAttribute('x', '0');
    rect.setAttribute('y', '0');
    rect.setAttribute('width', formatNumber(context.side));
    rect.setAttribute('height', formatNumber(context.side));
    rect.setAttribute('data-pq-role', 'background');
    replaceNode(element, rect);
    context.stats.backgroundRect = true;
    return;
  }

  // 文字列の部分は subpath ごとに別の path へ分ける。くり抜きのある塗り ({ pathData, fillRule }) は一つの path のまま出す。
  const parts = buildProjectedPath(element, matrix, style, context);
  const atomicParts = parts.flatMap((part) => (
    typeof part === 'string' ? explodePathDataToAtomicParts(part).map((pathData) => ({ pathData })) : [part]
  ));
  const outputParts = atomicParts.length ? atomicParts : [{ pathData: '' }];
  const replacements = outputParts.map(({ pathData, fillRule }, index) => {
    const pathElement = context.document.createElementNS(SVG_NS, 'path');
    const skip = new Set(GEOMETRY_ATTRIBUTES);
    if (index > 0) skip.add('id');
    copyAttributes(element, pathElement, skip);
    pathElement.setAttribute('d', pathData);
    if (fillRule) {
      pathElement.setAttribute('fill-rule', fillRule);
    }
    if (outputParts.length > 1) {
      pathElement.setAttribute('data-pq-fragment', `${index + 1}/${outputParts.length}`);
    }
    if (localName(element) !== 'path') {
      pathElement.setAttribute('data-pq-source-tag', localName(element));
    }
    return pathElement;
  });

  replaceNodeWithMany(element, replacements);
  context.stats.geometryCount += replacements.length;
}

function transformTextNode(element, matrix, context) {
  const anchor = getTextAnchor(element);
  const sourceAnchor = applyMatrix(matrix, anchor);
  const sourceLonLat = sourcePointToOriginalLonLat(sourceAnchor, context);
  const lonLat = orientLonLat(sourceLonLat, context);
  if (!lonLat) {
    element.setAttribute('display', 'none');
    return;
  }
  const projected = context.projection(lonLat);
  if (!projected || !Number.isFinite(projected[0]) || !Number.isFinite(projected[1])) {
    element.setAttribute('display', 'none');
    return;
  }

  const translate = `translate(${formatNumber(projected[0])} ${formatNumber(projected[1])})`;
  element.setAttribute('transform', translate);
  element.removeAttribute('x');
  element.removeAttribute('y');
  element.setAttribute('data-pq-lon', formatNumber(lonLat[0], 4));
  element.setAttribute('data-pq-lat', formatNumber(lonLat[1], 4));
  element.setAttribute('data-pq-source-lon', formatNumber(sourceLonLat[0], 4));
  element.setAttribute('data-pq-source-lat', formatNumber(sourceLonLat[1], 4));
  context.stats.textCount += 1;
}

function buildCoordinateRange(start, end, step) {
  const values = [];
  if (start <= end) {
    for (let value = start; value <= end + 1e-9; value += step) {
      values.push(Number(value.toFixed(6)));
    }
    if (values[values.length - 1] !== end) values.push(end);
    return values;
  }

  for (let value = start; value >= end - 1e-9; value -= step) {
    values.push(Number(value.toFixed(6)));
  }
  if (values[values.length - 1] !== end) values.push(end);
  return values;
}

function buildProjectedLineFromLonLat(coordinates, context) {
  const orientedCoordinates = coordinates
    .map((coordinate) => orientLonLat(coordinate, context))
    .filter(Boolean);
  if (orientedCoordinates.length < 2) return '';
  return buildProjectedOpenLinePath(orientedCoordinates, context);
}

function replaceGraticuleGroup(group, context) {
  while (group.firstChild) {
    group.removeChild(group.firstChild);
  }

  const grid30 = context.document.createElementNS(SVG_NS, 'g');
  grid30.setAttribute('id', '_30_');
  grid30.setAttribute('data-name', '30°');

  for (const latitude of GENERATED_GRATICULE_LATITUDES) {
    const path = context.document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'cls-26');
    path.setAttribute(
      'd',
      buildProjectedLineFromLonLat(
        buildCoordinateRange(-180, 180, GRATICULE_SAMPLE_STEP).map((longitude) => [longitude, latitude]),
        context,
      ),
    );
    path.setAttribute('data-pq-generated', `parallel-${latitude}`);
    grid30.appendChild(path);
  }

  for (const longitude of GENERATED_GRATICULE_LONGITUDES) {
    const path = context.document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'cls-26');
    path.setAttribute(
      'd',
      buildProjectedLineFromLonLat(
        buildCoordinateRange(89.999, -89.999, GRATICULE_SAMPLE_STEP).map((latitude) => [longitude, latitude]),
        context,
      ),
    );
    path.setAttribute('data-pq-generated', `meridian-${longitude}`);
    grid30.appendChild(path);
  }

  const equator = context.document.createElementNS(SVG_NS, 'path');
  equator.setAttribute('id', '_赤道');
  equator.setAttribute('data-name', '赤道');
  equator.setAttribute('class', 'cls-82');
  equator.setAttribute(
    'd',
    buildProjectedLineFromLonLat(
      buildCoordinateRange(-180, 180, GRATICULE_SAMPLE_STEP).map((longitude) => [longitude, 0]),
      context,
    ),
  );
  equator.setAttribute('data-pq-generated', 'equator');

  group.appendChild(grid30);
  group.appendChild(equator);
}

function walkTree(node, parentMatrix, parentStyle, context, inDefinitions = false) {
  if (node.nodeType !== 1) return;
  const tag = localName(node);
  const localMatrix = parseTransform(node.getAttribute('transform'));
  const matrix = matrixMultiply(parentMatrix, localMatrix);
  const style = resolveNodeStyle(node, parentStyle, context.stylesheet);
  const nextInDefinitions = inDefinitions || DEFINITION_TAGS.has(tag);

  if (!nextInDefinitions && GEOMETRY_TAGS.has(tag)) {
    replaceGeometryNode(node, matrix, style, context);
    return;
  }

  if (!nextInDefinitions && tag === 'g' && node.getAttribute('id') === '_経緯線') {
    replaceGraticuleGroup(node, context);
    return;
  }

  if (!nextInDefinitions && tag === 'text') {
    transformTextNode(node, matrix, context);
  }

  if (!nextInDefinitions && tag !== 'text' && !isIdentityMatrix(localMatrix)) {
    node.removeAttribute('transform');
  }

  const children = Array.from(node.childNodes);
  for (const child of children) {
    walkTree(child, matrix, style, context, nextInDefinitions);
  }
}

function ensureDefs(root, document) {
  let defs = findDirectChildByLocalName(root, 'defs');
  if (!defs) {
    defs = document.createElementNS(SVG_NS, 'defs');
    root.insertBefore(defs, root.firstChild);
  }
  return defs;
}

function finalizeDocument(root, context) {
  const defs = ensureDefs(root, context.document);
  const clipId = `pq-clip-${Math.random().toString(36).slice(2, 10)}`;
  const clipPath = context.document.createElementNS(SVG_NS, 'clipPath');
  clipPath.setAttribute('id', clipId);
  const clipPathShape = context.document.createElementNS(SVG_NS, 'rect');
  clipPathShape.setAttribute('x', '0');
  clipPathShape.setAttribute('y', '0');
  clipPathShape.setAttribute('width', formatNumber(context.side));
  clipPathShape.setAttribute('height', formatNumber(context.side));
  clipPath.appendChild(clipPathShape);
  defs.appendChild(clipPath);

  const contentGroup = context.document.createElementNS(SVG_NS, 'g');
  contentGroup.setAttribute('id', 'pq-content');
  contentGroup.setAttribute('clip-path', `url(#${clipId})`);

  const preserved = new Set(['defs', 'metadata', 'title', 'desc']);
  const movableChildren = Array.from(root.childNodes).filter(
    (child) => child.nodeType !== 1 || !preserved.has(localName(child)),
  );
  for (const child of movableChildren) {
    contentGroup.appendChild(child);
  }
  root.appendChild(contentGroup);

  root.setAttribute('viewBox', `0 0 ${formatNumber(context.side)} ${formatNumber(context.side)}`);
  root.setAttribute('width', formatNumber(context.side * context.sourceScale));
  root.setAttribute('height', formatNumber(context.side * context.sourceScale));
  root.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  root.setAttribute('data-pq-projection', 'peirce-quincuncial');
  root.setAttribute('data-pq-lon0', formatNumber(context.centerLon, 4));
  root.setAttribute('data-pq-center-lon', formatNumber(context.centerLon, 4));
  root.setAttribute('data-pq-center-lat', formatNumber(context.centerLat, 4));
  root.setAttribute('data-pq-roll', formatNumber(context.roll, 4));
}

function createContext(document, root, options) {
  const viewBox = getViewBox(root);
  const frame = findMapFrame(root);
  const side = options.outputSide || frame.width || viewBox.width || 2048;
  const sourceScale = detectSourceScale(root, viewBox) || 1;
  const { projection, pathBuilder, areaProjection, cutFrame } = buildProjection(side, options.pathPrecision);
  return {
    document,
    root,
    frame,
    stylesheet: parseStylesheet(root),
    side,
    sourceScale,
    centerLon: options.centerLon,
    centerLat: options.centerLat,
    roll: options.roll,
    rotation: geoRotation([-options.centerLon, -options.centerLat, options.roll]),
    projection,
    pathBuilder,
    areaProjection,
    cutFrame,
    options,
    stats: {
      geometryCount: 0,
      textCount: 0,
      backgroundRect: false,
      outputSide: side,
      centerLon: options.centerLon,
      centerLat: options.centerLat,
      roll: options.roll,
    },
  };
}

export const DEFAULT_OPTIONS = {
  centerLon: -143,
  centerLat: 0,
  roll: 0,
  lon0: -143,
  sampleStep: 3,
  pathPrecision: 0.35,
  outputSide: null,
};

function normalizeTransformOptions(options = {}) {
  const centerLon = Number.isFinite(options.centerLon)
    ? options.centerLon
    : Number.isFinite(options.lon0)
      ? options.lon0
      : DEFAULT_OPTIONS.centerLon;
  const centerLat = Number.isFinite(options.centerLat) ? options.centerLat : DEFAULT_OPTIONS.centerLat;
  const roll = Number.isFinite(options.roll) ? options.roll : DEFAULT_OPTIONS.roll;
  // 刻み幅が 0 だと線分の分割が終わらず、メモリを使い切る。
  for (const key of ['sampleStep', 'pathPrecision']) {
    if (options[key] !== undefined && !(Number.isFinite(options[key]) && options[key] > 0)) {
      throw new Error(`${key} must be a positive number.`);
    }
  }
  return {
    ...DEFAULT_OPTIONS,
    ...options,
    centerLon,
    centerLat,
    roll,
    lon0: centerLon,
  };
}

export async function transformSvgString(svgText, options = {}, domImpl = {}) {
  const mergedOptions = normalizeTransformOptions(options);
  const { DOMParserImpl, XMLSerializerImpl } = getDomImpl(domImpl);
  const parser = new DOMParserImpl();
  const serializer = new XMLSerializerImpl();
  const document = parser.parseFromString(svgText, 'image/svg+xml');
  const root = document.documentElement;
  if (!root || localName(root) !== 'svg') {
    throw new Error('Input is not a valid SVG document.');
  }

  const parserErrors = document.getElementsByTagName('parsererror');
  if (parserErrors.length > 0) {
    throw new Error('SVG parsing failed.');
  }

  const context = createContext(document, root, mergedOptions);
  walkTree(root, IDENTITY_MATRIX, null, context, false);
  finalizeDocument(root, context);

  return {
    svgText: serializer.serializeToString(document),
    stats: context.stats,
  };
}
