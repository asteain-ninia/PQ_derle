# Sweep Viewer

既存の sweep 出力 (`out/sweep-full-defaults` など) を downstream で読む別アプリです。
中央の図は、sweep が各ケースを描いたのと同じ元画像 (正距円筒ラスタ) からブラウザ上でその場で投影し直す
**ライブ描画** で、どの角度でも連続に動きます。下段は quincuncial tiling の 3x3 parity preview
(odd parity のマスだけ 180° 回転) を gap なしで出します。

## 起動

```bash
npm run dev
```

ブラウザで `http://localhost:5173/sweep-viewer.html` を開きます。

## 既定入力

- `out/sweep-full-defaults/manifest.json` (`npm run sweep` の出力そのまま)。quarter-turn の sweep は
  viewer が読み込み時に 90° 回転ぶんを補って full-turn に展開するので、事前の変換は要りません
- 同じ場所に `viewer-manifest.json` (後述の事前展開済み manifest、任意) があればそちらを先に読みます
- ライブ描画の元画像: manifest の `sourceImage.png`、無ければ manifest と同じ場所の `source-equirect.png`
- ranking viewer (`/sweep-ranking.html`) の Dataset 欄にある `motion viewer` リンクは、同じ sweep の
  `manifest.json` (rank-sweep の `--input` で別名にした場合はその manifest) をこの viewer で開き、その case の向きを初期値にします

URL クエリで差し替えできます。

```text
/sweep-viewer.html?manifest=/out/other-sweep/manifest.json
```

## ライブ描画の元画像

`npm run sweep` は各ケースの PNG と一緒に `source-equirect.png` (各ケースを描いたのと同じ元画像) を書き、
manifest に `sourceWidth` と `sourceImage` を記録します。

それより前に作った sweep 出力には元画像が無いので、後から作ります。

```bash
npm run sweep-source                       # out/sweep-full-defaults
npm run sweep-source -- out/other-sweep --source-width=3072
```

`--source-width` を省略すると manifest の `sourceWidth`、それも無ければ manifest の `sourceFrame` と
同じ大きさになる幅を探します (`out/sweep-full-defaults` は 2048 でした)。sweep と違う幅で作ると
PNG と見た目が合わなくなるので、合わないときは止まります。
`out/sweep*/` は git 管理外なので、元画像もリポジトリには入りません (sweep 出力と同じ扱い)。

## 描画方式

投影の逆変換 (画素 → 球面) は向きに依存しない部分と回転に分けられます。

```text
projection.rotate(r).invert(p) = geoRotation(r).invert(base.invert(p))   (base は rotate([0, 0, 0]))
```

そこで `base.invert` の結果を画素ごとの単位ベクトル表 (LUT) として一度だけ作り、向きを変えるたびに
3x3 の回転と元画像の双一次補間だけを行います (`src/sweep-live-render.js`。sweep の `renderSweepCase` も同じ関数を使います)。

- LUT は Web Worker (最大 4 本) で行を分けて作ります。表示 400px で 0.1〜0.2 秒程度
- **WebGL2** (既定): LUT を float テクスチャにし、回転と補間をシェーダーで行います。sweep の PNG とは
  float32 の丸めで 0.05% 程度の画素が 1 段ずれることがあります
- **CPU**: WebGL2 が使えないとき、または WebGL2 がソフトウェア実装 (SwiftShader など、GPU の無い環境) のとき。
  Worker が行の帯ごとに描きます。sweep の PNG と画素単位で一致します。1 枚が 14ms を超えるときはドラッグ中だけ半分の解像度で描き、離すと全解像度で描き直します
- **PNG 表示** (フォールバック): 元画像が無い、または初期化に失敗したときは、従来どおり nearest asset を表示します。理由は Dataset 欄の「描画」に出ます

URL の `render=` で方式を固定できます (`auto` / `webgl` / `cpu` / `png`)。`liveDebug=1` で計測用の値を `window.__sweepViewerLive` に出します。

- 解像度は「ステージの短辺 − 余白」× devicePixelRatio (上限 1024、CPU は 640) です
- snap 欄と近傍ボタンは、ライブ描画中も参考として nearest asset の角度を示します
- PNG 表示での quarter-turn 補完は、roll +90° = 図の反時計回り 90° 回転として表示します
  (以前は時計回りに回していたため、roll 90° / 270° 付近で向きが違っていました)

## viewer manifest 生成 (任意)

viewer は `manifest.json` を読み込み時に展開するので、通常この手順は要りません。
展開済みの manifest をファイルとして残したいときだけ使います。

```bash
node scripts/generate-sweep-viewer-manifest.mjs
```

既定では `out/sweep-full-defaults/manifest.json` から
`out/sweep-full-defaults/viewer-manifest.json` を生成します (中身は viewer が読み込み時に作るものと同じです)。
