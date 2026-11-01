<#
.SYNOPSIS
  Builds key-reader (self-contained, single-file, trimmed win-x64) into out\key-reader.exe and runs its self-test.

.PARAMETER Out
  Where key-reader.exe goes (default: out\ next to this script; package.json's extraResources takes it from there).

.PARAMETER SkipSelfTest
  Do not run key-reader.exe --self-test after the build (it reads no keyboard: made-up records only).
#>
param(
    [string]$Out = (Join-Path $PSScriptRoot 'out'),
    [switch]$SkipSelfTest
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
& dotnet publish (Join-Path $root 'src/KeyReader.csproj') -c Release -r win-x64 -o $Out -nologo
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed ($LASTEXITCODE)" }

$exe = Join-Path $Out 'key-reader.exe'
if (-not (Test-Path $exe)) { throw "not built: $exe" }
# only the exe ships; nothing else may sit next to it
Get-ChildItem $Out | Where-Object { $_.Name -ne 'key-reader.exe' } | Remove-Item -Recurse -Force
Write-Host ("key-reader: {0} ({1:N1} MB)" -f $exe, ((Get-Item $exe).Length / 1MB))

if (-not $SkipSelfTest) {
    & $exe --self-test | Select-Object -Last 1
    if ($LASTEXITCODE -ne 0) { throw "key-reader --self-test failed ($LASTEXITCODE)" }
}
