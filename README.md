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

## CLI

```bash
npm run transform -- "イラレ出界図.svg" "out/イラレ出界図_peirceq_lon-143.svg"
```

主なオプション:

```bash
--lon0=-143
--sample-step=3
--path-precision=0.35
--side=<output-side>
```

`--side` を省略した場合は、入力フレーム幅をそのまま出力辺長に使います。

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
