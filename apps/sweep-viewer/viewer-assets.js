import {
  formatAngleLabel,
  normalizeLongitude,
  normalizeRoll,
} from './sweep-index.js';

const QUARTER_TURN_DEGREES = 90;

function inferRollSpan(manifest) {
  if (Number.isFinite(manifest.options?.rollSpan) && manifest.options.rollSpan > 0) {
    return manifest.options.rollSpan;
  }
  return manifest.options?.rollMode === 'full-turn' ? 360 : 90;
}

function buildLabel(entry) {
  return `lon=${formatAngleLabel(entry.centerLon, 4)} lat=${formatAngleLabel(entry.centerLat, 4)} roll=${formatAngleLabel(entry.roll, 4)}`;
}

function normalizeViewerCase(entry, sourceRollSpan) {
  const sourceCaseId = Number(entry.sourceCaseId ?? entry.caseId);
  const centerLon = normalizeLongitude(Number(entry.centerLon));
  const centerLat = Number(entry.centerLat);
  const roll = normalizeRoll(Number(entry.roll), 360);
  const baseRoll = normalizeRoll(Number(entry.baseRoll ?? entry.roll), sourceRollSpan);
  const rotationDegrees = Number(entry.rotationDegrees ?? 0);

  return {
    ...entry,
    caseKey: String(entry.caseKey ?? `${sourceCaseId}@${formatAngleLabel(roll, 4)}`),
    sourceCaseId,
    centerLon,
    centerLat,
    roll,
    baseRoll,
    rotationDegrees,
    sourcePng: entry.sourcePng || entry.png,
    sourceLabel: entry.sourceLabel || entry.label || '',
    label: buildLabel({ centerLon, centerLat, roll }),
  };
}

export function buildViewerManifest(sourceManifest) {
  if (!sourceManifest || !Array.isArray(sourceManifest.cases)) {
    throw new Error('Sweep manifest is invalid.');
  }

  const sourceRollSpan = inferRollSpan(sourceManifest);
  const alreadyExpanded = (
    sourceManifest.viewerAssets?.expandedByRotation
    || sourceManifest.options?.rollMode === 'full-turn'
    || sourceRollSpan === 360
  );

  if (alreadyExpanded) {
    const cases = sourceManifest.cases.map((entry) => normalizeViewerCase(entry, sourceRollSpan));
    return {
      ...sourceManifest,
      options: {
        ...sourceManifest.options,
        rollMode: 'full-turn',
        rollSpan: 360,
      },
      caseCount: cases.length,
      cases,
      viewerAssets: {
        ...sourceManifest.viewerAssets,
        expandedByRotation: Boolean(sourceManifest.viewerAssets?.expandedByRotation),
        sourceRollSpan,
      },
    };
  }

  const cases = [];
  const seen = new Set();

  for (const entry of sourceManifest.cases) {
    const sourceCaseId = Number(entry.caseId);
    const centerLon = normalizeLongitude(Number(entry.centerLon));
    const centerLat = Number(entry.centerLat);
    const baseRoll = normalizeRoll(Number(entry.roll), sourceRollSpan);

    for (let turn = 0; turn < 4; turn += 1) {
      const roll = normalizeRoll(baseRoll + turn * QUARTER_TURN_DEGREES, 360);
      const caseKey = `${sourceCaseId}@${formatAngleLabel(roll, 4)}`;
      if (seen.has(caseKey)) continue;
      seen.add(caseKey);

      cases.push({
        ...entry,
        caseKey,
        sourceCaseId,
        centerLon,
        centerLat,
        roll,
        baseRoll,
        rotationDegrees: turn * QUARTER_TURN_DEGREES,
        sourcePng: entry.png,
        sourceLabel: entry.label || '',
        label: buildLabel({ centerLon, centerLat, roll }),
      });
    }
  }

  return {
    ...sourceManifest,
    caseCount: cases.length,
    cases,
    options: {
      ...sourceManifest.options,
      rollMode: 'full-turn',
      rollSpan: 360,
    },
    viewerAssets: {
      expandedByRotation: true,
      sourceRollSpan,
      sourceCaseCount: sourceManifest.cases.length,
      generatedFrom: sourceManifest.generatedAt || null,
    },
  };
}
