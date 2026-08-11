@echo off
chcp 65001 >nul
title Cursor-zh 汉化工具
cd /d "%~dp0"

echo ============================================
echo   Cursor-zh - Cursor 本地汉化工具
echo ============================================
echo.

rem 检查 Node.js 是否安装
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装后重试：
    echo         https://nodejs.org/
    echo.
    pause
    exit /b 1
)

rem 首次运行自动安装依赖
if not exist node_modules (
    echo [首次运行] 正在安装依赖，请稍候...
    echo.
    call npm install --no-fund --no-audit
    if errorlevel 1 (
        echo.
        echo [错误] 依赖安装失败，请检查网络后重新运行本文件。
        echo.
        pause
        exit /b 1
    )
    echo.
    echo [完成] 依赖安装完成。
    echo.
)

rem 启动汉化工具（写入 Cursor 安装目录时工具会自行请求管理员权限）
node index.js

echo.
pause