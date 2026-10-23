$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version=(Get-Content -LiteralPath (Join-Path $root '.node-version') -Raw).Trim()
if($version -notmatch '^\d+\.\d+\.\d+$') {throw 'Invalid pinned runtime version.'}
$directory=Join-Path $root '.runtime'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$base='https://nodejs.org/dist/v' + $version
$checksums=(Invoke-WebRequest -Uri ($base+'/SHASUMS256.txt') -UseBasicParsing -TimeoutSec 45).Content
$match=[regex]::Match($checksums,'(?m)^([a-fA-F0-9]{64})\s+win-x64/node\.exe\s*$')
if(-not $match.Success) {throw 'The official checksum list does not contain the Windows x64 executable.'}
$executable=Join-Path $directory 'node.exe'
$download=Join-Path $directory 'node.download.exe'
Invoke-WebRequest -Uri ($base+'/win-x64/node.exe') -OutFile $download -UseBasicParsing -TimeoutSec 180
$actual=(Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash
if($actual -ne $match.Groups[1].Value) {throw 'Runtime checksum mismatch. Do not package this download.'}
Move-Item -LiteralPath $download -Destination $executable -Force
Invoke-WebRequest -Uri ('https://raw.githubusercontent.com/nodejs/node/v'+$version+'/LICENSE') -OutFile (Join-Path $directory 'LICENSE.txt') -UseBasicParsing -TimeoutSec 45
Write-Output ('Verified official Node.js ' + $version + ' Windows x64 runtime.')
