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

- `/sweep-viewer.html`: `out/sweep-full-defaults` を読む downstream viewer。sweep と同じ元画像からブラウザでその場で投影するので角度は連続 (古い sweep 出力には先に `npm run sweep-source`。詳細は `apps/sweep-viewer/README.md`)
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
--from-sweep
```

- `center-lon` / `center-lat` / `roll`: 最終 SVG の向きです。**sweep・ビューア・ランキングと同じ数字でも、同じ向きにはなりません**（下の「sweep の向きと最終 SVG の向き」）。
- `--from-sweep`: `center-lon` / `center-lat` / `roll` を sweep の向きとして読み、最終 SVG で同じ地図になる向きへ読み替えてから変換します。読み替えた値は標準エラーに出ます。
- `lon0`: 旧オプションです。`center-lon` の別名として引き続き使えます。
- `--side` を省略した場合は、入力フレーム幅をそのまま出力辺長に使います。

### sweep の向きと最終 SVG の向き

sweep・ビューア・ランキングと最終 SVG（`npm run transform` と Web 画面）は、同じ `centerLon` / `centerLat` / `roll` でも別の向きの地図になります。

- sweep 側は、Peirce quincuncial の投影が既定で持っている回転 `[-90, -90, 45]` を打ち消してから向きの回転をかけます。指定した `(centerLon, centerLat)` が正方形の中央に来ます。
- 最終 SVG 側は、既定の回転を残したまま、その手前に向きの回転をかけます。

最終 SVG の向きの決め方はこのままにして、sweep で選んだ向きを読み替えて使います。塗りは、どの向きでも正方形の縁 (下の「塗りの切り方」) で切ってから閉じるので、読み替えた向きでも sweep と同じ地図になります。

- `npm run transform -- <input.svg> <output.svg> --center-lon=... --center-lat=... --roll=... --from-sweep` で、sweep の値をそのまま渡せます。
- `npm run convert-orientation -- --center-lon=-143 --center-lat=0 --roll=0` は、sweep の向きを最終 SVG の向きに読み替えて表示します（`--center-lon=127 --center-lat=-45 --roll=90`）。`--to=sweep` で逆向きです。Web 画面に入れる値はこれで求めます。
- sweep ビューアの状態表示と、ランキングの詳細欄にも「最終 SVG 用」の値が出ます。

読み替えは `src/orientation.js` にあり、`test/orientation.test.js` が「読み替えた値で作った最終 SVG の点が、sweep と同じ画素に来る」ことを確かめています。

## SVG To PNG

レイヤーを取捨選択しながら、元 SVG をそのまま PNG にラスタライズする補助 CLI を追加しました。

まず入力 SVG のレイヤー一覧を見ます。

```bash
npm run svg-png -- "イラレ出界図.svg" --list-layers
```

例:

```bash
npm run svg-png -- "イラレ出界図.svg" "out/第二分高面.png" --include-layer=_第二分高面 --exclude-layer=_文字,_境界 --width=12000
```

主なオプション:

```bash
--include-layer=_海,_第二分高面
--exclude-layer=_文字,_境界
--width=12000
--height=6000
--zoom=2
--background=white
```

- `include-layer`: 指定した `id` または `data-name` に一致するレイヤーだけを残します。親レイヤーは自動で保持します。
- `exclude-layer`: 指定したレイヤーを落とします。`include-layer` の後に適用します。
- `width` / `height` / `zoom`: 出力サイズ指定です。幅・高さは片方だけ指定できます。
- サイズ指定を省略した場合、極端に大きい SVG は既定で最大辺 `8192px` に抑えて安全側へ倒します。さらに大きく出したい場合は `--width` などで明示指定してください。

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
- `skip-existing=true`: 既に出力済みの PNG を再生成せず、途中再開しやすくします。再利用するのは、`render-cache.json` に記録した描画条件 (`output-size`・`source-width`・入力 SVG の内容・元画像の画素・描画処理のコード) が今回と同じで、その条件で描いたと記録にあるファイルだけです。条件が違えば理由を表示して作り直します。
- `dry-run`: 実ファイルを作らず、生成ケース数だけ確認します。
- sweep 出力では、評価の邪魔になる経緯線・文字・境界・ストロークを既定で含めません。

出力:

- 各ケースの PNG
- `source-equirect.png`: 各ケースを描いた元画像 (sweep viewer のライブ描画が使う)
- `manifest.json`
- `manifest.csv`
- `render-cache.json`: 各ケース PNG を描いた条件と、その条件で描いたファイルの一覧 (`skip-existing` が使う)
- `index.html` の簡易ギャラリー

推奨フロー:

- まず `sweep` でケースを総当たりし、`manifest.csv` や `index.html` で当たりを探します。
- その `centerLon` / `centerLat` / `roll` を `transform` に **`--from-sweep` を付けて**渡し、最終 SVG を作ります（付けないと別の向きになります。上の「sweep の向きと最終 SVG の向き」）。

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

## 塗りの切り方

Peirce quincuncial の正方形の縁は、球面上では南極から赤道へ伸びる 4 本の切れ目 (半分の子午線) です。辺の中点が切れ目の先端 (赤道) に、四隅が南極に当たり、1 本の切れ目が 1 辺の左右の半分に 2 度現れます。

- 塗りの輪は、元の正距円筒の平面で囲む側が内側になるよう向きを揃えてから、球面上で切れ目と交わる所で切ります。地図の幅いっぱいに渡る極の塗りも、同じ扱いで極の側が内側になります。
- 切った鎖をそれぞれ投影し、正方形の周に沿って時計回りに次の鎖の始まりへつないで閉じます。片ごとに短い方へ回すと、切れ目をまたぐ塗りが正方形を横切って閉じてしまいます。
- 切れ目と交わらず、外側が四隅を含む輪は、正方形から輪をくり抜いた 1 つの path (`fill-rule="evenodd"`) にします。
- 行って戻るだけの細い筋のような、自分と交わる輪は、切れ目の所の向きが輪全体の向きと食い違います。正方形に占める割合が、元の平面で測った球面上の割合から大きく離れたら、逆向きの結果と比べて近い方を採ります。

`test/transform.test.js` は、最終 SVG を sweep と同じ寸法で描いて画素を比べ、切れ目のまわりでも同じ地図になることを確かめています。

## 変換内容

- 一般図形はサンプリングしてから投影します。
- 背景・地形・海岸線・等高面はすべてベクタのまま保存します。
- 出力 SVG は Illustrator などの編集アプリでそのまま開けます。

## 例

```bash
npm run transform -- "イラレ出界図.svg" "out/イラレ出界図_peirceq_lon-143.svg" --lon0=-143
```
