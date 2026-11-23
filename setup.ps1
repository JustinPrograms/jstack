[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [Alias("Host")]
  [ValidateSet("claude", "codex", "bob", "gemini", "all")]
  [string]$TargetHost,

  [Parameter(Mandatory)]
  [Alias("Scope")]
  [ValidateSet("global", "local")]
  [string]$InstallationScope,

  [switch]$Force,

  [switch]$DryRun,

  [switch]$Verify,

  [switch]$CheckUpdates
)

# Install JStack's portable Markdown skills into a host's global or local skill root.
# This is deliberately only an installer: it does not run as part of JStack.
$sourceRoot = $PSScriptRoot
$ErrorActionPreference = "Stop"
$skillNames = @("jstack-plan", "jstack-plan-critic", "jstack-implement", "jstack-review", "jstack-test", "jstack-review-pr")
$version = (Get-Content -LiteralPath (Join-Path $sourceRoot "package.json") -Raw | ConvertFrom-Json).version
$commit = (& git -C $sourceRoot rev-parse HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $commit) { throw "JStack source must be a Git checkout" }
if ($CheckUpdates -and -not $Verify) { throw "-CheckUpdates requires -Verify" }
if ($Verify -and ($Force -or $DryRun)) { throw "-Verify cannot be combined with -Force or -DryRun" }

function Get-JStackSkillHash([string]$folder) {
  $rootItem = Get-Item -LiteralPath $folder -Force
  if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Not a regular skill directory: $folder"
  }
  $records = @{}
  $pending = New-Object System.Collections.Stack
  $pending.Push($rootItem.FullName)
  while ($pending.Count -gt 0) {
    foreach ($entry in (Get-ChildItem -LiteralPath ([string]$pending.Pop()) -Force)) {
      $relative = $entry.FullName.Substring($rootItem.FullName.Length + 1).Replace("\", "/")
      if ($relative -eq ".jstack-managed") { continue }
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Linked package content: $relative"
      }
      if ($entry.PSIsContainer) {
        $records[$relative] = "d:$relative"
        $pending.Push($entry.FullName)
      } elseif ($entry -is [IO.FileInfo]) {
        $digest = (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $records[$relative] = "f:${relative}:$digest"
      } else {
        $records[$relative] = "other:$relative"
      }
    }
  }
  $paths = [string[]]@($records.Keys)
  [Array]::Sort($paths, [StringComparer]::Ordinal)
  $manifest = if ($paths.Count -eq 0) { "" } else { (($paths | ForEach-Object { $records[$_] }) -join "`n") + "`n" }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($manifest)
    return ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $hasher.Dispose()
  }
}

function Read-JStackMetadata([string]$marker) {
  $metadata = @{}
  foreach ($line in (Get-Content -LiteralPath $marker)) {
    if ($line -match '^([^=]+)=(.*)$') { $metadata[$Matches[1]] = $Matches[2] }
  }
  return $metadata
}

function Test-JStackInstallation([string]$destination, [string]$hostName) {
  $attention = $false
  Write-Host "Verifying $destination ($hostName/$InstallationScope)"
  foreach ($skillName in $skillNames) {
    $target = Join-Path $destination $skillName
    $marker = Join-Path $target ".jstack-managed"
    if (-not (Test-Path -LiteralPath $target)) {
      Write-Host "${skillName}: missing"
      $attention = $true
      continue
    }
    $targetItem = Get-Item -LiteralPath $target -Force
    if (-not $targetItem.PSIsContainer -or ($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      Write-Host "${skillName}: modified (not a regular directory)"
      $attention = $true
      continue
    }
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
      Write-Host "${skillName}: unmanaged"
      $attention = $true
      continue
    }
    $markerItem = Get-Item -LiteralPath $marker -Force
    if ($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      Write-Host "${skillName}: unmanaged (linked marker)"
      $attention = $true
      continue
    }
    $metadata = Read-JStackMetadata $marker
    if (-not $metadata.version -or -not $metadata.commit -or -not $metadata.hash) {
      Write-Host "${skillName}: unmanaged (missing install metadata)"
      $attention = $true
      continue
    }
    if ($metadata.host -ne $hostName -or $metadata.scope -ne $InstallationScope) {
      Write-Host "${skillName}: modified (host/scope metadata mismatch)"
      $attention = $true
      continue
    }
    try {
      $actualHash = Get-JStackSkillHash $target
      $sourceHash = Get-JStackSkillHash (Join-Path $sourceRoot "skills/$skillName")
    } catch {
      Write-Host "${skillName}: modified ($($_.Exception.Message))"
      $attention = $true
      continue
    }
    if ($actualHash -ne $metadata.hash) {
      Write-Host "${skillName}: modified (hash mismatch)"
      $attention = $true
    } elseif ($metadata.version -ne $version -or $metadata.commit -ne $commit -or $metadata.hash -ne $sourceHash) {
      Write-Host "${skillName}: outdated (installed $($metadata.version) $($metadata.commit); clone $version $commit)"
      $attention = $true
    } else {
      Write-Host "${skillName}: present ($($metadata.version) $($metadata.commit))"
    }
  }
  if (Test-Path -LiteralPath $destination) {
    foreach ($entry in (Get-ChildItem -LiteralPath $destination -Force -Filter "jstack-*")) {
      if ($entry.Name -notin $skillNames) {
        Write-Host "unexpected skill: $($entry.FullName)"
        $attention = $true
      }
    }
  }
  if ($attention) {
    Write-Host "To reinstall this host/scope: powershell -NoProfile -ExecutionPolicy Bypass -File `"$sourceRoot/setup.ps1`" -Host $hostName -Scope $InstallationScope"
  }
  return $attention
}

function Test-JStackRemoteRelease {
  $lines = @(& git -C $sourceRoot ls-remote --tags --refs origin "refs/tags/v*")
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Update check unavailable; verify results above are still valid."
    return 2
  }
  $latest = $null
  foreach ($line in $lines) {
    if ($line -match 'refs/tags/v([0-9]+\.[0-9]+\.[0-9]+)$') {
      $candidate = [version]$Matches[1]
      if ($null -eq $latest -or $candidate -gt $latest) { $latest = $candidate }
    }
  }
  if ($null -eq $latest) {
    Write-Host "No release tags found; update check unavailable."
    return 2
  }
  if ($latest -gt [version]$version) {
    Write-Host "Update available: v$latest (clone v$version). Run: git -C `"$sourceRoot`" fetch --tags origin; if (`$LASTEXITCODE -eq 0) { git -C `"$sourceRoot`" switch --detach v$latest; if (`$LASTEXITCODE -eq 0) { powershell -NoProfile -ExecutionPolicy Bypass -File `"$sourceRoot/setup.ps1`" -Host $TargetHost -Scope $InstallationScope } }"
    return 1
  }
  Write-Host "No newer tagged release (clone v$version; latest v$latest)."
  return 0
}

