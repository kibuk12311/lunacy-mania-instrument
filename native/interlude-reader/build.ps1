<#
.SYNOPSIS
  Builds interlude-reader (self-contained, single-file, trimmed win-x64) and the fake Interlude test fixtures.

.PARAMETER DacVersions
  .NET runtime versions whose mscordaccore.dll (DAC) gets bundled into out\reader\dac\<version>\.
  Interlude is published single-file + self-contained, so no DAC ships with the game; the reader needs one
  matching (or at least same major.minor as) the game's runtime. The DACs come from the official
  Microsoft.NETCore.App.Runtime.win-x64 NuGet packages (nuget.org, downloaded at build time only).
  Pass @() to bundle none.

.PARAMETER NoTrim
  Publish without IL trimming (bigger, ~70 MB uncompressed; use if a future ClrMD breaks under trimming).

.PARAMETER SkipFake
  Do not build the fake Interlude fixtures (only needed for test.mjs).
#>
param(
    [string[]]$DacVersions = @('9.0.22'),
    [switch]$NoTrim,
    [switch]$SkipFake,
    [string]$Out = (Join-Path $PSScriptRoot 'out')
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Invoke-Dotnet([string[]]$a) {
    & dotnet @a
    if ($LASTEXITCODE -ne 0) { throw "dotnet $($a -join ' ') failed ($LASTEXITCODE)" }
}

# ---------------------------------------------------------------- reader
$trim = if ($NoTrim) { 'false' } else { 'true' }
$readerOut = Join-Path $Out 'reader'
if (Test-Path $readerOut) { Remove-Item -Recurse -Force $readerOut }
Invoke-Dotnet @('publish', (Join-Path $root 'src/InterludeReader.csproj'), '-c', 'Release', '-r', 'win-x64',
    "-p:PublishTrimmed=$trim", '-o', $readerOut, '-nologo')

# ---------------------------------------------------------------- DACs
if ($DacVersions.Count -gt 0) {
    $dacProjDir = Join-Path $Out 'obj-dac'
    New-Item -ItemType Directory -Force $dacProjDir | Out-Null
    $items = ($DacVersions | ForEach-Object { "    <PackageDownload Include=`"Microsoft.NETCore.App.Runtime.win-x64`" Version=`"[$_]`" />" }) -join "`n"
    @"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <ItemGroup>
$items
  </ItemGroup>
</Project>
"@ | Set-Content (Join-Path $dacProjDir 'dac.csproj') -Encoding utf8
    Invoke-Dotnet @('restore', (Join-Path $dacProjDir 'dac.csproj'), '-nologo')
    $pkgRoot = ((& dotnet nuget locals global-packages -l) -replace '^global-packages:\s*', '').Trim()
    foreach ($v in $DacVersions) {
        $src = Join-Path $pkgRoot "microsoft.netcore.app.runtime.win-x64/$v/runtimes/win-x64/native/mscordaccore.dll"
        if (-not (Test-Path $src)) { throw "DAC not found in package: $src" }
        $dst = Join-Path $readerOut "dac/$v"
        New-Item -ItemType Directory -Force $dst | Out-Null
        Copy-Item $src $dst
        Write-Host "bundled DAC $v"
    }
}

$exe = Join-Path $readerOut 'interlude-reader.exe'
$size = (Get-Item $exe).Length
Write-Host ("reader: {0} ({1:N1} MB)" -f $exe, ($size / 1MB))

# ---------------------------------------------------------------- fake Interlude fixtures
if (-not $SkipFake) {
    $fakeProj = Join-Path $root 'fake/Interlude/Interlude.fsproj'
    # like the real release: single-file, self-contained, trimmed (TrimMode=partial in the fsproj)
    foreach ($variant in @(@{ Name = 'fake-renamed'; Prop = '-p:FakeVariant=renamed' }, @{ Name = 'fake'; Prop = '-p:FakeVariant=normal' })) {
        $dir = Join-Path $Out $variant.Name
        if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
        Invoke-Dotnet @('publish', $fakeProj, '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true',
            '-p:PublishSingleFile=True', $variant.Prop, '-o', $dir, '-nologo')
        # never let a fixture look like the real game
        Move-Item -Force (Join-Path $dir 'Interlude.exe') (Join-Path $dir 'FakeInterlude.exe')
    }
    # framework-dependent build: lets test.mjs run the fixture on an installed .NET 9 runtime (roll-forward)
    $fd = Join-Path $Out 'fake-fd'
    if (Test-Path $fd) { Remove-Item -Recurse -Force $fd }
    Invoke-Dotnet @('build', $fakeProj, '-c', 'Release', '-p:FakeVariant=normal', '-o', $fd, '-nologo')
    Move-Item -Force (Join-Path $fd 'Interlude.exe') (Join-Path $fd 'FakeInterlude.exe')
}
