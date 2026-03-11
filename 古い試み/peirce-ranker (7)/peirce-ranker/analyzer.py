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
import unicodedata
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
    error: str = ""  # エラーがあればここに入る


# ---------------------------------------------------------------------------
# ZIP 読み込み — 日本語ファイル名のエンコーディング問題への対策付き
# ---------------------------------------------------------------------------
#
# Windows 環境で作成された ZIP は日本語ファイル名を CP932 で格納しながら
# UTF-8 フラグを立てないことがある。Python の zipfile モジュールは
# フラグなしエントリを CP437 としてデコードするため文字化けが起こる。
#
# 対策:
#   1. ZipInfo の raw バイト列から CP932 / UTF-8 両方でデコードを試み、
#      正規化された名前 → 元エントリ名 のルックアップを構築する
#   2. manifest のファイル名と照合する際はこのルックアップを使う
#   3. 最終フォールバックとして lonXXX の ASCII パターンで直接マッチ
# ---------------------------------------------------------------------------

def _fix_zip_entry_name(info: zipfile.ZipInfo) -> str:
    """
    ZipInfo のファイル名を、日本語が正しく読める形にデコードし直す。

    Python の zipfile は UTF-8 フラグ (bit 11) が立っていないエントリを
    CP437 でデコードする。Windows で作られた ZIP は日本語を CP932 で
    格納していることが多いため、ここで再デコードする。
    """
    # UTF-8 フラグが立っている場合は既に正しくデコードされている
    if info.flag_bits & (1 << 11):
        return info.filename

    # flag が立っていない場合、内部の raw バイト列を取得して再デコード
    # Python の zipfile は既に CP437 デコード済みの str を返すので、
    # 元のバイト列を復元するために CP437 でエンコードし直す
    try:
        raw_bytes = info.filename.encode("cp437")
    except (UnicodeEncodeError, UnicodeDecodeError):
        # CP437 に戻せない文字がある → 既に正しい可能性が高い
        return info.filename

    # CP932 でデコードを試みる（日本語 Windows ZIP の最頻ケース）
    for encoding in ("cp932", "shift_jis", "utf-8", "euc_jp"):
        try:
            decoded = raw_bytes.decode(encoding)
            # デコード結果に ASCII 以外の文字が含まれているか確認
            if any(ord(c) > 127 for c in decoded):
                return decoded
        except (UnicodeDecodeError, UnicodeEncodeError):
            continue

    # どのエンコーディングでもダメなら元のままを返す
    return info.filename


def _build_zip_lookup(zf: zipfile.ZipFile) -> dict[str, str]:
    """
    ZIP 内の全エントリについて、正規化済みファイル名 → 元エントリ名 の
    ルックアップ辞書を構築する。

    ルックアップキーの候補:
      - 修正デコード後のフルパス
      - 修正デコード後のベースネーム（ディレクトリ部分を除去）
      - NFC 正規化版
      - 元の namelist() そのまま

    Returns:
        dict: 正規化名 → zf.namelist() のエントリ名
    """
    lookup: dict[str, str] = {}

    for info in zf.infolist():
        original = info.filename   # namelist() が返す文字列
        fixed = _fix_zip_entry_name(info)

        # 登録候補
        variants = set()
        for name in (original, fixed):
            variants.add(name)
            # NFC / NFD 正規化
            variants.add(unicodedata.normalize("NFC", name))
            variants.add(unicodedata.normalize("NFD", name))
            # ベースネーム
            bn = name.rsplit("/", 1)[-1] if "/" in name else name
            variants.add(bn)
            variants.add(unicodedata.normalize("NFC", bn))

        for v in variants:
            if v and v not in lookup:
                lookup[v] = original

    return lookup


def _resolve_in_zip(
    fname: str,
    prefix: str,
    lookup: dict[str, str],
) -> Optional[str]:
    """
    manifest 内のファイル名を ZIP 内のエントリ名に解決する。

    Returns:
        解決できた場合は zf.namelist() のエントリ名、できなければ None
    """
    fname_nfc = unicodedata.normalize("NFC", fname)
    bn = fname.rsplit("/", 1)[-1] if "/" in fname else fname
    bn_nfc = unicodedata.normalize("NFC", bn)

    candidates = [
        prefix + fname,
        prefix + fname_nfc,
        fname,
        fname_nfc,
        fname.lstrip("/"),
        bn,
        bn_nfc,
    ]

    for cand in candidates:
        if cand in lookup:
            return lookup[cand]

    return None


