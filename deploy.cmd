@echo off
rem Bam dup de dua Xe Phao Ma len VPS (lan dau: cai dat; lan sau: cap nhat). Huong dan: DEPLOY.md
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\deploy.ps1"
pause
