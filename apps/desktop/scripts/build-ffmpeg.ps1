# Builds the minimal ffmpeg sidecar with scripts/build-ffmpeg.sh and installs it as
# src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe. Run it before building an installer.
#
# Needs MSYS2. Uses $env:MSYS2_ROOT or C:\msys64 when present, otherwise unpacks a private copy
# into the work dir (no admin rights, nothing installed system-wide). The work dir defaults to
# %LOCALAPPDATA%\cos-nostra-ffmpeg-build, overridable with $env:COS_NOSTRA_FFMPEG_BUILD, and
# must not contain spaces. A first build takes 15-30 minutes; a rerun with nothing changed only
# copies the finished exe.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$work = if ($env:COS_NOSTRA_FFMPEG_BUILD) { $env:COS_NOSTRA_FFMPEG_BUILD } else { Join-Path $env:LOCALAPPDATA 'cos-nostra-ffmpeg-build' }
if ($work.Contains(' ')) { throw "build-ffmpeg: the work dir must not contain spaces ($work); set COS_NOSTRA_FFMPEG_BUILD" }
New-Item -ItemType Directory -Force $work | Out-Null

$msys = @($env:MSYS2_ROOT, 'C:\msys64', (Join-Path $work 'msys64')) |
    Where-Object { $_ -and (Test-Path (Join-Path $_ 'usr\bin\bash.exe')) } |
    Select-Object -First 1
if (-not $msys) {
    $msys = Join-Path $work 'msys64'
    $sfx = Join-Path $work 'msys2-base.sfx.exe'
    Write-Host "build-ffmpeg: unpacking MSYS2 into $msys"
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri 'https://github.com/msys2/msys2-installer/releases/download/nightly-x86_64/msys2-base-x86_64-latest.sfx.exe' -OutFile $sfx -UseBasicParsing
    & $sfx -y "-o$work" | Out-Null
    Remove-Item $sfx
}

$bash = Join-Path $msys 'usr\bin\bash.exe'
$env:MSYSTEM = 'UCRT64'
$env:CHERE_INVOKING = '1'
function Invoke-Msys([string]$command) {
    & $bash -lc $command
    if ($LASTEXITCODE -ne 0) { throw "build-ffmpeg: '$command' exited with $LASTEXITCODE" }
}

Invoke-Msys 'pacman -S --needed --noconfirm make diffutils bzip2 xz curl mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-binutils mingw-w64-ucrt-x86_64-cmake mingw-w64-ucrt-x86_64-ninja mingw-w64-ucrt-x86_64-meson mingw-w64-ucrt-x86_64-nasm mingw-w64-ucrt-x86_64-pkgconf'

# The script and its paths go to bash as separate arguments, not inside a -c string: Windows
# PowerShell drops the inner double quotes such a string would need around the repo's spaces.
$script = (Join-Path $PSScriptRoot 'build-ffmpeg.sh') -replace '\\', '/'
$out = Join-Path $root 'src-tauri\binaries\ffmpeg-x86_64-pc-windows-msvc.exe'
& $bash -l $script $work $out
if ($LASTEXITCODE -ne 0) { throw "build-ffmpeg: build-ffmpeg.sh exited with $LASTEXITCODE" }

# ffprobe is no longer a sidecar; a copy left from an older ensure-ffmpeg only wastes space.
Remove-Item -ErrorAction SilentlyContinue (Join-Path $root 'src-tauri\binaries\ffprobe-x86_64-pc-windows-msvc.exe')
