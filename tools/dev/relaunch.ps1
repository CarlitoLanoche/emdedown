# Kill Emdedown, optionally rebuild, and start dist\Emdedown.exe with the DevTools port open (for cdp.mjs).
# usage: .\tools\dev\relaunch.ps1 [-NoBuild] [-File path.md] [-TestMode]
#   -TestMode sets EMDEDOWN_DEVTOOLS=1 (enables F12 DevTools and the `testPath` save-dialog bypass).
param([switch]$NoBuild, [string]$File = "$PSScriptRoot\..\..\samples\Welcome.md", [switch]$TestMode)
$root = Resolve-Path "$PSScriptRoot\..\.."
Get-Process Emdedown -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800
if (-not $NoBuild) { & "$root\build.ps1" | Select-Object -Last 2 }
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
if ($TestMode) { $env:EMDEDOWN_DEVTOOLS = "1" }
Start-Process "$root\dist\Emdedown.exe" -ArgumentList "`"$((Resolve-Path $File).Path)`""
Start-Sleep 3
