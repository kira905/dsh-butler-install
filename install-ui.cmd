@echo off
rem ============================================================================
rem  DSH butler suite - double-click installer (web wizard)
rem  ---------------------------------------------------------------------------
rem  This file must stay PURE ASCII. A .cmd with CJK text gets parsed as GBK and
rem  can break the command line. All Chinese copy lives on the web page.
rem
rem  What it does (three things only):
rem    1) check node
rem    2) hand off to bin/install-ui.mjs  (which probes for an already running
rem       wizard, starts one if needed, and opens the browser by itself)
rem    3) keep the window open on error so the message can be read
rem
rem  Why npx: the user only needs THIS file. No npm install, no clone.
rem ============================================================================
setlocal
title DSH butler suite - installer
echo.
echo   ============================================
echo    DSH butler suite - installer
echo   ============================================
echo.

where node >nul 2>&1
if errorlevel 1 goto nonode

echo   [1/2] node found. Checking the installer page...
echo   [2/2] The browser opens by itself when the page is ready.
echo         Keep this window open while installing (Ctrl+C stops it).
echo.

npx -y -p "@kira905/dsh-butler-install@^0.3.0" dsh-butler-install-ui %*
if errorlevel 1 goto failed
goto done

:nonode
echo   [X] Node.js was not found.
echo.
echo       The installer needs Node.js 22 or newer.
echo       Download:  https://nodejs.org/en/download
echo       Install it, then double-click this file again.
echo.
pause
exit /b 1

:failed
echo.
echo   [X] The installer stopped with an error (exit code %ERRORLEVEL%).
echo       Read the messages above - they say which package or which port failed.
echo.
pause
exit /b 1

:done
echo.
echo   The wizard is closed. If it was still installing, the log above shows
echo   where it stopped. Nothing was changed silently.
echo.
pause
endlocal
exit /b 0
