import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { geoPeirceQuincuncial } from 'd3-geo-projection';
import { geoRotation } from 'd3-geo';
import { SVGPathData } from 'svg-pathdata';
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

function maxDrawnEdgeRun(pathData, side, tolerance = 1e-6) {
  let commands;
  try {
    commands = new SVGPathData(pathData).toAbs().commands;
  } catch {
    return 0;
  }

  const near = (value, target) => Math.abs(value - target) <= tolerance;
  let previous = null;
  let currentRun = 0;
  let maxRun = 0;

  for (const command of commands) {
    if (command.type === SVGPathData.MOVE_TO) {
      previous = [command.x, command.y];
      currentRun = 0;
      continue;
    }
    if (command.type !== SVGPathData.LINE_TO || !previous) continue;

    const point = [command.x, command.y];
    const sameEdge = (
      (near(previous[0], 0) && near(point[0], 0))
      || (near(previous[0], side) && near(point[0], side))
      || (near(previous[1], 0) && near(point[1], 0))
      || (near(previous[1], side) && near(point[1], side))
    );

    if (sameEdge) {
      currentRun += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
      maxRun = Math.max(maxRun, currentRun);
    } else {
      currentRun = 0;
    }

    previous = point;
  }

  return maxRun;
}

function countMoveCommands(pathData) {
  try {
    return new SVGPathData(pathData).toAbs().commands
      .filter((command) => command.type === SVGPathData.MOVE_TO)
      .length;
  } catch {
    return 0;
  }
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

test('transformSvgString emits south-polar split fills as standalone fragments', async () => {
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
  const fragmentedPaths = Array.from(document.getElementsByTagName('path'))
    .filter((node) => node.hasAttribute('data-pq-fragment'));
  assert.ok(fragmentedPaths.length >= 1);
});

test('transformSvgString does not send north-spanning open fills through south-polar corner closure', async () => {
  const sampleSvg = await readFile(new URL('../イラレ出界図.svg', import.meta.url), 'utf8');
  const result = await transformSvgString(
    sampleSvg,
    {
      centerLon: 45,
      centerLat: -30,
      roll: 45,
      outputSide: 720,
    },
    { DOMParser, XMLSerializer },
  );

  const document = parseDocument(result.svgText);
  const secondContour = Array.from(document.getElementsByTagName('g'))
    .find((node) => node.getAttribute('id') === '_第二分高面');
  assert.ok(secondContour);

  const evenoddPaths = Array.from(secondContour.getElementsByTagName('path'))
    .filter((node) => node.getAttribute('fill-rule') === 'evenodd');
  assert.equal(evenoddPaths.length, 0);
});

test('transformSvgString splits boundary and graticule lines instead of tracing along square edges', async () => {
  const sampleSvg = await readFile(new URL('../イラレ出界図.svg', import.meta.url), 'utf8');
  const outputSide = 720;
  const result = await transformSvgString(
    sampleSvg,
    {
      centerLon: 45,
      centerLat: -30,
      roll: 45,
      outputSide,
    },
    { DOMParser, XMLSerializer },
  );

  const document = parseDocument(result.svgText);

  for (const groupId of ['_境界', '_経緯線']) {
    const group = Array.from(document.getElementsByTagName('g'))
      .find((node) => node.getAttribute('id') === groupId);
    assert.ok(group, `Missing ${groupId}`);
    if (groupId === '_経緯線') {
      assert.equal(group.getElementsByTagName('rect').length, 0, '_経緯線 should not contain a frame rect');
    }

    const paths = Array.from(group.getElementsByTagName('path'));
    assert.ok(paths.length > 0, `${groupId} is empty`);

    const worstEdgeRun = paths.reduce(
      (max, node) => Math.max(max, maxDrawnEdgeRun(node.getAttribute('d') || '', outputSide)),
      0,
    );
    assert.ok(worstEdgeRun < 10, `${groupId} still contains a drawn edge run of ${worstEdgeRun}`);
  }
});

test('transformSvgString emits split contour fragments as separate path elements', async () => {
  const sampleSvg = await readFile(new URL('../イラレ出界図.svg', import.meta.url), 'utf8');
  const contourGroups = ['_第一分高面', '_第二分高面', '_第三分高面', '_第四分高面', '_第五分高面'];
  const result = await transformSvgString(
    sampleSvg,
    {
      centerLon: 45,
      centerLat: -30,
      roll: 45,
      outputSide: 720,
    },
    { DOMParser, XMLSerializer },
  );

  const document = parseDocument(result.svgText);

  for (const groupId of contourGroups) {
    const group = Array.from(document.getElementsByTagName('g'))
      .find((node) => node.getAttribute('id') === groupId);
    assert.ok(group, `Missing ${groupId}`);

    const paths = Array.from(group.getElementsByTagName('path'));
    for (const path of paths) {
      assert.ok(
        countMoveCommands(path.getAttribute('d') || '') <= 1,
        `${groupId} still contains a multi-subpath contour fragment`,
      );
    }
  }
});

test('transformSvgString keeps contour fills from tracing around the square to rejoin split pieces', async () => {
  const sampleSvg = await readFile(new URL('../イラレ出界図.svg', import.meta.url), 'utf8');
  const contourGroups = ['_第一分高面', '_第二分高面', '_第三分高面', '_第四分高面', '_第五分高面'];

  for (const options of [
    { outputSide: 720 },
    { centerLon: 45, centerLat: -30, roll: 45, outputSide: 720 },
  ]) {
    const result = await transformSvgString(sampleSvg, options, { DOMParser, XMLSerializer });
    const document = parseDocument(result.svgText);

    for (const groupId of contourGroups) {
      const group = Array.from(document.getElementsByTagName('g'))
        .find((node) => node.getAttribute('id') === groupId);
      assert.ok(group, `Missing ${groupId}`);

      const paths = Array.from(group.getElementsByTagName('path'));
      if (!paths.length) continue;

      const worstEdgeRun = paths.reduce(
        (max, node) => Math.max(max, maxDrawnEdgeRun(node.getAttribute('d') || '', options.outputSide)),
        0,
      );
      assert.ok(worstEdgeRun < 50, `${groupId} still contains a contour edge run of ${worstEdgeRun}`);
    }
  }
});
