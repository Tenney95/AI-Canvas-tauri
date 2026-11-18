[CmdletBinding()]
param(
    [string]$OutputRoot,
    [switch]$NoOpen
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspaceRoot = Split-Path $projectRoot -Parent
if (!$OutputRoot) { $OutputRoot = Join-Path $workspaceRoot 'packages' }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$originalLocation = Get-Location
$writer = $null
$buildLock = $null
$exitCode = 1

function Write-BuildMessage([string]$Message) {
    Write-Host $Message
    if ($script:writer) { $script:writer.WriteLine($Message); $script:writer.Flush() }
}

function Invoke-BuildStep([string]$Label, [string]$Executable, [string[]]$Arguments) {
    Write-BuildMessage "`n=== $Label ==="
    # Windows PowerShell treats native stderr as ErrorRecord. Preserve the real
    # exit code while logging both streams as UTF-8, without stopping on warnings.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $Executable @Arguments 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-BuildMessage $_.Exception.Message }
            else { Write-BuildMessage ([string]$_) }
        }
        $stepExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($stepExit -ne 0) { throw "$Label failed (exit $stepExit). See build.log." }
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This script requires Windows x64.' }
    if (![Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
    Set-Location -LiteralPath $projectRoot
    $package = [IO.File]::ReadAllText((Join-Path $projectRoot 'package.json'), $utf8) | ConvertFrom-Json
    $tauri = [IO.File]::ReadAllText((Join-Path $projectRoot 'src-tauri\tauri.conf.json'), $utf8) | ConvertFrom-Json
    $cargoToml = [IO.File]::ReadAllText((Join-Path $projectRoot 'src-tauri\Cargo.toml'), $utf8)
    $cargoVersion = [regex]::Match($cargoToml, '(?ms)^\[package\]\s*.*?^version\s*=\s*"([^"]+)"').Groups[1].Value
    if ($package.version -ne $tauri.version -or $package.version -ne $cargoVersion) { throw 'package.json, tauri.conf.json and Cargo.toml versions must match.' }
    if ($package.version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw 'Invalid application version.' }

    $cacheRoot = Join-Path $workspaceRoot '.build-cache'
    [IO.Directory]::CreateDirectory($cacheRoot) | Out-Null
    try { $buildLock = [IO.File]::Open((Join-Path $cacheRoot 'windows-build.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { throw 'Another local build is using this workspace. Wait for it to finish.' }

    $buildName = 'AI-Canvas-' + $package.version + '-local-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
    $outputDirectory = Join-Path $OutputRoot $buildName
    [IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
    $writer = New-Object System.IO.StreamWriter((Join-Path $outputDirectory 'build.log'), $false, $utf8)
    Write-BuildMessage 'Building the current working tree, including saved uncommitted edits.'
    Write-BuildMessage 'Local NSIS installer; updater signing artifacts are disabled for this run only.'
    Write-BuildMessage 'The installed application and project data will not be replaced by this script.'

    # Discover tools in newly installed Rust locations without requiring a reboot.
    $rustBins = @()
    if ($env:CARGO_HOME) { $rustBins += Join-Path $env:CARGO_HOME 'bin' }
    $rustBins += Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cargo\bin'
    foreach ($directory in $rustBins) { if (Test-Path -LiteralPath $directory -PathType Container) { $env:Path = $directory + ';' + $env:Path } }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $cargo = (Get-Command cargo.exe -ErrorAction Stop).Source
    $rustc = (Get-Command rustc.exe -ErrorAction Stop).Source
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source

    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (!(Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio C++ Build Tools and the Windows SDK are required.' }
    $vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (!$vsRoot) { throw 'The Visual Studio C++ x64 toolchain was not found.' }
    $devShell = Join-Path $vsRoot 'Common7\Tools\Launch-VsDevShell.ps1'
    if (!(Test-Path -LiteralPath $devShell)) { throw 'Visual Studio Developer PowerShell was not found.' }
    & $devShell -SkipAutomaticLocation -Arch amd64 -HostArch amd64 | Out-Host
    $cmakeBin = Join-Path $vsRoot 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin'
    if (Test-Path -LiteralPath $cmakeBin) { $env:Path = $cmakeBin + ';' + $env:Path }
    foreach ($tool in @('cl.exe', 'cmake.exe')) { Get-Command $tool -ErrorAction Stop | Out-Null }

    # Keep large downloads/build caches beside the checkout, off the system drive.
    # Respect an explicitly configured cache, but never change user/global settings.
    if (!$env:CARGO_HOME) { $env:CARGO_HOME = Join-Path $cacheRoot 'cargo' }
    if (!$env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $cacheRoot 'target' }
    $env:CARGO_HOME = [IO.Path]::GetFullPath($env:CARGO_HOME)
    $env:CARGO_TARGET_DIR = [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
    $env:CARGO_TERM_COLOR = 'never'
    $env:NO_COLOR = '1'
    $env:TEMP = Join-Path $cacheRoot 'tmp'
    $env:TMP = $env:TEMP
    [IO.Directory]::CreateDirectory($env:TEMP) | Out-Null

    Invoke-BuildStep 'Node.js' $node @('--version')
    Invoke-BuildStep 'Rust compiler' $rustc @('--version')
    Invoke-BuildStep 'Cargo' $cargo @('--version')
    if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\@tauri-apps\cli\tauri.js'))) {
        Invoke-BuildStep 'Install locked npm dependencies' $npm @('ci')
    }

    # Use a temporary merge config instead of modifying the checked-in signing,
    # security, application identity, version, or feature configuration.
    $localConfig = Join-Path $outputDirectory 'tauri-local.config.json'
    [IO.File]::WriteAllText($localConfig, '{"bundle":{"createUpdaterArtifacts":false}}', $utf8)
    $target = 'x86_64-pc-windows-msvc'
    $releaseRoot = Join-Path $env:CARGO_TARGET_DIR "$target\release"
    $intermediateRoot = $env:CARGO_TARGET_DIR
    if ($env:CARGO_BUILD_BUILD_DIR) { $intermediateRoot = [IO.Path]::GetFullPath($env:CARGO_BUILD_BUILD_DIR) }
    $env:CARGO_BUILD_BUILD_DIR = $intermediateRoot
    $buildReleaseRoot = Join-Path $intermediateRoot "$target\release"
    # ort-sys rc.12 assumes the pre-Cargo-1.100 OUT_DIR depth. New Cargo places
    # its DLLs in release/build instead. Supply both layouts' copy destinations
    # without modifying the dependency or removing the local ONNX feature.
    foreach ($directory in @($buildReleaseRoot, (Join-Path $buildReleaseRoot 'build'))) {
        foreach ($child in @('examples', 'deps')) { [IO.Directory]::CreateDirectory((Join-Path $directory $child)) | Out-Null }
    }
    $started = [DateTime]::UtcNow
    $cli = Join-Path $projectRoot 'node_modules\@tauri-apps\cli\tauri.js'
    Invoke-BuildStep 'Build frontend, MCP adapter and Rust application' $node @(
        $cli, 'build', '--target', $target, '--no-bundle', '--ci', '--no-sign', '--config', $localConfig, '--', '--locked'
    )

    # DirectML is a runtime dependency of the default Windows ONNX build. Map it
    # explicitly beside the installed EXE so both Cargo layouts bundle it.
    $directML = $null
    foreach ($candidate in @((Join-Path $buildReleaseRoot 'build\DirectML.dll'), (Join-Path $buildReleaseRoot 'DirectML.dll'))) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $directML = $candidate; break }
    }
    if (!$directML) { throw 'The default ONNX build did not produce DirectML.dll. Refusing to create an incomplete installer.' }
    $runtimeDll = Join-Path $releaseRoot 'DirectML.dll'
    if ([IO.Path]::GetFullPath($directML) -ne [IO.Path]::GetFullPath($runtimeDll)) { Copy-Item -LiteralPath $directML -Destination $runtimeDll -Force }
    $runtimeHash = (Get-FileHash -LiteralPath $runtimeDll -Algorithm SHA256).Hash.ToLowerInvariant()
    $resources = [ordered]@{}
    foreach ($resource in $tauri.bundle.resources.PSObject.Properties) { $resources[$resource.Name] = $resource.Value }
    $resources[$runtimeDll] = 'DirectML.dll'
    $bundleConfig = @{ bundle = @{ createUpdaterArtifacts = $false; resources = $resources } }
    [IO.File]::WriteAllText($localConfig, ($bundleConfig | ConvertTo-Json -Depth 5), $utf8)
    Write-BuildMessage ('DirectML runtime SHA-256: ' + $runtimeHash)
    Invoke-BuildStep 'Bundle the Windows NSIS installer with its runtime DLL' $node @(
        $cli, 'bundle', '--target', $target, '--bundles', 'nsis', '--ci', '--no-sign', '--config', $localConfig
    )

    $installerRoot = Join-Path $env:CARGO_TARGET_DIR "$target\release\bundle\nsis"
    $installers = @(Get-ChildItem -LiteralPath $installerRoot -Filter '*-setup.exe' -File | Where-Object { $_.LastWriteTimeUtc -ge $started.AddSeconds(-2) })
    if (!$installers.Count) { throw 'Build returned success but no installer from this run was found.' }
    $artifacts = @()
    foreach ($installer in $installers) {
        $destination = Join-Path $outputDirectory $installer.Name
        Copy-Item -LiteralPath $installer.FullName -Destination $destination
        $artifacts += @{ file = $installer.Name; bytes = $installer.Length; sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $sourceHead = $null
    $sourceDirty = $null
    if (Get-Command git.exe -ErrorAction SilentlyContinue) {
        $sourceHead = (& git.exe rev-parse HEAD 2>$null | Out-String).Trim()
        $sourceDirty = [bool](& git.exe status --porcelain --untracked-files=normal 2>$null)
    }
    $metadata = @{ version = $package.version; kind = 'local-unsigned'; target = $target; builtAtUtc = [DateTime]::UtcNow.ToString('o'); sourceHead = $sourceHead; workingTreeDirty = $sourceDirty; runtime = @{ file = 'DirectML.dll'; sha256 = $runtimeHash }; artifacts = $artifacts }
    [IO.File]::WriteAllText((Join-Path $outputDirectory 'build-info.json'), ($metadata | ConvertTo-Json -Depth 5), $utf8)
    Write-BuildMessage "`nBUILD SUCCEEDED. Installers and SHA-256 are in:"
    Write-BuildMessage $outputDirectory
    Write-BuildMessage 'Install manually when ready. This local package is not an official update release.'
    $exitCode = 0
    if (!$NoOpen) { Start-Process explorer.exe -ArgumentList @('"' + $outputDirectory + '"') | Out-Null }
} catch {
    Write-BuildMessage ('BUILD FAILED: ' + $_.Exception.Message)
    Write-BuildMessage 'Resolve the reported error, then run the launcher again. Existing caches will be reused.'
} finally {
    if ($writer) { $writer.Dispose() }
    if ($buildLock) { $buildLock.Dispose() }
    Set-Location -LiteralPath $originalLocation.Path
}
exit $exitCode
