# ============================================================
#  stream-party auto-sync script
#  Polls every 5 seconds, commits and pushes any changes
# ============================================================

$repoPath        = $PSScriptRoot
$branch          = "main"
$pollSeconds     = 5

# Load PAT from config file (excluded from git via .gitignore)
$configFile = Join-Path $PSScriptRoot "sync-config.ps1"
if (-not (Test-Path $configFile)) {
    Write-Error "Missing sync-config.ps1. Create it with: `$githubPat = 'your-pat-here'"
    exit 1
}
. $configFile

$remoteUrl = "https://$githubUser`:$githubPat@github.com/xtacyyy/streamparty.git"

function Write-Log($msg) {
    $timestamp = Get-Date -Format "HH:mm:ss"
    Write-Host "[$timestamp] $msg"
}

function Sync-Repo {
    Set-Location $repoPath

    # Pull latest
    $pull = git pull $remoteUrl $branch 2>&1
    $pullStr = "$pull"
    if ($pullStr -notmatch "Already up to date") {
        Write-Log "Pulled: $pullStr"
    }

    # Check for local changes
    $status = git status --porcelain 2>&1
    if ($status) {
        Write-Log "Changes detected, pushing..."
        git add -A 2>&1 | Out-Null
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        git commit -m "Auto-sync: $timestamp" 2>&1 | Out-Null
        $push = git push $remoteUrl $branch 2>&1
        $pushStr = "$push"
        if ($pushStr -match "error|fatal") {
            Write-Log "Push error: $pushStr"
        } else {
            Write-Log "Pushed OK"
        }
    }
}

# Setup
Set-Location $repoPath
git config user.email "razinnizar9@gmail.com" 2>$null
git config user.name  "Razin"                 2>$null
git remote set-url origin $remoteUrl          2>$null

Write-Log "=== Auto-Sync Started === (polling every $pollSeconds s)"
Write-Log "Watching: $repoPath"

# Initial sync
Sync-Repo
Write-Log "Ready. Watching for changes..."

# Poll loop
while ($true) {
    Start-Sleep -Seconds $pollSeconds
    Set-Location $repoPath
    $status = git status --porcelain 2>&1
    if ($status) {
        Sync-Repo
    }
}