def parse_zip(zip_bytes: bytes) -> dict[int, CaseFiles]:
    """
    ZIP を読み込み、lon をキーとした CaseFiles 辞書を返す。

    manifest.csv があればそれを優先し、なければファイル名から lon を抽出する。
    日本語ファイル名のエンコーディング問題に対して複数の方法でフォールバックする。
    """
    cases: dict[int, CaseFiles] = {}

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        # エンコーディング修正済みルックアップを構築
        lookup = _build_zip_lookup(zf)
        logger.info("ZIP ルックアップ構築完了: %d エントリ → %d キー",
                     len(zf.infolist()), len(lookup))

        # manifest.csv を探す (ASCII 部分でマッチ)
        manifest_entry = None
        for info in zf.infolist():
            fixed = _fix_zip_entry_name(info)
            if fixed.endswith("manifest.csv") or info.filename.endswith("manifest.csv"):
                manifest_entry = info.filename
                break

        if manifest_entry:
            logger.info("manifest.csv を検出: %s", manifest_entry)
            cases = _parse_with_manifest(zf, manifest_entry, lookup)
        else:
            logger.info("manifest.csv なし — ファイル名パターンから復元")

        # manifest 経由で解決できなかったファイルを lonXXX パターンで補完
        # (ASCII 部分は文字化けしないので確実にマッチする)
        cases = _supplement_by_lonpattern(zf, cases, lookup)

    logger.info("読み込み完了: %d ケース", len(cases))

    # map_svg の有無をサマリ
    n_with_map = sum(1 for c in cases.values() if c.map_svg is not None)
    n_total = len(cases)
    logger.info("map.svg あり: %d / %d ケース", n_with_map, n_total)
    if n_with_map == 0 and n_total > 0:
        logger.error("全ケースで map.svg が見つかりません！"
                      "ZIP 内のファイル名エンコーディングを確認してください。")

    return cases


def apply_rotation_equivalence(cases: dict[int, CaseFiles]) -> tuple[dict[int, CaseFiles], dict[int, list[int]]]:
    """
    Peirce quincuncial の 90° 回転対称性を適用する。

    lon=X と lon=X+90 と lon=X+180 と lon=X+270 は同じ地図を回転したもの。
    72 ケース → 18 ケースに削減される。

    Returns:
        reduced_cases: 代表ケースのみ (lon は 0〜89)
        equiv_groups: {代表lon: [同一視された全lon]} の辞書
    """
    groups: dict[int, list[int]] = {}
    for lon in sorted(cases.keys()):
        canonical = lon % 90
        if canonical not in groups:
            groups[canonical] = []
        groups[canonical].append(lon)

    reduced: dict[int, CaseFiles] = {}
    equiv: dict[int, list[int]] = {}

    for canonical, lons in sorted(groups.items()):
        # map_svg がある最初の lon を代表として採用
        representative = None
        for lon in lons:
            if cases[lon].map_svg is not None:
                representative = cases[lon]
                break
        if representative is None:
            representative = cases[lons[0]]

        rep = CaseFiles(
            lon=canonical,
            map_svg=representative.map_svg,
            combined_svg=representative.combined_svg,
            text_svg=representative.text_svg,
        )
        reduced[canonical] = rep
        equiv[canonical] = lons

    logger.info("回転同一視: %d → %d ケース (90°回転対称)", len(cases), len(reduced))
    return reduced, equiv


