@echo off
echo.
echo  Closing any existing Chrome processes...
taskkill /F /IM chrome.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo  Starting Chrome with remote debugging on port 9222...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --no-first-run

echo.
echo  Chrome is open.
echo  ---------------------------------------------------
echo  Log into these sites in the Chrome window:
echo    1. https://claude.ai
echo    2. https://chat.openai.com  (ChatGPT)
echo    3. https://gemini.google.com
echo  ---------------------------------------------------
echo  When you are fully logged into all three, come back
echo  to Claude Code and say "done".
echo.
pause
