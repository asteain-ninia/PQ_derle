svg_peirce_quincuncial_v2.py

主な修正:
- 東西逆転対策として、出力Xをデフォルトで反転
- 海レイヤの背景矩形(_海色)は地理投影せず、出力全体の背景rectとして保持
- 分高面レイヤは塗りポリゴンの seam split を抑制
- 曲線サンプリングを細かく (max-seg=3, curve-steps=24)

まずは10度刻みをまとめて出す:
  py svg_peirce_quincuncial_v2.py "イラレ出界図.svg" --outdir out_all --combined-only

当たりの lon_0 だけ map/text/combined を出す:
  py svg_peirce_quincuncial_v2.py "イラレ出界図.svg" --outdir out_25 --lon0-list 25

まだ左右が逆なら:
  py svg_peirce_quincuncial_v2.py "イラレ出界図.svg" --outdir out_25 --lon0-list 25 --no-flip-x

元データ自体が西→東でなく東→西に並んでいる場合だけ:
  py svg_peirce_quincuncial_v2.py "イラレ出界図.svg" --outdir out_25 --lon0-list 25 --reverse-east-west
