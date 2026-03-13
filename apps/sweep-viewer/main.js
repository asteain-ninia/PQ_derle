import './style.css';
import {
  angularDistance,
  buildSweepIndex,
  findNearestSweepCase,
  formatAngleLabel,
  getNeighborCases,
  normalizeLongitude,
  normalizeRoll,
  signedAngularDelta,
} from './sweep-index.js';
import { buildViewerManifest } from './viewer-assets.js';

const DEFAULT_INPUT_STEP = 0.5;
const DIAL_SWEEP_DEGREES = 300;

const DEFAULT_VIEW = {
  centerLon: -143,
  centerLat: 0,
  roll: 0,
};

const DEFAULT_SWEEP_MANIFEST_PATHS = [
  '/out/sweep-full-defaults/viewer-manifest.json',
  '/out/sweep-full-defaults/manifest.json',
];

const TILING_VARIANTS = [
  { key: 'nw', title: 'NW', gridX: -1, gridY: -1 },
  { key: 'n', title: 'N', gridX: 0, gridY: -1 },
  { key: 'ne', title: 'NE', gridX: 1, gridY: -1 },
  { key: 'w', title: 'W', gridX: -1, gridY: 0 },
  { key: 'c', title: 'Center', gridX: 0, gridY: 0, isCenter: true },
  { key: 'e', title: 'E', gridX: 1, gridY: 0 },
  { key: 'sw', title: 'SW', gridX: -1, gridY: 1 },
  { key: 's', title: 'S', gridX: 0, gridY: 1 },
  { key: 'se', title: 'SE', gridX: 1, gridY: 1 },
];

const state = {
  sourceSweepManifest: null,
  sweepManifest: null,
  sweepManifestUrl: null,
  sweepIndex: null,
  selectedCase: null,
  targetOrientation: { ...DEFAULT_VIEW },
  dialDrag: null,
  stageDrag: null,
  failedSourcePngs: new Set(),
  motionSignature: '',
  motionRequestId: 0,
};

const refs = {};

function buildAxisControl(axisName, label) {
  return `
    <section class="sqv-axis">
      <label class="sqv-axis-label" for="${axisName}-number">${label}</label>
      <div class="sqv-axis-row">
        <button class="sqv-dial" type="button" data-axis-dial="${axisName}" aria-label="${label}">
          <span class="sqv-dial-ring"></span>
          <span class="sqv-dial-indicator" data-axis-indicator="${axisName}"></span>
          <span class="sqv-dial-core"></span>
        </button>
        <div class="sqv-axis-values">
          <input id="${axisName}-number" data-axis-number="${axisName}" type="number" step="${DEFAULT_INPUT_STEP}" />
          <span data-axis-snap="${axisName}" class="sqv-axis-snap">snap</span>
        </div>
      </div>
    </section>
  `;
}

function buildPreviewCells() {
  return TILING_VARIANTS.map((variant) => `
    <div class="sqv-preview-cell${variant.isCenter ? ' is-center' : ''}" data-preview-cell="${variant.key}">
      <img class="sqv-preview-image" data-preview-image="${variant.key}" alt="" draggable="false" />
    </div>
  `).join('');
}

function bindAxisRefs(root, axisName) {
  return {
    dial: root.querySelector(`[data-axis-dial="${axisName}"]`),
    indicator: root.querySelector(`[data-axis-indicator="${axisName}"]`),
    number: root.querySelector(`[data-axis-number="${axisName}"]`),
    snap: root.querySelector(`[data-axis-snap="${axisName}"]`),
    config: null,
  };
}

