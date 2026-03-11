# Peirce Quincuncial 歪みリスクランキング

Peirce quincuncial 投影法の候補地図（lon=0°, 5°, 10°, ... 355°）を読み込み、
**陸上の歪みリスクが小さい順**にランキングするローカル Web アプリです。

> ⚠ **注意**: このアプリが算出するスコアは、厳密な微分幾何学的歪みテンソルではなく、
> Peirce quincuncial の既知の高歪み領域との空間的重なりに基づく**プロキシ指標**（代理変数）です。

---

## ディレクトリ構成

```
peirce-ranker/
├── app.py              # Flask Web サーバー（API + ページ配信）
├── analyzer.py         # 解析エンジン（ラスタライズ、マスク生成、スコア算出）
├── templates/
│   └── index.html      # フロントエンド SPA
├── requirements.txt    # Python 依存パッケージ
├── run.bat             # Windows ダブルクリック起動用
└── README.md           # このファイル
```

---

## 起動方法

### 前提条件

- **Python 3.10 以上**（3.11 / 3.12 推奨）
- pip が使える状態

### 手順

1. コマンドプロンプトまたは PowerShell でこのフォルダに移動:
   ```
   cd peirce-ranker
   ```

2. 依存パッケージをインストール:
   ```
   pip install -r requirements.txt
   ```
   > **CairoSVG のインストールに失敗する場合**:
   > Windows では GTK ランタイムが必要な場合があります。
   > - `pip install cairosvg` が通れば問題ありません（近年の pip wheel は同梱）
   > - それでも失敗する場合: [GTK for Windows](https://github.com/nickvdp/gtk3-for-windows) をインストールしてから再試行

3. アプリを起動:
   ```
   python app.py
   ```
   または `run.bat` をダブルクリック。

4. ブラウザで **http://localhost:5050** を開く。

---

## 使い方

### 1. ZIP ファイルの読み込み

- 画面中央のドロップゾーンに ZIP をドラッグ＆ドロップ、またはファイル選択
- ZIP 内に `manifest.csv` があれば自動認識
- なくてもファイル名の `lonXXX` パターンから復元

### 2. 解析

- アップロード後、自動で全ケースの解析が始まる
- 進捗バーで状況を確認
- **同一 lon の combined/map/text は 1 ケースとして統合**（二重カウントなし）

### 3. ランキング確認

- スコアが低い（歪みリスクが小さい）順に表示
- ソート列の変更、表示件数の絞り込みが可能
- 各行の「詳細」ボタンで個別ケースの解析画像を表示

### 4. 詳細ビュー

- combined / map / text の 3 枚を並べて表示
- 陸地マスク、海岸線マスク、歪みリスクヒートマップ、高リスクオーバーレイ

### 5. 比較ビュー

- 「比較+」ボタンで任意のケースを追加
- 「上位3自動」で 1〜3 位を自動選択
- オーバーレイ・ヒートマップを横並びで比較

### 6. パラメータ調整

- サイドバーで各パラメータを変更
- 「パラメータで再解析」ボタンで全ケースを再計算

### 7. エクスポート

- CSV: ランキング表をダウンロード
- JSON: パラメータ含む詳細情報をダウンロード

---

## スコアリング式の説明

### 歪みリスクフィールド（ピクセル単位）

Peirce quincuncial の正方形上で、各ピクセル位置 p に以下の 3 種のリスクを定義:

#### A. 特異点近傍ペナルティ (`risk_point`)

4 辺の中央点（特異点代表）への最短距離 dS に基づくガウス:

```
risk_point(p) = Σ exp(-dS²/(2·σ_point²))   (4点の和)
```

- σ_point = 0.065 × W（初期値）
- 特異点に近い陸地ほど強いペナルティ

#### B. 辺中央帯ペナルティ (`risk_band`)

各辺中央から内側へ伸びる楕円ガウス帯 4 本:

```
risk_band(p) = Σ exp(-d_tangent²/(2·σ_t²) - d_normal²/(2·σ_n²))
```

- σ_tangent = 0.12 × W（辺に平行方向に広い）
- σ_normal = 0.07 × W（辺から内側方向にやや狭い）

#### C. 外周ペナルティ (`risk_edge`)

最も近い辺までの距離 dE に基づく二次関数:

```
risk_edge(p) = (1 - clamp(dE/edge_soft_limit, 0, 1))²
```

- edge_soft_limit = 0.18 × W

### 海岸線重み付け

海岸線近傍（陸海境界から coast_distance_px 以内）の陸ピクセルには coast_weight（初期値 1.35）を乗算。

### ピクセル単位の合成リスク

```
risk_total(p) = coast_weight(p) × (
    0.45 × risk_band(p) +
    0.35 × risk_point(p) +
    0.20 × risk_edge(p)
)
```

### ケース単位の最終スコア

```
final_score = 0.50 × mean(risk_total on land)
            + 0.30 × percentile_95(risk_total on land)
            + 0.20 × fraction(land in high_risk_zone)
```

high_risk_zone: risk_total が全ピクセルリスクの 75 パーセンタイルを超える領域（自動閾値）。

**スコアが低いほど上位（陸上歪みリスクが小さい）。**

---

## 拡張ポイント（将来のより厳密な歪み評価への差し替え）

### 1. `build_risk_field()` の差し替え

`analyzer.py` の `build_risk_field(W, H, params)` 関数が歪みリスクフィールドを返す。
これを以下に差し替え可能:

- **Jacobian ベースの真の歪み**: 逆投影の解析微分から局所的な面積歪み・角度歪みを計算
- **Tissot indicatrix**: 各点の Tissot 楕円の離心率・面積比をフィールド化
- **数値的偏微分**: 投影関数の数値微分から歪みテンソルを近似

差し替え時のインターフェース:
```python
def build_risk_field(W: int, H: int, params: AnalysisParams) -> np.ndarray:
    """(H, W) の float64 配列を返す。値域は [0, 1] 推奨。"""
```

### 2. `create_land_mask()` の改良

- GeoJSON/Shapefile の海岸線データを直接使用
- Natural Earth のベクタデータと投影変換を組み合わせ

### 3. 投影パラメータの追加

現在は lon（中心経度の回転）のみだが、以下を追加可能:
- 中心緯度の回転
- 回転角（正方形自体の回転）
- 別の quincuncial 系バリエーション

### 4. スコアリングの改良

- `score_case()` 内の重み・合成式をプラグイン化
- 人口密度重み（陸地でも無人地域は低重み）
- 特定地域（例: 日本近傍）の重み付け強化

---

## 依存パッケージ

| パッケージ | 用途 |
|-----------|------|
| Flask | Web サーバー |
| NumPy | 数値計算 |
| SciPy | 画像形態学処理 |
| Pillow | 画像処理 |
| CairoSVG | SVG → PNG ラスタライズ |

---

## トラブルシューティング

- **CairoSVG がインストールできない**: `pip install svglib reportlab` をインストールすればフォールバックで動作します
- **SVG が正しく描画されない**: viewBox 属性の設定を確認してください
- **メモリ不足**: raster_size を 512 に下げてください
- **解析が遅い**: raster_size を 512〜768 に下げると高速化されます（72 ケースで数分程度）
