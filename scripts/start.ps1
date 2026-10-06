# Starts Pip. The client launches the backend itself and stops it on quit.
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$exe = Join-Path $root "clients\windows\Pip\bin\Release\net8.0-windows10.0.19041.0\Pip.exe"
if (-not (Test-Path $exe)) { throw "Pip isn't built yet. Run scripts\setup.ps1 first." }
if (-not (Get-Process ollama -ErrorAction SilentlyContinue)) { Start-Process ollama -ArgumentList "serve" -WindowStyle Hidden }
$env:PIP_REPO_ROOT = $root
# The GPU speech server for Indian languages, if setup installed it.
if (-not $env:PIP_SPEECH_SERVER -and (Test-Path (Join-Path $root "speech-server\.venv"))) { $env:PIP_SPEECH_SERVER = Join-Path $root "speech-server" }
Start-Process $exe
