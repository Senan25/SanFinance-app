@echo off
REM Run without Docker on Windows: double-click start.bat
cd /d "%~dp0"
if not exist .env (echo Create .env first: copy .env.example .env & pause & exit /b 1)
if not exist .venv python -m venv .venv
call .venv\Scripts\activate.bat
pip install -q -r requirements.txt
python run.py
pause
