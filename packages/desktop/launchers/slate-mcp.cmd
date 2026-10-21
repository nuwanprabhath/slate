@echo off
rem Slate's MCP server for AI agents (packaged app). Register: claude mcp add slate -- "<this file>"
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\Slate.exe" "%~dp0..\app.asar\out\main\mcp.js" %*
