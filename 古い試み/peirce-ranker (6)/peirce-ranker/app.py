"""
app.py — Peirce Quincuncial 歪みリスクランキング ローカル Web アプリ

使い方:
    python app.py
    → ブラウザで http://localhost:5050 を開く
    → ZIP をドロップして解析開始
"""

import io
import json
import csv
import base64
import logging
import threading
from pathlib import Path

from flask import Flask, render_template, request, jsonify, send_file

from analyzer import (
    AnalysisParams, CaseFiles, CaseResult,
    parse_zip, score_case, build_risk_field, analyze_all,
)

# ---------------------------------------------------------------------------
# Flask アプリ
# ---------------------------------------------------------------------------
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024  # 500 MB

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# グローバル状態（シングルユーザー前提）
state = {
    "status": "idle",       # idle | loading | analyzing | done | error
    "progress": 0,          # 0-100
    "progress_msg": "",
    "cases": {},            # int -> CaseFiles
    "results": [],          # list[CaseResult]
    "params": AnalysisParams(),
    "zip_bytes": None,
    "error": "",
}
state_lock = threading.Lock()


# ---------------------------------------------------------------------------
# ページ
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# API: ZIP アップロード + 解析
# ---------------------------------------------------------------------------

@app.route("/api/upload", methods=["POST"])
def api_upload():
    """ZIP をアップロードし、非同期で解析を開始"""
    f = request.files.get("zip")
    if not f:
        return jsonify({"error": "ZIP ファイルが選択されていません"}), 400

    zip_bytes = f.read()
    if len(zip_bytes) < 100:
        return jsonify({"error": "ファイルが小さすぎます"}), 400

    # パラメータ取得（フォームから）
    params = _params_from_form(request.form)

    with state_lock:
        state["zip_bytes"] = zip_bytes
        state["params"] = params
        state["status"] = "loading"
        state["progress"] = 0
        state["progress_msg"] = "ZIP を読み込み中…"
        state["error"] = ""
        state["results"] = []

    # バックグラウンド解析
    t = threading.Thread(target=_run_analysis, daemon=True)
    t.start()

    return jsonify({"ok": True, "msg": "解析を開始しました"})


@app.route("/api/reanalyze", methods=["POST"])
def api_reanalyze():
    """パラメータを変更して再解析"""
    with state_lock:
        if state["zip_bytes"] is None:
            return jsonify({"error": "先に ZIP をアップロードしてください"}), 400
        params = _params_from_form(request.json or {})
        state["params"] = params
        state["status"] = "analyzing"
        state["progress"] = 0
        state["progress_msg"] = "パラメータ変更・再解析中…"
        state["error"] = ""
        state["results"] = []

    t = threading.Thread(target=_run_analysis, daemon=True)
    t.start()
    return jsonify({"ok": True})


def _params_from_form(form) -> AnalysisParams:
    """フォームデータからパラメータを構築"""
    p = AnalysisParams()
    _float_field(form, "raster_size", p, cast=int)
    _float_field(form, "sigma_point_ratio", p)
    _float_field(form, "sigma_tangent_ratio", p)
    _float_field(form, "sigma_normal_ratio", p)
    _float_field(form, "edge_soft_limit_ratio", p)
    _float_field(form, "weight_band", p)
    _float_field(form, "weight_point", p)
    _float_field(form, "weight_edge", p)
    _float_field(form, "coast_weight", p)
    _float_field(form, "coast_distance_px", p, cast=int)
    _float_field(form, "weight_mean", p)
    _float_field(form, "weight_p95", p)
    _float_field(form, "weight_fraction", p)
    _float_field(form, "high_risk_threshold", p)
    _float_field(form, "bg_color_tolerance", p, cast=int)
    _float_field(form, "min_land_area", p, cast=int)
    return p


def _float_field(form, name, obj, cast=float):
    val = form.get(name)
    if val is not None and val != "":
        try:
            setattr(obj, name, cast(val))
        except (ValueError, TypeError):
            pass


