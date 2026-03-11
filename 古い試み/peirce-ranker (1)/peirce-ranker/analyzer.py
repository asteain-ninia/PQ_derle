"""
analyzer.py — Peirce Quincuncial 歪みリスク・プロキシ解析エンジン

このモジュールは map.svg をラスタライズし、陸地マスク・海岸線を抽出した上で、
Peirce quincuncial 投影法の既知の高歪み領域（4辺中央の特異点とその周辺帯）
との重なりから「歪みリスク・プロキシ」を算出する。

注意: これは厳密な微分幾何学的歪みテンソルではなく、
投影法の性質に基づく近似的リスク指標である。
"""

import io
import csv
import re
import zipfile
import logging
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from PIL import Image
from scipy import ndimage

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# データクラス
# ---------------------------------------------------------------------------

@dataclass
class AnalysisParams:
    """解析パラメータ（UI から調整可能）"""
    raster_size: int = 512  # 大きな SVG の場合 512 推奨 (1024 は高精度だが遅い)

    # 特異点ガウスの sigma（正方形辺に対する比率）
    sigma_point_ratio: float = 0.065

    # 辺中央帯の sigma（接線方向 / 法線方向）
    sigma_tangent_ratio: float = 0.12
    sigma_normal_ratio: float = 0.07

    # 外周ペナルティのソフトリミット比率
    edge_soft_limit_ratio: float = 0.18

    # 3 種リスクの合成重み
    weight_band: float = 0.45
    weight_point: float = 0.35
    weight_edge: float = 0.20

    # 海岸線近傍の追加重み
    coast_weight: float = 1.35
    coast_distance_px: int = 6  # 海岸線からこの距離以内

    # 最終スコア合成
    weight_mean: float = 0.50
    weight_p95: float = 0.30
    weight_fraction: float = 0.20

    # 高リスクゾーン閾値（0 なら自動: 75 パーセンタイル）
    high_risk_threshold: float = 0.0

    # 背景色検出の色距離閾値
    bg_color_tolerance: int = 40

    # 小領域ノイズ除去の最小面積 (px)
    min_land_area: int = 80


@dataclass
class CaseFiles:
    """lon ごとの SVG ファイルバイト"""
    lon: int
    map_svg: Optional[bytes] = None
    combined_svg: Optional[bytes] = None
    text_svg: Optional[bytes] = None


@dataclass
class CaseResult:
    """1 ケースの解析結果"""
    lon: int
    mean_risk: float = 0.0
    p95_risk: float = 0.0
    high_risk_fraction: float = 0.0
    final_score: float = 0.0
    land_pixel_count: int = 0
    land_ratio: float = 0.0

    # 画像データ (PNG bytes) — UI 表示用
    thumb_png: bytes = field(default=b"", repr=False)
    land_mask_png: bytes = field(default=b"", repr=False)
    coastline_png: bytes = field(default=b"", repr=False)
    heatmap_png: bytes = field(default=b"", repr=False)
    overlay_png: bytes = field(default=b"", repr=False)
    raster_png: bytes = field(default=b"", repr=False)  # ラスタライズ結果

    # デバッグ情報
    mask_diag: dict = field(default_factory=dict, repr=False)


# ---------------------------------------------------------------------------
# ZIP 読み込み
# ---------------------------------------------------------------------------

def parse_zip(zip_bytes: bytes) -> dict[int, CaseFiles]:
    """
    ZIP を読み込み、lon をキーとした CaseFiles 辞書を返す。
    manifest.csv があればそれを優先し、なければファイル名から lon を抽出する。
    """
    cases: dict[int, CaseFiles] = {}

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = zf.namelist()

        # manifest.csv を探す
        manifest_path = None
        for n in names:
            if n.endswith("manifest.csv"):
                manifest_path = n
                break

        if manifest_path:
            logger.info("manifest.csv を検出: %s", manifest_path)
            cases = _parse_with_manifest(zf, manifest_path)
        else:
            logger.info("manifest.csv なし — ファイル名パターンから復元")
            cases = _parse_by_filename(zf)

    logger.info("読み込み完了: %d ケース", len(cases))
    return cases