function createApp() {
  const app = document.querySelector('#app');
  app.innerHTML = `
    <main class="sqv-shell">
      <section class="sqv-hero sqv-panel">
        <p class="sqv-kicker">Downstream Viewer</p>
        <h1>Peirce Sweep Motion Desk</h1>
        <p class="sqv-lead">
          quarter-turn sweep の欠けた roll は downstream 側で 90° 回転補完し、
          scrubber は単一の nearest asset だけを表示します。入力は連続のまま保持しつつ、
          表示は nearest asset の roll に離散スナップし、
          下段は quincuncial tiling の 3x3 parity preview を gap なしで出します。
        </p>
      </section>

      <section class="sqv-layout">
        <aside class="sqv-sidebar sqv-panel">
          <div class="sqv-block">
            <p class="sqv-section-label">Dataset</p>
            <dl class="sqv-meta" id="dataset-meta">
              <div><dt>状態</dt><dd>manifest を読込中...</dd></div>
            </dl>
            <div class="sqv-link-row">
              <a class="sqv-link" id="gallery-link" target="_blank" rel="noreferrer">既存ギャラリー</a>
              <a class="sqv-link" id="png-link" target="_blank" rel="noreferrer">nearest PNG</a>
            </div>
          </div>

          <div class="sqv-block">
            <p class="sqv-section-label">Orientation</p>
            <div class="sqv-control-grid">
              ${buildAxisControl('centerLon', 'centerLon')}
              ${buildAxisControl('centerLat', 'centerLat')}
              ${buildAxisControl('roll', 'roll')}
            </div>
          </div>

          <div class="sqv-action-row">
            <button type="button" class="sqv-accent" id="reset-selection">default に戻す</button>
            <button type="button" class="sqv-ghost" id="copy-link">URL をコピー</button>
          </div>

          <p class="sqv-help">
            Dial は連続値を保持します。画像合成はせず、表示は常に単一 asset のみです。<br />
            roll 入力は連続でも、表示は nearest asset の離散 roll に固定します。<br />
            Tiling は quincuncial parity に従って odd parity だけ 180° 回転します。
          </p>
        </aside>

        <section class="sqv-main">
          <article class="sqv-panel">
            <div class="sqv-panel-head">
              <div>
                <p class="sqv-section-label">Motion</p>
                <h2>3 DOF Scrubber</h2>
              </div>
              <div class="sqv-readout" id="case-readout">case を選択中...</div>
            </div>

            <div class="sqv-motion-stage" id="motion-stage" tabindex="0">
              <img class="sqv-motion-image" id="motion-image" alt="" draggable="false" />
              <div class="sqv-stage-hud">
                <span>drag: lon / lat</span>
                <span>shift+drag or wheel: roll</span>
                <span>single asset only</span>
              </div>
            </div>

            <div class="sqv-neighbor-strip" id="neighbor-strip"></div>
          </article>

          <article class="sqv-panel">
            <div class="sqv-panel-head">
              <div>
                <p class="sqv-section-label">Tiling</p>
                <h2>Quincuncial Preview</h2>
              </div>
              <div class="sqv-readout" id="tiling-readout">gap-less 3x3 tessellation preview</div>
            </div>

            <div class="sqv-preview-stage" id="preview-stage">
              ${buildPreviewCells()}
            </div>
          </article>
        </section>
      </section>
    </main>
  `;

  refs.datasetMeta = app.querySelector('#dataset-meta');
  refs.galleryLink = app.querySelector('#gallery-link');
  refs.pngLink = app.querySelector('#png-link');
  refs.caseReadout = app.querySelector('#case-readout');
  refs.tilingReadout = app.querySelector('#tiling-readout');
  refs.neighborStrip = app.querySelector('#neighbor-strip');
  refs.motionStage = app.querySelector('#motion-stage');
  refs.motionImage = app.querySelector('#motion-image');
  refs.copyLinkButton = app.querySelector('#copy-link');
  refs.resetSelectionButton = app.querySelector('#reset-selection');
  refs.controls = {
    centerLon: bindAxisRefs(app, 'centerLon'),
    centerLat: bindAxisRefs(app, 'centerLat'),
    roll: bindAxisRefs(app, 'roll'),
  };
  refs.previewTiles = TILING_VARIANTS.map((variant) => ({
    variant,
    image: app.querySelector(`[data-preview-image="${variant.key}"]`),
  }));

  bindEvents();
}

