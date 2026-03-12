import { geoPath } from 'd3-geo';
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
const GENERATED_GRATICULE_LONGITUDES = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150];
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
  return { projection, pathBuilder };
}

function sourcePointToLonLat(point, context) {
  const lon = ((point[0] - context.frame.x) / context.frame.width) * 360 - 180 - context.lon0;
  const lat = 90 - ((point[1] - context.frame.y) / context.frame.height) * 180;
  return [lon, lat];
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

function snapPathToSquare(pathData, side, tolerance = 0.05) {
  if (!pathData) return pathData;
  let changed = false;
  const commands = new SVGPathData(pathData).toAbs().commands.map((command) => {
    const next = { ...command };
    for (const key of ['x', 'x1', 'x2']) {
      if (Number.isFinite(next[key])) {
        const snapped = snapEdgeCoordinate(next[key], side, tolerance);
        changed ||= snapped !== next[key];
        next[key] = snapped;
      }
    }
    for (const key of ['y', 'y1', 'y2']) {
      if (Number.isFinite(next[key])) {
        const snapped = snapEdgeCoordinate(next[key], side, tolerance);
        changed ||= snapped !== next[key];
        next[key] = snapped;
      }
    }
    return next;
  });
  return changed ? new SVGPathData(commands).encode() : pathData;
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

function isSouthPolarSpanningFilledSubpath(subpath, style, context) {
  if (subpath.points.length < 3 || !hasVisibleFill(style)) return false;
  const span = getPolarSpanInfo(subpath, context);
  return span.spansWidth && span.touchesSouth;
}

function getPolarSeamX(context) {
  const seamLongitude = normalizeLongitude(context.lon0 - 180);
  return context.frame.x + ((seamLongitude + 180) / 360) * context.frame.width;
}

function shiftPointsAroundSeam(points, seamX, period) {
  return points.map(([x, y]) => [x < seamX ? x + period : x, y]);
}

function clipPolygonWithVerticalBoundary(points, boundaryX, keepGreater) {
  if (!points.length) return [];
  const output = [];
  const isInside = (point) => (keepGreater ? point[0] >= boundaryX : point[0] <= boundaryX);
  const intersect = (start, end) => {
    const deltaX = end[0] - start[0];
    if (deltaX === 0) return [boundaryX, start[1]];
    const t = (boundaryX - start[0]) / deltaX;
    return [boundaryX, start[1] + (end[1] - start[1]) * t];
  };

  let previous = points[points.length - 1];
  let previousInside = isInside(previous);
  for (const current of points) {
    const currentInside = isInside(current);
    if (currentInside && previousInside) {
      output.push(current);
    } else if (previousInside && !currentInside) {
      output.push(intersect(previous, current));
    } else if (!previousInside && currentInside) {
      output.push(intersect(previous, current), current);
    }
    previous = current;
    previousInside = currentInside;
  }
  return output;
}

function clipPolygonToVerticalBand(points, minX, maxX) {
  const leftClipped = clipPolygonWithVerticalBoundary(points, minX, true);
  if (!leftClipped.length) return [];
  return clipPolygonWithVerticalBoundary(leftClipped, maxX, false);
}

function getCyclicTrueRuns(flags) {
  const runs = [];
  let start = -1;

  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index]) {
      if (start === -1) start = index;
    } else if (start !== -1) {
      runs.push({ start, end: index - 1 });
      start = -1;
    }
  }

  if (start !== -1) {
    runs.push({ start, end: flags.length - 1 });
  }

  if (runs.length > 1 && flags[0] && flags[flags.length - 1]) {
    const first = runs[0];
    const last = runs[runs.length - 1];
    runs.splice(0, runs.length, { start: last.start, end: first.end + flags.length });
  }

  return runs;
}

function runContainsPoint(vertices, run, predicate) {
  for (let index = run.start; index <= run.end; index += 1) {
    if (predicate(vertices[index % vertices.length])) return true;
  }
  return false;
}