def _run_analysis():
    """バックグラウンド解析"""
    try:
        with state_lock:
            zip_bytes = state["zip_bytes"]
            params = state["params"]

        # ZIP パース
        _update_progress("loading", 5, "ZIP を展開中…")
        cases = parse_zip(zip_bytes)
        if not cases:
            _update_progress("error", 0, "", error="ZIP 内に有効な SVG ケースが見つかりません")
            return

        with state_lock:
            state["cases"] = cases

        _update_progress("analyzing", 10, f"{len(cases)} ケースの解析を開始…")

        # 全ケース解析
        results = []
        sorted_lons = sorted(cases.keys())
        total = len(sorted_lons)
        first_error = ""
        for i, lon in enumerate(sorted_lons):
            pct = 10 + int(85 * (i / total))
            _update_progress("analyzing", pct, f"lon={lon} ({i+1}/{total})")
            try:
                r = score_case(cases[lon], params)
                results.append(r)
                # 最初のエラーを記録
                if r.error and not first_error:
                    first_error = r.error
            except Exception as e:
                err = f"{type(e).__name__}: {e}"
                logger.error("lon=%d 失敗: %s", lon, err, exc_info=True)
                results.append(CaseResult(lon=lon, final_score=999.0, error=err))
                if not first_error:
                    first_error = err

        results.sort(key=lambda r: r.final_score)

        with state_lock:
            state["results"] = results

        # 全ケースで解析失敗しているか確認
        n_ok = sum(1 for r in results if r.final_score < 999.0)
        n_err = sum(1 for r in results if r.error)
        if n_ok == 0 and first_error:
            _update_progress("error", 100, "",
                             error=f"全 {total} ケースの解析に失敗しました。\n"
                                   f"最初のエラー: {first_error}")
        elif n_err > 0:
            _update_progress("done", 100,
                             f"解析完了 (成功={n_ok}, 失敗={n_err}/{total})")
        else:
            _update_progress("done", 100, "解析完了")

    except Exception as e:
        logger.error("解析エラー: %s", e, exc_info=True)
        _update_progress("error", 0, "", error=str(e))


def _update_progress(status, pct, msg, error=""):
    with state_lock:
        state["status"] = status
        state["progress"] = pct
        state["progress_msg"] = msg
        if error:
            state["error"] = error


# ---------------------------------------------------------------------------
# API: 状態・結果取得
# ---------------------------------------------------------------------------

@app.route("/api/status")
def api_status():
    with state_lock:
        return jsonify({
            "status": state["status"],
            "progress": state["progress"],
            "progress_msg": state["progress_msg"],
            "error": state["error"],
            "n_cases": len(state["cases"]),
            "n_results": len(state["results"]),
        })


@app.route("/api/results")
def api_results():
    """ランキング結果を返す"""
    with state_lock:
        results = state["results"]
    if not results:
        return jsonify([])

    sort_by = request.args.get("sort", "final_score")
    reverse = request.args.get("desc", "0") == "1"
    limit = int(request.args.get("limit", 0))

    data = []
    for r in results:
        data.append({
            "lon": r.lon,
            "final_score": r.final_score,
            "mean_risk": r.mean_risk,
            "p95_risk": r.p95_risk,
            "high_risk_fraction": r.high_risk_fraction,
            "land_pixel_count": r.land_pixel_count,
            "land_ratio": r.land_ratio,
            "thumb": _b64(r.thumb_png),
            "error": r.error,
        })

    # ソート
    if sort_by in ("final_score", "mean_risk", "p95_risk", "high_risk_fraction", "lon", "land_ratio"):
        data.sort(key=lambda x: x.get(sort_by, 0), reverse=reverse)

    if limit > 0:
        data = data[:limit]

    # ランク付与
    for i, d in enumerate(data):
        d["rank"] = i + 1

    return jsonify(data)


