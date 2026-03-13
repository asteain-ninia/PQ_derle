const EPSILON = 1e-6;

function getCaseIdentifier(entry) {
  return String(entry.caseKey ?? entry.caseId);
}

function formatKeyPart(value) {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function inferStep(values, wrapSpan = null) {
  if (!Array.isArray(values) || values.length < 2) {
    return 1;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const diffs = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const diff = sorted[index] - sorted[index - 1];
    if (diff > EPSILON) diffs.push(diff);
  }

  if (wrapSpan && sorted.length > 1) {
    const wrapDiff = sorted[0] + wrapSpan - sorted[sorted.length - 1];
    if (wrapDiff > EPSILON) diffs.push(wrapDiff);
  }

  return diffs.length ? Number(Math.min(...diffs).toFixed(6)) : 1;
}

function buildCaseKey(centerLon, centerLat, roll, rollSpan) {
  return [
    formatKeyPart(normalizeLongitude(centerLon)),
    formatKeyPart(centerLat),
    formatKeyPart(normalizeRoll(roll, rollSpan)),
  ].join('|');
}

function snapLinear(values, target) {
  let best = values[0];
  let bestDistance = Infinity;

  for (const value of values) {
    const distance = Math.abs(value - target);
    if (distance < bestDistance - EPSILON) {
      best = value;
      bestDistance = distance;
    }
  }

  return best;
}

function snapWrapped(values, target, span) {
  let best = values[0];
  let bestDistance = Infinity;

  for (const value of values) {
    const distance = angularDistance(value, target, span);
    if (distance < bestDistance - EPSILON) {
      best = value;
      bestDistance = distance;
    }
  }

  return best;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeLongitude(value) {
  let normalized = Number.isFinite(value) ? value : 0;
  while (normalized <= -180) normalized += 360;
  while (normalized > 180) normalized -= 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}

export function normalizeRoll(value, span = 90) {
  if (!Number.isFinite(value)) return 0;
  let normalized = value % span;
  if (normalized < 0) normalized += span;
  return Object.is(normalized, -0) ? 0 : normalized;
}

export function angularDistance(a, b, span = 360) {
  let delta = Math.abs((a - b) % span);
  if (delta > span / 2) delta = span - delta;
  return delta;
}

export function signedAngularDelta(from, to, span = 360) {
  let delta = (to - from) % span;
  if (delta <= -span / 2) delta += span;
  if (delta > span / 2) delta -= span;
  return Object.is(delta, -0) ? 0 : delta;
}

export function formatAngleLabel(value, digits = 2) {
  const rounded = Number(value.toFixed(digits));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

export function buildSweepIndex(manifest) {
  if (!manifest || !Array.isArray(manifest.cases)) {
    throw new Error('Sweep manifest is invalid.');
  }

  const rollSpan = Number.isFinite(manifest.options?.rollSpan) && manifest.options.rollSpan > 0
    ? manifest.options.rollSpan
    : manifest.options?.rollMode === 'full-turn'
      ? 360
      : 90;

  const cases = manifest.cases.map((entry) => ({
    ...entry,
    centerLon: normalizeLongitude(Number(entry.centerLon)),
    centerLat: Number(entry.centerLat),
    roll: normalizeRoll(Number(entry.roll), rollSpan),
  }));

  const byKey = new Map();
  const byCaseKey = new Map();
  const lonValues = [...new Set(cases.map((entry) => entry.centerLon))].sort((a, b) => a - b);
  const latValues = [...new Set(cases.map((entry) => entry.centerLat))].sort((a, b) => a - b);
  const rollValues = [...new Set(cases.map((entry) => entry.roll))].sort((a, b) => a - b);

  for (const entry of cases) {
    byKey.set(buildCaseKey(entry.centerLon, entry.centerLat, entry.roll, rollSpan), entry);
    byCaseKey.set(getCaseIdentifier(entry), entry);
  }

  return {
    manifest,
    cases,
    byKey,
    byCaseKey,
    lonValues,
    latValues,
    rollValues,
    lonStep: Number(manifest.options?.centerLonStep) || inferStep(lonValues, 360),
    latStep: Number(manifest.options?.centerLatStep) || inferStep(latValues),
    rollStep: Number(manifest.options?.rollStep) || inferStep(rollValues, rollSpan),
    rollSpan,
    latMin: latValues[0] ?? -90,
    latMax: latValues[latValues.length - 1] ?? 90,
  };
}

export function findNearestSweepCase(index, target = {}) {
  if (!index?.cases?.length) {
    throw new Error('Sweep index is empty.');
  }

  const targetLon = normalizeLongitude(Number(target.centerLon) || 0);
  const targetLat = clamp(Number(target.centerLat) || 0, index.latMin, index.latMax);
  const targetRoll = normalizeRoll(Number(target.roll) || 0, index.rollSpan);
  const snappedLat = snapLinear(index.latValues, targetLat);
  const snappedLon = Math.abs(Math.abs(snappedLat) - 90) <= EPSILON
    ? 0
    : snapWrapped(index.lonValues, targetLon, 360);
  const snappedRoll = snapWrapped(index.rollValues, targetRoll, index.rollSpan);
  const direct = index.byKey.get(buildCaseKey(snappedLon, snappedLat, snappedRoll, index.rollSpan));

  if (direct) {
    return direct;
  }

  let best = index.cases[0];
  let bestScore = Infinity;

  for (const entry of index.cases) {
    const score = (
      angularDistance(entry.centerLon, targetLon, 360) ** 2
      + (entry.centerLat - targetLat) ** 2
      + angularDistance(entry.roll, targetRoll, index.rollSpan) ** 2
    );

    if (score < bestScore - EPSILON) {
      best = entry;
      bestScore = score;
    }
  }

  return best;
}

export function getNeighborCases(index, currentCase) {
  const targets = [
    { label: `lon -${formatAngleLabel(index.lonStep, 0)}`, centerLon: currentCase.centerLon - index.lonStep, centerLat: currentCase.centerLat, roll: currentCase.roll },
    { label: `lon +${formatAngleLabel(index.lonStep, 0)}`, centerLon: currentCase.centerLon + index.lonStep, centerLat: currentCase.centerLat, roll: currentCase.roll },
    { label: `lat -${formatAngleLabel(index.latStep, 0)}`, centerLon: currentCase.centerLon, centerLat: currentCase.centerLat - index.latStep, roll: currentCase.roll },
    { label: `lat +${formatAngleLabel(index.latStep, 0)}`, centerLon: currentCase.centerLon, centerLat: currentCase.centerLat + index.latStep, roll: currentCase.roll },
    { label: `roll -${formatAngleLabel(index.rollStep, 0)}`, centerLon: currentCase.centerLon, centerLat: currentCase.centerLat, roll: currentCase.roll - index.rollStep },
    { label: `roll +${formatAngleLabel(index.rollStep, 0)}`, centerLon: currentCase.centerLon, centerLat: currentCase.centerLat, roll: currentCase.roll + index.rollStep },
  ];

  const seen = new Set([getCaseIdentifier(currentCase)]);
  const neighbors = [];

  for (const target of targets) {
    const entry = findNearestSweepCase(index, target);
    if (!entry || seen.has(getCaseIdentifier(entry))) continue;
    seen.add(getCaseIdentifier(entry));
    neighbors.push({
      ...target,
      entry,
    });
  }

  return neighbors;
}
