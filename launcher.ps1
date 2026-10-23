param(
    [ValidateSet('Run','Stop')][string]$Action = 'Run',
    [switch]$NoBrowser,
    [ValidateRange(1024,65515)][int]$Port = 3210
)
$ErrorActionPreference = 'Stop'
$projectDirectory = [System.IO.Path]::GetFullPath($PSScriptRoot)
$stateDirectory = Join-Path $projectDirectory '.soundmesh'
$stateFile = Join-Path $stateDirectory 'runtime.json'
$serverFile = Join-Path $projectDirectory 'server.mjs'
$hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
$rootHash = [BitConverter]::ToString($hashAlgorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectDirectory.ToLowerInvariant()))).Replace('-','')
$hashAlgorithm.Dispose()
$launchMutex = New-Object System.Threading.Mutex($false, ('Local\SoundMesh-' + $rootHash))
$locked = $false

function Get-RunningRoom {
    if (-not (Test-Path -LiteralPath $stateFile)) { return $null }
    try {
        $record = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        if ([IO.Path]::GetFullPath($record.root).TrimEnd([IO.Path]::DirectorySeparatorChar) -ne $projectDirectory.TrimEnd([IO.Path]::DirectorySeparatorChar)) { return $null }
        if ($record.serverPath -ne $serverFile) { return $null }
        if ($record.hostKey -notmatch '^[a-f0-9]{48}$' -or $record.roomKey -notmatch '^[a-f0-9]{24}$') { return $null }
        if ($record.port -lt 1024 -or $record.port -gt 65535) { return $null }
        $runningProcess = Get-Process -Id $record.pid -ErrorAction Stop
        if ($runningProcess.Path -ne $record.node) { return $null }
        $checkUrl = 'http://127.0.0.1:{0}/api/instance?key={1}' -f $record.port, $record.roomKey
        $identity = Invoke-RestMethod -Uri $checkUrl -Headers @{'x-host-token'=$record.hostKey} -TimeoutSec 2 -UseBasicParsing
        if ($identity.app -ne 'soundmesh' -or -not $identity.managed -or $identity.pid -ne $record.pid -or $identity.instanceId -ne $record.instanceId) { return $null }
        # Build the browser URL from validated fields rather than trusting a file URL.
        $record.hostUrl = 'http://localhost:{0}/?host={1}' -f $record.port, $record.hostKey
        return $record
    } catch { return $null }
}

function Open-Room($room) {
    if ($NoBrowser) { Write-Output ('SoundMesh ready on port ' + $room.port); return }
    $candidates = @()
    foreach ($baseDirectory in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if ($baseDirectory) { $candidates += (Join-Path $baseDirectory 'Google\Chrome\Application\chrome.exe') }
    }
    $chromePath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($chromePath) {
        Start-Process -FilePath $chromePath -ArgumentList @('--new-tab', $room.hostUrl) -WindowStyle Normal | Out-Null
    } else {
        $edgePath = @((Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'), (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if ($edgePath) { Start-Process -FilePath $edgePath -ArgumentList @('--new-tab',$room.hostUrl) -WindowStyle Normal | Out-Null }
        else { Start-Process -FilePath $room.hostUrl | Out-Null }
    }
}

try {
    $locked = $launchMutex.WaitOne(15000)
    if (-not $locked) { throw 'SoundMesh is already starting. Please try Run again in a few seconds.' }
    $room = Get-RunningRoom
    if ($Action -eq 'Stop') {
        if (-not $room) { Write-Output 'SoundMesh is already stopped for this folder.'; exit 0 }
        $stopUrl = 'http://127.0.0.1:{0}/api/shutdown?key={1}' -f $room.port, $room.roomKey
        Invoke-RestMethod -Uri $stopUrl -Method Post -Headers @{'x-host-token'=$room.hostKey} -ContentType 'application/json' -Body '{}' -TimeoutSec 5 -UseBasicParsing | Out-Null
        $finished = $false
        for ($attempt=0; $attempt -lt 30; $attempt++) {
            if (-not (Get-RunningRoom)) { $finished=$true; break }
            Start-Sleep -Milliseconds 100
        }
        if (-not $finished) { throw 'SoundMesh did not confirm shutdown. Please try Stop again.' }
        Write-Output 'SoundMesh stopped.'
        exit 0
    }
    if ($room) { Open-Room $room; exit 0 }
    $nodePath = Join-Path $projectDirectory '.runtime\node.exe'
    if (-not (Test-Path -LiteralPath $nodePath)) {
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $nodeCommand) { throw 'The bundled runtime is missing. Extract the complete SoundMesh ZIP, including its .runtime folder.' }
        $nodePath = $nodeCommand.Source
    }
    $version = & $nodePath -p 'process.versions.node.split(String.fromCharCode(46))[0]'
    if ([int]$version -lt 20) { throw 'SoundMesh needs Node.js 20 or newer. Use the bundled portable folder.' }
    $selectedPort = $null
    for ($candidate=$Port; $candidate -lt ($Port+20); $candidate++) {
        $probe = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Any,$candidate)
        try { $probe.Start(); $selectedPort=$candidate; break } catch {} finally { $probe.Stop() }
    }
    if (-not $selectedPort) { throw 'No free local port was found. Stop other SoundMesh copies and try again.' }
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    $stdout = Join-Path $stateDirectory 'server.log'
    $stderr = Join-Path $stateDirectory 'server-error.log'
    $arguments = @(('"' + $serverFile + '"'),'--managed',('--port=' + $selectedPort))
    $serverProcess = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $projectDirectory -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $startupDeadline=[DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $startupDeadline) {
        Start-Sleep -Milliseconds 150
        $room = Get-RunningRoom
        if ($room) { Open-Room $room; exit 0 }
        $serverProcess.Refresh()
        if ($serverProcess.HasExited) {
            $details = if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Raw } else { '' }
            throw ('SoundMesh could not start. ' + $details)
        }
    }
    try { $serverProcess.Refresh(); if(-not $serverProcess.HasExited) { $serverProcess.Kill() } } catch {}
    throw 'SoundMesh did not become ready. See .soundmesh\server-error.log in this folder.'
} catch {
    Write-Host ('SoundMesh: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if ($locked) { $launchMutex.ReleaseMutex() }
    $launchMutex.Dispose()
}
