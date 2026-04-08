<#
.SYNOPSIS
    Pre-DEVMODE Resource Setup Script for FLT Testing
    
.DESCRIPTION
    This script creates workspace and lakehouse resources via EDOG metadata API
    BEFORE starting DEVMODE. Once resources are created, start DEVMODE and run tests.
    
.NOTES
    Run this BEFORE starting DEVMODE (flt-edog-devmode)
    
.EXAMPLE
    .\Setup-DevmodeResources.ps1 -CreateWorkspace -CreateLakehouse
#>

param(
    [switch]$CreateWorkspace,
    [switch]$CreateLakehouse,
    [string]$WorkspaceName = "devmode-test-ws-$(Get-Date -Format 'yyyyMMdd-HHmmss')",
    [string]$LakehouseName = "devmode-test-lh-$(Get-Date -Format 'yyyyMMdd-HHmmss')",
    [string]$ConfigPath = "$PSScriptRoot\edog-config.json"
)

$ErrorActionPreference = "Stop"

# EDOG Configuration
$EdogEndpoint = "https://edog.pbidedicated.windows-int.net"
$TokenCachePath = "$PSScriptRoot\.edog-token-cache"

function Get-EdogToken {
    if (-not (Test-Path $TokenCachePath)) {
        throw "Token cache not found at $TokenCachePath. Run the edog authentication first."
    }
    
    $encoded = Get-Content $TokenCachePath -Raw
    $decoded = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($encoded))
    $parts = $decoded -split '\|'
    return $parts[1]
}

function Get-EdogConfig {
    if (-not (Test-Path $ConfigPath)) {
        throw "Config not found at $ConfigPath"
    }
    return Get-Content $ConfigPath | ConvertFrom-Json
}

function Test-DevmodeRunning {
    # Check if DEVMODE might be intercepting traffic by testing a metadata endpoint
    $token = Get-EdogToken
    $headers = @{
        "Authorization" = "Bearer $token"
        "Content-Type" = "application/json"
    }
    
    try {
        # This endpoint should return something if DEVMODE is NOT running
        # If DEVMODE is running, it will return 404
        $response = Invoke-RestMethod -Uri "$EdogEndpoint/metadata/folders" -Headers $headers -Method Get -ErrorAction Stop
        return $false  # Metadata works, DEVMODE not intercepting
    } catch {
        if ($_.Exception.Response.StatusCode -eq 'NotFound') {
            return $true  # 404 means DEVMODE is intercepting
        }
        # Other errors might be auth issues
        return $false
    }
}

function New-Workspace {
    param(
        [string]$Name,
        [string]$CapacityId
    )
    
    $token = Get-EdogToken
    $headers = @{
        "Authorization" = "Bearer $token"
        "Content-Type" = "application/json"
    }
    
    $body = @{
        capacityObjectId = $CapacityId
        displayName = $Name
        description = "Auto-created workspace for DEVMODE testing"
        isServiceApp = $false
        datasetStorageMode = 1
    } | ConvertTo-Json
    
    Write-Host "Creating workspace '$Name' on capacity $CapacityId..."
    
    $response = Invoke-RestMethod -Uri "$EdogEndpoint/metadata/folders" -Headers $headers -Method Post -Body $body -ErrorAction Stop
    
    Write-Host "  ✅ Workspace created: $($response.objectId)"
    return $response.objectId
}

function New-Lakehouse {
    param(
        [string]$Name,
        [string]$WorkspaceId
    )
    
    $token = Get-EdogToken
    $headers = @{
        "Authorization" = "Bearer $token"
        "Content-Type" = "application/json"
    }
    
    $body = @{
        displayName = $Name
        description = "Auto-created lakehouse for DEVMODE testing"
        workloadPayload = '{"enableSchemas":true}'
    } | ConvertTo-Json
    
    Write-Host "Creating lakehouse '$Name' in workspace $WorkspaceId..."
    
    $url = "$EdogEndpoint/metadata/workspaces/$WorkspaceId/artifacts?artifactType=Lakehouse"
    $response = Invoke-RestMethod -Uri $url -Headers $headers -Method Post -Body $body -ErrorAction Stop
    
    Write-Host "  ✅ Lakehouse created: $($response.objectId)"
    return $response.objectId
}

# Main execution
Write-Host "=" * 60
Write-Host "DEVMODE Resource Setup Script"
Write-Host "=" * 60
Write-Host ""

# Check if DEVMODE is running
Write-Host "Checking if DEVMODE is running..."
if (Test-DevmodeRunning) {
    Write-Host "  ⚠️  WARNING: DEVMODE appears to be running!"
    Write-Host "  Metadata API calls will fail."
    Write-Host "  Please STOP DEVMODE first, then run this script."
    Write-Host ""
    $continue = Read-Host "Continue anyway? (y/N)"
    if ($continue -ne 'y') {
        exit 1
    }
} else {
    Write-Host "  ✅ DEVMODE not detected - metadata API accessible"
}
Write-Host ""

# Load config
$config = Get-EdogConfig
Write-Host "Loaded config:"
Write-Host "  Capacity: $($config.capacity_id)"
Write-Host "  Current Workspace: $($config.workspace_id)"
Write-Host "  Current Lakehouse: $($config.artifact_id)"
Write-Host ""

$newWorkspaceId = $null
$newLakehouseId = $null

if ($CreateWorkspace) {
    $newWorkspaceId = New-Workspace -Name $WorkspaceName -CapacityId $config.capacity_id
}

if ($CreateLakehouse) {
    $targetWorkspaceId = if ($newWorkspaceId) { $newWorkspaceId } else { $config.workspace_id }
    $newLakehouseId = New-Lakehouse -Name $LakehouseName -WorkspaceId $targetWorkspaceId
}

# Output results
Write-Host ""
Write-Host "=" * 60
Write-Host "Setup Complete!"
Write-Host "=" * 60
Write-Host ""

if ($newWorkspaceId) {
    Write-Host "New Workspace ID: $newWorkspaceId"
}
if ($newLakehouseId) {
    Write-Host "New Lakehouse ID: $newLakehouseId"
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Update edog-config.json with new IDs (if needed)"
Write-Host "2. Start DEVMODE: .\start-edog.ps1"
Write-Host "3. Run tests against the new resources"
