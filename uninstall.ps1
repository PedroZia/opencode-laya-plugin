#Requires -Version 5.1
<#
.SYNOPSIS
    Remove o plugin laya_decide do OpenCode e o servico local (venv, logs, serve.cmd).
.DESCRIPTION
    Para o servidor local (se estiver rodando), remove o plugin instalado e a pasta
    do servico em %USERPROFILE%\.config\opencode\laya.
    Os pesos baixados em ~\.cache\huggingface NAO sao tocados.
.PARAMETER Force
    Nao pede confirmacao.
.EXAMPLE
    .\uninstall.ps1
    .\uninstall.ps1 -Force
#>
[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = "Stop"

$LayaDir = Join-Path $env:USERPROFILE ".config\opencode\laya"
$PlugDir = Join-Path $env:USERPROFILE ".config\opencode\plugins\laya"

Write-Host ""
Write-Host "Isto vai remover:" -ForegroundColor Yellow
Write-Host "  - plugin:  $PlugDir" -ForegroundColor Yellow
Write-Host "  - servico: $LayaDir (venv, logs, serve.cmd)" -ForegroundColor Yellow
Write-Host "  (os pesos em ~\.cache\huggingface NAO sao tocados)" -ForegroundColor DarkGray
Write-Host ""

if (-not $Force) {
    $resp = Read-Host "Confirmar? [S/N]"
    if ($resp -notmatch '^[SsYy]') {
        Write-Host "cancelado."
        exit 0
    }
}

# Best-effort: para o servidor local se ele estiver rodando a partir deste venv.
try {
    $conns = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        if ($p -and $p.Path -like "$LayaDir*") {
            Write-Host "parando servidor local (PID $($p.Id))..." -ForegroundColor Cyan
            Stop-Process -Id $p.Id -Force
        }
    }
    Start-Sleep -Seconds 1
} catch {}

foreach ($dir in @($PlugDir, $LayaDir)) {
    if (Test-Path $dir) {
        try {
            Remove-Item -Recurse -Force $dir
            Write-Host "removido: $dir" -ForegroundColor Green
        } catch {
            Write-Host "nao consegui remover: $dir" -ForegroundColor Red
            Write-Host "  ($($_.Exception.Message))" -ForegroundColor DarkGray
            Write-Host "  Feche o OpenCode (e qualquer 'laya-serve') e rode de novo." -ForegroundColor DarkGray
        }
    } else {
        Write-Host "nao existe (ok): $dir" -ForegroundColor DarkGray
    }
}

Write-Host "Pronto. Reinicie o OpenCode para o plugin deixar de carregar." -ForegroundColor Green
