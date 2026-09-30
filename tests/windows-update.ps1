$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$releaseVersion=(Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).windowsVersion
. (Join-Path $root 'windows/update-windows.ps1') -Functions
$archive=Join-Path $root ('dist/CodexUsageBadge-Windows-'+$releaseVersion+'.zip')
function Assert($Condition,[string]$Message) { if(!$Condition) { throw $Message } }
function Reject([string]$File,[string]$Pattern) {
    $failure=$null
    try { [void](Expand-ValidatedUpdate $File (Join-Path $temp ([guid]::NewGuid().ToString('N'))) $releaseVersion (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()) }
    catch { $failure=$_.Exception.Message }
    Assert ($failure -and $failure -match $Pattern) ('Expected '+$Pattern+', got '+$failure)
}
function Variant([string]$Kind) {
    $file=Join-Path $temp ($Kind+'.zip')
    $sourceZip=[IO.Compression.ZipFile]::OpenRead($archive)
    $output=[IO.Compression.ZipFile]::Open($file,[IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach($entry in $sourceZip.Entries) {
            if($Kind -eq 'missing' -and $entry.FullName.EndsWith('/update.cjs')) { continue }
            $stream=$entry.Open();$memory=New-Object IO.MemoryStream
            try { $stream.CopyTo($memory);$data=$memory.ToArray() } finally { $stream.Dispose();$memory.Dispose() }
            if($Kind -eq 'tampered' -and $entry.FullName.EndsWith('/update.cjs')) { $data[0]=$data[0] -bxor 1 }
            $copy=$output.CreateEntry($entry.FullName);$target=$copy.Open()
            try { $target.Write($data,0,$data.Length) } finally { $target.Dispose() }
        }
        if($Kind -eq 'traversal') { [void]$output.CreateEntry(('CodexUsageBadge-Windows-'+$releaseVersion+'/../escape.ps1')) }
        if($Kind -eq 'duplicate') { [void]$output.CreateEntry(('CodexUsageBadge-Windows-'+$releaseVersion+'/update.cjs')) }
    } finally { $sourceZip.Dispose();$output.Dispose() }
    return $file
}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('badge-update-test-'+[guid]::NewGuid().ToString('N'))
try {
    [void][IO.Directory]::CreateDirectory($temp)
    $target=Join-Path $temp 'valid'
    $digest=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    [void](Expand-ValidatedUpdate $archive $target $releaseVersion $digest)
    Assert (Test-Path -LiteralPath (Join-Path $target 'update.cjs')) 'Valid update package failed extraction'
    foreach($name in @('manage-windows.ps1','update-windows.ps1')) {
        $tokens=$null;$errors=$null
        [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $target $name),[ref]$tokens,[ref]$errors)
        Assert (!$errors.Count) ('Invalid PowerShell '+$name)
    }
    Reject (Variant 'tampered') 'checksum mismatch'
    Reject (Variant 'missing') 'Incomplete'
    Reject (Variant 'traversal') 'Unexpected'
    Reject (Variant 'duplicate') 'duplicate'
    Assert (!(Test-Path -LiteralPath (Join-Path $temp 'escape.ps1'))) 'Archive escaped extraction directory'
    $failed=$false
    try { [void](Expand-ValidatedUpdate $archive (Join-Path $temp 'wrong') $releaseVersion ('0'*64)) } catch { $failed=$true }
    Assert $failed 'Outer archive hash must be verified again before extraction'
    Write-Host 'PASS Windows update package extraction, inner/outer SHA-256, missing files, duplicate entries, traversal refusal, PowerShell parsing'
} finally {
    $resolved=[IO.Path]::GetFullPath($temp)
    Assert ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved) -like 'badge-update-test-*') 'Invalid fixture cleanup root'
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
