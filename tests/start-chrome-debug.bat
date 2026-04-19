@echo off
echo.
echo  Closing any existing Chrome processes...
taskkill /F /IM chrome.exe >nul 2>&1
ping -n 3 127.0.0.1 >nul

echo  Starting Chrome with remote debugging on port 9222...
echo  (This window must stay open while you log in)
echo.
echo  ---------------------------------------------------
echo  Log into these sites in the Chrome window:
echo    1. https://claude.ai
echo    2. https://chat.openai.com  (ChatGPT)
echo    3. https://gemini.google.com
echo  ---------------------------------------------------
echo  When fully logged into all three, run:
echo    node tests/setup-auth.js
echo  ---------------------------------------------------
echo.

"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --no-first-run

pause
