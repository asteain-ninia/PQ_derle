import './style.css';
import { formatAngleLabel } from '../sweep-viewer/sweep-index.js';
import {
  buildFieldHeatmapRgba,
  buildFieldMaskRgba,
  buildLandHotspotOverlayRgba,
  buildLandMaskFromRgba,
  buildPeirceDistortionField,
  buildWeightedLandHighlightRgba,
} from '../../src/sweep-ranking-core.js';

const DEFAULT_MANIFEST_PATHS = [
  '/out/sweep-full-defaults/ranking-manifest.json',
];

const DEFAULT_VISIBLE_COUNT = 100;
const VIEW_LIST = 'list';
const VIEW_DETAIL = 'detail';
const state = {
  view: VIEW_LIST,
  manifest: null,
  manifestUrl: null,
  field: null,
  sortedCases: [],
  selectedCaseId: null,
  sortMetric: null,
  filterText: '',
  visibleCount: DEFAULT_VISIBLE_COUNT,
  currentAnalysisToken: 0,
  overlayCache: new Map(),
  fieldHeatmapUrl: null,
  fieldMaskUrl: null,
};

const refs = {};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatMetricValue(metric, value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (metric?.format === 'percent1') {
    return `${(value * 100).toFixed(1)}%`;
  }
  return value.toFixed(3);
}

function getMetricDefinition(metricKey) {
  return state.manifest.metrics.find((metric) => metric.key === metricKey) || null;
}

function buildMetricOptions() {
  return state.manifest.metrics
    .map((metric) => `
      <option value="${escapeHtml(metric.key)}"${metric.key === state.sortMetric ? ' selected' : ''}>
        ${escapeHtml(metric.label)} asc
      </option>
    `)
    .join('');
}

function buildMetricLegend() {
  return state.manifest.metrics
    .map((metric) => `
      <div class="sra-metric-card${metric.key === state.sortMetric ? ' is-active' : ''}">
        <strong>${escapeHtml(metric.label)}</strong>
        <span>${escapeHtml(metric.description)}</span>
      </div>
    `)
    .join('');
}

function buildDetailStage(stageId, title, imageId, overlayId) {
  return `
    <figure class="sra-stage-card">
      <figcaption>${escapeHtml(title)}</figcaption>
      <div class="sra-stage" id="${stageId}">
        <img class="sra-stage-image" id="${imageId}" alt="" draggable="false" />
        ${overlayId ? `<img class="sra-stage-overlay" id="${overlayId}" alt="" draggable="false" />` : ''}
      </div>
    </figure>
  `;
}

