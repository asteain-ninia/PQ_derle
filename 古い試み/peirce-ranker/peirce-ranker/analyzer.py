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
    raster_size: int = 1024

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

    raw = zf.read(manifest_path).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(raw))

    for row in reader:
        lon = int(float(row.get("lon0", 0))) % 360
        if lon not in cases:
            cases[lon] = CaseFiles(lon=lon)
        c = cases[lon]

        for key, attr in [("map", "map_svg"), ("combined", "combined_svg"), ("text", "text_svg")]:
            fname = row.get(key, "").strip()
            if fname:
                full = prefix + fname if not fname.startswith(prefix) else fname
                # ZIP 内のパスを探す
                for candidate in [full, fname, fname.lstrip("/")]:
                    if candidate in zf.namelist():
                        setattr(c, attr, zf.read(candidate))
                        break

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

def _dominant_corner_color(rgba: np.ndarray, margin: int = 8) -> np.ndarray:
    """4 隅の代表色（背景海色の推定）"""
    h, w = rgba.shape[:2]
    corners = np.concatenate([
        rgba[:margin, :margin].reshape(-1, 4),
        rgba[:margin, w - margin:].reshape(-1, 4),
        rgba[h - margin:, :margin].reshape(-1, 4),
        rgba[h - margin:, w - margin:].reshape(-1, 4),
    ])
    # 中央値を背景色とする
    return np.median(corners, axis=0).astype(np.uint8)


def create_land_mask(rgba: np.ndarray, params: AnalysisParams) -> tuple[np.ndarray, np.ndarray]:
    """
    RGBA 画像から陸地マスクと海岸線マスクを生成する。

    Returns:
        land_mask: bool 配列 (H, W) — True = 陸地
        coast_mask: bool 配列 (H, W) — True = 海岸線近傍の陸地
    """
    h, w = rgba.shape[:2]
    rgb = rgba[:, :, :3].astype(np.float32)
    alpha = rgba[:, :, 3]

    # 背景海色を推定
    bg = _dominant_corner_color(rgba).astype(np.float32)[:3]
    tol = float(params.bg_color_tolerance)

    # 色距離
    diff = np.sqrt(np.sum((rgb - bg[None, None, :]) ** 2, axis=2))

    # 海: 背景色に近い or 完全透明
    sea_mask = (diff < tol) | (alpha < 128)

    # 白線・境界線を除外 (明るすぎるピクセル)
    brightness = np.mean(rgb, axis=2)
    white_like = brightness > 240

    # 陸地候補: 海でも白線でもない
    land_raw = ~sea_mask & ~white_like & (alpha >= 128)

    # 小領域ノイズ除去
    labeled, n_features = ndimage.label(land_raw)
    if n_features > 0:
        sizes = ndimage.sum(land_raw, labeled, range(1, n_features + 1))
        for i, s in enumerate(sizes):
            if s < params.min_land_area:
                land_raw[labeled == (i + 1)] = False

    # モルフォロジーで微細穴を埋める
    land_mask = ndimage.binary_fill_holes(land_raw)
    land_mask = ndimage.binary_closing(land_mask, iterations=1)

    # 海岸線: 陸マスクの輪郭（膨張 - 元）の陸側
    dilated = ndimage.binary_dilation(land_mask, iterations=params.coast_distance_px)
    eroded = ndimage.binary_erosion(land_mask, iterations=1)
    coast_mask = land_mask & dilated & ~eroded

    return land_mask.astype(bool), coast_mask.astype(bool)


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
    land_mask, coast_mask = create_land_mask(rgba, params)

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
    )


# ---------------------------------------------------------------------------
# 可視化ヘルパー
# ---------------------------------------------------------------------------

THUMB_SIZE = 200


def _make_thumbnail(rgba: np.ndarray) -> bytes:
    img = Image.fromarray(rgba).convert("RGB")
    img.thumbnail((THUMB_SIZE, THUMB_SIZE), Image.LANCZOS)
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