function Install-JStackSkills([string]$destination, [string]$hostName) {
  if ($DryRun) {
    Write-Host "Would install JStack skills in $destination"
    return
  }

  New-Item -ItemType Directory -Force $destination | Out-Null
  foreach ($skillName in $skillNames) {
    $target = Join-Path $destination $skillName
    $temporary = Join-Path $destination ".$skillName.jstack-new-$PID"
    $backup = "$target.pre-jstack-backup"

    try {
      Copy-Item -Recurse (Join-Path $sourceRoot "skills/$skillName") $temporary
      $contentHash = Get-JStackSkillHash $temporary
      $metadata = "version=$version`ncommit=$commit`nhost=$hostName`nscope=$InstallationScope`nhash=$contentHash`n"
      [IO.File]::WriteAllText((Join-Path $temporary ".jstack-managed"), $metadata, (New-Object Text.UTF8Encoding $false))

      if (Test-Path -LiteralPath $target) {
        if (Test-Path -LiteralPath (Join-Path $target ".jstack-managed") -PathType Leaf) {
          Remove-Item -LiteralPath $target -Recurse -Force
        } else {
          if (Test-Path -LiteralPath $backup) {
            throw "Cannot preserve unmanaged skill because backup already exists: $backup"
          }
          Move-Item -LiteralPath $target -Destination $backup
          Write-Host "Preserved unmanaged skill in $backup"
        }
      }
      Move-Item -LiteralPath $temporary -Destination $target
    } finally {
      if (Test-Path -LiteralPath $temporary) {
        Remove-Item -LiteralPath $temporary -Recurse -Force
      }
    }
  }
  Write-Host "Installed JStack skills in $destination"
}

function Test-JStackDestination([string]$destination) {
  foreach ($skillName in $skillNames) {
    $target = Join-Path $destination $skillName
    if (
      (Test-Path -LiteralPath $target) -and
      -not (Test-Path -LiteralPath (Join-Path $target ".jstack-managed") -PathType Leaf) -and
      -not $Force
    ) {
      throw "Refusing to overwrite unmanaged skill: $target (rerun with -Force to preserve and replace it)"
    }
  }
}

function Get-JStackDestination([string]$hostName) {
  $basePath = if ($InstallationScope -eq "global") { $HOME } else { (Get-Location).Path }
  $hostFolder = switch ($hostName) {
    "claude" { ".claude/skills" }
    "codex" { ".agents/skills" }
    "bob" { ".bob/skills" }
    "gemini" { ".gemini/skills" }
  }
  return Join-Path $basePath $hostFolder
}

if ($InstallationScope -eq "local" -and (Get-Location).Path -eq $sourceRoot) {
  throw "For a local install, run setup from the repository receiving JStack."
}

$hosts = if ($TargetHost -eq "all") { @("claude", "codex", "bob", "gemini") } else { @($TargetHost) }
foreach ($hostName in $hosts) {
  if (-not $Verify) { Test-JStackDestination (Get-JStackDestination $hostName) }
}
$attention = $false
foreach ($hostName in $hosts) {
  if ($Verify) {
    if (Test-JStackInstallation (Get-JStackDestination $hostName) $hostName) { $attention = $true }
  } else {
    Install-JStackSkills (Get-JStackDestination $hostName) $hostName
  }
}
if ($CheckUpdates) {
  $updateResult = Test-JStackRemoteRelease
  if ($updateResult -eq 2) { exit 2 }
  if ($updateResult -eq 1) { $attention = $true }
}
if ($attention) { exit 1 }

