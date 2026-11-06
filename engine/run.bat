@echo off
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
title Movie Voice Engine (FastAPI + Groq + Gemini + TTS)
echo ========================================================
echo   MOVIE VOICE ENGINE - DUBBING & TRANSLATION SERVER
echo   Endpoint: http://127.0.0.1:8765
echo ========================================================
echo.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo [1/3] Khoi tao Virtual Environment Python 3.12...
    py -3.12 -m venv .venv
)
if not exist ".venv\Scripts\python.exe" (
    echo [Loi] Khong tim thay Python 3.12! Hay kiem tra lai.
    pause
    exit /b 1
)

echo [2/3] Kiem tra thu vien phu thuoc...
".venv\Scripts\python.exe" -m pip install -r requirements.txt --quiet
if errorlevel 1 (
    echo [Loi] Cai dat thu vien that bai. Kiem tra ket noi internet.
    pause
    exit /b 1
)

echo [3/3] Khoi dong Movie Voice Engine tai http://127.0.0.1:8765...
".venv\Scripts\python.exe" -m uvicorn main:app --host 127.0.0.1 --port 8765 --reload
pause
