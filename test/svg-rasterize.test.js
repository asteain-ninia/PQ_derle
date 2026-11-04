import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import {
  filterSvgNamedLayers,
  listSvgNamedLayers,
  renderSvgToPng,
} from '../src/svg-rasterize.js';

const SVG_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20">
  <g id="_海" data-name="海">
    <rect x="0" y="0" width="40" height="20" fill="#77aadd" />
  </g>
  <g id="_文字" data-name="文字">
    <g id="_都市名" data-name="都市名">
      <text x="10" y="10">city</text>
    </g>
    <g id="_国名" data-name="国名">
      <text x="20" y="10">country</text>
    </g>
  </g>
</svg>`;

function parseDocument(svgText) {
  return new DOMParser().parseFromString(svgText, 'image/svg+xml');
}

function getLayerIds(document) {
  return Array.from(document.getElementsByTagName('g'))
    .map((node) => node.getAttribute('id'))
    .filter(Boolean);
}

test('listSvgNamedLayers reports named group layers with nesting depth', () => {
  const layers = listSvgNamedLayers(SVG_FIXTURE, { DOMParser, XMLSerializer });

  assert.deepEqual(
    layers.map((layer) => [layer.id, layer.name, layer.depth]),
    [
      ['_海', '海', 0],
      ['_文字', '文字', 0],
      ['_都市名', '都市名', 1],
      ['_国名', '国名', 1],
    ],
  );
});

test('filterSvgNamedLayers keeps included layers plus required ancestors', () => {
  const filtered = filterSvgNamedLayers(
    SVG_FIXTURE,
    { includeLayers: ['都市名'] },
    { DOMParser, XMLSerializer },
  );

  const document = parseDocument(filtered.svgText);
  assert.deepEqual(getLayerIds(document), ['_文字', '_都市名']);
  assert.deepEqual(
    filtered.matchedIncludeLayers.map((layer) => layer.id),
    ['_都市名'],
  );
});

test('filterSvgNamedLayers removes excluded layers by id or display name', () => {
  const filtered = filterSvgNamedLayers(
    SVG_FIXTURE,
    { excludeLayers: ['_海', '国名'] },
    { DOMParser, XMLSerializer },
  );

  const document = parseDocument(filtered.svgText);
  assert.deepEqual(getLayerIds(document), ['_文字', '_都市名']);
  assert.deepEqual(
    filtered.matchedExcludeLayers.map((layer) => layer.id),
    ['_海', '_国名'],
  );
});

test('filterSvgNamedLayers rejects unknown layer names', () => {
  assert.throws(
    () => filterSvgNamedLayers(
      SVG_FIXTURE,
      { includeLayers: ['存在しないレイヤー'] },
      { DOMParser, XMLSerializer },
    ),
    /Unknown include layer/,
  );
});

test('renderSvgToPng renders a png at requested width', () => {
  const rendered = renderSvgToPng(SVG_FIXTURE, {
    width: 120,
    loadSystemFonts: false,
  });

  assert.equal(rendered.sourceWidth, 40);
  assert.equal(rendered.sourceHeight, 20);
  assert.equal(rendered.outputWidth, 120);
  assert.equal(rendered.outputHeight, 60);
  assert.ok(rendered.pngBuffer.length > 0);
});