def _parse_with_manifest(zf: zipfile.ZipFile, manifest_path: str) -> dict[int, CaseFiles]:
    """manifest.csv からケースを構築"""
    cases: dict[int, CaseFiles] = {}
    prefix = manifest_path.rsplit("/", 1)[0] + "/" if "/" in manifest_path else ""
    all_names = set(zf.namelist())
    # ベースネーム → フルパスのマッピング（重複時は最初の1つ）
    basename_map = {}
    for n in zf.namelist():
        bn = n.rsplit("/", 1)[-1] if "/" in n else n
        if bn and bn not in basename_map:
            basename_map[bn] = n

    raw = zf.read(manifest_path).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(raw))

    for row in reader:
        lon = int(float(row.get("lon0", 0))) % 360
        if lon not in cases:
            cases[lon] = CaseFiles(lon=lon)
        c = cases[lon]

        for key, attr in [("map", "map_svg"), ("combined", "combined_svg"), ("text", "text_svg")]:
            fname = row.get(key, "").strip()
            if not fname:
                continue

            # パス解決: 複数の候補を試す
            resolved = None
            candidates = [
                prefix + fname,                          # manifest 相対
                fname,                                   # そのまま
                fname.lstrip("/"),                       # 先頭スラッシュ除去
                fname.rsplit("/", 1)[-1] if "/" in fname else fname,  # ベースネームのみ
            ]
            for cand in candidates:
                if cand in all_names:
                    resolved = cand
                    break
            # ベースネームマッチもトライ
            if resolved is None:
                bn = fname.rsplit("/", 1)[-1] if "/" in fname else fname
                if bn in basename_map:
                    resolved = basename_map[bn]

            if resolved:
                setattr(c, attr, zf.read(resolved))
            else:
                logger.warning("manifest: lon=%d, %s='%s' が ZIP 内に見つかりません", lon, key, fname)

    # manifest で map が見つからなかったケースを filename パターンで補完
    lon_pat = re.compile(r"lon(\d{3})")
    for name in zf.namelist():
        if not name.lower().endswith(".svg"):
            continue
        m = lon_pat.search(name)
        if not m:
            continue
        lon = int(m.group(1)) % 360
        if lon not in cases:
            continue
        c = cases[lon]
        lower = name.lower()
        data = zf.read(name)
        if "_map" in lower and c.map_svg is None:
            c.map_svg = data
            logger.info("ファイル名パターンで補完: lon=%d map=%s", lon, name)
        elif "_combined" in lower and c.combined_svg is None:
            c.combined_svg = data
        elif "_text" in lower and c.text_svg is None:
            c.text_svg = data

    return cases


def _parse_by_filename(zf: zipfile.ZipFile) -> dict[int, CaseFiles]:
    """ファイル名の lonXXX パターンからケースを構築"""
    cases: dict[int, CaseFiles] = {}
    pat = re.compile(r"lon(\d{3})")

    for name in zf.namelist():
        if not name.lower().endswith(".svg"):
            continue
        m = pat.search(name)
        if not m:
            continue
        lon = int(m.group(1)) % 360
        if lon not in cases:
            cases[lon] = CaseFiles(lon=lon)
        c = cases[lon]

        lower = name.lower()
        data = zf.read(name)
        if "_map" in lower:
            c.map_svg = data
        elif "_combined" in lower:
            c.combined_svg = data
        elif "_text" in lower:
            c.text_svg = data

    return cases


# ---------------------------------------------------------------------------
# SVG → ラスタ
# ---------------------------------------------------------------------------

