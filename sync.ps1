# ============================================================
#  stream-party auto-sync script
#  Watches the repo folder and auto push/pulls on file change
# ============================================================

$repoPath   = $PSScriptRoot
$remoteName = "origin"
$branch     = "main"

# Load PAT from config file (excluded from git via .gitignore)
$configFile = Join-Path $PSScriptRoot "sync-config.ps1"
if (-not (Test-Path $configFile)) {
    Write-Error "Missing sync-config.ps1. Create it with: `$githubPat = 'your-pat-here'"
    exit 1
}
. $configFile

$remoteUrl = "https://$githubUser`:$githubPat@github.com/xtacyyy/streamparty.git"

function Write-Log($msg) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$timestamp] $msg"
}

function Sync-Repo {
    Set-Location $repoPath

    # Pull latest from remote
    Write-Log "Pulling from $branch..."
    $pullResult = git pull $remoteUrl $branch 2>&1
    Write-Log $pullResult

    # Stage all changes
    $status = git status --porcelain
    if ($status) {
        Write-Log "Changes detected - committing and pushing..."
        git add -A
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        git commit -m "Auto-sync: $timestamp"
        $pushResult = git push $remoteUrl $branch 2>&1
        Write-Log $pushResult
        Write-Log "Push complete."
    } else {
        Write-Log "No local changes to push."
    }
}

# Configure git identity if not already set
Set-Location $repoPath
git config user.email "razinnizar9@gmail.com" 2>$null
git config user.name  "Razin"                 2>$null
git remote set-url origin $remoteUrl          2>$null

Write-Log "=== Stream-Party Auto-Sync Started ==="
Write-Log "Watching: $repoPath"

# Do an initial sync on startup
Sync-Repo

# Set up FileSystemWatcher
$watcher                     = New-Object System.IO.FileSystemWatcher
$watcher.Path                = $repoPath
$watcher.IncludeSubdirectories = $true
$watcher.EnableRaisingEvents = $true
$watcher.NotifyFilter        = [System.IO.NotifyFilters]::LastWrite -bor
                               [System.IO.NotifyFilters]::FileName  -bor
                               [System.IO.NotifyFilters]::DirectoryName

# Debounce: track last sync time to avoid hammering on rapid saves
$script:lastSync = [datetime]::MinValue
$debounceSeconds = 5

$action = {
    $path = $Event.SourceEventArgs.FullPath
    # Ignore .git internals
    if ($path -match '\\\.git\\') { return }

    $now = Get-Date
    if (($now - $script:lastSync).TotalSeconds -ge $debounceSeconds) {
        $script:lastSync = $now
        Write-Log "File changed: $($Event.SourceEventArgs.Name)"
        Sync-Repo
    }
}

Register-ObjectEvent $watcher "Changed" -Action $action | Out-Null
Register-ObjectEvent $watcher "Created" -Action $action | Out-Null
Register-ObjectEvent $watcher "Deleted" -Action $action | Out-Null
Register-ObjectEvent $watcher "Renamed" -Action $action | Out-Null

Write-Log "Watching for changes (debounce: $debounceSeconds s). Press Ctrl+C to stop."

# Keep the script running
try {
    while ($true) { Start-Sleep -Seconds 1 }
} finally {
    $watcher.EnableRaisingEvents = $false
    $watcher.Dispose()
    Write-Log "Watcher stopped."
}
