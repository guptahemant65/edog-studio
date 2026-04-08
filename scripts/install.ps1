# FLT EDOG DevMode - One-liner Install Script
# 
# Usage:
#   irm https://raw.githubusercontent.com/guptahemant65/flt-edog-devmode/main/install.ps1 | iex
#
# Or locally:
#   .\install.ps1

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  FLT EDOG DevMode - Installer" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# Configuration
$InstallDir = "$env:USERPROFILE\.edog"
$RepoUrl = "https://github.com/guptahemant65/flt-edog-devmode/archive/refs/heads/main.zip"

# Step 1: Check Python
Write-Host "[1/5] Checking Python..." -ForegroundColor Yellow
try {
    $pyVersion = python --version 2>&1
    Write-Host "       Found: $pyVersion" -ForegroundColor Green
} catch {
    Write-Host "       ERROR: Python not found. Install from https://python.org" -ForegroundColor Red
    exit 1
}

# Step 2: Create install directory
Write-Host "[2/5] Creating install directory..." -ForegroundColor Yellow
if (Test-Path $InstallDir) {
    Write-Host "       Updating existing installation..." -ForegroundColor Gray
    Remove-Item -Recurse -Force "$InstallDir\*" -ErrorAction SilentlyContinue
} else {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}
Write-Host "       Location: $InstallDir" -ForegroundColor Green

# Step 3: Download (or copy if local)
Write-Host "[3/5] Getting EDOG files..." -ForegroundColor Yellow

# Check if running from repo (local install)
$ScriptDir = if ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $null }
if ($ScriptDir -and (Test-Path "$ScriptDir\edog.py")) {
    Write-Host "       Copying from local repo..." -ForegroundColor Gray
    Copy-Item "$ScriptDir\edog.py" "$InstallDir\" -Force
    Copy-Item "$ScriptDir\edog.cmd" "$InstallDir\" -Force
    if (Test-Path "$ScriptDir\edog-config.json") {
        Copy-Item "$ScriptDir\edog-config.json" "$InstallDir\" -Force
    }
} else {
    Write-Host "       Downloading from GitHub..." -ForegroundColor Gray
    try {
        $TempZip = "$env:TEMP\edog-download.zip"
        Invoke-WebRequest -Uri $RepoUrl -OutFile $TempZip
        Expand-Archive -Path $TempZip -DestinationPath "$env:TEMP\edog-extract" -Force
        Copy-Item "$env:TEMP\edog-extract\flt-edog-devmode-main\*" "$InstallDir\" -Recurse -Force
        Remove-Item $TempZip -Force
        Remove-Item "$env:TEMP\edog-extract" -Recurse -Force
    } catch {
        Write-Host "       ERROR: Download failed. Clone the repo manually." -ForegroundColor Red
        Write-Host "       git clone https://github.com/guptahemant65/flt-edog-devmode $InstallDir" -ForegroundColor Gray
        exit 1
    }
}
Write-Host "       Done." -ForegroundColor Green

# Step 4: Install dependencies
Write-Host "[4/5] Installing Python dependencies..." -ForegroundColor Yellow
pip install playwright pywinauto --quiet --disable-pip-version-check 2>$null
python -m playwright install msedge --quiet 2>$null
Write-Host "       Done." -ForegroundColor Green

# Step 5: Add to PATH
Write-Host "[5/5] Adding to PATH..." -ForegroundColor Yellow
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $UserPath -or $UserPath -notlike "*$InstallDir*") {
    if ($UserPath) {
        $NewPath = "$UserPath;$InstallDir"
    } else {
        $NewPath = $InstallDir
    }
    [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
    Write-Host "       Added to PATH. Restart terminal to use 'edog' globally." -ForegroundColor Green
} else {
    Write-Host "       Already in PATH." -ForegroundColor Green
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Installation Complete!" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Restart your terminal (for PATH changes)" -ForegroundColor White
Write-Host "  2. Configure EDOG:" -ForegroundColor White
Write-Host "       edog --config -w WORKSPACE_ID -a ARTIFACT_ID -c CAPACITY_ID" -ForegroundColor Gray
Write-Host "  3. Install git hook (recommended):" -ForegroundColor White
Write-Host "       edog --install-hook" -ForegroundColor Gray
Write-Host "  4. Start EDOG:" -ForegroundColor White
Write-Host "       edog" -ForegroundColor Gray
Write-Host ""