function getInitialManifestUrls() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('manifest')) {
    return [new URL(params.get('manifest'), window.location.href)];
  }
  return DEFAULT_SWEEP_MANIFEST_PATHS.map((value) => new URL(value, window.location.origin));
}

function getInitialTarget() {
  const params = new URLSearchParams(window.location.search);
  return {
    centerLon: Number(params.get('lon') ?? DEFAULT_VIEW.centerLon),
    centerLat: Number(params.get('lat') ?? DEFAULT_VIEW.centerLat),
    roll: Number(params.get('roll') ?? DEFAULT_VIEW.roll),
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchJsonWithFallback(urls) {
  let lastError = new Error('No manifest URL provided.');
  for (const url of urls) {
    try {
      return {
        url,
        data: await fetchJson(url),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isOddParityTile(variant) {
  return Math.abs(variant.gridX + variant.gridY) % 2 === 1;
}

function normalizeTargetOrientation(target) {
  return {
    centerLon: normalizeLongitude(Number(target.centerLon) || 0),
    centerLat: clamp(Number(target.centerLat) || 0, state.sweepIndex.latMin, state.sweepIndex.latMax),
    roll: normalizeRoll(Number(target.roll) || 0, 360),
  };
}

function configureAxis(axisRefs, config) {
  axisRefs.config = config;
  axisRefs.number.min = String(config.min);
  axisRefs.number.max = String(config.max);
  axisRefs.number.step = String(DEFAULT_INPUT_STEP);
}

function configureControls() {
  configureAxis(refs.controls.centerLon, {
    min: -180,
    max: 180,
    wrap: true,
    stepScale: 1.2,
  });
  configureAxis(refs.controls.centerLat, {
    min: state.sweepIndex.latMin,
    max: state.sweepIndex.latMax,
    wrap: false,
    stepScale: 0.6,
  });
  configureAxis(refs.controls.roll, {
    min: 0,
    max: 360,
    wrap: true,
    stepScale: 1.2,
  });
}

function updateDatasetMeta() {
  const sourceCaseCount = state.sourceSweepManifest.caseCount || state.sourceSweepManifest.cases.length;
  const compensation = state.sweepManifest.viewerAssets?.expandedByRotation
    ? 'quarter-turn + 90deg rotate'
    : 'none';

  refs.datasetMeta.innerHTML = `
    <div><dt>viewer cases</dt><dd>${state.sweepManifest.caseCount}</dd></div>
    <div><dt>source cases</dt><dd>${sourceCaseCount}</dd></div>
    <div><dt>lon step</dt><dd>${formatAngleLabel(state.sweepIndex.lonStep, 0)}°</dd></div>
    <div><dt>lat step</dt><dd>${formatAngleLabel(state.sweepIndex.latStep, 0)}°</dd></div>
    <div><dt>roll step</dt><dd>${formatAngleLabel(state.sweepIndex.rollStep, 0)}°</dd></div>
    <div><dt>roll補完</dt><dd>${escapeHtml(compensation)}</dd></div>
    <div><dt>source</dt><dd>${escapeHtml(state.sourceSweepManifest.inputFile)}</dd></div>
  `;
}

function normalizeDialValue(axisName, value) {
  if (axisName === 'centerLon') return normalizeLongitude(value);
  if (axisName === 'roll') return normalizeRoll(value, 360);
  return clamp(value, state.sweepIndex.latMin, state.sweepIndex.latMax);
}

function getDialAngle(axisName, axisRefs, value) {
  const normalizedValue = normalizeDialValue(axisName, value);
  const span = axisRefs.config.max - axisRefs.config.min;
  const ratio = span > 0 ? clamp((normalizedValue - axisRefs.config.min) / span, 0, 1) : 0.5;
  return ratio * DIAL_SWEEP_DEGREES - (DIAL_SWEEP_DEGREES / 2);
}

function getSnapDelta(axisName, targetValue, snappedValue) {
  if (axisName === 'centerLat') {
    return snappedValue - targetValue;
  }
  return signedAngularDelta(targetValue, snappedValue, 360);
}

function setAxisDisplay(axisName, targetValue, snappedValue) {
  const axisRefs = refs.controls[axisName];
  axisRefs.number.value = formatAngleLabel(targetValue, 2);
  axisRefs.snap.textContent = `snap ${formatAngleLabel(snappedValue)} / d ${formatAngleLabel(getSnapDelta(axisName, targetValue, snappedValue))}`;
  axisRefs.indicator.style.transform = `translate(-50%, -50%) rotate(${getDialAngle(axisName, axisRefs, targetValue)}deg)`;
}

function updateControlValues(targetOrientation, snappedCase) {
  setAxisDisplay('centerLon', targetOrientation.centerLon, snappedCase.centerLon);
  setAxisDisplay('centerLat', targetOrientation.centerLat, snappedCase.centerLat);
  setAxisDisplay('roll', targetOrientation.roll, snappedCase.roll);
}

function buildImageTransform(rotationDegrees) {
  return `translate(-50%, -50%) rotate(${rotationDegrees}deg)`;
}

function getRenderedRotation(selection) {
  return selection.rotationDegrees;
}

function getCaseScore(entry, targetOrientation) {
  return (
    angularDistance(entry.centerLon, targetOrientation.centerLon, 360) ** 2
    + (entry.centerLat - targetOrientation.centerLat) ** 2
    + angularDistance(entry.roll, targetOrientation.roll, 360) ** 2
  );
}

function findNearestRenderableCase(targetOrientation, targetCase) {
  const sourceKey = targetCase.sourcePng || targetCase.png;
  if (!state.failedSourcePngs.has(sourceKey)) return targetCase;

  let best = null;
  let bestScore = Infinity;

  for (const entry of state.sweepIndex.cases) {
    const nextSourceKey = entry.sourcePng || entry.png;
    if (state.failedSourcePngs.has(nextSourceKey)) continue;
    const score = getCaseScore(entry, targetOrientation);
    if (score < bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  return best || targetCase;
}

function handleFailedSelection(selection) {
  const failedSource = selection.sourcePng || selection.png;
  if (!failedSource || state.failedSourcePngs.has(failedSource)) return;
  state.failedSourcePngs.add(failedSource);
  state.motionSignature = '';
  renderForTarget(state.targetOrientation);
}

function renderMotionImage(selection) {
  const imageUrl = new URL(selection.sourcePng || selection.png, state.sweepManifestUrl).href;
  const renderedRotation = getRenderedRotation(selection);
  const signature = `${imageUrl}|${formatAngleLabel(renderedRotation, 4)}`;
  const image = refs.motionImage;

  if (state.motionSignature === signature) return;

  const applyRenderedState = () => {
    image.src = imageUrl;
    image.alt = selection.label;
    image.style.transform = buildImageTransform(renderedRotation);
    image.dataset.sourcePng = selection.sourcePng || selection.png;
    image.dataset.imageUrl = imageUrl;
    state.motionSignature = signature;
  };

  if (image.dataset.imageUrl === imageUrl) {
    applyRenderedState();
    return;
  }

  const requestId = ++state.motionRequestId;
  const preload = new Image();
  preload.addEventListener('load', () => {
    if (requestId !== state.motionRequestId) return;
    applyRenderedState();
  });
  preload.addEventListener('error', () => {
    if (requestId !== state.motionRequestId) return;
    handleFailedSelection(selection);
  });
  preload.src = imageUrl;
}

function updatePreviewTiles(selection) {
  const imageUrl = new URL(selection.sourcePng || selection.png, state.sweepManifestUrl).href;
  const baseRotation = getRenderedRotation(selection);

  for (const { variant, image } of refs.previewTiles) {
    const tileRotation = isOddParityTile(variant) ? 180 : 0;
    image.src = imageUrl;
    image.alt = `${selection.label} / ${variant.title}`;
    image.style.transform = `rotate(${baseRotation + tileRotation}deg)`;
  }
}

function renderNeighbors() {
  const neighbors = getNeighborCases(state.sweepIndex, state.selectedCase);
  refs.neighborStrip.innerHTML = neighbors
    .map((neighbor) => `
      <button class="sqv-neighbor" type="button" data-case-key="${escapeHtml(neighbor.entry.caseKey ?? String(neighbor.entry.caseId))}">
        <span>${neighbor.label}</span>
        <strong>${formatAngleLabel(neighbor.entry.centerLon)} / ${formatAngleLabel(neighbor.entry.centerLat)} / ${formatAngleLabel(neighbor.entry.roll)}</strong>
      </button>
    `)
    .join('');
}

function prefetchNeighbors() {
  for (const neighbor of getNeighborCases(state.sweepIndex, state.selectedCase)) {
    const preload = new Image();
    preload.src = new URL(neighbor.entry.sourcePng || neighbor.entry.png, state.sweepManifestUrl).href;
  }
}

function updateReadout(targetOrientation, selection) {
  refs.caseReadout.textContent = `target ${formatAngleLabel(targetOrientation.centerLon)} / ${formatAngleLabel(targetOrientation.centerLat)} / ${formatAngleLabel(targetOrientation.roll)} | snap ${formatAngleLabel(selection.centerLon)} / ${formatAngleLabel(selection.centerLat)} / ${formatAngleLabel(selection.roll)} | source ${selection.sourceCaseId}`;
  refs.tilingReadout.textContent = 'odd parity tiles rotate 180deg; preview has no inter-tile gap';
}

function syncLocation(targetOrientation) {
  const url = new URL(window.location.href);
  url.searchParams.set('lon', formatAngleLabel(targetOrientation.centerLon));
  url.searchParams.set('lat', formatAngleLabel(targetOrientation.centerLat));
  url.searchParams.set('roll', formatAngleLabel(targetOrientation.roll));
  url.searchParams.set('manifest', state.sweepManifestUrl.href);
  history.replaceState({}, '', url);
}

function renderForTarget(target) {
  const targetOrientation = normalizeTargetOrientation(target);
  const snapped = findNearestSweepCase(state.sweepIndex, targetOrientation);
  const selection = findNearestRenderableCase(targetOrientation, snapped);

  state.targetOrientation = targetOrientation;
  state.selectedCase = selection;

  refs.pngLink.href = new URL(selection.sourcePng || selection.png, state.sweepManifestUrl).href;
  updateControlValues(targetOrientation, selection);
  renderMotionImage(selection);
  updatePreviewTiles(selection);
  renderNeighbors();
  prefetchNeighbors();
  updateReadout(targetOrientation, selection);
  syncLocation(targetOrientation);
}

function stepAxisValue(axisName, delta) {
  const config = refs.controls[axisName].config;
  return normalizeDialValue(axisName, state.targetOrientation[axisName] + delta * config.stepScale);
}

function getPointerAngle(element, event) {
  const bounds = element.getBoundingClientRect();
  const centerX = bounds.left + (bounds.width / 2);
  const centerY = bounds.top + (bounds.height / 2);
  const angle = (Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180) / Math.PI + 90;
  return Number.isFinite(angle) ? angle : 0;
}

function wrapDialDelta(delta) {
  let nextDelta = delta;
  while (nextDelta <= -180) nextDelta += 360;
  while (nextDelta > 180) nextDelta -= 360;
  return nextDelta;
}

function bindDial(axisName, axisRefs) {
  axisRefs.dial.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    axisRefs.dial.focus();
    state.dialDrag = {
      pointerId: event.pointerId,
      axisName,
      lastAngle: getPointerAngle(axisRefs.dial, event),
      value: state.targetOrientation[axisName],
    };
    axisRefs.dial.setPointerCapture(event.pointerId);
  });

  axisRefs.dial.addEventListener('pointermove', (event) => {
    if (!state.dialDrag || state.dialDrag.axisName !== axisName || state.dialDrag.pointerId !== event.pointerId) {
      return;
    }

    const nextAngle = getPointerAngle(axisRefs.dial, event);
    const deltaAngle = wrapDialDelta(nextAngle - state.dialDrag.lastAngle);
    const span = axisRefs.config.max - axisRefs.config.min;
    const nextValue = normalizeDialValue(
      axisName,
      state.dialDrag.value + ((deltaAngle / DIAL_SWEEP_DEGREES) * span),
    );

    state.dialDrag.lastAngle = nextAngle;
    state.dialDrag.value = nextValue;

    renderForTarget({
      ...state.targetOrientation,
      [axisName]: nextValue,
    });
  });

  function releaseDial(event) {
    if (!state.dialDrag || state.dialDrag.axisName !== axisName || state.dialDrag.pointerId !== event.pointerId) {
      return;
    }
    state.dialDrag = null;
    if (axisRefs.dial.hasPointerCapture(event.pointerId)) {
      axisRefs.dial.releasePointerCapture(event.pointerId);
    }
  }

  axisRefs.dial.addEventListener('pointerup', releaseDial);
  axisRefs.dial.addEventListener('pointercancel', releaseDial);
  axisRefs.dial.addEventListener('wheel', (event) => {
    event.preventDefault();
    const direction = Math.sign(event.deltaY) || 1;
    renderForTarget({
      ...state.targetOrientation,
      [axisName]: stepAxisValue(axisName, direction),
    });
  }, { passive: false });

  axisRefs.dial.addEventListener('keydown', (event) => {
    let delta = 0;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') delta = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') delta = 1;
    if (!delta) return;
    event.preventDefault();
    renderForTarget({
      ...state.targetOrientation,
      [axisName]: stepAxisValue(axisName, delta),
    });
  });
}

function bindEvents() {
  refs.motionImage.addEventListener('error', () => {
    if (!state.selectedCase) return;
    handleFailedSelection(state.selectedCase);
  });

  for (const [axisName, axisRefs] of Object.entries(refs.controls)) {
    bindDial(axisName, axisRefs);

    axisRefs.number.addEventListener('input', (event) => {
      if (event.target.value === '') return;
      renderForTarget({
        ...state.targetOrientation,
        [axisName]: Number(event.target.value),
      });
    });
  }

  refs.resetSelectionButton.addEventListener('click', () => {
    renderForTarget(DEFAULT_VIEW);
  });

  refs.copyLinkButton.addEventListener('click', async () => {
    await navigator.clipboard.writeText(window.location.href);
    refs.copyLinkButton.textContent = 'コピー済み';
    window.setTimeout(() => {
      refs.copyLinkButton.textContent = 'URL をコピー';
    }, 900);
  });

  refs.motionStage.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

  refs.motionStage.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    refs.motionStage.focus();
    state.stageDrag = {
      pointerId: event.pointerId,
      mode: event.shiftKey || event.button === 2 ? 'roll' : 'orbit',
      startX: event.clientX,
      startY: event.clientY,
      centerLon: state.targetOrientation.centerLon,
      centerLat: state.targetOrientation.centerLat,
      roll: state.targetOrientation.roll,
    };
    refs.motionStage.setPointerCapture(event.pointerId);
  });

  refs.motionStage.addEventListener('pointermove', (event) => {
    if (!state.stageDrag || state.stageDrag.pointerId !== event.pointerId) return;

    if (state.stageDrag.mode === 'roll') {
      renderForTarget({
        centerLon: state.stageDrag.centerLon,
        centerLat: state.stageDrag.centerLat,
        roll: state.stageDrag.roll + ((event.clientX - state.stageDrag.startX) * 0.25),
      });
      return;
    }

    renderForTarget({
      centerLon: state.stageDrag.centerLon + ((event.clientX - state.stageDrag.startX) * 0.35),
      centerLat: state.stageDrag.centerLat - ((event.clientY - state.stageDrag.startY) * 0.35),
      roll: state.stageDrag.roll,
    });
  });

  function releaseMotionPointer(event) {
    if (!state.stageDrag || state.stageDrag.pointerId !== event.pointerId) return;
    state.stageDrag = null;
    if (refs.motionStage.hasPointerCapture(event.pointerId)) {
      refs.motionStage.releasePointerCapture(event.pointerId);
    }
  }

  refs.motionStage.addEventListener('pointerup', releaseMotionPointer);
  refs.motionStage.addEventListener('pointercancel', releaseMotionPointer);
  refs.motionStage.addEventListener('wheel', (event) => {
    event.preventDefault();
    const direction = Math.sign(event.deltaY) || 1;
    renderForTarget({
      ...state.targetOrientation,
      roll: state.targetOrientation.roll + (direction * state.sweepIndex.rollStep * 0.5),
    });
  }, { passive: false });

  refs.motionStage.addEventListener('dblclick', () => {
    renderForTarget(DEFAULT_VIEW);
  });

  refs.motionStage.addEventListener('keydown', (event) => {
    const next = { ...state.targetOrientation };
    let handled = true;

    switch (event.key) {
      case 'ArrowLeft':
        next.centerLon -= state.sweepIndex.lonStep * 0.5;
        break;
      case 'ArrowRight':
        next.centerLon += state.sweepIndex.lonStep * 0.5;
        break;
      case 'ArrowUp':
        next.centerLat += state.sweepIndex.latStep * 0.5;
        break;
      case 'ArrowDown':
        next.centerLat -= state.sweepIndex.latStep * 0.5;
        break;
      case 'q':
      case 'Q':
        next.roll -= state.sweepIndex.rollStep * 0.5;
        break;
      case 'e':
      case 'E':
        next.roll += state.sweepIndex.rollStep * 0.5;
        break;
      default:
        handled = false;
    }

    if (!handled) return;
    event.preventDefault();
    renderForTarget(next);
  });

  refs.neighborStrip.addEventListener('click', (event) => {
    const button = event.target.closest('[data-case-key]');
    if (!button) return;
    const selected = state.sweepIndex.byCaseKey.get(String(button.dataset.caseKey));
    if (!selected) return;
    renderForTarget({
      centerLon: selected.centerLon,
      centerLat: selected.centerLat,
      roll: selected.roll,
    });
  });
}

async function loadData() {
  const { url, data } = await fetchJsonWithFallback(getInitialManifestUrls());
  state.sweepManifestUrl = url;
  state.sourceSweepManifest = data;
  state.sweepManifest = buildViewerManifest(data);
  state.sweepIndex = buildSweepIndex(state.sweepManifest);

  refs.galleryLink.href = new URL('./index.html', state.sweepManifestUrl).href;
  configureControls();
  updateDatasetMeta();
  renderForTarget(getInitialTarget());
}

async function main() {
  createApp();
  try {
    await loadData();
  } catch (error) {
    refs.datasetMeta.innerHTML = `
      <div><dt>読込失敗</dt><dd>${escapeHtml(error.message)}</dd></div>
    `;
    refs.caseReadout.textContent = 'manifest を読めませんでした';
    refs.tilingReadout.textContent = 'preview を初期化できませんでした';
    console.error(error);
  }
}

main();
