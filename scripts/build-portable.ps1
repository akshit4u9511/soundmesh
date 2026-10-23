param([string]$OutputName='SoundMesh-Windows-x64')
$ErrorActionPreference='Stop'
if($OutputName -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Use a simple package name.' }
$sourceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseRoot=Join-Path $sourceRoot 'release'
$packageRoot=Join-Path $releaseRoot $OutputName
$runtimeRoot=Join-Path $sourceRoot '.runtime'
if(-not (Test-Path -LiteralPath (Join-Path $runtimeRoot 'node.exe'))) { throw 'Place the verified Windows x64 node.exe and its LICENSE in .runtime first.' }
if(-not (Test-Path -LiteralPath (Join-Path $runtimeRoot 'LICENSE.txt'))) { throw 'The Node.js license is required.' }
if(Test-Path -LiteralPath $packageRoot) { throw 'This output folder already exists. Choose a new OutputName to avoid mixing packages or including private runtime state.' }
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
foreach($file in @('server.mjs','package.json','launcher.ps1','Run SoundMesh.cmd','Stop SoundMesh.cmd','Start SoundMesh.cmd','START HERE.txt','README.md','LICENSE','THIRD_PARTY_NOTICES.md','CHANGELOG.md')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $file) -Destination (Join-Path $packageRoot $file)
}
foreach($directory in @('public','lib','.runtime')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $directory) -Destination (Join-Path $packageRoot $directory) -Recurse
}
New-Item -ItemType Directory -Path (Join-Path $packageRoot 'docs') -Force | Out-Null
foreach($document in @('ARCHITECTURE.md','TROUBLESHOOTING.md','RELEASING.md')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot ('docs\'+$document)) -Destination (Join-Path $packageRoot ('docs\'+$document))
}
Copy-Item -LiteralPath (Join-Path $sourceRoot 'docs\images') -Destination (Join-Path $packageRoot 'docs\images') -Recurse
# Credentials, logs, current room state, music, and development dependencies
# are intentionally absent from the allowlist above.
$manifest=Get-ChildItem -LiteralPath $packageRoot -File -Recurse -Force | ForEach-Object {
    $relative=$_.FullName.Substring($packageRoot.Length+1).Replace('\','/')
    $digest=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $digest + '  ' + $relative
}
[IO.File]::WriteAllLines((Join-Path $packageRoot 'SHA256SUMS.txt'),[string[]]$manifest)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=Join-Path $releaseRoot ($OutputName + '.zip')
if(Test-Path -LiteralPath $archive) { throw 'The archive already exists. Choose a new OutputName.' }
[IO.Compression.ZipFile]::CreateFromDirectory($packageRoot,$archive,[IO.Compression.CompressionLevel]::Optimal,$true)
Write-Output ('Portable folder: ' + $packageRoot)
Write-Output ('ZIP: ' + $archive)