function extractSouthPolarCoastline(points, context) {
  const vertices = closeCoordinateRing(points).slice(0, -1);
  if (vertices.length < 4) return null;

  const leftX = context.frame.x;
  const rightX = context.frame.x + context.frame.width;
  const southY = context.frame.y + context.frame.height;
  const tolerance = Math.max(0.01, context.frame.height * 1e-4);
  const poleBandTop = southY - context.frame.height * 0.15;
  const isBottomLeft = ([x, y]) => Math.abs(x - leftX) <= tolerance && Math.abs(y - southY) <= tolerance;
  const isBottomRight = ([x, y]) => Math.abs(x - rightX) <= tolerance && Math.abs(y - southY) <= tolerance;
  const isClosureBoundaryPoint = ([x, y]) => {
    const onLeft = Math.abs(x - leftX) <= tolerance;
    const onRight = Math.abs(x - rightX) <= tolerance;
    const onSouth = Math.abs(y - southY) <= tolerance;
    return y >= poleBandTop - tolerance && (onLeft || onRight || onSouth);
  };

  const runs = getCyclicTrueRuns(vertices.map(isClosureBoundaryPoint));
  const closureRun = runs
    .filter(
      (run) => runContainsPoint(vertices, run, isBottomLeft) && runContainsPoint(vertices, run, isBottomRight),
    )
    .sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];

  if (!closureRun) return null;

  const coastline = [];
  const count = vertices.length;
  const start = closureRun.end % count;
  const end = closureRun.start % count;
  let index = start;

  while (true) {
    coastline.push(vertices[index]);
    if (index === end) break;
    index = (index + 1) % count;
    if (coastline.length > count) return null;
  }

  return dedupeSequentialPoints(coastline);
}

function clipLineSegmentToVerticalBand(start, end, minX, maxX) {
  const deltaX = end[0] - start[0];
  let t0 = 0;
  let t1 = 1;

  if (deltaX === 0) {
    if (start[0] < minX || start[0] > maxX) return null;
  } else {
    const tx1 = (minX - start[0]) / deltaX;
    const tx2 = (maxX - start[0]) / deltaX;
    t0 = Math.max(t0, Math.min(tx1, tx2));
    t1 = Math.min(t1, Math.max(tx1, tx2));
    if (t0 > t1) return null;
  }

  return [lerp(start, end, t0), lerp(start, end, t1), t0, t1];
}

function clipPolylineToVerticalBand(points, minX, maxX) {
  if (points.length < 2) return [];
  const tolerance = 1e-6;
  const inside = ([x]) => x >= minX - tolerance && x <= maxX + tolerance;
  const segments = [];
  let current = null;

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const clipped = clipLineSegmentToVerticalBand(start, end, minX, maxX);

    if (!clipped) {
      if (current?.length >= 2) segments.push(dedupeSequentialPoints(current));
      current = null;
      continue;
    }

    const [clippedStart, clippedEnd, , t1] = clipped;
    if (!current) {
      current = [clippedStart, clippedEnd];
    } else if (pointsEqual(current[current.length - 1], clippedStart, tolerance)) {
      current.push(clippedEnd);
    } else {
      if (current.length >= 2) segments.push(dedupeSequentialPoints(current));
      current = [clippedStart, clippedEnd];
    }

    if (!inside(end) || t1 < 1 - tolerance) {
      if (current.length >= 2) segments.push(dedupeSequentialPoints(current));
      current = null;
    }
  }

  if (current?.length >= 2) segments.push(dedupeSequentialPoints(current));
  return segments;
}

function splitPolylineAtLargeXJumps(points, threshold, period = null, wrapStart = null) {
  if (points.length < 2) return points.length ? [points] : [];
  const segments = [];
  let current = [points[0]];

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    if (Math.abs(point[0] - previous[0]) > threshold) {
      if (period && Number.isFinite(wrapStart)) {
        const wrapEnd = wrapStart + period;
        const jumpedForward = point[0] > previous[0];
        const boundaryA = jumpedForward ? wrapStart : wrapEnd;
        const boundaryB = jumpedForward ? wrapEnd : wrapStart;
        const adjustedPointX = jumpedForward ? point[0] - period : point[0] + period;
        const deltaX = adjustedPointX - previous[0];
        const t = deltaX === 0 ? 0.5 : (boundaryA - previous[0]) / deltaX;
        const seamPointA = [boundaryA, previous[1] + (point[1] - previous[1]) * t];
        const seamPointB = [boundaryB, seamPointA[1]];
        current.push(seamPointA);
        if (current.length >= 2) segments.push(dedupeSequentialPoints(current));
        current = [seamPointB, point];
        continue;
      }

      if (current.length >= 2) segments.push(current);
      current = [point];
      continue;
    }
    current.push(point);
  }

  if (current.length >= 2) segments.push(current);
  return segments;
}

function sourceShiftedPointToLonLat(point, seamX, context) {
  return [
    ((point[0] - seamX) / context.frame.width) * 360 - 180,
    90 - ((point[1] - context.frame.y) / context.frame.height) * 180,
  ];
}