def _parse_with_manifest(
    zf: zipfile.ZipFile,
    manifest_entry: str,
    lookup: dict[str, str],
) -> dict[int, CaseFiles]:
    """manifest.csv からケースを構築"""
    cases: dict[int, CaseFiles] = {}

    # manifest の親ディレクトリをプレフィックスとして使う
    prefix = manifest_entry.rsplit("/", 1)[0] + "/" if "/" in manifest_entry else ""

    raw = zf.read(manifest_entry).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(raw))

    resolved_count = 0
    failed_count = 0

    for row in reader:
        lon = int(float(row.get("lon0", 0))) % 360
        if lon not in cases:
            cases[lon] = CaseFiles(lon=lon)
        c = cases[lon]

        for key, attr in [("map", "map_svg"), ("combined", "combined_svg"), ("text", "text_svg")]:
            fname = row.get(key, "").strip()
            if not fname:
                continue

            entry_name = _resolve_in_zip(fname, prefix, lookup)
            if entry_name:
                setattr(c, attr, zf.read(entry_name))
                resolved_count += 1
            else:
                failed_count += 1
                if key == "map":  # map の失敗のみログ
                    logger.warning("manifest: lon=%d, %s='%s' → ZIP 内に見つからず", lon, key, fname)

    logger.info("manifest 解決: 成功=%d, 失敗=%d", resolved_count, failed_count)
    return cases


def _supplement_by_lonpattern(
    zf: zipfile.ZipFile,
    cases: dict[int, CaseFiles],
    lookup: dict[str, str],
) -> dict[int, CaseFiles]:
    """
    ZIP 内の全エントリを lonXXX パターンでスキャンし、
    manifest で見つからなかったファイルを補完する。

    lonXXX は ASCII なので文字化けの影響を受けない。
    _map / _combined / _text も ASCII なのでマッチ可能。
    """
    lon_pat = re.compile(r"lon(\d{3})")

    for info in zf.infolist():
        name = info.filename  # namelist() のエントリ名 (読み取り用)
        # 修正デコードも参照
        fixed = _fix_zip_entry_name(info)

        # .svg で終わるか確認 (ASCII 部分)
        if not (name.lower().endswith(".svg") or fixed.lower().endswith(".svg")):
            continue

        # lonXXX を探す (ASCII 部分なので確実)
        m = lon_pat.search(name) or lon_pat.search(fixed)
        if not m:
            continue

        lon = int(m.group(1)) % 360

        if lon not in cases:
            cases[lon] = CaseFiles(lon=lon)
        c = cases[lon]

        # _map / _combined / _text で分類 (ASCII 部分)
        check_str = name.lower() + fixed.lower()  # 両方チェック
        data = None  # 遅延読み込み

        if "_map" in check_str and c.map_svg is None:
            data = zf.read(name)
            c.map_svg = data
            logger.info("lonパターン補完: lon=%d map (entry=%s)", lon, repr(name[:60]))
        elif "_combined" in check_str and c.combined_svg is None:
            data = zf.read(name)
            c.combined_svg = data
        elif "_text" in check_str and c.text_svg is None:
            data = zf.read(name)
            c.text_svg = data

    return cases


# ---------------------------------------------------------------------------
# SVG → ラスタ (Playwright 優先、CairoSVG / Inkscape フォールバック)
# ---------------------------------------------------------------------------
#
# CairoSVG は複雑な SVG（多数のパス、CSS クラス、大きな viewBox）で
# 描画不備（下部クロップ、島の欠落等）を起こすことがある。
# Playwright (Chromium) は本物のブラウザエンジンなので完全に描画できる。
#

import base64 as _b64
import threading as _threading


class _BrowserPool:
    """
    Playwright ブラウザインスタンスのシングルトン管理。
    全ケース解析中にブラウザを使い回して起動コストを削減する。
    """
    _instance = None
    _lock = _threading.Lock()

    def __init__(self):
        self._pw = None
        self._browser = None

    @classmethod
    def get(cls) -> "_BrowserPool":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def ensure_browser(self):
        if self._browser is None:
            from playwright.sync_api import sync_playwright
            self._pw = sync_playwright().start()
            self._browser = self._pw.chromium.launch(headless=True)
            logger.info("Playwright Chromium ブラウザを起動")

    def render_svg(self, svg_bytes: bytes, size: int) -> bytes:
        """SVG → PNG バイト列"""
        self.ensure_browser()
        svg_b64 = _b64.b64encode(svg_bytes).decode()
        html = (
            '<!DOCTYPE html><html><head><meta charset="utf-8">'
            '<style>*{margin:0;padding:0}'
            f'html,body{{width:{size}px;height:{size}px;overflow:hidden}}'
            f'img{{width:{size}px;height:{size}px;display:block}}'
            '</style></head><body>'
            f'<img src="data:image/svg+xml;base64,{svg_b64}">'
            '</body></html>'
        )
        page = self._browser.new_page(viewport={"width": size, "height": size})
        try:
            page.set_content(html, wait_until="networkidle")
            return page.screenshot(type="png")
        finally:
            page.close()

    def close(self):
        try:
            if self._browser:
                self._browser.close()
            if self._pw:
                self._pw.stop()
        except Exception:
            pass
        self._browser = None
        self._pw = None


