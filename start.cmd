@echo off
rem ---------------------------------------------------------------------------
rem  ws-scrcpy5 launcher  (PC version)
rem
rem    start.cmd                      -> open http://localhost:8080
rem    start.cmd 9000                 -> use port 9000
rem    start.cmd 8080 192.168.1.5:5555 -> open that device and start mirroring
rem
rem  This folder is SELF-CONTAINED: copy the whole pc\ folder to any machine
rem  (Desktop, USB stick, another PC) and double-click start.cmd. Nothing
rem  outside this folder is required except Node.js.
rem
rem  Stop the server with Ctrl+C in this window.
rem ---------------------------------------------------------------------------
setlocal
rem Work inside THIS folder: build.mjs, src\, public\ and dist\ all live here.
set "ROOT=%~dp0"
cd /d "%ROOT%"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8080"
set "DEVICE=%~2"

rem ---- 1. locate node -------------------------------------------------------
set "NODE="
where node >nul 2>nul
if %errorlevel%==0 (
  for /f "delims=" %%i in ('where node') do (
    set "NODE=%%i"
    goto :gotnode
  )
)
:gotnode
if not defined NODE (
  if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" (
    set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
  )
)
if not defined NODE (
  echo.
  echo [error] Node.js not found.
  echo         Install Node.js 18+ from https://nodejs.org and add it to PATH.
  echo.
  pause
  exit /b 1
)

rem ---- 2. prefer the bundled adb -------------------------------------------
if exist "%ROOT%adb\adb.exe" (
  set "ADB=%ROOT%adb\adb.exe"
)

rem ---- 3. the server jar must be here too ----------------------------------
rem It is gitignored, so a folder copied without it cannot work. Fail with a
rem usable message instead of a stack trace from deep inside a session.
set "JAR="
for %%f in ("%ROOT%server\scrcpy-server-v*") do set "JAR=%%f"
if not defined JAR (
  echo.
  echo [error] Missing server\scrcpy-server-v5.0.1
  echo         This folder was copied incompletely.
  echo         Get the full pc\ folder again, or run this in the project root:
  echo             npm run fetch-server
  echo.
  pause
  exit /b 1
)

rem ---- 4. already running? --------------------------------------------------
rem Just open the browser when the port is taken, instead of letting node die
rem with a raw EADDRINUSE stack trace.
set "LISTENING="
for /f "delims=" %%a in ('netstat -ano ^| findstr /c:"LISTENING" ^| findstr /c:":%PORT% "') do set "LISTENING=1"
if defined LISTENING (
  echo.
  echo   Port %PORT% is already in use - ws-scrcpy5 is probably already running.
  echo   Opening the browser only. Close that window first if you want a restart.
  echo.
  start "" http://localhost:%PORT%
  timeout /t 3 /nobreak >nul 2>nul
  exit /b 0
)

rem ---- 5. build every time ------------------------------------------------
rem Always rebuild, never "build only if missing".
rem
rem A missing-file check looks harmless but has a nasty failure mode: once
rem dist\ exists, edits to src\ are never picked up, so the browser keeps
rem running yesterday's code. That is exactly how a fixed bug appears to
rem still be present on the phone - the process in memory predates the fix.
rem
rem The build takes about a second, so paying it on every launch is cheap
rem insurance against shipping a stale bundle.
echo [setup] Building...
"%NODE%" "%ROOT%build.mjs"
if errorlevel 1 (
  echo.
  echo [error] Build failed. Run "npm install" in this folder first.
  echo.
  pause
  exit /b 1
)

rem ---- 6. open the browser --------------------------------------------------
if "%DEVICE%"=="" (
  start "" http://localhost:%PORT%
) else (
  start "" "http://localhost:%PORT%/?serial=%DEVICE%&autostart=1"
)

echo.
echo   ws-scrcpy5  -  press Ctrl+C in this window to stop
echo   PC     http://localhost:%PORT%
echo   Phone  http://[your-lan-ip]:%PORT%        (works as-is, hardware decoding via MSE)
echo.
"%NODE%" "%ROOT%dist\server\index.js"

echo.
echo   server stopped
pause
