[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [Alias("Host")]
  [ValidateSet("claude", "codex", "bob", "all")]
  [string]$TargetHost,

  [Parameter(Mandatory)]
  [Alias("Scope")]
  [ValidateSet("global", "local")]
  [string]$InstallationScope
)

# Install JStack's portable Markdown skills into a host's global or local skill root.
# This is deliberately only an installer: it does not run as part of JStack.
$sourceRoot = $PSScriptRoot
$skillNames = @("jstack-plan", "jstack-implement", "jstack-review")

function Install-JStackSkills([string]$destination) {
  New-Item -ItemType Directory -Force $destination | Out-Null
  foreach ($skillName in $skillNames) {
    Copy-Item -Recurse -Force (Join-Path $sourceRoot "skills/$skillName") $destination
  }
  Write-Host "Installed JStack skills in $destination"
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
  Install-JStackSkills (Get-JStackDestination $hostName)
}
