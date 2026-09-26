@echo off
rem Double-click to start GoblinKit and open it in your browser.
rem Keep this window open while you use it; close it to stop GoblinKit.

setlocal
title GoblinKit
rem UTF-8, so the servers' arrows and ticks show as themselves.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo GoblinKit needs Node.js, and it is not installed.
  echo Install the LTS version from https://nodejs.org, then double-click this again.
  echo.
  pause
  exit /b 1
)

rem First start on this machine: fetch the packages GoblinKit is built from.
rem pnpm is only needed for this step, so it is only checked for here.
if not exist "node_modules\.pnpm" (
  where pnpm >nul 2>nul
  if errorlevel 1 (
    echo.
    echo GoblinKit needs pnpm to install its packages, and pnpm is not installed.
    echo Open a terminal and run:  npm install -g pnpm
    echo Then double-click this again.
    echo.
    pause
    exit /b 1
  )
  echo Installing GoblinKit's packages. This happens once and takes a minute...
  call pnpm install --frozen-lockfile
  if errorlevel 1 (
    echo.
    echo Installing failed. The messages above say why.
    pause
    exit /b 1
  )
)

node tools\dev.mjs --open

rem Reaching here means GoblinKit stopped. If it stopped with an error, keep
rem the window open so the reason can be read instead of flashing past.
if errorlevel 1 pause