function projectShiftedPoint(point, seamX, context) {
  const projected = context.projection(sourceShiftedPointToLonLat(point, seamX, context));
  if (!projected || !Number.isFinite(projected[0]) || !Number.isFinite(projected[1])) {
    return null;
  }
  return snapPointToSquare(projected, context.side);
}

function getPolarSectorCorner(sector, side) {
  if (sector === 0) return [0, 0];
  if (sector === 1) return [0, side];
  if (sector === 2) return [side, side];
  return [side, 0];
}

function getPolarSectorEdges(sector) {
  if (sector === 0) return ['top', 'left'];
  if (sector === 1) return ['left', 'bottom'];
  if (sector === 2) return ['bottom', 'right'];
  return ['right', 'top'];
}

function distanceToSquareEdge(point, side, edge) {
  if (edge === 'left') return Math.abs(point[0]);
  if (edge === 'right') return Math.abs(point[0] - side);
  if (edge === 'top') return Math.abs(point[1]);
  return Math.abs(point[1] - side);
}

function snapPointToEdge(point, side, edge) {
  if (edge === 'left') return [0, point[1]];
  if (edge === 'right') return [side, point[1]];
  if (edge === 'top') return [point[0], 0];
  return [point[0], side];
}

function resolvePolarBoundaryEdges(sector, minX, maxX, seamX, context) {
  const allowedEdges = getPolarSectorEdges(sector);
  const sampleY = context.frame.y + context.frame.height - Math.max(0.5, context.frame.height * 0.01);
  const resolveEdge = (boundaryX) => {
    const projected = projectShiftedPoint([boundaryX, sampleY], seamX, context);
    if (!projected) return null;
    return [...allowedEdges].sort(
      (a, b) => distanceToSquareEdge(projected, context.side, a) - distanceToSquareEdge(projected, context.side, b),
    )[0];
  };

  let minEdge = resolveEdge(minX);
  let maxEdge = resolveEdge(maxX);
  if (minEdge && maxEdge && minEdge === maxEdge) {
    maxEdge = allowedEdges.find((edge) => edge !== minEdge) || maxEdge;
  }
  if (!minEdge) [minEdge] = allowedEdges;
  if (!maxEdge) maxEdge = allowedEdges.find((edge) => edge !== minEdge) || allowedEdges[1];
  return { min: minEdge, max: maxEdge };
}

function classifySectorBoundaryPoint(point, minX, maxX, tolerance = 1e-4) {
  if (Math.abs(point[0] - minX) <= tolerance) return 'min';
  if (Math.abs(point[0] - maxX) <= tolerance) return 'max';
  return null;
}

function isPointOnVerticalBoundary(point, boundaryX, tolerance = 1e-4) {
  return Math.abs(point[0] - boundaryX) <= tolerance;
}

function mergeSegmentsAcrossVerticalBoundary(segments, boundaryX, tolerance = 1e-4) {
  const output = segments.map((segment) => dedupeSequentialPoints(segment)).filter((segment) => segment.length >= 2);

  while (true) {
    let bestPair = null;

    for (let endIndex = 0; endIndex < output.length; endIndex += 1) {
      const endSegment = output[endIndex];
      const endPoint = endSegment[endSegment.length - 1];
      if (!isPointOnVerticalBoundary(endPoint, boundaryX, tolerance)) continue;

      for (let startIndex = 0; startIndex < output.length; startIndex += 1) {
        if (startIndex === endIndex) continue;
        const startSegment = output[startIndex];
        const startPoint = startSegment[0];
        if (!isPointOnVerticalBoundary(startPoint, boundaryX, tolerance)) continue;

        const gap = Math.abs(startPoint[1] - endPoint[1]);
        if (!bestPair || gap < bestPair.gap) {
          bestPair = { endIndex, startIndex, gap };
        }
      }
    }

    if (!bestPair) break;

    const { endIndex, startIndex } = bestPair;
    const first = output[endIndex];
    const second = output[startIndex];
    const merged = [...first];
    if (!pointsEqual(first[first.length - 1], second[0], tolerance)) {
      merged.push(second[0]);
    }
    merged.push(...second.slice(1));

    const next = [];
    for (let index = 0; index < output.length; index += 1) {
      if (index !== endIndex && index !== startIndex) next.push(output[index]);
    }
    next.push(dedupeSequentialPoints(merged));
    output.splice(0, output.length, ...next);
  }

  return output;
}

