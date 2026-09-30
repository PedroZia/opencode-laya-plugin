#Requires -Version 5.1
<#
.SYNOPSIS
    Instala o plugin laya_decide para o OpenCode (servidor local Laya + plugin).
.DESCRIPTION
    O que este script faz:
      1. Garante o 'uv' (gerenciador de Python) - oferece instalar via winget
      2. Cria o venv em %USERPROFILE%\.config\opencode\laya\.venv (Python 3.12)
      3. Instala PyTorch (CUDA detectado automaticamente; sem NVIDIA usa CPU) e laya[serve]
      4. Copia o plugin para %USERPROFILE%\.config\opencode\plugins\laya\index.ts
      5. Opcionalmente roda um smoke test (baixa os pesos ~1,7 GB)
.PARAMETER Force
    Recria o venv e reinstala as dependências do zero.
.PARAMETER SkipSmoke
    Pula o smoke test (o download dos pesos acontece no primeiro uso real).
.EXAMPLE
    .\install.ps1
    .\install.ps1 -SkipSmoke
    .\install.ps1 -Force
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipSmoke
)

$ErrorActionPreference = "Stop"

function Info($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }
function Ok($msg) { Write-Host "OK  $msg" -ForegroundColor Green }

# ------------------------------------------------------------------ caminhos
$RepoDir = $PSScriptRoot
$LayaDir = Join-Path $env:USERPROFILE ".config\opencode\laya"
$PlugDir = Join-Path $env:USERPROFILE ".config\opencode\plugins\laya"
$VenvDir = Join-Path $LayaDir ".venv"
$VenvPy = Join-Path $VenvDir "Scripts\python.exe"

Write-Host ""
Write-Host "  opencode-laya-plugin - instalador (Windows)" -ForegroundColor White
Write-Host "  https://github.com/PedroZia/opencode-laya-plugin" -ForegroundColor DarkGray
Write-Host ""

if ($env:OS -ne "Windows_NT") {
    throw "Este instalador e para Windows. No macOS/Linux, siga o README manualmente."
}

# ---------------------------------------------------------------------- uv
function Find-Uv {
    $cmd = Get-Command uv -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidate = Join-Path $env:USERPROFILE ".local\bin\uv.exe"
    if (Test-Path $candidate) { return $candidate }
    return $null
}

# Executa o uv tratando stderr como saida normal (progresso), nao como erro.
function Invoke-Uv {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$UvArgs)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $script:uv @UvArgs
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($code -ne 0) { throw "uv falhou (exit $code): uv $($UvArgs -join ' ')" }
}

$uv = Find-Uv
if (-not $uv) {
    Warn "O 'uv' (gerenciador de Python) nao foi encontrado."
    Write-Host ""
    Write-Host "  Instale com:  winget install --id astral-sh.uv -e" -ForegroundColor White
    Write-Host "  Ou:           powershell -c ""irm https://astral.sh/uv/install.ps1 | iex""" -ForegroundColor White
    Write-Host ""
    $resp = Read-Host "Tentar instalar via winget agora? [S/N]"
    if ($resp -match '^[SsYy]') {
        winget install --id astral-sh.uv -e --accept-source-agreements --accept-package-agreements
        $uv = Find-Uv
    }
    if (-not $uv) {
        Warn "uv continua indisponivel; instale e rode este script de novo."
        exit 1
    }
}
Ok "uv: $uv"

# --------------------------------------------------------------------- venv
New-Item -ItemType Directory -Force (Join-Path $LayaDir "logs") | Out-Null
New-Item -ItemType Directory -Force $PlugDir | Out-Null

if ($Force -and (Test-Path $VenvDir)) {
    Info "removendo venv antigo (-Force)"
    Remove-Item -Recurse -Force $VenvDir
}

if (-not (Test-Path $VenvPy)) {
    Info "criando venv (Python 3.12; o uv baixa o interpretador se necessario)"
    Invoke-Uv venv --python 3.12 $VenvDir
}

function Test-Deps {
    if (-not (Test-Path $VenvPy)) { return $false }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $VenvPy -c "import laya, torch" *> $null
        return ($LASTEXITCODE -eq 0)
    } finally {
        $ErrorActionPreference = $prev
    }
}

if ($Force -or -not (Test-Deps)) {
    Info "instalando PyTorch (CUDA detectado automaticamente; sem placa NVIDIA usa CPU)"
    try {
        Invoke-Uv pip install --python $VenvPy --torch-backend=auto torch
    } catch {
        Warn "instalacao com --torch-backend=auto falhou; tentando o indice padrao do PyPI"
        Invoke-Uv pip install --python $VenvPy torch
    }
    Info "instalando laya[serve]"
    Invoke-Uv pip install --python $VenvPy "laya[serve]"
    Info "instalando httpx (usado pelos scripts de teste)"
    Invoke-Uv pip install --python $VenvPy httpx
} else {
    Ok "dependencias ja instaladas (use -Force para reinstalar)"
}

# ---------------------------------------------------------------- serve.cmd
$ServeCmd = Join-Path $LayaDir "serve.cmd"
$cmdContent = @"
@echo off
rem Sobe o servidor local da Laya para o plugin do OpenCode (uso manual; o plugin sobe sozinho).
setlocal
set "LAYA_DEVICE=cuda"
set "LAYA_PRELOAD=1"
set "LAYA_HOST=127.0.0.1"
set "LAYA_PORT=8000"
set "USE_TF=0"
set "HF_HUB_DISABLE_SYMLINKS_WARNING=1"
"%~dp0.venv\Scripts\laya-serve.exe"
"@
Set-Content -Path $ServeCmd -Value $cmdContent -Encoding ASCII
Ok "serve.cmd em $ServeCmd"

# ------------------------------------------------------------------- plugin
$Src = Join-Path $RepoDir "plugin\index.ts"
if (-not (Test-Path $Src)) {
    throw "plugin\index.ts nao encontrado - rode este script de dentro do repositorio."
}
$Dst = Join-Path $PlugDir "index.ts"
if (Test-Path $Dst) {
    $bak = "$Dst.bak-$(Get-Date -Format 'yyyy-MM-dd_HH-mm-ss')"
    Copy-Item $Dst $bak
    Ok "backup do plugin anterior: $bak"
}
Copy-Item $Src $Dst -Force
Ok "plugin instalado em $Dst"

# ---------------------------------------------------------------- smoke test
if (-not $SkipSmoke) {
    Write-Host ""
    $resp = Read-Host "Baixar os modelos agora (~1,7 GB) e rodar um teste rapido? [S/N]"
    if ($resp -match '^[SsYy]') {
        Info "rodando smoke test (pode demorar alguns minutos no primeiro download)"
        & $VenvPy (Join-Path $RepoDir "tools\smoke.py")
        if ($LASTEXITCODE -ne 0) { Warn "smoke test falhou - veja a saida acima" } else { Ok "smoke test passou" }
    } else {
        Info "smoke test pulado (o download acontece no primeiro uso real)"
    }
}

Write-Host ""
Ok "instalacao concluida!"
Write-Host @"

Proximos passos:
  1. Abra/reinicie o OpenCode - o plugin carrega automaticamente.
  2. Digite /laya-status para conferir o servidor local.
  3. Ex.: peca "use laya_decide para classificar este texto".

O servidor local sobe sozinho quando o plugin carrega; log em:
  $LayaDir\logs\serve.log
"@ -ForegroundColor Gray
