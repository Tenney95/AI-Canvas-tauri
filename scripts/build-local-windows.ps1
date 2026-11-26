[CmdletBinding()]
param(
    [string]$OutputRoot,
    [switch]$NoOpen,
    [switch]$KeepBuildCache
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = $utf8
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspaceRoot = Split-Path $projectRoot -Parent
if (!$OutputRoot) { $OutputRoot = Join-Path $workspaceRoot 'packages' }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$originalLocation = Get-Location
$writer = $null
$buildLock = $null
$resourceDirectory = $null
$stagedRuntimeDll = $null
$exitCode = 1
$cleanup = [ordered]@{}
$protectedPaths = @()
$cacheRoot = Join-Path $workspaceRoot '.build-cache'
$oldEnvironment = [Environment]::GetEnvironmentVariables('Process')
$oldEncoding = [Console]::OutputEncoding

function Write-BuildMessage([string]$Message) {
    Write-Host $Message
    if ($script:writer) { $script:writer.WriteLine($Message); $script:writer.Flush() }
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $hash = [Security.Cryptography.SHA256]::Create()
        try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
        finally { $hash.Dispose() }
    } finally { $stream.Dispose() }
}

function Test-InDirectory([string]$Path, [string]$Root) {
    $prefix = $Root.TrimEnd('\') + '\'
    return ($Path.TrimEnd('\') + '\').StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-OrdinaryBuildPath([string]$Path) {
    for ($current = $Path; $current; $current = [IO.Path]::GetDirectoryName($current)) {
        try { $attributes = [IO.File]::GetAttributes($current) }
        catch [IO.FileNotFoundException] { continue }
        catch [IO.DirectoryNotFoundException] { continue }
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Build path redirects through $current" }
    }
}

function Add-CleanupPath([string]$Root, [string]$Relative, [switch]$EmptyOnly) {
    $path = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
    if ($path -eq $Root -or !(Test-InDirectory $path $Root)) { throw "Invalid cleanup path: $path" }
    foreach ($protected in $script:protectedPaths) {
        if ((Test-InDirectory $protected $path) -or (Test-InDirectory $path $protected)) { return }
    }
    Assert-OrdinaryBuildPath $path
    $script:cleanup[$path] = $EmptyOnly.IsPresent
}

function Remove-BuildPath([string]$Path, [bool]$EmptyOnly) {
    if (!$script:cleanup.Contains($Path)) { throw "Unregistered cleanup path: $Path" }
    Assert-OrdinaryBuildPath $Path
    if (![IO.Directory]::Exists($Path)) {
        if ([IO.File]::Exists($Path)) { [IO.File]::Delete($Path) }
        return
    }
    if ($EmptyOnly) {
        if (!([IO.Directory]::EnumerateFileSystemEntries($Path) | Select-Object -First 1)) { [IO.Directory]::Delete($Path) }
        return
    }
    try { [IO.Directory]::Delete($Path, $true) }
    catch [UnauthorizedAccessException] {
        Clear-ReadOnlyBuildEntries $Path
        [IO.Directory]::Delete($Path, $true)
    }
}

function Clear-ReadOnlyBuildEntries([string]$Directory) {
    foreach ($entry in [IO.DirectoryInfo]::new($Directory).EnumerateFileSystemInfos()) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        if ($entry.Attributes -band [IO.FileAttributes]::ReadOnly) {
            $entry.Attributes = $entry.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
        }
        if ($entry -is [IO.DirectoryInfo]) { Clear-ReadOnlyBuildEntries $entry.FullName }
    }
}

function Invoke-BuildStep([string]$Label, [string]$Executable, [string[]]$Arguments, [switch]$CompactFrontendOutput) {
    Write-BuildMessage "`n=== $Label ==="
    # Windows PowerShell treats native stderr as ErrorRecord. Preserve the real
    # exit code while logging both streams as UTF-8, without stopping on warnings.
    $previousPreference = $ErrorActionPreference
    $dynamicImportWarnings = 0
    try {
        $ErrorActionPreference = 'Continue'
        & $Executable @Arguments 2>&1 | ForEach-Object {
            $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ }
            $line = $line -replace '\x1b\[[0-?]*[ -/]*[@-~]', ''
            if ($CompactFrontendOutput -and $line -match '^\[INEFFECTIVE_DYNAMIC_IMPORT\]') {
                $dynamicImportWarnings++
                $script:writer.WriteLine($line)
            } elseif ($CompactFrontendOutput -and (
                $line -match '^dist/.+\s+\d[\d,.]*\s+kB(?:\s|$)' -or
                ($dynamicImportWarnings -gt 0 -and [string]::IsNullOrWhiteSpace($line))
            )) {
                $script:writer.WriteLine($line)
            } else { Write-BuildMessage $line }
        }
        $stepExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($dynamicImportWarnings) {
        Write-BuildMessage "$dynamicImportWarnings ineffective dynamic imports reported by Vite. See build.log for the module list."
    }
    if ($stepExit -ne 0) { throw "$Label failed (exit $stepExit). See build.log." }
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This script requires Windows x64.' }
    if (![Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
    [Console]::OutputEncoding = $utf8
    Set-Location -LiteralPath $projectRoot
    $package = [IO.File]::ReadAllText((Join-Path $projectRoot 'package.json'), $utf8) | ConvertFrom-Json
    $tauri = [IO.File]::ReadAllText((Join-Path $projectRoot 'src-tauri\tauri.conf.json'), $utf8) | ConvertFrom-Json
    $cargoToml = [IO.File]::ReadAllText((Join-Path $projectRoot 'src-tauri\Cargo.toml'), $utf8)
    $cargoVersion = [regex]::Match($cargoToml, '(?ms)^\[package\]\s*.*?^version\s*=\s*"([^"]+)"').Groups[1].Value
    if ($package.version -ne $tauri.version -or $package.version -ne $cargoVersion) { throw 'package.json, tauri.conf.json and Cargo.toml versions must match.' }
    if ($package.version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw 'Invalid application version.' }

    Assert-OrdinaryBuildPath (Join-Path $cacheRoot 'windows-build.lock')
    [IO.Directory]::CreateDirectory($cacheRoot) | Out-Null
    try { $buildLock = [IO.File]::Open((Join-Path $cacheRoot 'windows-build.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { throw 'Another local build is using this workspace. Wait for it to finish.' }

    $node = (Get-Command node.exe -ErrorAction Stop).Source
    # Keep relative Cargo paths based on the .NET process directory, as in earlier builds.
    $explicit = [ordered]@{}
    foreach ($name in @('CARGO_HOME', 'CARGO_TARGET_DIR', 'CARGO_BUILD_BUILD_DIR')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        $explicit[$name] = if ($value) { [IO.Path]::GetFullPath($value) } else { $null }
    }
    $resolvePaths = @'
const fs = require('node:fs'), path = require('node:path');
function physical(p) {
  try { return fs.realpathSync.native(p); } catch (e) {
    if (e.code !== 'ENOENT' || path.dirname(p) === p) throw e;
    return path.join(physical(path.dirname(p)), path.basename(p));
  }
}
console.log(JSON.stringify(process.argv.slice(2).map(p => physical(path.resolve(p)))));
'@
    $explicitPaths = @($explicit.Values | Where-Object { $_ })
    $locations = @($OutputRoot, $cacheRoot, (Join-Path $projectRoot 'dist'), (Join-Path $projectRoot 'node_modules')) + $explicitPaths
    $resolved = $resolvePaths | & $node - @locations
    if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the delivery and cache paths.' }
    $resolved = ConvertFrom-Json -InputObject $resolved
    foreach ($root in $resolved[1..3]) {
        if (Test-InDirectory $resolved[0] $root) { throw "Choose an output directory outside $root" }
    }
    $protectedPaths = $explicitPaths + @($resolved | Select-Object -Skip 4)
    foreach ($path in $protectedPaths) {
        if (Test-InDirectory $path (Join-Path $cacheRoot 'tmp')) { throw 'Explicit Cargo paths must be outside the packaging temp directory.' }
    }

    $buildName = 'AI-Canvas-' + $package.version + '-local-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
    $outputDirectory = Join-Path $OutputRoot $buildName
    [IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
    $writer = New-Object System.IO.StreamWriter((Join-Path $outputDirectory 'build.log'), $false, $utf8)
    Write-BuildMessage 'Building the current working tree, including saved uncommitted edits.'
    Write-BuildMessage 'Local NSIS installer; updater signing artifacts are disabled for this run only.'
    Write-BuildMessage 'The installed application and project data will not be replaced by this script.'

    # Discover tools in newly installed Rust locations without requiring a reboot.
    $rustBins = @()
    if ($explicit.CARGO_HOME) { $rustBins += Join-Path $explicit.CARGO_HOME 'bin' }
    $rustBins += Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cargo\bin'
    foreach ($directory in $rustBins) { if (Test-Path -LiteralPath $directory -PathType Container) { $env:Path = $directory + ';' + $env:Path } }
    $cargo = (Get-Command cargo.exe -ErrorAction Stop).Source
    $rustc = (Get-Command rustc.exe -ErrorAction Stop).Source
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    $git = $null
    $gitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($gitCommand) { $git = $gitCommand.Source }
    $sourceHead = $null
    $sourceDirty = $null
    if ($git) {
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $head = & $git rev-parse --verify HEAD 2>$null
            if ($LASTEXITCODE -eq 0) { $sourceHead = $head }
            $status = & $git status --porcelain --untracked-files=normal 2>$null
            if ($LASTEXITCODE -eq 0) { $sourceDirty = [bool]$status }
        } finally { $ErrorActionPreference = $previousPreference }
    }

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
    foreach ($entry in $explicit.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
    if (!$env:CARGO_HOME) {
        $env:CARGO_HOME = Join-Path $cacheRoot 'cargo'
        Assert-OrdinaryBuildPath $env:CARGO_HOME
        if (!$KeepBuildCache) {
            foreach ($name in @('registry', 'git', '.global-cache', '.package-cache', '.package-cache-mutate')) {
                Add-CleanupPath $cacheRoot "cargo\$name"
            }
            Add-CleanupPath $cacheRoot 'cargo' -EmptyOnly
        }
    }
    if (!$env:CARGO_TARGET_DIR) {
        $env:CARGO_TARGET_DIR = Join-Path $cacheRoot 'target'
        Assert-OrdinaryBuildPath $env:CARGO_TARGET_DIR
        if (!$KeepBuildCache) { Add-CleanupPath $cacheRoot 'target' }
    }
    $env:CARGO_TERM_COLOR = 'never'
    $env:NO_COLOR = '1'
    $tempRelative = 'tmp\' + [Guid]::NewGuid().ToString('N')
    Add-CleanupPath $cacheRoot $tempRelative
    if (![IO.Directory]::Exists((Join-Path $cacheRoot 'tmp'))) { Add-CleanupPath $cacheRoot 'tmp' -EmptyOnly }
    $env:TEMP = Join-Path $cacheRoot $tempRelative
    $env:TMP = $env:TEMP
    [IO.Directory]::CreateDirectory($env:TEMP) | Out-Null

    Invoke-BuildStep 'Node.js' $node @('--version')
    Invoke-BuildStep 'Rust compiler' $rustc @('--version')
    Invoke-BuildStep 'Cargo' $cargo @('--version')
    $cli = Join-Path $projectRoot 'node_modules\@tauri-apps\cli\tauri.js'
    $npmLockHash = Get-Sha256 (Join-Path $projectRoot 'package-lock.json')
    $npmLockStamp = Join-Path $projectRoot 'node_modules\.ai-canvas-package-lock.sha256'
    $npmLockMatches = (Test-Path -LiteralPath $npmLockStamp -PathType Leaf) -and
        ([IO.File]::ReadAllText($npmLockStamp, $utf8) -eq $npmLockHash)
    # The CLI can still be present after the working tree adds build dependencies.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $npm ls --depth=0 --include=dev --silent 2>&1 | Out-Null
        $npmDependenciesReady = $LASTEXITCODE -eq 0
    } finally { $ErrorActionPreference = $previousPreference }
    if (!$npmLockMatches -or !$npmDependenciesReady -or !(Test-Path -LiteralPath $cli -PathType Leaf)) {
        Invoke-BuildStep 'Install locked npm dependencies' $npm @('ci', '--include=dev')
        [IO.File]::WriteAllText($npmLockStamp, $npmLockHash, $utf8)
    }

    if (![IO.Directory]::Exists((Join-Path $projectRoot 'dist'))) { Add-CleanupPath $projectRoot 'dist' }
    $tsCache = Join-Path $projectRoot 'node_modules\.tmp'
    foreach ($file in @('tsconfig.app.tsbuildinfo', 'tsconfig.node.tsbuildinfo')) {
        if (![IO.File]::Exists((Join-Path $tsCache $file))) { Add-CleanupPath $tsCache $file }
    }
    if (![IO.Directory]::Exists($tsCache)) { Add-CleanupPath $projectRoot 'node_modules\.tmp' -EmptyOnly }

    # Use a temporary merge config instead of modifying the checked-in signing,
    # security, application identity, version, or feature configuration.
    $localConfig = Join-Path $env:TEMP 'tauri-local.config.json'
    [IO.File]::WriteAllText($localConfig, '{"bundle":{"createUpdaterArtifacts":false}}', $utf8)
    $target = 'x86_64-pc-windows-msvc'
    $releaseRoot = Join-Path $env:CARGO_TARGET_DIR "$target\release"
    $intermediateRoot = $env:CARGO_TARGET_DIR
    if ($env:CARGO_BUILD_BUILD_DIR) { $intermediateRoot = $env:CARGO_BUILD_BUILD_DIR }
    $env:CARGO_BUILD_BUILD_DIR = $intermediateRoot
    $buildReleaseRoot = Join-Path $intermediateRoot "$target\release"
    # ort-sys rc.12 assumes the pre-Cargo-1.100 OUT_DIR depth. New Cargo places
    # its DLLs in release/build instead. Supply both layouts' copy destinations
    # without modifying the dependency or removing the local ONNX feature.
    foreach ($directory in @($buildReleaseRoot, (Join-Path $buildReleaseRoot 'build'))) {
        foreach ($child in @('examples', 'deps')) { [IO.Directory]::CreateDirectory((Join-Path $directory $child)) | Out-Null }
    }
    $started = [DateTime]::UtcNow
    Invoke-BuildStep 'Build frontend, MCP adapter and Rust application' $node @(
        $cli, 'build', '--target', $target, '--no-bundle', '--ci', '--no-sign', '--config', $localConfig, '--', '--locked'
    ) -CompactFrontendOutput

    # DirectML is a runtime dependency of the default Windows ONNX build. Map it
    # explicitly beside the installed EXE so both Cargo layouts bundle it.
    $directML = $null
    foreach ($candidate in @((Join-Path $buildReleaseRoot 'build\DirectML.dll'), (Join-Path $buildReleaseRoot 'DirectML.dll'))) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $directML = $candidate; break }
    }
    if (!$directML) { throw 'The default ONNX build did not produce DirectML.dll. Refusing to create an incomplete installer.' }
    $runtimeDll = Join-Path $releaseRoot 'DirectML.dll'
    if ([IO.Path]::GetFullPath($directML) -ne [IO.Path]::GetFullPath($runtimeDll)) { Copy-Item -LiteralPath $directML -Destination $runtimeDll -Force }
    $runtimeHash = Get-Sha256 $runtimeDll
    # Tauri resolves resource paths from src-tauri and strips drive prefixes.
    # Stage on the source drive so an external CARGO_TARGET_DIR works too.
    $relativeResourceDirectory = 'target/local-nsis-' + [Guid]::NewGuid().ToString('N')
    $resourceDirectory = Join-Path (Join-Path $projectRoot 'src-tauri') $relativeResourceDirectory
    $stageParent = Split-Path $resourceDirectory -Parent
    Assert-OrdinaryBuildPath $resourceDirectory
    if (![IO.Directory]::Exists($stageParent)) { Add-CleanupPath $projectRoot 'src-tauri\target' -EmptyOnly }
    [IO.Directory]::CreateDirectory($resourceDirectory) | Out-Null
    $stagedRuntimeDll = Join-Path $resourceDirectory 'DirectML.dll'
    Copy-Item -LiteralPath $runtimeDll -Destination $stagedRuntimeDll
    $resources = [ordered]@{}
    foreach ($resource in $tauri.bundle.resources.PSObject.Properties) { $resources[$resource.Name] = $resource.Value }
    $resources["$relativeResourceDirectory/DirectML.dll"] = 'DirectML.dll'
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
        $artifacts += @{ file = $installer.Name; bytes = $installer.Length; sha256 = Get-Sha256 $destination }
    }
    if ($null -eq $sourceHead -or $null -eq $sourceDirty) {
        Write-BuildMessage 'Warning: Git source metadata is unavailable.'
    }
    $metadata = @{ version = $package.version; kind = 'local-unsigned'; target = $target; builtAtUtc = [DateTime]::UtcNow.ToString('o'); sourceHead = $sourceHead; workingTreeDirty = $sourceDirty; runtime = @{ file = 'DirectML.dll'; sha256 = $runtimeHash }; artifacts = $artifacts }
    [IO.File]::WriteAllText((Join-Path $outputDirectory 'build-info.json'), ($metadata | ConvertTo-Json -Depth 5), $utf8)
    $exitCode = 0
} catch {
    Write-BuildMessage ('BUILD FAILED: ' + $_.Exception.Message)
} finally {
    try {
        if ($buildLock) {
            try {
                if ($resourceDirectory) { Assert-OrdinaryBuildPath $resourceDirectory }
                if ($stagedRuntimeDll) { [IO.File]::Delete($stagedRuntimeDll) }
                if ($resourceDirectory -and [IO.Directory]::Exists($resourceDirectory)) { [IO.Directory]::Delete($resourceDirectory) }
            } catch {
                Write-BuildMessage ('Cleanup failed: ' + $_.Exception.Message)
                if ($exitCode -eq 0) { $exitCode = 2 }
            }
            foreach ($entry in $cleanup.GetEnumerator()) {
                for ($attempt = 1; $attempt -le 3; $attempt++) {
                    try { Remove-BuildPath $entry.Key $entry.Value; break }
                    catch {
                        if ($attempt -lt 3) { Start-Sleep -Milliseconds 250; continue }
                        Write-BuildMessage ("Cleanup failed for {0}: {1}" -f $entry.Key, $_.Exception.Message)
                        if ($exitCode -eq 0) { $exitCode = 2 }
                    }
                }
            }
        }
        if ($exitCode -eq 0) { Write-BuildMessage ('BUILD SUCCEEDED. Installer, SHA-256 and log: ' + $outputDirectory) }
        elseif ($exitCode -eq 2) { Write-BuildMessage ('Installer created; cleanup incomplete. See ' + $outputDirectory) }
        elseif ($writer) { Write-BuildMessage ('Build log: ' + $outputDirectory) }
    } finally {
        try { if ($writer) { $writer.Dispose() } }
        finally {
            if ($buildLock) { $buildLock.Dispose() }
            foreach ($name in [Environment]::GetEnvironmentVariables('Process').Keys) {
                if (!$oldEnvironment.ContainsKey($name)) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
            }
            foreach ($name in $oldEnvironment.Keys) {
                if ([Environment]::GetEnvironmentVariable($name, 'Process') -cne $oldEnvironment[$name]) {
                    [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], 'Process')
                }
            }
            [Console]::OutputEncoding = $oldEncoding
            Set-Location -LiteralPath $originalLocation.Path
        }
    }
}
if ($exitCode -eq 0 -and !$NoOpen) {
    try { Start-Process explorer.exe -ArgumentList @('"' + $outputDirectory + '"') | Out-Null }
    catch { Write-Warning ('Could not open installer folder: ' + $_.Exception.Message) }
}
exit $exitCode
