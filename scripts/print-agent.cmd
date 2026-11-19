@echo off
chcp 65001 >nul
title Photobooth - In tu dong (DNP)
rem Chuong trinh in tu dong tai quay: nhan lenh in tu web va in ra may DNP DS-RX1.
rem Chay tren may tinh Windows cam may in DNP (can Node.js 20+). Dien PRINT_AGENT_API_URL,
rem PRINT_AGENT_BRANCH, PRINT_AGENT_TOKEN, DNP_PRINTER_NAME (va DNP_STRIP_PRINTER_NAME) vao
rem file .env canh thu muc scripts (xem .env.example). Bam dup file nay, hoac dat loi tat vao
rem thu muc Startup (Win + R, go shell:startup) de tu chay khi bat may.
cd /d "%~dp0.."
if not exist node_modules call npm install --omit=dev
:loop
node scripts\print-agent.js
echo Chuong trinh in da dung - tu chay lai sau 5 giay...
timeout /t 5 /nobreak >nul
goto loop
