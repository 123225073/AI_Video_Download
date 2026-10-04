@echo off
"%~dp0resources\bin\node\node.exe" "%~dp0resources\cli\fengsha.mjs" %*
exit /b %errorlevel%
