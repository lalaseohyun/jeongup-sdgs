@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  퀴즈로 알아보는 정읍 — 서버를 켭니다
echo  이 창을 닫으면 참여자 접속이 끊깁니다. 행사 끝날 때까지 켜두세요.
echo.
call npm run live
pause
