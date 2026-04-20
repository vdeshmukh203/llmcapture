$ErrorActionPreference = 'Stop'

$repoPath = 'C:\Users\user\Downloads\llmcapture'
$branch = 'popup-debug-manual-test'
$stashMessage = "auto-stash before sync $(Get-Date -Format s)"

if (-not (Test-Path $repoPath)) {
  Write-Host "Repo path not found: $repoPath" -ForegroundColor Red
  exit 1
}

Set-Location $repoPath

$insideRepo = git rev-parse --is-inside-work-tree 2>$null
if ($LASTEXITCODE -ne 0 -or $insideRepo -ne 'true') {
  Write-Host 'Not a git repository.' -ForegroundColor Red
  exit 1
}

$statusLines = git status --porcelain
$hasChanges = ($statusLines | Measure-Object).Count -gt 0

if ($hasChanges) {
  Write-Host 'Local changes detected. Stashing them first...' -ForegroundColor Yellow
  git stash push -u -m $stashMessage | Out-Host
} else {
  Write-Host 'No local changes detected.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Fetching latest branch state...' -ForegroundColor Cyan
 git fetch origin | Out-Host
 git switch $branch | Out-Host
 git reset --hard "origin/$branch" | Out-Host

Write-Host ''
Write-Host 'Sync complete.' -ForegroundColor Green
Write-Host "Repo path: $repoPath"
Write-Host "Branch: $branch"

$stashList = git stash list
if ($stashList) {
  Write-Host ''
  Write-Host 'Saved stashes:' -ForegroundColor Yellow
  $stashList | Out-Host
  Write-Host 'Restore later with: git stash pop' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Next step: open chrome://extensions and click Reload.' -ForegroundColor Cyan
Read-Host 'Press Enter to exit'
