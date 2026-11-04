import { Resvg } from '@resvg/resvg-js';

const DEFAULT_MAX_RENDER_DIMENSION = 8192;
const SHAPE_RENDERING_GEOMETRIC_PRECISION = 2;
const TEXT_RENDERING_GEOMETRIC_PRECISION = 2;
const IMAGE_RENDERING_OPTIMIZE_QUALITY = 0;

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

function parseSvgDocument(svgText, domImpl = {}) {
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

  return { document, root, serializer };
}

function isNamedLayerNode(node) {
  if (!node || node.nodeType !== 1) return false;
  if (localName(node) !== 'g') return false;
  return Boolean(node.getAttribute('id') || node.getAttribute('data-name'));
}

function countNamedLayerDepth(node) {
  let depth = 0;
  for (let current = node.parentNode; current; current = current.parentNode) {
    if (isNamedLayerNode(current)) depth += 1;
  }
  return depth;
}

function describeLayer(node) {
  return {
    id: node.getAttribute('id') || '',
    name: node.getAttribute('data-name') || '',
    depth: countNamedLayerDepth(node),
  };
}

function collectNamedLayerNodes(root) {
  return Array.from(root.getElementsByTagName('g')).filter(isNamedLayerNode);
}

function normalizeLayerTokens(tokens = []) {
  return tokens
    .flatMap((token) => String(token).split(','))
    .map((token) => token.trim())
    .filter(Boolean);
}

function getLayerKeys(node) {
  return [node.getAttribute('id'), node.getAttribute('data-name')]
    .map((value) => (value || '').trim())
    .filter(Boolean);
}

function matchLayerTokens(layerNodes, tokens) {
  const normalizedTokens = normalizeLayerTokens(tokens);
  const matchedNodes = new Set();
  const unmatchedTokens = [];

  for (const token of normalizedTokens) {
    const matches = layerNodes.filter((node) => getLayerKeys(node).includes(token));
    if (!matches.length) {
      unmatchedTokens.push(token);
      continue;
    }
    for (const match of matches) {
      matchedNodes.add(match);
    }
  }

  return {
    tokens: normalizedTokens,
    matchedNodes: [...matchedNodes],
    unmatchedTokens,
  };
}

function isAncestorNode(ancestor, descendant) {
  for (let current = descendant?.parentNode; current; current = current.parentNode) {
    if (current === ancestor) return true;
  }
  return false;
}

function removeNode(node) {
  const parent = node.parentNode;
  if (parent) {
    parent.removeChild(node);
  }
}

function removeLayerNodes(nodes) {
  const uniqueNodes = [...new Set(nodes)];
  uniqueNodes
    .sort((left, right) => countNamedLayerDepth(right) - countNamedLayerDepth(left))
    .forEach(removeNode);
}

function applyIncludeFilter(root, layerNodes, includeTokens) {
  if (!includeTokens.length) {
    return { matchedLayers: [], unmatchedTokens: [] };
  }

  const matches = matchLayerTokens(layerNodes, includeTokens);
  if (matches.unmatchedTokens.length > 0) {
    throw new Error(`Unknown include layer(s): ${matches.unmatchedTokens.join(', ')}`);
  }

  const keepNodes = new Set();
  for (const matchedNode of matches.matchedNodes) {
    keepNodes.add(matchedNode);

    for (let current = matchedNode.parentNode; current; current = current.parentNode) {
      if (isNamedLayerNode(current)) keepNodes.add(current);
    }

    for (const layerNode of layerNodes) {
      if (isAncestorNode(matchedNode, layerNode)) {
        keepNodes.add(layerNode);
      }
    }
  }

  removeLayerNodes(layerNodes.filter((node) => !keepNodes.has(node)));

  return {
    matchedLayers: matches.matchedNodes.map(describeLayer),
    unmatchedTokens: [],
  };
}

function applyExcludeFilter(root, excludeTokens) {
  if (!excludeTokens.length) {
    return { matchedLayers: [], unmatchedTokens: [] };
  }

  const layerNodes = collectNamedLayerNodes(root);
  const matches = matchLayerTokens(layerNodes, excludeTokens);

  const removalRoots = matches.matchedNodes.filter(
    (node) => !matches.matchedNodes.some((candidate) => candidate !== node && isAncestorNode(candidate, node)),
  );
  removeLayerNodes(removalRoots);

  return {
    matchedLayers: matches.matchedNodes.map(describeLayer),
    unmatchedTokens: [],
  };
}

