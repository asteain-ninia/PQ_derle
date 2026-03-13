import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { geoPeirceQuincuncial } from 'd3-geo-projection';
import { geoRotation } from 'd3-geo';
import { transformSvgString } from '../src/transform.js';

const SVG_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="360" height="180" viewBox="0 0 360 180">
  <rect id="frame" x="0" y="0" width="360" height="180" fill="#ddeeff" />
  <text id="center" x="210" y="70">center</text>
  <text id="east" x="300" y="70">east</text>
  <text id="legacy" x="225" y="90">legacy</text>
</svg>`;

function parseDocument(svgText) {
  return new DOMParser().parseFromString(svgText, 'image/svg+xml');
}

function getTextById(document, id) {
  const nodes = Array.from(document.getElementsByTagName('text'));
  return nodes.find((node) => node.getAttribute('id') === id) || null;
}

function parseTranslate(transformValue) {
  const match = /translate\(([-+\d.eE]+)\s+([-+\d.eE]+)\)/.exec(transformValue || '');
  assert.ok(match, `Missing translate() in "${transformValue}"`);
  return [Number(match[1]), Number(match[2])];
}

function assertPointNear(actual, expected, tolerance = 0.05) {
  assert.ok(Math.abs(actual[0] - expected[0]) <= tolerance, `${actual[0]} != ${expected[0]}`);
  assert.ok(Math.abs(actual[1] - expected[1]) <= tolerance, `${actual[1]} != ${expected[1]}`);
}

test('transformSvgString supports centerLon/centerLat/roll orientation', async () => {
  const result = await transformSvgString(
    SVG_FIXTURE,
    {
      centerLon: 30,
      centerLat: 20,
      roll: 15,
      outputSide: 360,
    },
    { DOMParser, XMLSerializer },
  );

  const document = parseDocument(result.svgText);
  const root = document.documentElement;
  assert.equal(root.getAttribute('data-pq-center-lon'), '30');
  assert.equal(root.getAttribute('data-pq-center-lat'), '20');
  assert.equal(root.getAttribute('data-pq-roll'), '15');

  const projection = geoPeirceQuincuncial()
    .fitExtent(
      [
        [0, 0],
        [360, 360],
      ],
      { type: 'Sphere' },
    );
  const rotation = geoRotation([-30, -20, 15]);

  const centerText = getTextById(document, 'center');
  assert.ok(centerText);
  assertPointNear(
    parseTranslate(centerText.getAttribute('transform')),
    projection([0, 0]),
  );

  const eastText = getTextById(document, 'east');
  assert.ok(eastText);
  assertPointNear(
    parseTranslate(eastText.getAttribute('transform')),
    projection(rotation([120, 20])),
  );
});

test('transformSvgString keeps lon0 as a centerLon alias', async () => {
  const result = await transformSvgString(
    SVG_FIXTURE,
    {
      lon0: 45,
      outputSide: 360,
    },
    { DOMParser, XMLSerializer },
  );

  const document = parseDocument(result.svgText);
  const root = document.documentElement;
  assert.equal(root.getAttribute('data-pq-lon0'), '45');
  assert.equal(root.getAttribute('data-pq-center-lon'), '45');
  assert.equal(root.getAttribute('data-pq-center-lat'), '0');
  assert.equal(root.getAttribute('data-pq-roll'), '0');

  const projection = geoPeirceQuincuncial()
    .fitExtent(
      [
        [0, 0],
        [360, 360],
      ],
      { type: 'Sphere' },
    );

  const legacyText = getTextById(document, 'legacy');
  assert.ok(legacyText);
  assertPointNear(
    parseTranslate(legacyText.getAttribute('transform')),
    projection([0, 0]),
  );
});

test('transformSvgString merges south-polar split fills into a single evenodd path', async () => {
  const sampleSvg = await readFile(new URL('../イラレ出界図.svg', import.meta.url), 'utf8');
  const result = await transformSvgString(
    sampleSvg,
    {
      outputSide: 720,
    },
    { DOMParser, XMLSerializer },
  );

  assert.equal(result.svgText.includes('data-pq-split='), false);

  const document = parseDocument(result.svgText);
  const evenoddPaths = Array.from(document.getElementsByTagName('path'))
    .filter((node) => node.getAttribute('fill-rule') === 'evenodd');
  assert.ok(evenoddPaths.length >= 1);
});