function buildProjectedPolarWedgePath(coastline, corner, sectorEdges, minX, maxX, seamX, context) {
  const projected = coastline
    .map((point) => projectShiftedPoint(point, seamX, context))
    .filter(Boolean);
  if (projected.length < 2) return '';

  const snapped = dedupeSequentialPoints(projected.map((point) => snapPointToSquare(point, context.side)));
  if (snapped.length < 2) return '';

  const endpointTolerance = Math.max(1e-4, context.frame.width * 1e-6);
  const firstBoundary = classifySectorBoundaryPoint(coastline[0], minX, maxX, endpointTolerance);
  const lastBoundary = classifySectorBoundaryPoint(
    coastline[coastline.length - 1],
    minX,
    maxX,
    endpointTolerance,
  );
  const allowedEdges = [...new Set(Object.values(sectorEdges).filter(Boolean))];
  const snapPolarEndpoint = (point, boundaryKind) => {
    const edge = boundaryKind && sectorEdges[boundaryKind]
      ? sectorEdges[boundaryKind]
      : [...allowedEdges].sort(
        (a, b) => distanceToSquareEdge(point, context.side, a) - distanceToSquareEdge(point, context.side, b),
      )[0];
    return edge
      ? snapPointToSquare(snapPointToEdge(point, context.side, edge), context.side)
      : point;
  };

  snapped[0] = snapPolarEndpoint(snapped[0], firstBoundary);
  snapped[snapped.length - 1] = snapPolarEndpoint(snapped[snapped.length - 1], lastBoundary);

  return buildPathDataFromPoints([...snapped, corner], true);
}

function buildPolarSectorProjectedPaths(points, context) {
  const coastline = extractSouthPolarCoastline(points, context) || points;
  if (!coastline || coastline.length < 2) return [];
  const seamX = getPolarSeamX(context);
  const shiftedSegments = splitPolylineAtLargeXJumps(
    closeCoordinateRing(shiftPointsAroundSeam(coastline, seamX, context.frame.width)),
    context.frame.width / 2,
    context.frame.width,
    seamX,
  );
  const sectorWidth = context.frame.width / 4;
  const parts = [];

  for (let sector = 0; sector < 4; sector += 1) {
    const minX = seamX + sector * sectorWidth;
    const maxX = minX + sectorWidth;
    const corner = getPolarSectorCorner(sector, context.side);
    const sectorEdges = resolvePolarBoundaryEdges(sector, minX, maxX, seamX, context);
    const clippedSegments = [];
    for (const shiftedSegment of shiftedSegments) {
      clippedSegments.push(...clipPolylineToVerticalBand(shiftedSegment, minX, maxX));
    }

    const mergedSegments = mergeSegmentsAcrossVerticalBoundary(
      clippedSegments,
      context.frame.x + context.frame.width,
      Math.max(1e-4, context.frame.width * 1e-6),
    );

    for (const segment of mergedSegments) {
      const wedgePath = buildProjectedPolarWedgePath(
        segment,
        corner,
        sectorEdges,
        minX,
        maxX,
        seamX,
        context,
      );
      if (wedgePath) {
        parts.push(wedgePath);
      }
    }
  }

  return parts;
}

function shouldProjectSubpathAsArea(element, subpath, style, context) {
  const tag = localName(element);
  if (tag !== 'path' && tag !== 'polyline') return false;
  if (subpath.closed || subpath.points.length < 3 || !hasVisibleFill(style)) return false;
  if (isPolarSpanningOpenAreaSubpath(subpath, context)) return true;
  return !hasVisibleStroke(style);
}

