@echo off
chcp 65001 >nul
setlocal
node "%~dp0bin\dsh-fix-attachments.mjs" %*
echo.
echo ---- 结束（窗口停在这里，按任意键关闭）----
pause >nul
