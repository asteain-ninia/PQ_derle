const SWEEP_FILTER_STYLE = `
#_経緯線,
#_文字,
#_境界,
g[data-name="経緯線"],
g[data-name="文字"],
g[data-name="境界"],
g[data-name="州境界"],
g[data-name="国境界"],
text,
tspan {
  display: none !important;
}

path,
rect,
polygon,
polyline,
line,
circle,
ellipse {
  stroke: none !important;
}
`.trim();

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

function findDirectChildByLocalName(node, name) {
  return Array.from(node.childNodes || []).find(
    (child) => child.nodeType === 1 && localName(child) === name,
  ) || null;
}

function ensureDefs(root, document) {
  let defs = findDirectChildByLocalName(root, 'defs');
  if (!defs) {
    defs = document.createElementNS(root.namespaceURI, 'defs');
    root.insertBefore(defs, root.firstChild);
  }
  return defs;
}

export function prepareSweepSourceSvg(svgText, domImpl = {}) {
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

  const defs = ensureDefs(root, document);
  const style = document.createElementNS(root.namespaceURI, 'style');
  style.setAttribute('data-pq-sweep-filter', '1');
  style.appendChild(document.createTextNode(SWEEP_FILTER_STYLE));
  defs.appendChild(style);

  return serializer.serializeToString(document);
}

export { SWEEP_FILTER_STYLE };
