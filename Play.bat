@echo off
rem Opens the Ragdoll Playground through a small local web server (the fly brain needs it to load its data).
cd /d "%~dp0"
start "Ragdoll Playground - server (close this window to stop it)" /min python tools\serve.py
timeout /t 2 /nobreak >nul
start "" http://localhost:8000/
