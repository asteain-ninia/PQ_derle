import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
  buildRenderKey,
  describeRenderKeyMismatch,
  planRenderCacheReuse,
  readRenderCache,
  RENDER_CACHE_FILE_NAME,
  writeRenderCache,
} from '../scripts/lib/sweep-render-cache.mjs';

const execFileAsync = promisify(execFile);
const SWEEP_SCRIPT = fileURLToPath(new URL('../scripts/sweep-peirce.mjs', import.meta.url));

function makeSourceImage(fill) {
  const pixels = new Uint8ClampedArray(4 * 2 * 4).fill(fill);
  return { width: 4, height: 2, pixels };
}

function makeKey(overrides = {}) {
  return buildRenderKey({
    svgText: '<svg/>',
    sourceWidth: 512,
    sourceImage: makeSourceImage(10),
    outputSize: 16,
    rendererSha256: 'r'.repeat(64),
    ...overrides,
  });
}

test('describeRenderKeyMismatch は変わった条件だけを理由に挙げる', () => {
  const base = makeKey();
  assert.deepEqual(describeRenderKeyMismatch(base, makeKey()), []);

  const resized = describeRenderKeyMismatch(base, makeKey({ outputSize: 24 }));
  assert.equal(resized.length, 1);
  assert.match(resized[0], /^output-size: 16 → 24$/);

  // SVG が変われば、元画像の画素も変わったことになる
  const edited = describeRenderKeyMismatch(base, makeKey({
    svgText: '<svg><rect/></svg>',
    sourceImage: makeSourceImage(20),
  }));
  assert.equal(edited.length, 2);
  assert.match(edited[0], /入力 SVG/);
  assert.match(edited[1], /元画像/);

  // SVG が同じでも、フィルタや resvg の違いで元画像の画素が変われば作り直す
  assert.equal(describeRenderKeyMismatch(base, makeKey({ sourceImage: makeSourceImage(30) })).length, 1);
  assert.equal(describeRenderKeyMismatch(base, makeKey({ rendererSha256: 's'.repeat(64) })).length, 1);
});

test('planRenderCacheReuse は条件が一致したときだけ記録のファイルを再利用する', () => {
  const key = makeKey();
  const cache = { key, files: new Set(['a.png', 'b.png']) };

  assert.deepEqual([...planRenderCacheReuse(cache, makeKey(), true).reusable].sort(), ['a.png', 'b.png']);
  assert.equal(planRenderCacheReuse(cache, makeKey({ outputSize: 24 }), true).reusable.size, 0);
  assert.equal(planRenderCacheReuse(null, key, true).reusable.size, 0);
  assert.equal(planRenderCacheReuse(null, key, true).reasons.length, 1);
  assert.deepEqual(planRenderCacheReuse(cache, key, false), { reusable: new Set(), reasons: [] });
});

test('render-cache.json は読み書きでき、壊れていれば null になる', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pq-render-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  assert.equal(await readRenderCache(dir), null);
  const key = makeKey();
  await writeRenderCache(dir, key, new Set(['b.png', 'a.png']));
  const loaded = await readRenderCache(dir);
  assert.deepEqual(loaded.key, key);
  assert.deepEqual([...loaded.files], ['a.png', 'b.png']);

  await fs.writeFile(path.join(dir, RENDER_CACHE_FILE_NAME), '{ broken', 'utf8');
  assert.equal(await readRenderCache(dir), null);
});

// 2:1 のフレームに陸地が 1 つある小さな地図。fill で陸地の色を変えられる
function makeSvg(landFill) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="180" viewBox="0 0 360 180">
  <rect x="0" y="0" width="360" height="180" fill="#3060a0"/>
  <path d="M60 40 L200 40 L200 120 L60 120 Z" fill="${landFill}"/>
</svg>`;
}

async function runSweep(svgPath, outputDir, extraArgs) {
  const { stdout } = await execFileAsync(process.execPath, [
    SWEEP_SCRIPT,
    svgPath,
    outputDir,
    '--lon-step=180',
    '--lat-step=90',
    '--roll-step=90',
    '--source-width=128',
    '--html=false',
    ...extraArgs,
  ]);
  const jsonStart = stdout.lastIndexOf('\n{');
  return { stdout, summary: JSON.parse(stdout.slice(jsonStart + 1)) };
}

async function readCasePngs(outputDir) {
  const manifest = JSON.parse(await fs.readFile(path.join(outputDir, 'manifest.json'), 'utf8'));
  return Promise.all(manifest.cases.map(async (entry) => PNG.sync.read(await fs.readFile(path.join(outputDir, entry.png)))));
}

test('sweep の skip-existing は出力の大きさや入力 SVG が変わったら作り直す', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pq-sweep-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const svgPath = path.join(dir, 'map.svg');
  const outputDir = path.join(dir, 'out');
  await fs.writeFile(svgPath, makeSvg('#40a040'), 'utf8');

  const first = await runSweep(svgPath, outputDir, ['--output-size=16']);
  assert.equal(first.summary.caseCount, 4);
  assert.equal(first.summary.renderedCount, 4);

  // 同じ条件なら全部再利用する
  const same = await runSweep(svgPath, outputDir, ['--output-size=16']);
  assert.equal(same.summary.renderedCount, 0);
  assert.equal(same.summary.skippedCount, 4);

  // 出力の大きさが変われば作り直し、PNG も新しい大きさになる (以前は全部スキップして古い大きさのまま残った)
  const resized = await runSweep(svgPath, outputDir, ['--output-size=24']);
  assert.equal(resized.summary.renderedCount, 4);
  assert.match(resized.stdout, /output-size: 16 → 24/);
  for (const png of await readCasePngs(outputDir)) {
    assert.equal(png.width, 24);
    assert.equal(png.height, 24);
  }

  // 入力 SVG が変われば作り直し、ケース画像も元画像と同じ新しい地図から描かれる
  const before = await readCasePngs(outputDir);
  await fs.writeFile(svgPath, makeSvg('#d02020'), 'utf8');
  const edited = await runSweep(svgPath, outputDir, ['--output-size=24']);
  assert.equal(edited.summary.renderedCount, 4);
  assert.match(edited.stdout, /入力 SVG の内容/);
  const after = await readCasePngs(outputDir);
  assert.ok(before.some((png, index) => !png.data.equals(after[index].data)));

  // skip-existing=false で描いたものも記録され、次回は再利用できる
  const forced = await runSweep(svgPath, outputDir, ['--output-size=24', '--skip-existing=false']);
  assert.equal(forced.summary.renderedCount, 4);
  const reused = await runSweep(svgPath, outputDir, ['--output-size=24']);
  assert.equal(reused.summary.skippedCount, 4);
});

test('sweep は描画条件の記録が無い既存 PNG を再利用しない', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pq-sweep-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const svgPath = path.join(dir, 'map.svg');
  const outputDir = path.join(dir, 'out');
  await fs.writeFile(svgPath, makeSvg('#40a040'), 'utf8');

  await runSweep(svgPath, outputDir, ['--output-size=16']);
  await fs.rm(path.join(outputDir, RENDER_CACHE_FILE_NAME));
  const rerun = await runSweep(svgPath, outputDir, ['--output-size=16']);
  assert.equal(rerun.summary.renderedCount, 4);
  assert.match(rerun.stdout, /記録 \(render-cache\.json\) が無い/);
});