@app.route("/api/detail/<int:lon>")
def api_detail(lon: int):
    """lon の詳細画像を返す"""
    with state_lock:
        results = state["results"]
        cases = state["cases"]

    result = None
    for r in results:
        if r.lon == lon:
            result = r
            break

    if result is None:
        return jsonify({"error": f"lon={lon} の結果がありません"}), 404

    data = {
        "lon": lon,
        "final_score": result.final_score,
        "mean_risk": result.mean_risk,
        "p95_risk": result.p95_risk,
        "high_risk_fraction": result.high_risk_fraction,
        "land_pixel_count": result.land_pixel_count,
        "land_ratio": result.land_ratio,
        "mask_diag": result.mask_diag,
        "images": {
            "land_mask": _b64(result.land_mask_png),
            "coastline": _b64(result.coastline_png),
            "heatmap": _b64(result.heatmap_png),
            "overlay": _b64(result.overlay_png),
            "raster": _b64(result.raster_png),
        },
    }

    # SVG 原画 (combined/map/text)
    case = cases.get(lon)
    if case:
        if case.combined_svg:
            data["images"]["combined_svg"] = base64.b64encode(case.combined_svg).decode()
        if case.map_svg:
            data["images"]["map_svg"] = base64.b64encode(case.map_svg).decode()
        if case.text_svg:
            data["images"]["text_svg"] = base64.b64encode(case.text_svg).decode()

    return jsonify(data)


@app.route("/api/params")
def api_params():
    """現在のパラメータを返す"""
    with state_lock:
        p = state["params"]
    return jsonify({
        "raster_size": p.raster_size,
        "sigma_point_ratio": p.sigma_point_ratio,
        "sigma_tangent_ratio": p.sigma_tangent_ratio,
        "sigma_normal_ratio": p.sigma_normal_ratio,
        "edge_soft_limit_ratio": p.edge_soft_limit_ratio,
        "weight_band": p.weight_band,
        "weight_point": p.weight_point,
        "weight_edge": p.weight_edge,
        "coast_weight": p.coast_weight,
        "coast_distance_px": p.coast_distance_px,
        "weight_mean": p.weight_mean,
        "weight_p95": p.weight_p95,
        "weight_fraction": p.weight_fraction,
        "high_risk_threshold": p.high_risk_threshold,
        "bg_color_tolerance": p.bg_color_tolerance,
        "min_land_area": p.min_land_area,
    })


@app.route("/api/diag")
def api_diag():
    """SVG ラスタライザの利用可否と環境情報を診断"""
    import shutil
    import platform
    import os

    diag = {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "rasterizers": {},
    }

    # Playwright (推奨)
    try:
        import playwright
        from playwright._impl._driver import compute_driver_executable
        driver = compute_driver_executable()
        import os
        if os.path.exists(driver):
            diag["rasterizers"]["playwright"] = {"status": "OK (インストール済み)"}
        else:
            diag["rasterizers"]["playwright"] = {"status": "playwright install chromium が必要"}
    except ImportError:
        diag["rasterizers"]["playwright"] = {"status": "未インストール (pip install playwright && playwright install chromium)"}
    except Exception as e:
        diag["rasterizers"]["playwright"] = {"status": f"インストール済み (詳細確認不可: {e})"}

    # CairoSVG (フォールバック)
    try:
        import cairosvg
        test_svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>'
        png = cairosvg.svg2png(bytestring=test_svg, output_width=10, output_height=10)
        diag["rasterizers"]["cairosvg"] = {
            "status": "OK" if len(png) > 50 else "NG",
            "version": getattr(cairosvg, "__version__", "?"),
        }
    except ImportError:
        diag["rasterizers"]["cairosvg"] = {"status": "未インストール (pip install cairosvg)"}
    except Exception as e:
        diag["rasterizers"]["cairosvg"] = {"status": f"エラー: {type(e).__name__}: {e}"}

    # svglib
    try:
        import svglib
        from reportlab.graphics import renderPM
        diag["rasterizers"]["svglib"] = {"status": "インストール済み"}
    except ImportError:
        diag["rasterizers"]["svglib"] = {"status": "未インストール (pip install svglib reportlab)"}
    except Exception as e:
        diag["rasterizers"]["svglib"] = {"status": f"エラー: {e}"}

    # Inkscape
    ink = shutil.which("inkscape")
    diag["rasterizers"]["inkscape"] = {"status": "検出: " + ink if ink else "PATH 上に見つからず"}

    # resvg
    resvg = shutil.which("resvg")
    diag["rasterizers"]["resvg"] = {"status": "検出: " + resvg if resvg else "PATH 上に見つからず"}

    # Chrome / Edge
    for name, paths in [
        ("edge", [
            shutil.which("msedge"),
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        ]),
        ("chrome", [
            shutil.which("chrome"),
            shutil.which("google-chrome"),
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ]),
    ]:
        found = None
        for p in paths:
            if p and os.path.isfile(p):
                found = p
                break
        diag["rasterizers"][name] = {"status": "検出: " + found if found else "見つからず"}

    # 解析状態
    with state_lock:
        n_cases = len(state["cases"])
        n_with_map = sum(1 for c in state["cases"].values() if c.map_svg is not None)
        first_err = next((r.error for r in state["results"] if r.error), "")
    diag["analysis"] = {
        "cases_total": n_cases,
        "cases_with_map_svg": n_with_map,
        "first_error": first_err,
    }
    return jsonify(diag)


