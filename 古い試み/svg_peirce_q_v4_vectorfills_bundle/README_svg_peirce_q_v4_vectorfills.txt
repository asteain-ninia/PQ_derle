svg_peirce_quincuncial_v4_vectorfills.py

目的
- 地図の塗り（海・分高面）は、ラスター埋め込みではなく SVG のベクタパスとして出力する
- 境界線はベクタのまま
- テキストは text のまま残して、位置だけ投影する

考え方
- 元の塗りパスをそのまま非線形投影すると、第一分高面のような大きい複合パスが壊れやすい
- そこで塗りだけは一度「色インデックス画像」にして投影し、投影後の色領域を輪郭抽出して SVG パスに戻す
- 出力自体は SVG ベクタだが、塗りの輪郭は内部で使った mask 解像度に依存する
- つまり v3 のような埋め込み PNG ではないが、数学的に元のベジェをそのまま保っているわけでもない

使い方（Windows）

10度刻みをまとめて出す:
py svg_peirce_quincuncial_v4_vectorfills.py "イラレ出界図.svg" --outdir out_all --combined-only

1つだけ出す:
py svg_peirce_quincuncial_v4_vectorfills.py "イラレ出界図.svg" --outdir out_25 --lon0-list 25

高画質寄り:
py svg_peirce_quincuncial_v4_vectorfills.py "イラレ出界図.svg" --outdir out_hq --lon0-list 25 --source-raster-width 9000 --mask-max-dim 4200 --contour-epsilon-px 0.8

速くプレビュー:
py svg_peirce_quincuncial_v4_vectorfills.py "イラレ出界図.svg" --outdir out_fast --combined-only --source-raster-width 3500 --mask-max-dim 1600 --contour-epsilon-px 1.4

主なオプション
- --source-raster-width
  元SVGの塗りを何px幅で一度サンプリングするか。大きいほど元地図の細かい島や尾根が残りやすい。
- --mask-max-dim
  投影後の色領域を輪郭抽出するための内部マスクの最大寸法。大きいほど輪郭が滑らか。
- --contour-epsilon-px
  輪郭簡略化。小さいほど元形状に近いがファイルは重くなる。
- --dilate-px
  輪郭抽出前に各色を少し膨らませる。色境界の細い隙間を防ぐ用途。既定は 1。
- --no-flip-x
  東西が逆になる場合のみ使う
- --reverse-east-west
  元SVGの経度解釈そのものが逆の場合のみ使う

出力
- *_combined.svg : 塗り + 境界 + 経緯線 + 文字
- *_map.svg      : 塗り + 境界 + 経緯線
- *_text.svg     : 文字のみ

今回のSVG向けの初期値メモ
- まずは lon_0 を 10 度刻みでざっと見る
- 当たりが出たら --source-raster-width 7000 以上、--mask-max-dim 3200 以上で本番
- まだ色の境界にごく細い隙間が見えるなら --dilate-px 2 を試す
- 輪郭の角張りが気になるなら --mask-max-dim を上げるか --contour-epsilon-px を 0.7〜0.9 に下げる
