@echo off
chcp 65001 >nul 2>&1
echo ============================================================
echo   Peirce Quincuncial 歪みリスクランキング
echo ============================================================
echo.

REM 依存パッケージ確認
python -c "import flask, numpy, scipy, PIL" 2>nul
if errorlevel 1 (
    echo 初回セットアップ: 依存パッケージをインストールします...
    pip install -r requirements.txt
    echo.
)

REM Playwright Chromium 確認・インストール
python -c "from playwright.sync_api import sync_playwright" 2>nul
if errorlevel 1 (
    echo Playwright をインストールします...
    pip install playwright
)
playwright install chromium 2>nul

echo ブラウザで http://localhost:5050 を開いてください
echo Ctrl+C で終了
echo.
python app.py
pause
