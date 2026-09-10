# Makes sure the ffmpeg / ffprobe Tauri sidecars exist under src-tauri/binaries/.
# tauri-build (dev and release) refuses to build when bundle.externalBin entries are missing.
# The binaries are large and never committed; sources in order of preference:
#   1. ffmpeg.exe / ffprobe.exe already on PATH (same build the developer uses by hand)
#   2. the winget Gyan.FFmpeg package directory, if PATH has not been refreshed yet
#   3. the pinned BtbN GPL build (libsvtav1, amf, nvenc, qsv; GPL-3.0 compatible)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'src-tauri\binaries'
$triple = 'x86_64-pc-windows-msvc'
$ffmpegDst = Join-Path $dir "ffmpeg-$triple.exe"
$ffprobeDst = Join-Path $dir "ffprobe-$triple.exe"

if ((Test-Path $ffmpegDst) -and (Test-Path $ffprobeDst)) { exit 0 }

New-Item -ItemType Directory -Force $dir | Out-Null

function Find-Local {
    $ffmpeg = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
    $ffprobe = Get-Command ffprobe.exe -ErrorAction SilentlyContinue
    if ($ffmpeg -and $ffprobe) {
        return @{ Source = "PATH ($($ffmpeg.Source))"; Ffmpeg = $ffmpeg.Source; Ffprobe = $ffprobe.Source }
    }
    $winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (Test-Path $winget) {
        $bins = Get-ChildItem -Path $winget -Directory -Filter 'Gyan.FFmpeg*' -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ChildItem -Path $_.FullName -Directory -Filter 'ffmpeg-*' -ErrorAction SilentlyContinue } |
            ForEach-Object { Join-Path $_.FullName 'bin' } |
            Where-Object { (Test-Path (Join-Path $_ 'ffmpeg.exe')) -and (Test-Path (Join-Path $_ 'ffprobe.exe')) } |
            Sort-Object -Descending | Select-Object -First 1
        if ($bins) {
            return @{ Source = "winget ($bins)"; Ffmpeg = (Join-Path $bins 'ffmpeg.exe'); Ffprobe = (Join-Path $bins 'ffprobe.exe') }
        }
    }
    return $null
}

$found = Find-Local
if ($null -eq $found) {
    $url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("cos-nostra-ffmpeg-" + [System.Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $zip = Join-Path $tmp 'ffmpeg.zip'
    Write-Host "ensure-ffmpeg: no local ffmpeg found, downloading $url"
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $bin = Get-ChildItem -Path $tmp -Directory -Filter 'ffmpeg-*' | Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName 'bin' }
    if (-not $bin -or -not (Test-Path (Join-Path $bin 'ffmpeg.exe'))) { throw "ensure-ffmpeg: ffmpeg.exe not found in the downloaded archive" }
    $found = @{ Source = "download ($url)"; Ffmpeg = (Join-Path $bin 'ffmpeg.exe'); Ffprobe = (Join-Path $bin 'ffprobe.exe') }
}

Copy-Item -Path $found.Ffmpeg -Destination $ffmpegDst -Force
Copy-Item -Path $found.Ffprobe -Destination $ffprobeDst -Force
if ($tmp -and (Test-Path $tmp)) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
Write-Host "ensure-ffmpeg: copied sidecars from $($found.Source) to $dir"
