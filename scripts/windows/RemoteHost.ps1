[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('init', 'validate', 'install', 'start', 'stop', 'status', 'uninstall', 'protect-secrets', 'run')]
    [string]$Action,
    [string]$Config,
    [string]$Hostname = '',
    [string]$NodePath,
    [string]$CloudflaredPath,
    [switch]$CheckPublic
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Config) { $Config = Join-Path $projectDir '.threads-data\remote-host\config.json' }
$Config = [IO.Path]::GetFullPath($Config)
$supervisor = Join-Path $PSScriptRoot 'supervisor.mjs'
$privatePaths = Join-Path $PSScriptRoot 'Assert-PrivatePaths.ps1'
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
# Scheduler/network cmdlets must resolve from Windows' own modules even when this
# script is invoked by Node inherited from a PowerShell 7 developer shell.
$env:PSModulePath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
$utf8 = [Text.UTF8Encoding]::new($false)
$userIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($Config.ToLowerInvariant()))).Replace('-', '').ToLowerInvariant()
$taskName = 'ThreadsMCP-RemoteHost-' + $hash.Substring(0, 12)
$marker = 'ThreadsMCP.RemoteHost.v1:' + $hash

function Get-HostConfig {
    if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) { throw 'CONFIG_MISSING' }
    if ((Get-Item -LiteralPath $Config).Length -gt 16384) { throw 'CONFIG_INVALID' }
    return (Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json)
}
function Invoke-Supervisor([string]$Command, [bool]$Public = $false) {
    $settings = Get-HostConfig
    $arguments = @($supervisor, $Command, '--config', $Config)
    if ($Public) { $arguments += '--check-public' }
    & $settings.nodePath @arguments
    if ($LASTEXITCODE -ne 0) { throw 'SUPERVISOR_COMMAND_FAILED' }
}
function Get-OwnedTask {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) { return $null }
    $taskUser = $task.Principal.UserId
    if ($task.Description -ne $marker -or ($taskUser -ne $userIdentity.User.Value -and $taskUser -ine $userIdentity.Name)) { throw 'TASK_NAME_COLLISION' }
    return $task
}
function Request-Stop {
    Invoke-Supervisor 'stop'
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $task = Get-OwnedTask
        if (-not $task -or $task.State -ne 'Running') { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'STOP_PENDING_NO_FORCE_KILL'
}

try {
    if ($Action -eq 'init') {
        if (Test-Path -LiteralPath $Config) { throw 'CONFIG_ALREADY_EXISTS' }
        if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
        if (-not $CloudflaredPath) { $found = Get-Command cloudflared.exe -ErrorAction SilentlyContinue; $CloudflaredPath = if ($found) { $found.Source } else { '' } }
        $stateDir = Split-Path -Parent $Config
        if ((Split-Path -Leaf $stateDir) -ne 'remote-host') { throw 'PRIVATE_PATH_REQUIRED' }
        $dataDir = Split-Path -Parent $stateDir
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
        $tunnelToken = Join-Path $stateDir 'tunnel.token'
        & $powershellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $privatePaths -StateDir $stateDir -ConfigPath $Config -TokenFile $tunnelToken -ProtectState
        if ($LASTEXITCODE -ne 0) { throw 'PRIVATE_ACL_REQUIRED' }
        $settings = [ordered]@{
            schemaVersion = 1; projectDir = $projectDir; dataDir = $dataDir
            nodePath = [IO.Path]::GetFullPath($NodePath); cloudflaredPath = $CloudflaredPath
            bridgePort = 19758; httpPort = 19759; metricsPort = 19760
            hostname = $Hostname; tunnelTokenFile = $tunnelToken; tunnelEnabled = $false
            remoteWritesEnabled = $false
            checkIntervalMs = 5000; healthTimeoutMs = 5000; restartBaseMs = 1000
            restartMaxMs = 60000; stableResetMs = 60000; maxEventLogBytes = 262144
        }
        [IO.File]::WriteAllText($Config, ($settings | ConvertTo-Json -Depth 4), $utf8)
        @{ initialized = $true; config = $Config; tunnelEnabled = $false; remoteWritesEnabled = $false; taskInstalled = $false } | ConvertTo-Json -Compress
        exit 0
    }
    if ($Action -eq 'protect-secrets') {
        $settings = Get-HostConfig
        & $powershellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $privatePaths -StateDir (Split-Path -Parent $Config) -ConfigPath $Config -TokenFile $settings.tunnelTokenFile -ProtectSecrets
        if ($LASTEXITCODE -ne 0) { throw 'PRIVATE_ACL_REQUIRED' }
        @{ protectedExistingKnownTokenFiles = $true; contentsRead = $false } | ConvertTo-Json -Compress
        exit 0
    }
    if ($Action -eq 'validate') { Invoke-Supervisor 'validate'; exit 0 }
    if ($Action -eq 'run') { Invoke-Supervisor 'run'; exit 0 }
    if ($Action -eq 'status') {
        Invoke-Supervisor 'status' $CheckPublic.IsPresent
        $task = Get-OwnedTask
        $taskState = if ($task) { [string]$task.State } else { 'not-installed' }
        $settings = Get-HostConfig
        $listeners = @()
        $listenerState = 'checked'
        try {
            $listeners = @(foreach ($port in @($settings.bridgePort, $settings.httpPort, $settings.metricsPort)) { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort, OwningProcess })
        } catch { $listenerState = 'unavailable' }
        @{ scheduledTask = $taskName; taskState = $taskState; listenersInspection = $listenerState; listeners = $listeners } | ConvertTo-Json -Depth 4 -Compress
        exit 0
    }
    if ($Action -eq 'install') {
        Invoke-Supervisor 'validate'
        $existing = Get-OwnedTask
        if ($existing) { @{ installed = $true; alreadyPresent = $true; task = $taskName; started = $false } | ConvertTo-Json -Compress; exit 0 }
        $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '" -Action run -Config "' + $Config + '"'
        $taskAction = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory $projectDir
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userIdentity.Name
        $principal = New-ScheduledTaskPrincipal -UserId $userIdentity.User.Value -LogonType Interactive -RunLevel Limited
        $taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $taskSettings -Description $marker | Out-Null
        @{ installed = $true; task = $taskName; logonType = 'Interactive'; runLevel = 'Limited'; started = $false } | ConvertTo-Json -Compress
        exit 0
    }
    if ($Action -eq 'start') {
        $task = Get-OwnedTask
        if (-not $task) { throw 'TASK_NOT_INSTALLED' }
        Invoke-Supervisor 'resume'
        Enable-ScheduledTask -TaskName $taskName | Out-Null
        Start-ScheduledTask -TaskName $taskName
        @{ startRequested = $true; task = $taskName; healthVerified = $false } | ConvertTo-Json -Compress
        exit 0
    }
    if ($Action -eq 'stop') { Request-Stop; @{ stopRequested = $true; noUnownedProcessWasStopped = $true } | ConvertTo-Json -Compress; exit 0 }
    if ($Action -eq 'uninstall') {
        $task = Get-OwnedTask
        if ($task) { Disable-ScheduledTask -TaskName $taskName | Out-Null }
        Request-Stop
        if ($task) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
        @{ uninstalled = $true; configurationAndSecretsPreserved = $true } | ConvertTo-Json -Compress
        exit 0
    }
} catch {
    # Do not echo exception messages, command lines, config contents, or secrets.
    $known = @('CONFIG_MISSING', 'CONFIG_INVALID', 'CONFIG_ALREADY_EXISTS', 'PRIVATE_PATH_REQUIRED', 'PRIVATE_ACL_REQUIRED', 'TASK_NAME_COLLISION', 'TASK_NOT_INSTALLED', 'STOP_PENDING_NO_FORCE_KILL', 'SUPERVISOR_COMMAND_FAILED')
    $code = if ($known -contains $_.Exception.Message) { $_.Exception.Message } else { 'WINDOWS_REMOTE_HOST_FAILED' }
    [Console]::Error.WriteLine((@{ error = $code } | ConvertTo-Json -Compress))
    exit 1
}
