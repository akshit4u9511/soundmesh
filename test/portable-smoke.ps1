param([int]$Port=43212,[ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$PackageName='SoundMesh-Windows-x64')
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$archive=Join-Path $root ('release\'+$PackageName+'.zip')
$extraction=Join-Path $root ('.soundmesh\Portable launch verification '+[Guid]::NewGuid().ToString('N'))
if(Test-Path -LiteralPath $extraction) { throw 'Verification folder already exists; choose a clean destination.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($archive)
try {
  foreach($entry in $zip.Entries) {
    if($entry.FullName -match '(^|/)(\.soundmesh|node_modules|\.git)(/|$)') { throw 'Archive contains private or development runtime state.' }
  }
} finally {$zip.Dispose()}
[IO.Compression.ZipFile]::ExtractToDirectory($archive,$extraction)
$folder=Join-Path $extraction $PackageName
$launcher=Join-Path $folder 'launcher.ps1'
$recordFile=Join-Path $folder '.soundmesh\runtime.json'
foreach($line in (Get-Content -LiteralPath (Join-Path $folder 'SHA256SUMS.txt'))) {
  $digest,$relative=$line -split '  ',2
  $actual=(Get-FileHash -LiteralPath (Join-Path $folder $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
  if($actual -ne $digest) { throw ('Packaged file checksum failed: ' + $relative) }
}
$previousPath=$env:PATH
try {
  # Simulate a Windows machine without Node on PATH.
  $env:PATH=$env:SystemRoot + '\System32;' + $env:SystemRoot + '\System32\WindowsPowerShell\v1.0'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher -Action Run -NoBrowser -Port $Port
  if($LASTEXITCODE -ne 0) { throw 'Packaged startup failed' }
  $first=Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
  if($first.node -ne (Join-Path $folder '.runtime\node.exe')) { throw 'Package did not use its own runtime' }
  $headers=@{'x-host-token'=$first.hostKey}
  $base='http://127.0.0.1:' + $first.port
  $bootstrap=Invoke-RestMethod -Uri ($base + '/api/bootstrap') -Method Post -ContentType 'application/json' -Body (@{host=$first.hostKey}|ConvertTo-Json) -UseBasicParsing
  if(-not $bootstrap.isHost) { throw 'The generated invitation did not grant host access' }
  foreach($asset in @('/','/app.js','/qr.js','/capture-worklet.js','/playback-worklet.js')) {
    if((Invoke-WebRequest -Uri ($base+$asset) -UseBasicParsing).StatusCode -ne 200) {throw ('Missing packaged asset: ' + $asset)}
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher -Action Run -NoBrowser -Port $Port
  if($LASTEXITCODE -ne 0) { throw 'Repeated Run failed' }
  $second=Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
  if($first.instanceId -ne $second.instanceId) { throw 'Repeated Run created a duplicate server' }
  Write-Output 'PASS: extracted ZIP runs without Node on PATH; host invitation and all audio assets work; repeated Run reuses one process.'
} finally {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher -Action Stop -NoBrowser
  $env:PATH=$previousPath
}
if(Test-Path -LiteralPath $recordFile) { throw 'Stop did not remove the session state' }
Write-Output 'PASS: Stop shuts down the packaged server and cleans up its current session.'
