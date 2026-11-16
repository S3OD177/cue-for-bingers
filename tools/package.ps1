# Builds cue-for-bingers.zip (the Chrome Web Store upload) from extension/.
#   powershell -ExecutionPolicy Bypass -File tools\package.ps1
# Compress-Archive in Windows PowerShell 5.1 writes paths like "_locales\ar\messages.json" with
# backslashes, which the Web Store can reject; this writes standard forward-slash paths.
# Skips dotfiles, and refuses a manifest that still has a "key" (only for local testing).

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$repo = Split-Path -Parent $PSScriptRoot
$root = Join-Path $repo 'extension'
$out = Join-Path $repo 'cue-for-bingers.zip'

$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.PSObject.Properties.Name -contains 'key') {
  throw 'manifest.json still has a "key" (for local testing). Remove it before packaging.'
}

if (Test-Path $out) { Remove-Item $out }
$zip = [IO.Compression.ZipFile]::Open($out, 'Create')
$count = 0
try {
  Get-ChildItem $root -Recurse -File | Sort-Object FullName | ForEach-Object {
    $name = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
    if ($name -match '(^|/)\.') { return } # .DS_Store, .gitkeep, …
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $name, 'Optimal')
    $count++
  }
} finally {
  $zip.Dispose()
}

'{0}: version {1}, {2} files, {3} KB' -f (Split-Path -Leaf $out), $manifest.version, $count, [math]::Round((Get-Item $out).Length / 1KB)