function buildProjectedPath(element, matrix, style, context) {
  const subpaths = sampleGeometry(element, matrix, context.options);
  const parts = [];
  let forceSplit = false;

  for (const subpath of subpaths) {
    if (!subpath.points.length) continue;
    const points = unwrapPeriodicX(subpath.points, context.frame.width);
    const isSouthPolarFill = isSouthPolarSpanningFilledSubpath(subpath, style, context) && !hasVisibleStroke(style);
    const coordinates = points.map((point) => sourcePointToLonLat(point, context));
    if (isSouthPolarFill) {
      const polarParts = buildPolarSectorProjectedPaths(points, context);
      if (polarParts.length) {
        parts.push(...polarParts);
        forceSplit ||= polarParts.length > 1;
        continue;
      }
    }

    if (subpath.closed) {
      if (coordinates.length < 3) continue;
      const ring = closeCoordinateRing(coordinates);
      const projected = context.pathBuilder({ type: 'LineString', coordinates: ring }) || '';
      const closedProjected = stripWorldBoundarySubpaths(closeProjectedPath(projected), context.side);
      if (closedProjected) parts.push(closedProjected);
    } else if (shouldProjectSubpathAsArea(element, subpath, style, context)) {
      if (coordinates.length < 3) continue;
      if (isPolarSpanningOpenAreaSubpath(subpath, context)) {
        parts.push(...buildPolarSectorProjectedPaths(points, context));
      } else {
        const ring = closeCoordinateRing(coordinates);
        const projected = context.pathBuilder({ type: 'Polygon', coordinates: [ring] }) || '';
        const stripped = stripWorldBoundarySubpaths(projected, context.side);
        if (stripped) parts.push(stripped);
      }
    } else if (coordinates.length >= 2) {
      const projected = context.pathBuilder({ type: 'LineString', coordinates }) || '';
      if (projected) parts.push(projected);
    }
  }

  return { parts, forceSplit };
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

  const { parts, forceSplit } = buildProjectedPath(element, matrix, style, context);

  if (forceSplit && parts.length > 1) {
    const group = context.document.createElementNS(SVG_NS, 'g');
    const id = element.getAttribute('id');
    const dataName = element.getAttribute('data-name');
    if (id) group.setAttribute('id', id);
    if (dataName) group.setAttribute('data-name', dataName);
    group.setAttribute('data-pq-split', '1');

    const childSkip = new Set([...GEOMETRY_ATTRIBUTES, 'id', 'data-name']);
    for (let index = 0; index < parts.length; index += 1) {
      const pathElement = context.document.createElementNS(SVG_NS, 'path');
      copyAttributes(element, pathElement, childSkip);
      pathElement.setAttribute('d', parts[index] || '');
      pathElement.setAttribute('data-pq-split-index', String(index));
      if (localName(element) !== 'path') {
        pathElement.setAttribute('data-pq-source-tag', localName(element));
      }
      group.appendChild(pathElement);
    }

    replaceNode(element, group);
    context.stats.geometryCount += parts.length;
    return;
  }

  const pathElement = context.document.createElementNS(SVG_NS, 'path');
  copyAttributes(element, pathElement, GEOMETRY_ATTRIBUTES);
  pathElement.setAttribute('d', parts.join('') || '');
  if (localName(element) !== 'path') {
    pathElement.setAttribute('data-pq-source-tag', localName(element));
  }
  replaceNode(element, pathElement);
  context.stats.geometryCount += 1;
}

function transformTextNode(element, matrix, context) {
  const anchor = getTextAnchor(element);
  const sourceAnchor = applyMatrix(matrix, anchor);
  const lonLat = sourcePointToLonLat(sourceAnchor, context);
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
  return snapPathToSquare(context.pathBuilder({ type: 'LineString', coordinates }) || '', context.side);
}

function replaceGraticuleGroup(group, context) {
  while (group.firstChild) {
    group.removeChild(group.firstChild);
  }

  const grid30 = context.document.createElementNS(SVG_NS, 'g');
  grid30.setAttribute('id', '_30_');
  grid30.setAttribute('data-name', '30°');

  const border = context.document.createElementNS(SVG_NS, 'rect');
  border.setAttribute('class', 'cls-26');
  border.setAttribute('x', '0');
  border.setAttribute('y', '0');
  border.setAttribute('width', formatNumber(context.side));
  border.setAttribute('height', formatNumber(context.side));
  border.setAttribute('data-pq-generated', 'graticule-frame');
  grid30.appendChild(border);

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
  root.setAttribute('data-pq-lon0', formatNumber(context.lon0, 4));
}

function createContext(document, root, options) {
  const viewBox = getViewBox(root);
  const frame = findMapFrame(root);
  const side = options.outputSide || frame.width || viewBox.width || 2048;
  const sourceScale = detectSourceScale(root, viewBox) || 1;
  const { projection, pathBuilder } = buildProjection(side, options.pathPrecision);
  return {
    document,
    root,
    frame,
    stylesheet: parseStylesheet(root),
    side,
    sourceScale,
    lon0: options.lon0,
    projection,
    pathBuilder,
    options,
    stats: {
      geometryCount: 0,
      textCount: 0,
      backgroundRect: false,
      outputSide: side,
    },
  };
}

export const DEFAULT_OPTIONS = {
  lon0: -143,
  sampleStep: 3,
  pathPrecision: 0.35,
  outputSide: null,
};

export async function transformSvgString(svgText, options = {}, domImpl = {}) {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
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
