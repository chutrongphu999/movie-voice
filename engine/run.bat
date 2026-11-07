@echo off
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
title Movie Voice Engine (FastAPI + Groq + Gemini + TTS)
echo ========================================================
echo   MOVIE VOICE ENGINE - DUBBING ^& TRANSLATION SERVER
echo   Endpoint: http://127.0.0.1:8765
echo ========================================================
echo.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo [1/4] Khoi tao Virtual Environment Python...
    py -3.12 -m venv .venv 2>nul || python -m venv .venv
    if exist ".venv\Scripts\python.exe" (
        echo [2/4] Cai dat thu vien tu requirements.txt...
        ".venv\Scripts\python.exe" -m pip install --upgrade pip
        ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    )
)
if not exist ".venv\Scripts\python.exe" (
    echo [Loi] Khong tim thay Python 3.10+! Hay cai Python va tick Add Python to PATH.
    pause
    exit /b 1
)
if not exist ".env" (
    if exist ".env.example" copy /Y ".env.example" ".env" >nul
)

echo [3/4] Giai phong port 8765 neu dang bi chiem...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8765 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo [4/4] Khoi dong Movie Voice Studio v6 tai http://127.0.0.1:8765...
".venv\Scripts\python.exe" -m uvicorn main:app --host 127.0.0.1 --port 8765 --reload
pause