function createApp() {
  const app = document.querySelector('#app');
  app.innerHTML = `
    <main class="sra-shell">
      <section class="sra-hero sra-panel">
        <p class="sra-kicker">Downstream Ranker</p>
        <h1>Peirce Distortion Atlas</h1>
        <p class="sra-lead">
          <code>out/sweep-full-defaults</code> を downstream 解析し、
          Peirce quincuncial 上で陸地が高歪み帯にどれだけ乗るかを複数指標で順位付けします。
          詳細では高歪みマスクと重み付きハイライトを重ねて確認できます。
        </p>
      </section>

      <section class="sra-layout">
        <aside class="sra-sidebar sra-panel">
          <div class="sra-block">
            <p class="sra-section-label">Dataset</p>
            <dl class="sra-meta" id="dataset-meta">
              <div><dt>状態</dt><dd>ranking manifest を読込中...</dd></div>
            </dl>
            <div class="sra-link-row">
              <a class="sra-link" id="ranking-link" target="_blank" rel="noreferrer">ranking manifest</a>
              <a class="sra-link" id="viewer-link" target="_blank" rel="noreferrer">motion viewer</a>
            </div>
          </div>

          <div class="sra-block">
            <p class="sra-section-label">Sort</p>
            <label class="sra-label" for="metric-select">metric</label>
            <select id="metric-select" class="sra-select"></select>
            <label class="sra-label" for="filter-input">filter</label>
            <input id="filter-input" class="sra-input" type="search" placeholder="lon / lat / roll / case id" />
            <label class="sra-label" for="count-select">rows</label>
            <select id="count-select" class="sra-select">
              <option value="50">50</option>
              <option value="100" selected>100</option>
              <option value="200">200</option>
              <option value="99999">all</option>
            </select>
          </div>

          <div class="sra-block">
            <p class="sra-section-label">Metric Notes</p>
            <div class="sra-metric-grid" id="metric-legend"></div>
          </div>

          <div class="sra-block">
            <p class="sra-section-label">Global Field</p>
            <div class="sra-field-grid">
              <figure class="sra-field-card">
                <figcaption>distortion heat</figcaption>
                <img class="sra-field-image" id="field-heatmap" alt="" />
              </figure>
              <figure class="sra-field-card">
                <figcaption>hotspot mask</figcaption>
                <div class="sra-field-mask-wrap">
                  <img class="sra-field-image" id="field-base" alt="" />
                  <img class="sra-field-overlay" id="field-mask" alt="" />
                </div>
              </figure>
            </div>
            <p class="sra-help" id="field-summary"></p>
          </div>
        </aside>

        <section class="sra-main">
          <nav class="sra-viewbar sra-panel" aria-label="表示切替">
            <div class="sra-tabs" role="tablist">
              <button class="sra-tab" id="tab-list" type="button" role="tab" data-view="${VIEW_LIST}" aria-controls="ranking-panel">
                ランキング <span class="sra-tab-sub" id="tab-list-sub"></span>
              </button>
              <button class="sra-tab" id="tab-detail" type="button" role="tab" data-view="${VIEW_DETAIL}" aria-controls="detail-panel">
                詳細 <span class="sra-tab-sub" id="tab-detail-sub"></span>
              </button>
            </div>
            <div class="sra-stepper">
              <button class="sra-step-button" id="prev-case" type="button" title="前の順位 (← / k)">← 前</button>
              <span class="sra-step-position" id="rank-position">-</span>
              <button class="sra-step-button" id="next-case" type="button" title="次の順位 (→ / j)">次 →</button>
            </div>
            <p class="sra-key-hint">
              <kbd>←</kbd><kbd>→</kbd> / <kbd>k</kbd><kbd>j</kbd> 順位移動
              · <kbd>Enter</kbd> 詳細 · <kbd>Esc</kbd> 一覧
            </p>
          </nav>

          <article class="sra-panel sra-table-panel" id="ranking-panel" role="tabpanel" aria-labelledby="tab-list">
            <div class="sra-panel-head">
              <div>
                <p class="sra-section-label">Ranking</p>
                <h2 id="ranking-title">Loading...</h2>
              </div>
              <div class="sra-readout" id="ranking-readout"></div>
            </div>
            <div class="sra-table-wrap">
              <table class="sra-table">
                <thead>
                  <tr>
                    <th>rank</th>
                    <th>orientation</th>
                    <th>Geo Mean</th>
                    <th>Visual Mean</th>
                    <th>P95</th>
                    <th>Hotspot %</th>
                    <th>land %</th>
                  </tr>
                </thead>
                <tbody id="ranking-body"></tbody>
              </table>
            </div>
          </article>

          <article class="sra-panel sra-detail-panel" id="detail-panel" role="tabpanel" aria-labelledby="tab-detail" hidden>
            <div class="sra-panel-head">
              <div>
                <p class="sra-section-label">Detail</p>
                <h2 id="detail-title">case を選択中...</h2>
              </div>
              <div class="sra-readout" id="detail-readout"></div>
            </div>

            <div class="sra-detail-grid">
              ${buildDetailStage('detail-base-stage', 'Base Map', 'detail-base-image', null)}
              ${buildDetailStage('detail-mask-stage', 'Distortion Mask', 'detail-mask-image', 'detail-mask-overlay')}
              ${buildDetailStage('detail-highlight-stage', 'Weighted Land Highlight', 'detail-highlight-image', 'detail-highlight-overlay')}
            </div>

            <dl class="sra-case-meta" id="case-metrics">
              <div><dt>状態</dt><dd>case を待機中...</dd></div>
            </dl>
          </article>
        </section>
      </section>
    </main>
  `;

  refs.datasetMeta = app.querySelector('#dataset-meta');
  refs.rankingLink = app.querySelector('#ranking-link');
  refs.viewerLink = app.querySelector('#viewer-link');
  refs.metricSelect = app.querySelector('#metric-select');
  refs.filterInput = app.querySelector('#filter-input');
  refs.countSelect = app.querySelector('#count-select');
  refs.metricLegend = app.querySelector('#metric-legend');
  refs.fieldHeatmap = app.querySelector('#field-heatmap');
  refs.fieldBase = app.querySelector('#field-base');
  refs.fieldMask = app.querySelector('#field-mask');
  refs.fieldSummary = app.querySelector('#field-summary');
  refs.rankingTitle = app.querySelector('#ranking-title');
  refs.rankingReadout = app.querySelector('#ranking-readout');
  refs.rankingBody = app.querySelector('#ranking-body');
  refs.detailTitle = app.querySelector('#detail-title');
  refs.detailReadout = app.querySelector('#detail-readout');
  refs.caseMetrics = app.querySelector('#case-metrics');
  refs.detailBaseImage = app.querySelector('#detail-base-image');
  refs.detailMaskImage = app.querySelector('#detail-mask-image');
  refs.detailMaskOverlay = app.querySelector('#detail-mask-overlay');
  refs.detailHighlightImage = app.querySelector('#detail-highlight-image');
  refs.detailHighlightOverlay = app.querySelector('#detail-highlight-overlay');
  refs.main = app.querySelector('.sra-main');
  refs.rankingPanel = app.querySelector('#ranking-panel');
  refs.detailPanel = app.querySelector('#detail-panel');
  refs.tabList = app.querySelector('#tab-list');
  refs.tabDetail = app.querySelector('#tab-detail');
  refs.tabListSub = app.querySelector('#tab-list-sub');
  refs.tabDetailSub = app.querySelector('#tab-detail-sub');
  refs.prevCase = app.querySelector('#prev-case');
  refs.nextCase = app.querySelector('#next-case');
  refs.rankPosition = app.querySelector('#rank-position');
}

