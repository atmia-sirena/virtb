# One-time setup for Pip on Windows. Everything is local and open source:
#   Ollama (LLMs/vision), sherpa-onnx with Parakeet + Kokoro (speech), Node (backend),
#   .NET 8 (client), optional Codex CLI (agents) and Cua Driver (background computer use).
param(
    [switch]$SkipSpeech,
    [switch]$SkipAgents
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Require($command, $hint) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command is missing. $hint" }
}
Require node   "Install Node.js 20 or newer (winget install OpenJS.NodeJS.LTS)."
Require dotnet "Install the .NET 8 SDK (winget install Microsoft.DotNet.SDK.8)."
Require ollama "Install Ollama (https://ollama.com)."

Write-Host "`n== models ==" -ForegroundColor Cyan
& "$root\scripts\setup-models.ps1"

Write-Host "`n== backend ==" -ForegroundColor Cyan
Push-Location backend
npm ci
npm run build
if (-not $SkipSpeech) {
    Write-Host "downloading speech models (Parakeet ~490 MB, Kokoro ~135 MB) into %APPDATA%\Pip\models"
    npm run setup:speech
}
Pop-Location

Write-Host "`n== home ==" -ForegroundColor Cyan
Push-Location home-web
npm ci
npm run build
Pop-Location

if (-not $SkipAgents) {
    Write-Host "`n== agents (optional) ==" -ForegroundColor Cyan
    if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
        $answer = Read-Host "install the open-source Codex CLI for agents? (npm i -g @openai/codex) [y/N]"
        if ($answer -eq "y") { npm install -g @openai/codex }
    }
    if (-not (Get-Command cua-driver -ErrorAction SilentlyContinue)) {
        $answer = Read-Host "install Cua Driver (MIT) so agents can use apps in the background? [y/N]"
        if ($answer -eq "y") { Invoke-RestMethod https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1 | Invoke-Expression }
    }
}

Write-Host "`n== windows client ==" -ForegroundColor Cyan
dotnet build clients\windows\Pip\Pip.csproj -c Release
Write-Host "`nall set. start pip with: scripts\start.ps1" -ForegroundColor Green
