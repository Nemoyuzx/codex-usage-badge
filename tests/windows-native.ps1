# Native Windows smoke test with disposable data and a synthetic CLI; no real account/client.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows runner required' }
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).windowsVersion
$package = Join-Path $root ('dist/CodexUsageBadge-Windows-' + $version)
. (Join-Path $package 'manage-windows.ps1') -Action Functions
$temp = Join-Path ([IO.Path]::GetTempPath()) ('badge-native-中文 空格-' + [guid]::NewGuid().ToString('N'))
$originalLocal = $env:LOCALAPPDATA
$originalCodeHome = $env:CODEX_HOME
$originalEnv = @{}
foreach ($key in @('CODEX_BADGE_APP','CODEX_BADGE_BIN','CODEX_BADGE_PORT','CODEX_BADGE_STOP_FILE')) { $originalEnv[$key] = [Environment]::GetEnvironmentVariable($key) }
function Assert($Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Isolate-Package([string]$Directory) {
    # A developer may have a real client listening on 39222. Fixture agents and
    # uninstall cleanup must never connect to it, including in child supervisors.
    foreach($file in @(Get-ChildItem -LiteralPath $Directory -Recurse -File | Where-Object { $_.Extension -in @('.cjs','.ps1','.cs') })) {
        $text=[IO.File]::ReadAllText($file.FullName).Replace('39222','49323')
        $encoding=New-Object Text.UTF8Encoding($file.Extension -eq '.ps1')
        [IO.File]::WriteAllText($file.FullName,$text,$encoding)
    }
}
try {
    [void][IO.Directory]::CreateDirectory($temp)
    $env:LOCALAPPDATA = $temp
    $env:CODEX_HOME = Join-Path $temp 'synthetic-home'
    [void][IO.Directory]::CreateDirectory($env:CODEX_HOME)
    $gui = Join-Path $temp 'Fixture/Codex.exe'
    [void][IO.Directory]::CreateDirectory((Join-Path (Split-Path $gui) 'resources'))
    Write-Utf8 (Join-Path (Split-Path $gui) 'resources/app.asar') 'synthetic fixture'
    $cli = Join-Path $temp 'codex.exe'
    Add-Type -TypeDefinition 'public class BadgeFixture { public static void Main(string[] args) { System.Console.WriteLine("codex-cli fixture"); } }' -OutputAssembly $cli -OutputType ConsoleApplication
    Copy-Item -LiteralPath $cli -Destination $gui
    $runtime = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $fixturePackage=Join-Path $temp 'isolated-package'
    Copy-Item -LiteralPath $package -Destination $fixturePackage -Recurse
    Isolate-Package $fixturePackage
    . (Join-Path $fixturePackage 'manage-windows.ps1') -Action Functions
    Initialize-Context
    # Use real .lnk APIs but keep the links away from the runner's startup/desktop folders.
    $script:DesktopLink = Join-Path $temp 'Test Desktop.lnk'
    $script:StartupLink = Join-Path $temp 'Test Startup.lnk'
    $DisableAutoUpdate = $true
    Write-Shortcut $script:DesktopLink 'Launch' $gui
    Install-Badge ([pscustomobject]@{AppExe=$gui;NodeExe=$runtime;CodexBin=$cli;CodexHome=$env:CODEX_HOME})
    Assert (Test-Worker) 'Native hidden supervisor did not start'
    Assert (!(Test-Path -LiteralPath $script:DesktopLink)) 'Legacy desktop shortcut not removed'
    Assert (Test-OwnedShortcut $script:StartupLink 'Run') 'Startup shortcut target mismatch'
    $state = Read-Json $script:StatePath
    $agentPid = $state.AgentPid
    $startupPid = $state.StartupPid
    $nativePid = (Read-Json (Join-Path $script:InstallRoot 'startup/state.json')).nativePid
    Assert ((Get-Process -Id $agentPid).ProcessName -eq 'node') 'Expected native Node agent'
    Assert ((Get-Process -Id $startupPid).ProcessName -eq 'node') 'Expected native startup observer'
    Assert ((Get-Process -Id $nativePid).ProcessName -eq 'powershell') 'Expected persistent native adapter'
    $duplicate = Start-Process -FilePath $script:PowerShell -ArgumentList (Get-ManagerArguments 'Run') -WindowStyle Hidden -PassThru
    Assert ($duplicate.WaitForExit(15000)) 'Duplicate worker was not rejected'
    $duplicate.Dispose()
    Assert ((Read-Json $script:StatePath).AgentPid -eq $agentPid) 'Duplicate start replaced running worker'
    # Simulate a Store update removing the old executable while the supervisor is alive.
    $updatedGui=Join-Path $temp 'Updated/Codex.exe'
    [void][IO.Directory]::CreateDirectory((Join-Path (Split-Path $updatedGui) 'resources'))
    Copy-Item -LiteralPath $cli -Destination $updatedGui
    Write-Utf8 (Join-Path (Split-Path $updatedGui) 'resources/app.asar') 'updated fixture'
    $updated=Read-Json $script:ConfigPath
    $updated.AppExe=$updatedGui;$updated.Overrides.AppExe=$updatedGui
    Write-Json $script:ConfigPath $updated
    Remove-Item -LiteralPath $gui
    $deadline=[DateTime]::UtcNow.AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 200
        $newState=Read-Json $script:StatePath
    } while (($newState.State -ne 'running' -or $newState.AgentPid -eq $agentPid) -and [DateTime]::UtcNow -lt $deadline)
    Assert ($newState.State -eq 'running' -and $newState.AgentPid -ne $agentPid -and $newState.Pid -eq $state.Pid) 'client update must refresh observers without replacing supervisor'
    Assert ((Read-Json $script:ConfigPath).AppExe -eq $updatedGui) 'updated app path not retained'
    Assert (!(Get-Process -Id $nativePid -ErrorAction SilentlyContinue)) 'old native adapter must stop after path refresh'
    $agentPid=$newState.AgentPid;$startupPid=$newState.StartupPid
    $nativePid=(Read-Json (Join-Path $script:InstallRoot 'startup/state.json')).nativePid
    Stop-Worker
    Assert (!(Test-Worker)) 'Native stop-file shutdown failed'
    Assert (!(Get-Process -Id $agentPid -ErrorAction SilentlyContinue)) 'Agent process still running after stop'
    Assert (!(Get-Process -Id $startupPid -ErrorAction SilentlyContinue)) 'Startup observer still running after stop'
    Assert (!(Get-Process -Id $nativePid -ErrorAction SilentlyContinue)) 'Native adapter still running after stop'
    # Install a checksum-validated release over a running fixture, preserving settings.
    $releaseVersion=$version
    . (Join-Path $root 'windows/update-windows.ps1') -Functions
    $updateArchive=Join-Path $root ('dist/CodexUsageBadge-Windows-'+$releaseVersion+'.zip')
    $validated=Join-Path $temp 'validated-update'
    [void](Expand-ValidatedUpdate $updateArchive $validated $releaseVersion (Get-FileHash -LiteralPath $updateArchive -Algorithm SHA256).Hash.ToLowerInvariant())
    Isolate-Package $validated
    . (Join-Path $validated 'manage-windows.ps1') -Action Functions
    Initialize-Context
    $script:DesktopLink=Join-Path $temp 'Test Desktop.lnk';$script:StartupLink=Join-Path $temp 'Test Startup.lnk'
    Start-Worker
    Install-Badge $null
    Assert (Test-Worker) 'Validated update failed to restart background worker'
    Assert (!(Get-AutoUpdateEnabled)) 'Validated update failed to retain update preference'
    Assert ((Read-Json $script:ConfigPath).Overrides.AppExe -eq $updatedGui) 'Validated update lost explicit application path'
    Start-Worker
    Assert (Test-Worker) 'Native worker restart failed'
    Uninstall-Badge
    Assert (!(Test-Worker)) 'Supervisor still running after uninstall'
    Assert (!(Test-Path -LiteralPath $script:InstallRoot)) 'Install directory not archived'
    Assert (!(Test-Path -LiteralPath $script:StartupLink)) 'Startup shortcut not removed'
    Write-Host 'PASS Windows PowerShell 5.1 native install, real COM shortcuts, hidden process startup, singleton mutex, graceful stop, restart, uninstall'
} finally {
    try { Stop-Worker } catch {}
    $env:LOCALAPPDATA = $originalLocal
    $env:CODEX_HOME = $originalCodeHome
    foreach ($key in $originalEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $originalEnv[$key]) }
    $resolved=[IO.Path]::GetFullPath($temp)
    Assert ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved) -like 'badge-native-*') 'cleanup must stay inside fixture root'
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