function resolveFitTo(sourceWidth, sourceHeight, options = {}) {
  const {
    width = null,
    height = null,
    zoom = null,
    maxDefaultDimension = DEFAULT_MAX_RENDER_DIMENSION,
  } = options;

  if (width && height) {
    throw new Error('Specify either width or height, not both.');
  }
  if (width && zoom) {
    throw new Error('Specify either width or zoom, not both.');
  }
  if (height && zoom) {
    throw new Error('Specify either height or zoom, not both.');
  }

  if (width) {
    return {
      fitTo: { mode: 'width', value: Math.max(1, Math.round(Number(width))) },
      scaledByDefault: false,
    };
  }
  if (height) {
    return {
      fitTo: { mode: 'height', value: Math.max(1, Math.round(Number(height))) },
      scaledByDefault: false,
    };
  }
  if (zoom) {
    return {
      fitTo: { mode: 'zoom', value: Number(zoom) },
      scaledByDefault: false,
    };
  }

  const dominantDimension = Math.max(sourceWidth, sourceHeight);
  if (dominantDimension > maxDefaultDimension) {
    return {
      fitTo: sourceWidth >= sourceHeight
        ? { mode: 'width', value: maxDefaultDimension }
        : { mode: 'height', value: maxDefaultDimension },
      scaledByDefault: true,
    };
  }

  return {
    fitTo: { mode: 'original' },
    scaledByDefault: false,
  };
}

export function listSvgNamedLayers(svgText, domImpl = {}) {
  const { root } = parseSvgDocument(svgText, domImpl);
  return collectNamedLayerNodes(root).map(describeLayer);
}

export function filterSvgNamedLayers(svgText, options = {}, domImpl = {}) {
  const { includeLayers = [], excludeLayers = [] } = options;
  const { document, root, serializer } = parseSvgDocument(svgText, domImpl);
  const originalLayerNodes = collectNamedLayerNodes(root);
  const originalLayers = originalLayerNodes.map(describeLayer);
  const excludeTokens = normalizeLayerTokens(excludeLayers);
  const excludeValidation = matchLayerTokens(originalLayerNodes, excludeTokens);

  if (excludeValidation.unmatchedTokens.length > 0) {
    throw new Error(`Unknown exclude layer(s): ${excludeValidation.unmatchedTokens.join(', ')}`);
  }

  const includeResult = applyIncludeFilter(root, collectNamedLayerNodes(root), normalizeLayerTokens(includeLayers));
  const excludeResult = applyExcludeFilter(root, excludeTokens);
  const remainingLayers = collectNamedLayerNodes(root).map(describeLayer);

  return {
    svgText: serializer.serializeToString(document),
    originalLayers,
    remainingLayers,
    matchedIncludeLayers: includeResult.matchedLayers,
    matchedExcludeLayers: excludeResult.matchedLayers,
  };
}

export function renderSvgToPng(svgText, options = {}) {
  const logLevel = options.logLevel || 'error';
  const probe = new Resvg(svgText, {
    font: {
      loadSystemFonts: options.loadSystemFonts ?? true,
      fontFiles: options.fontFiles,
      fontDirs: options.fontDirs,
      defaultFontFamily: options.defaultFontFamily,
    },
    logLevel,
  });
  const sourceWidth = probe.width;
  const sourceHeight = probe.height;
  const { fitTo, scaledByDefault } = resolveFitTo(sourceWidth, sourceHeight, options);

  const resvg = new Resvg(svgText, {
    fitTo,
    dpi: options.dpi,
    background: options.background,
    logLevel,
    shapeRendering: options.shapeRendering ?? SHAPE_RENDERING_GEOMETRIC_PRECISION,
    textRendering: options.textRendering ?? TEXT_RENDERING_GEOMETRIC_PRECISION,
    imageRendering: options.imageRendering ?? IMAGE_RENDERING_OPTIMIZE_QUALITY,
    font: {
      loadSystemFonts: options.loadSystemFonts ?? true,
      fontFiles: options.fontFiles,
      fontDirs: options.fontDirs,
      defaultFontFamily: options.defaultFontFamily,
    },
  });

  const rendered = resvg.render();
  return {
    pngBuffer: rendered.asPng(),
    sourceWidth,
    sourceHeight,
    outputWidth: rendered.width,
    outputHeight: rendered.height,
    fitTo,
    scaledByDefault,
  };
}

export { DEFAULT_MAX_RENDER_DIMENSION };