function getInitialManifestUrls() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('manifest')) {
    return [new URL(params.get('manifest'), window.location.href)];
  }
  return DEFAULT_MANIFEST_PATHS.map((value) => new URL(value, window.location.origin));
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchJsonWithFallback(urls) {
  let lastError = new Error('No ranking manifest URL provided.');
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

function rgbaToDataUrl(rgba, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const imageData = context.createImageData(size, size);
  imageData.data.set(rgba);
  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

function buildSearchText(entry) {
  return [
    entry.caseId,
    entry.label,
    `lon ${formatAngleLabel(entry.centerLon)}`,
    `lat ${formatAngleLabel(entry.centerLat)}`,
    `roll ${formatAngleLabel(entry.roll)}`,
  ].join(' ').toLowerCase();
}

function getVisibleCases() {
  const needle = state.filterText.trim().toLowerCase();
  const filtered = needle
    ? state.sortedCases.filter((entry) => buildSearchText(entry).includes(needle))
    : state.sortedCases;
  return filtered.slice(0, state.visibleCount);
}

function ensureSelectedCase() {
  const visibleCases = getVisibleCases();
  if (!visibleCases.length) {
    state.selectedCaseId = null;
    return;
  }
  if (!visibleCases.some((entry) => entry.caseId === state.selectedCaseId)) {
    state.selectedCaseId = visibleCases[0].caseId;
  }
}

function updateDatasetMeta() {
  refs.datasetMeta.innerHTML = `
    <div><dt>cases</dt><dd>${state.manifest.caseCount}</dd></div>
    <div><dt>output</dt><dd>${state.manifest.outputSize}px</dd></div>
    <div><dt>source</dt><dd>${escapeHtml(state.manifest.inputFile || 'unknown')}</dd></div>
    <div><dt>hotspot</dt><dd>${state.manifest.distortionField.hotspotThreshold.toFixed(3)}</dd></div>
    <div><dt>clip max</dt><dd>${state.manifest.distortionField.clipMax.toFixed(3)}</dd></div>
  `;
  refs.rankingLink.href = state.manifestUrl.href;
}

function updateGlobalField() {
  refs.metricLegend.innerHTML = buildMetricLegend();
  refs.fieldHeatmap.src = state.fieldHeatmapUrl;
  refs.fieldBase.src = state.fieldHeatmapUrl;
  refs.fieldMask.src = state.fieldMaskUrl;
  refs.fieldSummary.textContent = `hotspot quantile ${state.manifest.analysisOptions.hotspotQuantile}, clip quantile ${state.manifest.analysisOptions.clipQuantile}`;
}

function sortCases() {
  state.sortedCases = [...state.manifest.cases].sort((left, right) => {
    const delta = left.metrics[state.sortMetric] - right.metrics[state.sortMetric];
    if (Math.abs(delta) > 1e-9) return delta;
    return left.caseId - right.caseId;
  });
}

function renderRanking() {
  sortCases();
  ensureSelectedCase();
  const visibleCases = getVisibleCases();
  const metric = getMetricDefinition(state.sortMetric);
  refs.metricSelect.innerHTML = buildMetricOptions();
  refs.rankingTitle.textContent = `${metric.label} で昇順`;
  refs.rankingReadout.textContent = `${visibleCases.length} / ${state.sortedCases.length} rows visible`;

  refs.rankingBody.innerHTML = visibleCases.length
    ? visibleCases
      .map((entry, index) => `
        <tr class="${entry.caseId === state.selectedCaseId ? 'is-selected' : ''}" data-case-id="${entry.caseId}">
          <td>${index + 1}</td>
          <td>
            <button class="sra-row-button" type="button" data-case-id="${entry.caseId}">
              <strong>${escapeHtml(entry.label)}</strong>
              <span>case ${entry.caseId}</span>
            </button>
          </td>
          <td>${entry.metrics.geoMeanDistortion.toFixed(3)}</td>
          <td>${entry.metrics.visualMeanDistortion.toFixed(3)}</td>
          <td>${entry.metrics.p95Distortion.toFixed(3)}</td>
          <td>${(entry.metrics.hotspotCoverage * 100).toFixed(1)}%</td>
          <td>${(entry.landRatio * 100).toFixed(1)}%</td>
        </tr>
      `)
      .join('')
    : '<tr><td colspan="7">filter に一致するケースがありません。</td></tr>';
  refs.tabListSub.textContent = `${visibleCases.length} 件`;
  updateNavigation();
  // filter / sort / rows の変更で選択中の case が差し替わることがあるので、URL も合わせる。
  syncLocation();
}

function getSelectedVisibleIndex(visibleCases = getVisibleCases()) {
  return visibleCases.findIndex((entry) => entry.caseId === state.selectedCaseId);
}

function updateNavigation() {
  const visibleCases = getVisibleCases();
  const index = getSelectedVisibleIndex(visibleCases);
  const selected = index >= 0 ? visibleCases[index] : null;
  refs.rankPosition.textContent = selected ? `#${index + 1} / ${visibleCases.length}` : '-';
  refs.prevCase.disabled = index <= 0;
  refs.nextCase.disabled = index < 0 || index >= visibleCases.length - 1;
  refs.tabDetailSub.textContent = selected ? `#${index + 1} ${selected.label}` : '';
}

function syncLocation() {
  // manifest 読込前は URL の case / view を初期値として残しておく。
  if (!state.manifest) return;
  const url = new URL(window.location.href);
  if (state.selectedCaseId === null) {
    url.searchParams.delete('case');
  } else {
    url.searchParams.set('case', String(state.selectedCaseId));
  }
  if (state.view === VIEW_DETAIL) {
    url.searchParams.set('view', VIEW_DETAIL);
  } else {
    url.searchParams.delete('view');
  }
  history.replaceState(history.state, '', url);
}

function setView(view, { focus = false } = {}) {
  state.view = view === VIEW_DETAIL ? VIEW_DETAIL : VIEW_LIST;
  const isDetail = state.view === VIEW_DETAIL;
  refs.rankingPanel.hidden = isDetail;
  refs.detailPanel.hidden = !isDetail;
  for (const [tab, active] of [[refs.tabList, !isDetail], [refs.tabDetail, isDetail]]) {
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  document.body.dataset.view = state.view;
  if (!isDetail) {
    scrollSelectedRowIntoView();
  }
  if (focus) {
    (isDetail ? refs.tabDetail : refs.tabList).focus({ preventScroll: true });
  }
  // 下までスクロールした状態で切り替えても、切替バーの直下から見えるようにする。
  const mainTop = refs.main.getBoundingClientRect().top + window.scrollY;
  if (window.scrollY > mainTop) {
    window.scrollTo({ top: mainTop });
  }
  syncLocation();
}

function scrollSelectedRowIntoView() {
  const row = refs.rankingBody.querySelector('tr.is-selected');
  if (!row) return;
  const wrap = row.closest('.sra-table-wrap');
  if (!wrap) return;
  const head = wrap.querySelector('thead');
  const headHeight = head ? head.offsetHeight : 0;
  const rowTop = row.offsetTop;
  const rowBottom = rowTop + row.offsetHeight;
  if (rowTop - headHeight < wrap.scrollTop) {
    wrap.scrollTop = rowTop - headHeight;
  } else if (rowBottom > wrap.scrollTop + wrap.clientHeight) {
    wrap.scrollTop = rowBottom - wrap.clientHeight;
  }
}

function selectCase(caseId) {
  if (caseId === state.selectedCaseId) return;
  state.selectedCaseId = caseId;
  for (const row of refs.rankingBody.querySelectorAll('tr[data-case-id]')) {
    row.classList.toggle('is-selected', Number(row.dataset.caseId) === caseId);
  }
  scrollSelectedRowIntoView();
  updateNavigation();
  syncLocation();
  renderSelectedCase();
}

function stepSelection(delta) {
  const visibleCases = getVisibleCases();
  if (!visibleCases.length) return;
  const index = getSelectedVisibleIndex(visibleCases);
  const nextIndex = Math.min(visibleCases.length - 1, Math.max(0, (index < 0 ? 0 : index + delta)));
  selectCase(visibleCases[nextIndex].caseId);
}

function updateViewerLink(selected) {
  if (!selected) {
    refs.viewerLink.removeAttribute('href');
    return;
  }
  const viewerManifestUrl = new URL('./viewer-manifest.json', state.manifestUrl);
  const viewerUrl = new URL('/sweep-viewer.html', window.location.origin);
  viewerUrl.searchParams.set('manifest', viewerManifestUrl.href);
  viewerUrl.searchParams.set('lon', formatAngleLabel(selected.centerLon, 2));
  viewerUrl.searchParams.set('lat', formatAngleLabel(selected.centerLat, 2));
  viewerUrl.searchParams.set('roll', formatAngleLabel(selected.roll, 2));
  refs.viewerLink.href = viewerUrl.href;
}

function renderCaseMeta(selected) {
  if (!selected) {
    refs.caseMetrics.innerHTML = '<div><dt>状態</dt><dd>case がありません</dd></div>';
    refs.detailTitle.textContent = 'case がありません';
    refs.detailReadout.textContent = '';
    updateViewerLink(null);
    return;
  }
  refs.detailTitle.textContent = selected.label;
  refs.detailReadout.textContent = `case ${selected.caseId} | ocean tol ${selected.oceanTolerance.toFixed(1)} | land ${(selected.landRatio * 100).toFixed(1)}%`;
  refs.caseMetrics.innerHTML = state.manifest.metrics
    .map((metric) => `
      <div>
        <dt>${escapeHtml(metric.label)}</dt>
        <dd>${escapeHtml(formatMetricValue(metric, selected.metrics[metric.key]))}</dd>
      </div>
    `)
    .join('')
    + `
      <div><dt>centerLon</dt><dd>${formatAngleLabel(selected.centerLon, 2)}</dd></div>
      <div><dt>centerLat</dt><dd>${formatAngleLabel(selected.centerLat, 2)}</dd></div>
      <div><dt>roll</dt><dd>${formatAngleLabel(selected.roll, 2)}</dd></div>
      <div><dt>ocean RGB</dt><dd>${selected.oceanColor.map((value) => value.toFixed(0)).join(', ')}</dd></div>
      <div><dt>land px</dt><dd>${selected.landPixelCount}</dd></div>
    `;
  updateViewerLink(selected);
}

function getSelectedCase() {
  return state.manifest.cases.find((entry) => entry.caseId === state.selectedCaseId) || null;
}

function clearDetailImages() {
  for (const image of [
    refs.detailBaseImage,
    refs.detailMaskImage,
    refs.detailMaskOverlay,
    refs.detailHighlightImage,
    refs.detailHighlightOverlay,
  ]) {
    image.removeAttribute('src');
    image.alt = '';
  }
}

function setDetailLoading(text) {
  refs.detailReadout.textContent = text;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.addEventListener('load', () => resolve(image));
    image.addEventListener('error', () => reject(new Error(`Failed to load ${url}`)));
    image.src = url;
  });
}

async function analyzeCaseOverlays(selected) {
  const cached = state.overlayCache.get(selected.caseId);
  if (cached) return cached;
  const imageUrl = new URL(selected.png, state.manifestUrl).href;
  const image = await loadImage(imageUrl);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const landAnalysis = buildLandMaskFromRgba(
    imageData.data,
    canvas.width,
    canvas.height,
    state.manifest.analysisOptions,
  );
  const maskOverlay = rgbaToDataUrl(
    buildLandHotspotOverlayRgba(landAnalysis.landMask, state.field, state.manifest.analysisOptions),
    state.field.outputSize,
  );
  const highlightOverlay = rgbaToDataUrl(
    buildWeightedLandHighlightRgba(landAnalysis.landMask, state.field, state.manifest.analysisOptions),
    state.field.outputSize,
  );
  const result = {
    imageUrl,
    maskOverlay,
    highlightOverlay,
  };
  state.overlayCache.set(selected.caseId, result);
  return result;
}

async function renderSelectedCase() {
  const selected = getSelectedCase();
  renderCaseMeta(selected);
  clearDetailImages();
  if (!selected) return;

  const currentToken = ++state.currentAnalysisToken;
  const imageUrl = new URL(selected.png, state.manifestUrl).href;
  refs.detailBaseImage.src = imageUrl;
  refs.detailMaskImage.src = imageUrl;
  refs.detailHighlightImage.src = imageUrl;
  setDetailLoading(`case ${selected.caseId} を解析中...`);

  try {
    const overlaySet = await analyzeCaseOverlays(selected);
    if (currentToken !== state.currentAnalysisToken) return;
    refs.detailBaseImage.alt = selected.label;
    refs.detailMaskImage.alt = selected.label;
    refs.detailHighlightImage.alt = selected.label;
    refs.detailMaskOverlay.src = overlaySet.maskOverlay;
    refs.detailMaskOverlay.alt = `${selected.label} distortion mask`;
    refs.detailHighlightOverlay.src = overlaySet.highlightOverlay;
    refs.detailHighlightOverlay.alt = `${selected.label} weighted land highlight`;
    renderCaseMeta(selected);
  } catch (error) {
    if (currentToken !== state.currentAnalysisToken) return;
    refs.detailReadout.textContent = error.message;
  }
}

function bindEvents() {
  refs.metricSelect.addEventListener('change', (event) => {
    state.sortMetric = event.target.value;
    renderRanking();
    renderSelectedCase();
    updateGlobalField();
  });

  refs.filterInput.addEventListener('input', (event) => {
    state.filterText = event.target.value;
    renderRanking();
    renderSelectedCase();
  });

  refs.countSelect.addEventListener('change', (event) => {
    state.visibleCount = Number(event.target.value) || DEFAULT_VISIBLE_COUNT;
    renderRanking();
    renderSelectedCase();
  });

  refs.rankingBody.addEventListener('click', (event) => {
    const button = event.target.closest('[data-case-id]');
    if (!button) return;
    // 一覧と詳細は同時に見えないので、行を選んだらそのまま詳細へ切り替える。
    selectCase(Number(button.dataset.caseId));
    setView(VIEW_DETAIL);
  });

  refs.tabList.addEventListener('click', () => setView(VIEW_LIST));
  refs.tabDetail.addEventListener('click', () => setView(VIEW_DETAIL));
  refs.prevCase.addEventListener('click', () => stepSelection(-1));
  refs.nextCase.addEventListener('click', () => stepSelection(1));

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input, select, textarea, [contenteditable="true"]')) {
      if (event.key === 'Escape' && target instanceof HTMLInputElement) target.blur();
      return;
    }
    if (!state.manifest) return;

    switch (event.key) {
      case 'ArrowLeft':
      case 'k':
      case 'K':
        event.preventDefault();
        stepSelection(-1);
        break;
      case 'ArrowRight':
      case 'j':
      case 'J':
        event.preventDefault();
        stepSelection(1);
        break;
      case 'Enter':
        if (state.view === VIEW_LIST && !(target instanceof HTMLElement && target.closest('button, a'))) {
          event.preventDefault();
          setView(VIEW_DETAIL);
        }
        break;
      case 'Escape':
        if (state.view === VIEW_DETAIL) {
          event.preventDefault();
          setView(VIEW_LIST);
        }
        break;
      default:
        break;
    }
  });
}

