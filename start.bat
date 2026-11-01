@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install it from https://nodejs.org and run this file again. & pause & exit /b)
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Created the .env file. Put your API key after API_KEY= then save and close Notepad.
  notepad ".env"
)
if not exist "node_modules" (
  echo Installing, please wait...
  call npm install
)
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
call npm start
pause