# ---------------------------------------------------------------------------
# エクスポート
# ---------------------------------------------------------------------------

@app.route("/api/export/csv")
def export_csv():
    """ランキングを CSV でダウンロード"""
    with state_lock:
        results = state["results"]

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["rank", "lon", "final_score", "mean_risk", "p95_risk",
                      "high_risk_fraction", "land_pixel_count", "land_ratio"])
    for i, r in enumerate(results):
        writer.writerow([i + 1, r.lon, r.final_score, r.mean_risk, r.p95_risk,
                          r.high_risk_fraction, r.land_pixel_count, r.land_ratio])

    output = io.BytesIO(buf.getvalue().encode("utf-8-sig"))
    return send_file(output, mimetype="text/csv", as_attachment=True,
                     download_name="peirce_ranking.csv")


@app.route("/api/export/json")
def export_json():
    """ランキング詳細を JSON でダウンロード"""
    with state_lock:
        results = state["results"]
        p = state["params"]

    data = {
        "params": {
            "raster_size": p.raster_size,
            "sigma_point_ratio": p.sigma_point_ratio,
            "sigma_tangent_ratio": p.sigma_tangent_ratio,
            "sigma_normal_ratio": p.sigma_normal_ratio,
            "edge_soft_limit_ratio": p.edge_soft_limit_ratio,
            "weight_band": p.weight_band,
            "weight_point": p.weight_point,
            "weight_edge": p.weight_edge,
            "coast_weight": p.coast_weight,
            "weight_mean": p.weight_mean,
            "weight_p95": p.weight_p95,
            "weight_fraction": p.weight_fraction,
        },
        "results": [
            {
                "rank": i + 1,
                "lon": r.lon,
                "final_score": r.final_score,
                "mean_risk": r.mean_risk,
                "p95_risk": r.p95_risk,
                "high_risk_fraction": r.high_risk_fraction,
                "land_pixel_count": r.land_pixel_count,
                "land_ratio": r.land_ratio,
            }
            for i, r in enumerate(results)
        ],
    }

    output = io.BytesIO(json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"))
    return send_file(output, mimetype="application/json", as_attachment=True,
                     download_name="peirce_ranking.json")


# ---------------------------------------------------------------------------
# ヘルパー
# ---------------------------------------------------------------------------

def _b64(data: bytes) -> str:
    if not data:
        return ""
    return "data:image/png;base64," + base64.b64encode(data).decode()


# ---------------------------------------------------------------------------
# メイン
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("=" * 60)
    print("  Peirce Quincuncial 歪みリスクランキング")
    print("  http://localhost:5050 をブラウザで開いてください")
    print("=" * 60)
    app.run(host="127.0.0.1", port=5050, debug=False)