def _preprocess_svg_for_cairosvg(svg_bytes: bytes) -> bytes:
    """CairoSVG フォールバック用: width/height 削除、viewBox のみ残す"""
    s = svg_bytes.decode("utf-8", errors="replace")

    def strip(m):
        tag = m.group(0)
        tag = re.sub(r'\s+width\s*=\s*"[^"]*"', '', tag)
        tag = re.sub(r"\s+width\s*=\s*'[^']*'", '', tag)
        tag = re.sub(r'\s+height\s*=\s*"[^"]*"', '', tag)
        tag = re.sub(r"\s+height\s*=\s*'[^']*'", '', tag)
        return tag

    s = re.sub(r'<svg\b[^>]*>', strip, s, count=1)
    return s.encode("utf-8")


def _postprocess_raster(img: Image.Image, target_size: int) -> np.ndarray:
    """非正方形出力 → 正方形クロップ → target_size リサイズ"""
    w, h = img.size
    if w == target_size and h == target_size:
        return np.array(img)
    if w != h:
        side = min(w, h)
        img = img.crop((0, 0, side, side))
        logger.info("非正方形出力を正方形にクロップ: (%d,%d) → (%d,%d)", w, h, side, side)
    if img.size != (target_size, target_size):
        img = img.resize((target_size, target_size), Image.LANCZOS)
    return np.array(img)


