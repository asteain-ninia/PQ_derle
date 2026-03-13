import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSweepIndex,
  findNearestSweepCase,
  normalizeLongitude,
  normalizeRoll,
  signedAngularDelta,
} from '../apps/sweep-viewer/sweep-index.js';
import { buildViewerManifest } from '../apps/sweep-viewer/viewer-assets.js';

const manifest = {
  options: {
    centerLonStep: 90,
    centerLatStep: 90,
    rollStep: 45,
    rollSpan: 90,
  },
  cases: [
    { caseId: 1, centerLon: 0, centerLat: -90, roll: 0, png: 'a.png', label: 'south' },
    { caseId: 2, centerLon: -180, centerLat: 0, roll: 0, png: 'b.png', label: 'west' },
    { caseId: 3, centerLon: -90, centerLat: 0, roll: 0, png: 'c.png', label: 'mid-west' },
    { caseId: 4, centerLon: 0, centerLat: 0, roll: 0, png: 'd.png', label: 'center' },
    { caseId: 5, centerLon: 90, centerLat: 0, roll: 45, png: 'e.png', label: 'east-roll' },
    { caseId: 6, centerLon: 0, centerLat: 90, roll: 0, png: 'f.png', label: 'north' },
  ],
};

test('normalize helpers wrap angles into expected domains', () => {
  assert.equal(normalizeLongitude(181), -179);
  assert.equal(normalizeLongitude(-180), 180);
  assert.equal(normalizeRoll(105, 90), 15);
  assert.equal(normalizeRoll(-15, 90), 75);
  assert.equal(signedAngularDelta(350, 5, 360), 15);
  assert.equal(signedAngularDelta(5, 350, 360), -15);
});

test('findNearestSweepCase snaps lon across the dateline', () => {
  const index = buildSweepIndex(manifest);
  const selected = findNearestSweepCase(index, {
    centerLon: 179,
    centerLat: 0,
    roll: 0,
  });

  assert.equal(selected.caseId, 2);
});

test('findNearestSweepCase collapses longitude at the poles', () => {
  const index = buildSweepIndex(manifest);
  const selected = findNearestSweepCase(index, {
    centerLon: 120,
    centerLat: 89,
    roll: 0,
  });

  assert.equal(selected.caseId, 6);
  assert.equal(selected.centerLon, 0);
});

test('findNearestSweepCase wraps roll inside the sweep span', () => {
  const index = buildSweepIndex(manifest);
  const selected = findNearestSweepCase(index, {
    centerLon: 90,
    centerLat: 0,
    roll: 91,
  });

  assert.equal(selected.caseId, 5);
});

test('buildViewerManifest expands quarter-turn sweep into full-turn viewer cases', () => {
  const viewerManifest = buildViewerManifest({
    ...manifest,
    caseCount: manifest.cases.length,
    options: {
      ...manifest.options,
      rollMode: 'quarter-turn',
      rollSpan: 90,
    },
  });

  assert.equal(viewerManifest.options.rollMode, 'full-turn');
  assert.equal(viewerManifest.options.rollSpan, 360);
  assert.equal(viewerManifest.viewerAssets.expandedByRotation, true);
  assert.equal(viewerManifest.caseCount, manifest.cases.length * 4);

  const rotated = viewerManifest.cases.find((entry) => entry.sourceCaseId === 5 && entry.roll === 135);
  assert.ok(rotated);
  assert.equal(rotated.rotationDegrees, 90);
  assert.equal(rotated.baseRoll, 45);
});
