@echo off
chcp 65001 >nul 2>&1
echo ============================================================
echo   Peirce Quincuncial 歪みリスクランキング
echo ============================================================
echo.

REM 依存パッケージ確認
python -c "import flask, numpy, scipy, PIL, cairosvg" 2>nul
if errorlevel 1 (
    echo 初回セットアップ: 依存パッケージをインストールします...
    pip install -r requirements.txt
    echo.
)

echo ブラウザで http://localhost:5050 を開いてください
echo Ctrl+C で終了
echo.
python app.py
pause
