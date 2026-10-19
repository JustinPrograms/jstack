[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [Alias("Host")]
  [ValidateSet("claude", "codex", "bob", "all")]
  [string]$TargetHost,

  [Parameter(Mandatory)]
  [Alias("Scope")]
  [ValidateSet("global", "local")]
  [string]$InstallationScope,

  [switch]$Force,

  [switch]$DryRun
)

# Install JStack's portable Markdown skills into a host's global or local skill root.
# This is deliberately only an installer: it does not run as part of JStack.
$sourceRoot = $PSScriptRoot
$skillNames = @("jstack-plan", "jstack-plan-critic", "jstack-implement", "jstack-review")

function Install-JStackSkills([string]$destination) {
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
      New-Item -ItemType File (Join-Path $temporary ".jstack-managed") | Out-Null

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
  }
  return Join-Path $basePath $hostFolder
}

if ($InstallationScope -eq "local" -and (Get-Location).Path -eq $sourceRoot) {
  throw "For a local install, run setup from the repository receiving JStack."
}

$hosts = if ($TargetHost -eq "all") { @("claude", "codex", "bob") } else { @($TargetHost) }
foreach ($hostName in $hosts) {
  Test-JStackDestination (Get-JStackDestination $hostName)
}
foreach ($hostName in $hosts) {
  Install-JStackSkills (Get-JStackDestination $hostName)
}