def rasterize_svg(svg_bytes: bytes, size: int) -> np.ndarray:
    """
    SVG を size x size にラスタライズし RGBA numpy 配列を返す。

    優先順:
      1. Playwright (Chromium) — 最も正確。複雑な SVG も完全描画。
      2. CairoSVG — 軽量だが複雑 SVG で描画不備の可能性あり。
      3. Inkscape CLI — インストール済みなら。
    """
    errors: list[str] = []

    # === 方法 1: Playwright ===
    try:
        pool = _BrowserPool.get()
        png_data = pool.render_svg(svg_bytes, size)
        img = Image.open(io.BytesIO(png_data)).convert("RGBA")
        logger.info("ラスタライズ成功: Playwright (%dx%d)", img.size[0], img.size[1])
        return _postprocess_raster(img, size)
    except ImportError:
        errors.append("Playwright: 未インストール (pip install playwright && playwright install chromium)")
    except Exception as e:
        errors.append(f"Playwright: {type(e).__name__}: {e}")
        logger.warning("Playwright 失敗: %s", e)

    # === 方法 2: CairoSVG ===
    svg_fixed = _preprocess_svg_for_cairosvg(svg_bytes)
    try:
        import cairosvg
        png_data = cairosvg.svg2png(
            bytestring=svg_fixed,
            output_width=size,
            output_height=size,
        )
        img = Image.open(io.BytesIO(png_data)).convert("RGBA")
        logger.info("ラスタライズ成功: CairoSVG (%dx%d)", img.size[0], img.size[1])
        return _postprocess_raster(img, size)
    except ImportError:
        errors.append("CairoSVG: 未インストール")
    except Exception as e:
        errors.append(f"CairoSVG: {type(e).__name__}: {e}")
        logger.warning("CairoSVG 失敗: %s", e)

    # === 方法 3: Inkscape CLI ===
    import shutil, subprocess, tempfile, os
    inkscape = shutil.which("inkscape")
    if inkscape:
        tmp_svg = tmp_png = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".svg", delete=False, mode="wb") as f:
                f.write(svg_fixed)
                tmp_svg = f.name
            tmp_png = tmp_svg.replace(".svg", ".png")
            subprocess.run(
                [inkscape, tmp_svg, "--export-type=png",
                 f"--export-filename={tmp_png}",
                 f"--export-width={size}", f"--export-height={size}"],
                capture_output=True, timeout=120,
            )
            if os.path.exists(tmp_png):
                img = Image.open(tmp_png).convert("RGBA")
                logger.info("ラスタライズ成功: Inkscape (%dx%d)", img.size[0], img.size[1])
                return _postprocess_raster(img, size)
            errors.append("Inkscape: 出力ファイルなし")
        except Exception as e:
            errors.append(f"Inkscape: {type(e).__name__}: {e}")
        finally:
            for p in (tmp_svg, tmp_png):
                if p:
                    try: os.unlink(p)
                    except OSError: pass
    else:
        errors.append("Inkscape: PATH 上に見つからず")

    raise RuntimeError(
        "SVG ラスタライズにすべて失敗しました。\n"
        "以下のいずれかをインストールしてください:\n\n"
        "【推奨】pip install playwright && playwright install chromium\n"
        "【代替1】pip install cairosvg\n"
        "【代替2】Inkscape をインストール\n\n"
        "試行結果:\n" + "\n".join(f"  - {e}" for e in errors)
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
    brightness = np.mean(rgb, axis=2)
    r, g, b = rgb[:,:,0], rgb[:,:,1], rgb[:,:,2]
    max_rgb = np.maximum(np.maximum(r, g), b)
    min_rgb = np.minimum(np.minimum(r, g), b)
    saturation = (max_rgb - min_rgb) / (max_rgb + 1e-6)
    # 白線 = 明るい + 低彩度 (境界線など)
    white_like = (brightness > 230) & (saturation < 0.15)

    # --- 格子線 (graticule / グリッド) のフィルタリング ---
    # SVG の格子線は海上に描かれた細い線で、ラスタライズ時に
    # アンチエイリアスで海色と格子色のブレンドになる。
    # これらは「海でも陸でもない」ので、陸地マスクから除外する。
    #
    # 格子線の特徴:
    #   - 海色とも陸色とも異なる
    #   - 中間輝度 & 低彩度 (海と格子色のブレンド)
    #   - または高彩度だが非典型的な色（マゼンタ、黄、紫）
    not_ocean = diff >= tol
    # 格子線候補1: 中間輝度 + 低彩度（海と格子色のブレンド）
    grid_blend = not_ocean & (brightness > 110) & (brightness < 185) & (saturation < 0.35)
    # 格子線候補2: マゼンタ/ピンク系 (R高, G低, B中〜高)
    grid_magenta = not_ocean & (r > 140) & (g < 110) & (b > 100)
    # 格子線候補3: 黄色系 (R高, G高, B低)
    grid_yellow = not_ocean & (r > 190) & (g > 190) & (b < 100)
    # 格子線候補4: 紫系
    grid_purple = not_ocean & (r > 100) & (g < 80) & (b > 180)

    grid_like = grid_blend | grid_magenta | grid_yellow | grid_purple | white_like

    # 海候補に格子線も加える（格子線は陸地ではない）
    sea_candidate_with_border = sea_candidate | grid_like

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

    # --- Step 4: 陸地 = 不透明 かつ 確定海でない かつ 格子線でない ---
    land_raw = (alpha >= 128) & ~confirmed_sea & ~grid_like

    # --- Step 5: ノイズ除去 ---
    min_area = params.min_land_area
    labeled_land, n_land = ndimage.label(land_raw)
    if n_land > 0:
        sizes = ndimage.sum(land_raw, labeled_land, range(1, n_land + 1))
        for i, s in enumerate(sizes):
            if s < min_area:
                land_raw[labeled_land == (i + 1)] = False

    # モルフォロジー: 軽い closing のみ（fill_holes は格子線で囲まれた海を
    # 誤って陸地にするため使用しない）
    land_mask = ndimage.binary_closing(land_raw, iterations=1)

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
    エラー時は error フィールドに詳細を入れて返す。
    """
    if case.map_svg is None:
        logger.warning("lon=%d: map.svg がありません", case.lon)
        return CaseResult(lon=case.lon, final_score=999.0,
                          error="map.svg がZIP内に見つかりません")

    size = params.raster_size

    try:
        rgba = rasterize_svg(case.map_svg, size)
    except Exception as e:
        err_msg = f"SVG ラスタライズ失敗: {type(e).__name__}: {e}"
        logger.error("lon=%d: %s", case.lon, err_msg)
        return CaseResult(lon=case.lon, final_score=999.0, error=err_msg)

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
