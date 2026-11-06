@echo off
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
title Movie Voiceover Pro - Storytelling & Review Server
echo ========================================================
echo   MOVIE VOICEOVER PRO - STORYTELLING ^& REVIEW SERVER
echo   Che do: Review Phim / Ke Chuyen / Thuyet Minh VTV
echo   Endpoint: http://127.0.0.1:8765
echo ========================================================
echo.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" python -m venv .venv
if not exist ".venv\Scripts\python.exe" goto failed
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto failed
rem OCR cu khong bat buoc cho player dong bo Gemini.
".venv\Scripts\python.exe" setup_voice.py
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m uvicorn server:app --host 127.0.0.1 --port 8765
goto end
:failed
echo Khong cai duoc thu vien. Hay kiem tra Python va ket noi Internet.
:end
pause
