import './style.css';
import { DEFAULT_OPTIONS, transformSvgString } from './transform.js';

const bundledSampleUrl = new URL('../イラレ出界図.svg', import.meta.url).href;

const state = {
  fileName: '',
  sourceSvg: '',
  outputSvg: '',
  outputUrl: '',
  stats: null,
  busy: false,
};

function createApp() {
  const app = document.querySelector('#app');
  app.innerHTML = `
    <main class="shell">
      <section class="hero">
        <p class="eyebrow">Vector Projection Workbench</p>
        <h1>Illustrator SVG to Peirce Quincuncial</h1>
        <p class="lead">
          SVG をラスタライズせずに変換し、文字は <code>text</code> のまま残します。
          地図更新後も同じ画面から再変換できます。
        </p>
      </section>

      <section class="panel control-panel">
        <div class="dropzone" id="dropzone">
          <input type="file" id="file-input" accept=".svg,image/svg+xml" />
          <div>
            <p class="drop-title">SVG を読み込む</p>
            <p class="drop-copy">ここへドラッグするか、クリックして選択</p>
          </div>
          <button class="ghost" id="load-sample" type="button">同梱サンプルを使う</button>
        </div>

        <form id="controls" class="controls">
          <label>
            <span>lon_0</span>
            <input id="lon0" type="number" step="0.1" value="${DEFAULT_OPTIONS.lon0}" />
          </label>

          <label>
            <span>サンプリング間隔</span>
            <input id="sample-step" type="number" step="0.5" min="0.5" value="${DEFAULT_OPTIONS.sampleStep}" />
          </label>

          <label>
            <span>投影精度</span>
            <input id="path-precision" type="number" step="0.05" min="0.05" value="${DEFAULT_OPTIONS.pathPrecision}" />
          </label>

          <button class="accent" id="transform-button" type="submit">変換して保存準備</button>
        </form>

        <div class="status" id="status">入力待ち</div>
      </section>

      <section class="panel output-panel">
        <div class="output-header">
          <div>
            <p class="section-label">Output</p>
            <h2>生成結果</h2>
          </div>
          <a class="accent disabled" id="download-link" download="peirce-quincuncial.svg">SVG を保存</a>
        </div>

        <div class="stats" id="stats">
          <p>まだ出力はありません。</p>
        </div>

        <div class="preview-frame">
          <iframe id="preview" title="SVG preview"></iframe>
        </div>
      </section>
    </main>
  `;

  wireEvents(app);
}

function wireEvents(app) {
  const fileInput = app.querySelector('#file-input');
  const loadSampleButton = app.querySelector('#load-sample');
  const controls = app.querySelector('#controls');
  const dropzone = app.querySelector('#dropzone');

  fileInput.addEventListener('change', async (event) => {
    const [file] = event.target.files || [];
    if (!file) return;
    await loadFile(file);
  });

  loadSampleButton.addEventListener('click', async () => {
    setStatus('同梱サンプルを読み込み中...');
    const response = await fetch(bundledSampleUrl);
    const text = await response.text();
    state.fileName = 'イラレ出界図.svg';
    state.sourceSvg = text;
    setStatus(`サンプル読込完了: ${state.fileName}`);
  });

  controls.addEventListener('submit', async (event) => {
    event.preventDefault();
    await runTransform();
  });

  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', async (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragover');
    const [file] = event.dataTransfer?.files || [];
    if (!file) return;
    await loadFile(file);
  });
}

async function loadFile(file) {
  setStatus(`読込中: ${file.name}`);
  state.fileName = file.name;
  state.sourceSvg = await file.text();
  setStatus(`読込完了: ${file.name}`);
}

function setBusy(next) {
  state.busy = next;
  const transformButton = document.querySelector('#transform-button');
  transformButton.disabled = next;
  transformButton.textContent = next ? '変換中...' : '変換して保存準備';
}

function setStatus(message) {
  document.querySelector('#status').textContent = message;
}

function updateDownload() {
  const link = document.querySelector('#download-link');
  if (state.outputUrl) {
    link.href = state.outputUrl;
    link.classList.remove('disabled');
    const stem = (state.fileName || 'map').replace(/\.svg$/i, '');
    const lon0 = document.querySelector('#lon0').value || DEFAULT_OPTIONS.lon0;
    link.download = `${stem}_peirceq_lon${String(Math.round(Number(lon0))).padStart(3, '0')}.svg`;
  } else {
    link.removeAttribute('href');
    link.classList.add('disabled');
  }
}

function updatePreview() {
  const preview = document.querySelector('#preview');
  preview.src = state.outputUrl || 'about:blank';
}

function updateStats() {
  const stats = document.querySelector('#stats');
  if (!state.stats) {
    stats.innerHTML = '<p>まだ出力はありません。</p>';
    return;
  }

  stats.innerHTML = `
    <dl>
      <div><dt>入力ファイル</dt><dd>${escapeHtml(state.fileName || '(sample)')}</dd></div>
      <div><dt>変換ジオメトリ</dt><dd>${state.stats.geometryCount}</dd></div>
      <div><dt>文字要素</dt><dd>${state.stats.textCount}</dd></div>
      <div><dt>出力辺長</dt><dd>${Number(state.stats.outputSide).toFixed(3)}</dd></div>
    </dl>
  `;
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function runTransform() {
  if (!state.sourceSvg) {
    setStatus('先に SVG を読み込んでください。');
    return;
  }

  setBusy(true);
  setStatus('ベクタ変換を実行中...');

  const lon0 = Number(document.querySelector('#lon0').value);
  const sampleStep = Number(document.querySelector('#sample-step').value);
  const pathPrecision = Number(document.querySelector('#path-precision').value);

  try {
    const result = await transformSvgString(state.sourceSvg, {
      lon0,
      sampleStep,
      pathPrecision,
    });

    state.outputSvg = result.svgText;
    state.stats = result.stats;

    if (state.outputUrl) {
      URL.revokeObjectURL(state.outputUrl);
    }
    state.outputUrl = URL.createObjectURL(
      new Blob([state.outputSvg], { type: 'image/svg+xml;charset=utf-8' }),
    );

    updateDownload();
    updatePreview();
    updateStats();
    setStatus('変換完了。SVG はそのまま編集可能です。');
  } catch (error) {
    console.error(error);
    setStatus(`変換失敗: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

createApp();
