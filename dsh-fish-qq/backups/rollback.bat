@echo off
chcp 65001 >nul
setlocal
set "SRC=%~dp0backup_before_routing"
set "ROOT=%~dp0.."

if not exist "%SRC%\qq\index.js" (
  echo [错误] 找不到备份文件：%SRC%\qq\index.js
  echo 请确认 backups\backup_before_routing\ 没有被移动或删除。
  pause
  exit /b 1
)

echo 正在从备份恢复...
xcopy /E /I /Y "%SRC%" "%ROOT%" >nul
if errorlevel 1 (
  echo [错误] 回退失败，请检查文件是否被占用，或手工复制 %SRC% 到 %ROOT%。
  pause
  exit /b 1
)

rem 改动中新增的文件：回退时一并删除，保证恢复到改动前的样子。
rem 清单见 backups\NEW_FILES.txt（这里同步维护）。
if exist "%ROOT%\qq\test-tool-routing.mjs" del /q "%ROOT%\qq\test-tool-routing.mjs"

echo.
echo 回退成功，请重启 DSH
pause
endlocal