def rasterize_svg(svg_bytes: bytes, size: int) -> np.ndarray:
    """
    SVG を size x size にラスタライズし、RGBA numpy 配列を返す。
    CairoSVG を使用。フォールバックとして svglib を試みる。
    """
    try:
        import cairosvg
        png_data = cairosvg.svg2png(
            bytestring=svg_bytes,
            output_width=size,
            output_height=size,
        )
        img = Image.open(io.BytesIO(png_data)).convert("RGBA")
        # 正方形にリサイズ（念のため）
        if img.size != (size, size):
            img = img.resize((size, size), Image.LANCZOS)
        return np.array(img)
    except ImportError:
        pass

    # フォールバック: svglib + reportlab
    try:
        from svglib.svglib import svg2rlg
        from reportlab.graphics import renderPM
        import tempfile, os

        with tempfile.NamedTemporaryFile(suffix=".svg", delete=False) as f:
            f.write(svg_bytes)
            tmp_svg = f.name
        try:
            drawing = svg2rlg(tmp_svg)
            if drawing is None:
                raise ValueError("svglib が SVG を解析できませんでした")
            # スケール
            sx = size / drawing.width if drawing.width else 1
            sy = size / drawing.height if drawing.height else 1
            drawing.width = size
            drawing.height = size
            drawing.scale(sx, sy)
            png_data = renderPM.drawToString(drawing, fmt="PNG")
            img = Image.open(io.BytesIO(png_data)).convert("RGBA")
            if img.size != (size, size):
                img = img.resize((size, size), Image.LANCZOS)
            return np.array(img)
        finally:
            os.unlink(tmp_svg)
    except ImportError:
        raise RuntimeError(
            "SVG ラスタライザが見つかりません。"
            "cairosvg または svglib をインストールしてください。\n"
            "  pip install cairosvg\n"
            "  または pip install svglib reportlab"
        )


# ---------------------------------------------------------------------------
# 陸地マスク・海岸線抽出
# ---------------------------------------------------------------------------

