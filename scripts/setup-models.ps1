# Creates Pip's named Ollama models (pip-fast, pip-jev, pip-cleanup, pip-vision, pip-deep, pip-agent)
# from the base models you already have, with context size and temperature baked in,
# and sets Ollama's server options. Safe to re-run.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    throw "Ollama isn't installed or not on PATH. Get it from https://ollama.com (MIT-licensed)."
}

# Server options (user-level environment variables; restart Ollama afterwards).
$serverOptions = @{
    OLLAMA_MAX_LOADED_MODELS = "3"   # 3b + llava + one 70b at once
    OLLAMA_NUM_PARALLEL      = "2"   # a talk turn and an agent can run together
    OLLAMA_FLASH_ATTENTION   = "1"
    OLLAMA_KV_CACHE_TYPE     = "q8_0" # halves KV-cache memory, negligible quality loss
    OLLAMA_KEEP_ALIVE        = "10m" # default for requests that don't set keep_alive (Codex)
}
foreach ($name in $serverOptions.Keys) {
    if ([Environment]::GetEnvironmentVariable($name, "User") -ne $serverOptions[$name]) {
        [Environment]::SetEnvironmentVariable($name, $serverOptions[$name], "User")
        Write-Host "set $name=$($serverOptions[$name]) (restart Ollama to apply)"
    }
}

$installed = (ollama list) -join "`n"
# Dictation cleanup model for Indian languages (Apache-2.0, ~5 GB).
if ($installed -notmatch "qwen3:8b") {
    Write-Host "pulling qwen3:8b for dictation cleanup (Hindi, Hinglish, Tamil, Telugu, Punjabi)"
    ollama pull qwen3:8b
    $installed = (ollama list) -join "`n"
}
$aliases = @(
    @{ Name = "pip-fast";   Base = "llama3.2:3b" },
    @{ Name = "pip-jev";    Base = "llama3.2:3b" },
    @{ Name = "pip-cleanup"; Base = "qwen3:8b" },
    @{ Name = "pip-vision"; Base = "llava:13b" },
    @{ Name = "pip-deep";   Base = "llama3.3:70b" },
    @{ Name = "pip-agent";  Base = "llama3.3:70b" }
)
foreach ($alias in $aliases) {
    if ($installed -notmatch [regex]::Escape($alias.Base)) {
        Write-Warning "$($alias.Base) isn't pulled, skipping $($alias.Name). Run: ollama pull $($alias.Base)"
        continue
    }
    Write-Host "creating $($alias.Name) from $($alias.Base)"
    ollama create $alias.Name -f (Join-Path $here "modelfiles\$($alias.Name).Modelfile") | Out-Null
}

if ($installed -notmatch "qwen2.5vl") {
    Write-Host "optional: 'ollama pull qwen2.5vl:7b' lets Pip point precisely in apps without a UI tree (canvas apps, games)."
}
Write-Host "done. models:"; ollama list
