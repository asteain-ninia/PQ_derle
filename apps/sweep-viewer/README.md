# Sweep Viewer

既存の `out/sweep-full-defaults` を downstream で読むだけの別アプリです。
quarter-turn sweep の欠けた `roll` は viewer 側で 90° 回転補完し、
中央は単一の nearest asset だけを表示し、入力値は連続でも表示は nearest asset の離散 `roll` に固定します。
下段は quincuncial tiling の checkerboard 180° 回転 preview を gap なしで出します。

## 起動

```bash
npm run dev
```

ブラウザで `http://localhost:5173/sweep-viewer.html` を開きます。

## 既定入力

- first choice: `out/sweep-full-defaults/viewer-manifest.json`
- fallback: `out/sweep-full-defaults/manifest.json`

URL クエリで差し替えできます。

```text
/sweep-viewer.html?manifest=/out/other-sweep/manifest.json
```

## viewer manifest 生成

```bash
node scripts/generate-sweep-viewer-manifest.mjs
```

既定では `out/sweep-full-defaults/manifest.json` から
`out/sweep-full-defaults/viewer-manifest.json` を生成します。