async function loadData() {
  const { url, data } = await fetchJsonWithFallback(getInitialManifestUrls());
  state.manifestUrl = url;
  state.manifest = data;
  state.sortMetric = data.defaultSortMetric || data.metrics?.[0]?.key;
  state.field = buildPeirceDistortionField(data.outputSize, data.analysisOptions);
  state.fieldHeatmapUrl = rgbaToDataUrl(buildFieldHeatmapRgba(state.field), state.field.outputSize);
  state.fieldMaskUrl = rgbaToDataUrl(buildFieldMaskRgba(state.field, data.analysisOptions), state.field.outputSize);
}

// 直リンクの case が既定の表示件数より下位にあると、ensureSelectedCase() が
// 先頭の case に差し替えてしまう。その case が入るところまで rows を広げる。
function ensureVisibleCountIncludes(caseId) {
  sortCases();
  const rank = state.sortedCases.findIndex((entry) => entry.caseId === caseId);
  if (rank < state.visibleCount) return;
  const options = Array.from(refs.countSelect.options)
    .map((option) => Number(option.value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  const nextCount = options.find((value) => value > rank) ?? options.at(-1);
  state.visibleCount = nextCount;
  refs.countSelect.value = String(nextCount);
}

function applyInitialSelection() {
  const params = new URLSearchParams(window.location.search);
  const caseParam = params.get('case');
  if (caseParam !== null && caseParam !== '' && Number.isFinite(Number(caseParam))) {
    const caseId = Number(caseParam);
    if (state.manifest.cases.some((entry) => entry.caseId === caseId)) {
      state.selectedCaseId = caseId;
      ensureVisibleCountIncludes(caseId);
    }
  }
  return params.get('view') === VIEW_DETAIL ? VIEW_DETAIL : VIEW_LIST;
}

async function main() {
  createApp();
  bindEvents();
  setView(VIEW_LIST);
  try {
    await loadData();
    const initialView = applyInitialSelection();
    updateDatasetMeta();
    renderRanking();
    updateGlobalField();
    setView(initialView);
    await renderSelectedCase();
  } catch (error) {
    refs.datasetMeta.innerHTML = `
      <div><dt>読込失敗</dt><dd>${escapeHtml(error.message)}</dd></div>
      <div><dt>必要手順</dt><dd>node scripts/generate-sweep-ranking-manifest.mjs</dd></div>
    `;
    refs.rankingTitle.textContent = 'ranking manifest がありません';
    refs.rankingReadout.textContent = '';
    refs.detailTitle.textContent = '初期化できませんでした';
    refs.detailReadout.textContent = 'ranking manifest を生成してから再読込してください';
    console.error(error);
  }
}

main();