def _quantize_rgb(rgb: np.ndarray, levels: int = 32) -> np.ndarray:
    """RGB を量子化してヒストグラム分析を容易にする"""
    return (rgb // (256 // levels)).astype(np.uint8)


def _estimate_ocean_color(rgba: np.ndarray) -> tuple[np.ndarray, dict]:
    """
    海色を複数の方法で推定し、最も信頼できるものを返す。
    
    戦略:
      1. 画像全体で最頻出色（量子化後）→ 海は通常最大面積
      2. 4辺の縁ピクセルの最頻出色 → 正方形の辺は海であることが多い
      3. 4隅の中央値 → フォールバック
    結果を総合して最終候補を決定。

    Returns:
        ocean_color: (3,) float32 — 推定海色 RGB
        diag: dict — デバッグ情報
    """
    h, w = rgba.shape[:2]
    rgb = rgba[:, :, :3]
    alpha = rgba[:, :, 3]

    diag = {}

    # --- 方法1: 全体最頻出色 ---
    # 量子化して bin 化
    q = _quantize_rgb(rgb, levels=32)
    # 不透明ピクセルのみ
    opaque = alpha >= 128
    q_flat = q[opaque].reshape(-1, 3)
    if len(q_flat) > 0:
        # 量子化値をキーに
        keys = q_flat[:, 0].astype(np.int32) * 1024 + q_flat[:, 1].astype(np.int32) * 32 + q_flat[:, 2].astype(np.int32)
        unique, counts = np.unique(keys, return_counts=True)
        top_idx = np.argmax(counts)
        top_key = unique[top_idx]
        top_r = (top_key // 1024) * 8 + 4
        top_g = ((top_key % 1024) // 32) * 8 + 4
        top_b = (top_key % 32) * 8 + 4
        hist_color = np.array([top_r, top_g, top_b], dtype=np.float32)
        hist_ratio = counts[top_idx] / len(q_flat)
        diag["hist_color"] = hist_color.tolist()
        diag["hist_ratio"] = float(hist_ratio)
    else:
        hist_color = np.array([100, 150, 200], dtype=np.float32)
        hist_ratio = 0.0

    # --- 方法2: 4辺の縁ピクセル（幅 margin）の最頻出色 ---
    margin = max(4, min(h, w) // 64)
    edge_pixels = np.concatenate([
        rgb[:margin, :].reshape(-1, 3),       # top
        rgb[h-margin:, :].reshape(-1, 3),     # bottom
        rgb[:, :margin].reshape(-1, 3),       # left
        rgb[:, w-margin:].reshape(-1, 3),     # right
    ])
    edge_alpha = np.concatenate([
        alpha[:margin, :].ravel(),
        alpha[h-margin:, :].ravel(),
        alpha[:, :margin].ravel(),
        alpha[:, w-margin:].ravel(),
    ])
    edge_opaque = edge_pixels[edge_alpha >= 128]
    if len(edge_opaque) > 0:
        eq = _quantize_rgb(edge_opaque.reshape(-1, 1, 3), levels=32).reshape(-1, 3)
        ekeys = eq[:, 0].astype(np.int32) * 1024 + eq[:, 1].astype(np.int32) * 32 + eq[:, 2].astype(np.int32)
        eu, ec = np.unique(ekeys, return_counts=True)
        ei = np.argmax(ec)
        ek = eu[ei]
        edge_color = np.array([(ek // 1024) * 8 + 4, ((ek % 1024) // 32) * 8 + 4, (ek % 32) * 8 + 4], dtype=np.float32)
        edge_ratio = ec[ei] / len(ekeys)
        diag["edge_color"] = edge_color.tolist()
        diag["edge_ratio"] = float(edge_ratio)
    else:
        edge_color = hist_color
        edge_ratio = 0.0

    # --- 方法3: 4隅の中央値（フォールバック）---
    cm = max(8, min(h, w) // 32)
    corners = np.concatenate([
        rgb[:cm, :cm].reshape(-1, 3),
        rgb[:cm, w-cm:].reshape(-1, 3),
        rgb[h-cm:, :cm].reshape(-1, 3),
        rgb[h-cm:, w-cm:].reshape(-1, 3),
    ])
    corner_color = np.median(corners.astype(np.float32), axis=0)
    diag["corner_color"] = corner_color.tolist()

    # --- 総合判定 ---
    # 辺の最頻出色が十分な割合なら信頼できる
    if edge_ratio > 0.3:
        ocean = edge_color
        diag["method"] = "edge_mode"
    elif hist_ratio > 0.15:
        ocean = hist_color
        diag["method"] = "histogram_mode"
    else:
        # 辺色とヒストグラム色の平均
        ocean = (edge_color + hist_color) / 2
        diag["method"] = "blended"

    # ヒストグラム最頻色と辺最頻色が近ければさらに確信を持てる
    color_dist = np.sqrt(np.sum((hist_color - edge_color) ** 2))
    diag["hist_edge_distance"] = float(color_dist)

    logger.info("海色推定: method=%s, color=[%.0f,%.0f,%.0f], hist_ratio=%.2f, edge_ratio=%.2f, dist=%.1f",
                diag["method"], ocean[0], ocean[1], ocean[2], hist_ratio, edge_ratio, color_dist)

    return ocean, diag


def create_land_mask(rgba: np.ndarray, params: AnalysisParams) -> tuple[np.ndarray, np.ndarray, dict]:
    """
    RGBA 画像から陸地マスクと海岸線マスクを生成する。

    三段階のアプローチ:
      1. 海色を推定（ヒストグラム＋辺縁解析）
      2. 海色に近いピクセル → 海候補
      3. 画像端に接続する海候補の最大連結成分 → 確定海
      4. 残り（不透明かつ非境界線）→ 陸地

    Returns:
        land_mask: bool 配列 (H, W) — True = 陸地
        coast_mask: bool 配列 (H, W) — True = 海岸線近傍の陸地
        diag: dict — デバッグ情報
    """
    h, w = rgba.shape[:2]
    rgb = rgba[:, :, :3].astype(np.float32)
    alpha = rgba[:, :, 3]

    diag = {}

    # --- Step 1: 海色推定 ---
    ocean_color, color_diag = _estimate_ocean_color(rgba)
    diag.update(color_diag)
    tol = float(params.bg_color_tolerance)

    # --- Step 2: 海候補ピクセル ---
    # 海色との色距離
    diff = np.sqrt(np.sum((rgb - ocean_color[None, None, :]) ** 2, axis=2))

    # 海候補: 海色に近い OR 透明
    sea_candidate = (diff < tol) | (alpha < 128)

    # 境界線(白/非常に明るい＋非常に細い): 陸でも海でもない中間として扱う
    # ただし white_like の判定は厳しめに（真っ白に近いもののみ）
    brightness = np.mean(rgb, axis=2)
    # 白: RGB全チャンネルが高い（彩度が低い白〜灰）
    r, g, b = rgb[:,:,0], rgb[:,:,1], rgb[:,:,2]
    max_rgb = np.maximum(np.maximum(r, g), b)
    min_rgb = np.minimum(np.minimum(r, g), b)
    saturation = (max_rgb - min_rgb) / (max_rgb + 1e-6)
    # 白線 = 明るい + 低彩度 (境界線など)
    white_like = (brightness > 230) & (saturation < 0.15)

    # 海候補に白線も加える（海の一部として扱う方が安全）
    sea_candidate_with_border = sea_candidate | white_like

    # --- Step 3: 辺に接続する海の最大連結成分を確定海とする ---
    # これにより、内陸の海色ピクセル（湖など）が海と誤判定されるのを防ぎ、
    # 逆に辺に接してない孤立海色は陸として扱える
    labeled_sea, n_sea = ndimage.label(sea_candidate_with_border)

    # 画像端に触れているラベルを収集
    edge_labels = set()
    if n_sea > 0:
        edge_labels.update(labeled_sea[0, :].ravel())      # top row
        edge_labels.update(labeled_sea[h-1, :].ravel())    # bottom row
        edge_labels.update(labeled_sea[:, 0].ravel())      # left col
        edge_labels.update(labeled_sea[:, w-1].ravel())    # right col
        edge_labels.discard(0)  # 0 = 背景（非海候補）

    # 端に接続する海のみを確定海とする
    confirmed_sea = np.zeros((h, w), dtype=bool)
    for lbl in edge_labels:
        confirmed_sea |= (labeled_sea == lbl)

    diag["sea_labels_total"] = int(n_sea)
    diag["sea_labels_edge"] = len(edge_labels)
    diag["confirmed_sea_ratio"] = float(confirmed_sea.sum() / (h * w))

    # --- Step 4: 陸地 = 不透明 かつ 確定海でない ---
    # 白線は海側に入れたが、実際には陸の境界線もあるので、
    # ここでは「確定海でなく、不透明で、純粋な白線でもない」を陸とする
    land_raw = (alpha >= 128) & ~confirmed_sea & ~white_like

    # 追加: 海色にやや近いが辺に接続していない孤立ピクセル → 陸側とみなす
    # （湖は陸の一部として扱う）

    # --- Step 5: ノイズ除去 ---
    min_area = params.min_land_area
    labeled_land, n_land = ndimage.label(land_raw)
    if n_land > 0:
        sizes = ndimage.sum(land_raw, labeled_land, range(1, n_land + 1))
        for i, s in enumerate(sizes):
            if s < min_area:
                land_raw[labeled_land == (i + 1)] = False

    # モルフォロジー: 細い隙間を埋める
    land_mask = ndimage.binary_closing(land_raw, iterations=2)
    land_mask = ndimage.binary_fill_holes(land_mask)

    n_land_px = int(land_mask.sum())
    land_ratio = n_land_px / (h * w)
    diag["land_pixels"] = n_land_px
    diag["land_ratio"] = float(land_ratio)

    logger.info("陸地マスク: land_px=%d (%.1f%%), sea_ratio=%.1f%%, method=%s",
                n_land_px, land_ratio * 100,
                diag["confirmed_sea_ratio"] * 100,
                diag.get("method", "?"))

    # もし陸地率が極端に低い/高い場合、tol を広げてリトライ
    if land_ratio < 0.02 and tol < 80:
        logger.warning("陸地率が %.1f%% と低い → 色距離閾値を広げてリトライ (tol=%.0f→%.0f)",
                        land_ratio * 100, tol, tol * 1.5)
        wider_params = AnalysisParams(**{
            k: getattr(params, k) for k in params.__dataclass_fields__
        })
        wider_params.bg_color_tolerance = int(tol * 1.5)
        return create_land_mask(rgba, wider_params)

    if land_ratio > 0.85:
        logger.warning("陸地率が %.1f%% と高すぎる → 色距離閾値を狭めてリトライ (tol=%.0f→%.0f)",
                        land_ratio * 100, tol, tol * 0.7)
        narrower_params = AnalysisParams(**{
            k: getattr(params, k) for k in params.__dataclass_fields__
        })
        narrower_params.bg_color_tolerance = int(tol * 0.7)
        if narrower_params.bg_color_tolerance >= 15:
            return create_land_mask(rgba, narrower_params)

    # --- Step 6: 海岸線抽出 ---
    if n_land_px > 0:
        dilated = ndimage.binary_dilation(land_mask, iterations=params.coast_distance_px)
        eroded = ndimage.binary_erosion(land_mask, iterations=max(1, params.coast_distance_px // 2))
        coast_mask = land_mask & ~eroded
    else:
        coast_mask = np.zeros_like(land_mask)

    return land_mask.astype(bool), coast_mask.astype(bool), diag


# ---------------------------------------------------------------------------
# 歪みリスクフィールド
# ---------------------------------------------------------------------------

def build_risk_field(W: int, H: int, params: AnalysisParams) -> np.ndarray:
    """
    Peirce quincuncial の高歪みリスクフィールドを構築する (H, W)。
    値域: おおよそ [0, 1]

    3 成分:
      A. 特異点近傍ペナルティ (risk_point)
      B. 辺中央帯ペナルティ  (risk_band)
      C. 一般外周ペナルティ  (risk_edge)
    """
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)

    cx, cy = W / 2.0, H / 2.0

    # 4 特異点
    singularities = [
        (cx, 0),       # top
        (W, cy),       # right  (W-1 ではなく W: 座標系上の辺上)
        (cx, H),       # bottom
        (0, cy),       # left
    ]

    # --- A. 特異点近傍ガウス ---
    sigma_p = params.sigma_point_ratio * W
    risk_point = np.zeros((H, W), dtype=np.float64)
    for sx, sy in singularities:
        d2 = (xx - sx) ** 2 + (yy - sy) ** 2
        risk_point += np.exp(-d2 / (2 * sigma_p ** 2))
    risk_point = np.clip(risk_point, 0, 1)

    # --- B. 辺中央帯 (楕円ガウス 4 本) ---
    sigma_t = params.sigma_tangent_ratio * W
    sigma_n = params.sigma_normal_ratio * W
    risk_band = np.zeros((H, W), dtype=np.float64)

    # 上辺: 中心 (cx, 0), 接線=x 方向, 法線=y 方向
    risk_band += np.exp(
        -((xx - cx) ** 2) / (2 * sigma_t ** 2)
        - ((yy - 0) ** 2) / (2 * sigma_n ** 2)
    )
    # 下辺
    risk_band += np.exp(
        -((xx - cx) ** 2) / (2 * sigma_t ** 2)
        - ((yy - H) ** 2) / (2 * sigma_n ** 2)
    )
    # 左辺
    risk_band += np.exp(
        -((xx - 0) ** 2) / (2 * sigma_n ** 2)
        - ((yy - cy) ** 2) / (2 * sigma_t ** 2)
    )
    # 右辺
    risk_band += np.exp(
        -((xx - W) ** 2) / (2 * sigma_n ** 2)
        - ((yy - cy) ** 2) / (2 * sigma_t ** 2)
    )
    risk_band = np.clip(risk_band, 0, 1)

    # --- C. 外周ペナルティ ---
    # 最も近い辺までの距離
    d_edge = np.minimum(
        np.minimum(xx, W - xx),
        np.minimum(yy, H - yy),
    )
    edge_lim = params.edge_soft_limit_ratio * W
    risk_edge = np.clip(1.0 - d_edge / edge_lim, 0, 1) ** 2

    # --- 合成 ---
    risk_total = (
        params.weight_band * risk_band
        + params.weight_point * risk_point
        + params.weight_edge * risk_edge
    )
    return risk_total


# ---------------------------------------------------------------------------
# ケース評価
# ---------------------------------------------------------------------------

def score_case(
    case: CaseFiles,
    params: AnalysisParams,
    high_risk_threshold: Optional[float] = None,
) -> CaseResult:
    """
    1 ケースの map.svg を解析してスコアを返す。
    """
    if case.map_svg is None:
        logger.warning("lon=%d: map.svg がありません", case.lon)
        return CaseResult(lon=case.lon, final_score=999.0)

    size = params.raster_size
    rgba = rasterize_svg(case.map_svg, size)
    H, W = rgba.shape[:2]

    # 陸地マスク・海岸線
    land_mask, coast_mask, mask_diag = create_land_mask(rgba, params)
    logger.info("lon=%d: mask_diag=%s", case.lon,
                {k: v for k, v in mask_diag.items() if k not in ("hist_color", "edge_color", "corner_color")})

    # リスクフィールド
    risk_field = build_risk_field(W, H, params)

    # 海岸線重み付け
    weight_map = np.ones((H, W), dtype=np.float64)
    weight_map[coast_mask] = params.coast_weight

    # 陸地上のリスク値
    risk_on_land = risk_field[land_mask] * weight_map[land_mask]
    n_land = int(land_mask.sum())

    if n_land == 0:
        logger.warning("lon=%d: 陸地ピクセルが検出されません", case.lon)
        return CaseResult(lon=case.lon, final_score=0.0, land_pixel_count=0)

    mean_risk = float(np.mean(risk_on_land))
    p95_risk = float(np.percentile(risk_on_land, 95))

    # 高リスクゾーン閾値
    if high_risk_threshold and high_risk_threshold > 0:
        thr = high_risk_threshold
    else:
        # 自動: 全ピクセルのリスクの 75 パーセンタイル
        thr = float(np.percentile(risk_field[risk_field > 0], 75)) if np.any(risk_field > 0) else 0.3

    high_risk_land = np.sum((risk_field[land_mask] * weight_map[land_mask]) > thr)
    high_risk_frac = float(high_risk_land / n_land)

    # 最終スコア
    final = (
        params.weight_mean * mean_risk
        + params.weight_p95 * p95_risk
        + params.weight_fraction * high_risk_frac
    )

    # --- 可視化画像の生成 ---
    thumb_png = _make_thumbnail(rgba)
    raster_png = _make_thumbnail(rgba, size=512)  # より大きいデバッグ用
    land_mask_png = _mask_to_png(land_mask)
    coastline_png = _mask_to_png(coast_mask, color=(0, 200, 255))
    heatmap_png = _risk_to_heatmap(risk_field)
    overlay_png = _make_overlay(rgba, land_mask, risk_field, weight_map, thr)

    return CaseResult(
        lon=case.lon,
        mean_risk=round(mean_risk, 6),
        p95_risk=round(p95_risk, 6),
        high_risk_fraction=round(high_risk_frac, 6),
        final_score=round(final, 6),
        land_pixel_count=n_land,
        land_ratio=round(n_land / (H * W), 4),
        thumb_png=thumb_png,
        land_mask_png=land_mask_png,
        coastline_png=coastline_png,
        heatmap_png=heatmap_png,
        overlay_png=overlay_png,
        raster_png=raster_png,
        mask_diag=mask_diag,
    )


# ---------------------------------------------------------------------------
# 可視化ヘルパー
# ---------------------------------------------------------------------------

THUMB_SIZE = 200


def _make_thumbnail(rgba: np.ndarray, size: int = THUMB_SIZE) -> bytes:
    img = Image.fromarray(rgba).convert("RGB")
    img.thumbnail((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _mask_to_png(mask: np.ndarray, color: tuple = (255, 255, 255), size: int = 512) -> bytes:
    h, w = mask.shape
    img = np.zeros((h, w, 3), dtype=np.uint8)
    img[mask] = color
    pil = Image.fromarray(img)
    pil = pil.resize((size, size), Image.NEAREST)
    buf = io.BytesIO()
    pil.save(buf, format="PNG")
    return buf.getvalue()


def _risk_to_heatmap(risk: np.ndarray, size: int = 512) -> bytes:
    """リスクフィールドを赤-黄ヒートマップに変換"""
    norm = np.clip(risk / (risk.max() + 1e-9), 0, 1)
    h, w = norm.shape
    img = np.zeros((h, w, 3), dtype=np.uint8)
    # 青(0) → 黄(0.5) → 赤(1)
    img[:, :, 0] = (np.clip(norm * 2, 0, 1) * 255).astype(np.uint8)
    img[:, :, 1] = (np.clip(2 - norm * 2, 0, 1) * norm * 255).astype(np.uint8)
    img[:, :, 2] = ((1 - norm) * 80).astype(np.uint8)

    pil = Image.fromarray(img)
    pil = pil.resize((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    pil.save(buf, format="PNG")
    return buf.getvalue()


def _make_overlay(
    rgba: np.ndarray,
    land_mask: np.ndarray,
    risk_field: np.ndarray,
    weight_map: np.ndarray,
    threshold: float,
    size: int = 512,
) -> bytes:
    """元画像に高リスクゾーンを赤で重畳"""
    base = Image.fromarray(rgba).convert("RGBA")
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ov_arr = np.array(overlay)

    weighted_risk = risk_field * weight_map
    high_mask = land_mask & (weighted_risk > threshold)

    ov_arr[high_mask] = [255, 50, 50, 140]
    overlay = Image.fromarray(ov_arr)
    result = Image.alpha_composite(base, overlay).convert("RGB")
    result = result.resize((size, size), Image.LANCZOS)

    buf = io.BytesIO()
    result.save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# 全ケース解析 (ジェネレータ)
# ---------------------------------------------------------------------------

def analyze_all(
    cases: dict[int, CaseFiles],
    params: AnalysisParams,
) -> list[CaseResult]:
    """
    全ケースを解析し、final_score 昇順（低い＝良い）でソートして返す。
    """
    results: list[CaseResult] = []
    sorted_lons = sorted(cases.keys())
    total = len(sorted_lons)

    # 高リスク閾値: 全ケース共通にするため最初の1ケースから推定してもよいが、
    # ここではケースごとに自動決定する（params.high_risk_threshold == 0 のとき）
    for i, lon in enumerate(sorted_lons):
        logger.info("解析中: lon=%d (%d/%d)", lon, i + 1, total)
        try:
            result = score_case(cases[lon], params)
            results.append(result)
        except Exception as e:
            logger.error("lon=%d の解析に失敗: %s", lon, e)
            results.append(CaseResult(lon=lon, final_score=999.0))

    # ソート
    results.sort(key=lambda r: r.final_score)
    return results
