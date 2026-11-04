# Sweep Ranking

既存の `out/sweep-full-defaults` を downstream 解析して、
Peirce quincuncial 上の陸地歪みをランキング表示する別アプリです。

## 起動

まず ranking manifest を生成します。

```bash
npm run rank-sweep
```

続いて dev server を起動し、`http://localhost:5173/sweep-ranking.html` を開きます。

```bash
npm run dev
```

## 既定入力

- `/out/sweep-full-defaults/ranking-manifest.json`

URL クエリで差し替えできます。

```text
/sweep-ranking.html?manifest=/out/other-sweep/ranking-manifest.json
```

## 画面の切り替え

ランキング一覧と詳細は縦に積まず、上部の切替バーで入れ替えて表示します。

- 一覧の行をクリックすると、その case の詳細に切り替わります。
- `← 前` / `次 →` で、いまの並び順・filter のまま順位を前後に移動できます。
- キーボード: `←` `→` または `k` `j` で順位移動、`Enter` で詳細、`Esc` で一覧に戻ります
  (filter 入力中は文字入力が優先されます)。
- 選んだ case と表示中の画面は URL の `?case=<caseId>&view=detail` に残るので、再読込やリンク共有でも同じ画面を開けます。

## 指標

- `Geo Mean`: 地表面積補正つき平均歪み
- `Visual Mean`: 投影後の見た目ベース平均歪み
- `P95`: 陸地上位 5% の歪み強度
- `Hotspot %`: 高歪み帯に入る陸地の面積比率
