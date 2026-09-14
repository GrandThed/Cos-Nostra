# Makes sure the ffmpeg Tauri sidecar exists under src-tauri/binaries/.
# tauri-build (dev and release) refuses to build when a bundle.externalBin entry is missing.
#
# What should be there is the minimal build from `npm run build-ffmpeg` (scripts/build-ffmpeg.ps1),
# which is what CI puts in every release. When it is missing this falls back so `tauri dev` still
# starts, in order of preference:
#   1. ffmpeg.exe already on PATH (same build the developer uses by hand)
#   2. the winget Gyan.FFmpeg package directory, if PATH has not been refreshed yet
#   3. the BtbN GPL build (libsvtav1, amf, nvenc, qsv; GPL-3.0 compatible)
# Every fallback is a "full" build of ~150-200 MB, fine for development but not for an installer.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'src-tauri\binaries'
$triple = 'x86_64-pc-windows-msvc'
$ffmpegDst = Join-Path $dir "ffmpeg-$triple.exe"

# ffprobe used to be a sidecar too; nothing reads it any more.
Remove-Item -ErrorAction SilentlyContinue (Join-Path $dir "ffprobe-$triple.exe")

if (Test-Path $ffmpegDst) {
    # The minimal build is the one configured with --disable-everything.
    $version = (& $ffmpegDst -hide_banner -version 2>$null) -join "`n"
    if ($version -notmatch '--disable-everything') {
        Write-Warning "ensure-ffmpeg: $ffmpegDst is a full ffmpeg build ($([math]::Round((Get-Item $ffmpegDst).Length / 1MB)) MB). An installer built now ships all of it; run 'npm run build-ffmpeg -w apps/desktop' first."
    }
    exit 0
}

New-Item -ItemType Directory -Force $dir | Out-Null

function Find-Local {
    $ffmpeg = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
    if ($ffmpeg) {
        return @{ Source = "PATH ($($ffmpeg.Source))"; Ffmpeg = $ffmpeg.Source }
    }
    $winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (Test-Path $winget) {
        $bins = Get-ChildItem -Path $winget -Directory -Filter 'Gyan.FFmpeg*' -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ChildItem -Path $_.FullName -Directory -Filter 'ffmpeg-*' -ErrorAction SilentlyContinue } |
            ForEach-Object { Join-Path $_.FullName 'bin' } |
            Where-Object { Test-Path (Join-Path $_ 'ffmpeg.exe') } |
            Sort-Object -Descending | Select-Object -First 1
        if ($bins) {
            return @{ Source = "winget ($bins)"; Ffmpeg = (Join-Path $bins 'ffmpeg.exe') }
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
    $found = @{ Source = "download ($url)"; Ffmpeg = (Join-Path $bin 'ffmpeg.exe') }
}

Copy-Item -Path $found.Ffmpeg -Destination $ffmpegDst -Force
if ($tmp -and (Test-Path $tmp)) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
Write-Host "ensure-ffmpeg: copied the sidecar from $($found.Source) to $dir"
Write-Warning "ensure-ffmpeg: that is a full ffmpeg build, fine for tauri dev; run 'npm run build-ffmpeg -w apps/desktop' before building an installer."
