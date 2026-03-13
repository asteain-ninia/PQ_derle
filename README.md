# Peirce Quincuncial SVG Converter

Illustrator 由来の 2:1 正距円筒 SVG を、Peirce quincuncial の正方形 SVG に変換するローカルアプリです。

## 特徴

- 地図本体はラスタライズせず、SVG パスとして再生成します。
- 文字は `text/tspan` のまま残し、位置だけ投影します。
- 同じ元地図を何度でも再変換できます。
- Web UI と CLI の両方を用意しています。
- 既定の `lon_0` は `-143` です。

## 前提

- 入力 SVG は 2:1 の正距円筒図法です。
- 元フレームは、もっとも大きい 2:1 の `rect` から自動検出します。
- 出力は正方形 `viewBox` の SVG です。

## セットアップ

```bash
npm install
```

## Web UI

```bash
npm run dev
```

表示された画面に SVG をドラッグするか、`同梱サンプルを使う` を押してください。

追加アプリ:

- `/sweep-viewer.html`: `out/sweep-full-defaults` を読む downstream viewer
- `/sweep-ranking.html`: `out/sweep-full-defaults/ranking-manifest.json` を読む歪みランキング viewer

## CLI

```bash
npm run transform -- "イラレ出界図.svg" "out/イラレ出界図_peirceq_lon-143.svg"
```

主なオプション:

```bash
--center-lon=-143
--center-lat=0
--roll=0
--lon0=-143
--sample-step=3
--path-precision=0.35
--side=<output-side>
```

- `center-lon` / `center-lat` / `roll`: 最終 SVG でも sweep と同じ向きを指定できます。
- `lon0`: 旧オプションです。`center-lon` の別名として引き続き使えます。
- `--side` を省略した場合は、入力フレーム幅をそのまま出力辺長に使います。

## Batch Sweep

低解像度 PNG で大量の向きを試すための総当たりモードを追加しました。
これは既存のベクタ変換とは別系統で、元 SVG を一度だけラスタ化し、
球面回転を変えながら Peirce quincuncial を直接 PNG に描きます。

走査しているパラメーターは次の 3 つです。

- `centerLon`: 球面上で正方形中央へ寄せる経度
- `centerLat`: 球面上で正方形中央へ寄せる緯度
- `roll`: その向きのまま正方形を何度回すか

この 3 自由度で、Peirce quincuncial に入る前段の向きはひとまず総当たりできます。
`roll-mode=quarter-turn` は、正方形として同一視できる 90° 回転だけをまとめる設定です。
評価用の sweep 画像では、経緯線・文字・境界・各種ストロークを自動で落とします。
既定値は `output-size=320`、`source-width=3072` に上げています。

```bash
npm run sweep -- "イラレ出界図.svg" "out/sweep"
```

主なオプション:

```bash
--lon-step=15
--lat-step=15
--roll-step=15
--roll-mode=quarter-turn
--output-size=320
--source-width=3072
--skip-existing=true
--dry-run
```

- `lon-step` / `lat-step` / `roll-step`: 総当たりの刻み幅です。
- `roll-mode=quarter-turn`: 正方形の 90° 回転同値をまとめ、roll を 0〜90° 未満だけ走査します。
- `roll-mode=full-turn`: 同値圧縮せず 0〜360° 未満を走査します。
- `output-size`: 各ケース PNG の一辺ピクセル数です。低くするほどケース数を優先できます。
- `source-width`: 元の正距円筒フレームを何ピクセル幅でラスタ化するかです。
- `skip-existing=true`: 既に出力済みの PNG を再生成せず、途中再開しやすくします。
- `dry-run`: 実ファイルを作らず、生成ケース数だけ確認します。
- sweep 出力では、評価の邪魔になる経緯線・文字・境界・ストロークを既定で含めません。

出力:

- 各ケースの PNG
- `manifest.json`
- `manifest.csv`
- `index.html` の簡易ギャラリー

推奨フロー:

- まず `sweep` でケースを総当たりし、`manifest.csv` や `index.html` で当たりを探します。
- その `centerLon` / `centerLat` / `roll` を `transform` に渡して最終 SVG を作ります。

## Distortion Ranking

`out/sweep-full-defaults` を downstream 解析し、Peirce quincuncial 上で
陸地が高歪み帯にどれだけ乗るかをランキング表示する別アプリです。

まず ranking manifest を生成します。

```bash
npm run rank-sweep
```

既定では `out/sweep-full-defaults/manifest.json` を読み、
`out/sweep-full-defaults/ranking-manifest.json` を出力します。

その後、`npm run dev` のままブラウザで `http://localhost:5173/sweep-ranking.html` を開きます。

実装上の歪み指標:

- `Geo Mean`: 地表面積補正つき平均歪み
- `Visual Mean`: 投影後の見た目ベース平均歪み
- `P95`: 陸地上位 5% の歪み強度
- `Hotspot %`: 高歪み帯に入る陸地の面積比率

## 出力仕様

- 地図の塗りと線は SVG パスです。
- 背景フレーム `rect` は、投影後の正方形背景 `rect` に置き換えます。
- `text/tspan` は編集可能なまま保持します。
- 文字は位置だけ投影し、回転や細かな調整は行いません。
- 経緯線は数学生成したレイヤーとして出力します。

## 南極処理

南極をまたぐ塗りは、Peirce quincuncial の corner 構造に合わせて専用処理しています。

- 極域の閉路帯を分離して coastline を取り出します。
- 元地図の東西 seam は、source 上の連続した coastline として再接続します。
- 投影 seam を跨ぐ箇所は、境界点を明示的に補間してから分割します。
- 各 sector は、corner に対応する 2 辺へ endpoint を正確に吸着させて閉じます。

この構成により、極点付近の塗りを SVG のまま安定して出力します。

## 変換内容

- 一般図形はサンプリングしてから投影します。
- 背景・地形・海岸線・等高面はすべてベクタのまま保存します。
- 出力 SVG は Illustrator などの編集アプリでそのまま開けます。

## 例

```bash
npm run transform -- "イラレ出界図.svg" "out/イラレ出界図_peirceq_lon-143.svg" --lon0=-143
```
