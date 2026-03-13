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

## 指標

- `Geo Mean`: 地表面積補正つき平均歪み
- `Visual Mean`: 投影後の見た目ベース平均歪み
- `P95`: 陸地上位 5% の歪み強度
- `Hotspot %`: 高歪み帯に入る陸地の面積比率
