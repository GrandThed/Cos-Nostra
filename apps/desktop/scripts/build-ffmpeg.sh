#!/usr/bin/env bash
# Builds the ffmpeg.exe the desktop app ships as its sidecar: statically linked, and with only
# what src-tauri/src/ffmpeg.rs actually asks for. A stock "full" build is ~160-210 MB because it
# carries every codec library ffmpeg knows; this one is a small fraction of that.
#
# Runs inside an MSYS2 UCRT64 shell. Locally scripts/build-ffmpeg.ps1 sets that up; CI uses
# msys2/setup-msys2. Every source is pinned by version and SHA-256.
#
#   build-ffmpeg.sh <work dir> <output exe>
#
# The work dir holds downloads and build trees and must not contain spaces (ffmpeg's and
# x264's configure scripts break on them). Finished steps are skipped on a rerun; editing this
# file starts a fresh build tree, so a changed flag can never mix with an old library.
#
# What the app needs, and so all that is enabled:
#   encoders  libsvtav1, libx264, {av1,h264}_{amf,nvenc,qsv}, libopus, aac, mjpeg (thumbnails)
#   decoders  h264 and hevc (OBS recordings), libdav1d (re-cutting our own AV1), aac, opus,
#             and wrapped_avframe/pcm_s16le, which is what the lavfi sources hand over
#   formats   mov/mp4 in, mp4 and jpg out, concat (joining match parts), framecrc (keyframe
#             lookup), null (encoder probe), lavfi testsrc2/sine (encoder probe and tests)
#   filters   trim/atrim/setpts/asetpts/concat (cuts), scale (thumbnails), plus the ones ffmpeg
#             inserts on its own: format, aformat, aresample, null, anull, crop, transpose, flips
# Adding an ffmpeg feature to the app means adding it here too, or it fails at runtime with
# "Unknown encoder" / "No such filter".
set -euo pipefail

# Absolute, because the build steps change directory before the exe is copied out.
WORK=$(realpath -m "$(cygpath -u "${1:?usage: build-ffmpeg.sh <work dir> <output exe>}")")
OUT=$(realpath -m "$(cygpath -u "${2:?usage: build-ffmpeg.sh <work dir> <output exe>}")")
case "$WORK" in *" "*) echo "build-ffmpeg: work dir must not contain spaces: $WORK" >&2; exit 1 ;; esac
[ "${MSYSTEM:-}" = UCRT64 ] || { echo "build-ffmpeg: run this in an MSYS2 UCRT64 shell (MSYSTEM=${MSYSTEM:-unset})" >&2; exit 1; }

FFMPEG_VERSION=9.0.1
FFMPEG_SHA256=cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635
# av1_args() in ffmpeg.rs was measured with a v4.2.0 snapshot (4.2.0-72); a different release
# series moves the size and VMAF numbers behind the quality presets.
SVTAV1_VERSION=4.2.0
SVTAV1_SHA256=c7b13c4a84bd3751aa35fcc72be13e6875467e7c2216879251a486e5b1e4e740
# x264 has no releases; this is the head of its stable branch.
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
X264_SHA256=6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224
DAV1D_VERSION=1.5.4
DAV1D_SHA256=686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5
OPUS_VERSION=1.5.2
OPUS_SHA256=65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1
LIBVPL_VERSION=2.17.0
LIBVPL_SHA256=4de3e2faf1e8307fb282e4a43f443191810f6a6b0a484fffa7995ba1c814c6ec
# ffmpeg 9 needs AMF headers 1.5.2 or newer.
AMF_VERSION=1.5.2
AMF_SHA256=d3c12eb324edf05e214608b6a395a51dd95770ed9d45520185d6c3a206811c99
# NVENC API 12.2 rather than 13: a newer header raises the minimum NVIDIA driver (13 needs 570+,
# 12.2 works from 551.76), and av1_nvenc only needs 12.
NVCODEC_VERSION=12.2.72.0
NVCODEC_SHA256=dbeaec433d93b850714760282f1d0992b1254fc3b5a6cb7d76fc1340a1e47563

SRC=$WORK/src
RECIPE=$(sha256sum "$0" | cut -c1-12)
BUILD=$WORK/build-$RECIPE
PREFIX=$BUILD/prefix
JOBS=$(nproc)
mkdir -p "$SRC" "$PREFIX/include" "$PREFIX/lib/pkgconfig"
# Build trees from an older revision of this script are dead weight. Only names this script
# makes (build-<12 hex>), in case the work dir is shared with something else.
find "$WORK" -maxdepth 1 -type d -regex '.*/build-[0-9a-f]\{12\}' ! -name "build-$RECIPE" -exec rm -rf {} +

export PKG_CONFIG_PATH=$PREFIX/lib/pkgconfig
export CFLAGS="-O2" CXXFLAGS="-O2"

# fetch <url> <file> <sha256>: downloads into $SRC unless a file with that hash is already there.
fetch() {
    local file=$SRC/$2
    if ! { [ -f "$file" ] && echo "$3  $file" | sha256sum -c --status; }; then
        echo "build-ffmpeg: downloading $1"
        curl -fL --retry 3 -o "$file.part" "$1"
        mv "$file.part" "$file"
        echo "$3  $file" | sha256sum -c --status || { echo "build-ffmpeg: checksum mismatch for $2" >&2; exit 1; }
    fi
}

# step <name>: true when <name> still has to be built, and makes a clean source tree for it in
# $BUILD/<name> from the tarball given as $2. `done_step <name>` marks it finished.
step() {
    if [ -f "$BUILD/$1.done" ]; then
        echo "build-ffmpeg: $1 already built"
        return 1
    fi
    echo "build-ffmpeg: building $1"
    rm -rf "${BUILD:?}/$1"
    mkdir -p "$BUILD/$1"
    tar -xf "$SRC/$2" -C "$BUILD/$1" --strip-components=1
    cd "$BUILD/$1"
}
done_step() { touch "$BUILD/$1.done"; }

fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "ffmpeg-$FFMPEG_VERSION.tar.xz" $FFMPEG_SHA256
fetch "https://gitlab.com/AOMediaCodec/SVT-AV1/-/archive/v$SVTAV1_VERSION/SVT-AV1-v$SVTAV1_VERSION.tar.gz" "SVT-AV1-v$SVTAV1_VERSION.tar.gz" $SVTAV1_SHA256
fetch "https://code.videolan.org/videolan/x264/-/archive/$X264_COMMIT/x264-$X264_COMMIT.tar.bz2" "x264-$X264_COMMIT.tar.bz2" $X264_SHA256
fetch "https://downloads.videolan.org/videolan/dav1d/$DAV1D_VERSION/dav1d-$DAV1D_VERSION.tar.xz" "dav1d-$DAV1D_VERSION.tar.xz" $DAV1D_SHA256
fetch "https://github.com/xiph/opus/releases/download/v$OPUS_VERSION/opus-$OPUS_VERSION.tar.gz" "opus-$OPUS_VERSION.tar.gz" $OPUS_SHA256
fetch "https://github.com/intel/libvpl/archive/refs/tags/v$LIBVPL_VERSION.tar.gz" "libvpl-$LIBVPL_VERSION.tar.gz" $LIBVPL_SHA256
fetch "https://github.com/GPUOpen-LibrariesAndSDKs/AMF/releases/download/v$AMF_VERSION/AMF-headers-v$AMF_VERSION.tar.gz" "AMF-headers-v$AMF_VERSION.tar.gz" $AMF_SHA256
fetch "https://github.com/FFmpeg/nv-codec-headers/archive/refs/tags/n$NVCODEC_VERSION.tar.gz" "nv-codec-headers-$NVCODEC_VERSION.tar.gz" $NVCODEC_SHA256

if step amf "AMF-headers-v$AMF_VERSION.tar.gz"; then
    cp -r AMF "$PREFIX/include/"
    done_step amf
fi

if step nv-codec-headers "nv-codec-headers-$NVCODEC_VERSION.tar.gz"; then
    make PREFIX="$PREFIX" install
    done_step nv-codec-headers
fi

if step x264 "x264-$X264_COMMIT.tar.bz2"; then
    # 8-bit only: every source is 8-bit NV12 from OBS, and each extra depth is another full
    # copy of the encoder in the binary.
    ./configure --prefix="$PREFIX" --host=x86_64-w64-mingw32 --enable-static --disable-cli \
        --bit-depth=8 --disable-opencl --enable-strip
    make -j"$JOBS"
    make install
    done_step x264
fi

if step svt-av1 "SVT-AV1-v$SVTAV1_VERSION.tar.gz"; then
    cmake -S . -B out -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
        -DCMAKE_INSTALL_LIBDIR=lib -DBUILD_SHARED_LIBS=OFF -DBUILD_APPS=OFF -DBUILD_DEC=OFF \
        -DBUILD_TESTING=OFF
    cmake --build out -j "$JOBS"
    cmake --install out
    done_step svt-av1
fi

if step dav1d "dav1d-$DAV1D_VERSION.tar.xz"; then
    meson setup out --prefix="$PREFIX" --libdir=lib --buildtype=release --default-library=static \
        -Denable_tools=false -Denable_tests=false -Denable_examples=false
    ninja -C out install
    done_step dav1d
fi

if step opus "opus-$OPUS_VERSION.tar.gz"; then
    # No stack protector: with mingw it drags in libssp, which a static ffmpeg.exe then fails
    # to link. The neural-network features are decoder/encoder extras nothing here uses.
    ./configure --prefix="$PREFIX" --host=x86_64-w64-mingw32 --enable-static --disable-shared \
        --disable-doc --disable-extra-programs --disable-stack-protector \
        --disable-deep-plc --disable-dred --disable-osce
    make -j"$JOBS"
    make install
    done_step opus
fi

if step libvpl "libvpl-$LIBVPL_VERSION.tar.gz"; then
    # `#if _MSC_VER < 1400` is also true on gcc, where _MSC_VER is 0, and the wcscpy_s macro it
    # defines then breaks mingw's own stralign.h. mingw has the real wcscpy_s; keep the shim to
    # old MSVC.
    sed -i 's/^#if _MSC_VER < 1400$/#if defined(_MSC_VER) \&\& _MSC_VER < 1400/' libvpl/src/windows/mfx_dispatcher_defs.h
    cmake -S . -B out -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
        -DCMAKE_INSTALL_LIBDIR=lib -DBUILD_SHARED_LIBS=OFF -DBUILD_TOOLS=OFF -DBUILD_EXAMPLES=OFF \
        -DINSTALL_EXAMPLES=OFF -DBUILD_TESTS=OFF -DENABLE_WARNING_AS_ERROR=OFF
    cmake --build out -j "$JOBS"
    cmake --install out
    # The dispatcher is C++, but its vpl.pc only lists what a shared build needs; linked
    # statically it also needs the C++ runtime, or ffmpeg's configure reports "libvpl not found".
    sed -i 's/^Libs.private:.*$/Libs.private: -lstdc++/' "$PREFIX/lib/pkgconfig/vpl.pc"
    done_step libvpl
fi

if step ffmpeg "ffmpeg-$FFMPEG_VERSION.tar.xz"; then
    ./configure \
        --prefix="$PREFIX" \
        --pkg-config-flags=--static \
        --extra-cflags="-I$PREFIX/include" \
        --extra-ldflags="-L$PREFIX/lib -static" \
        --enable-gpl \
        --disable-everything --disable-autodetect \
        --disable-doc --disable-debug --disable-network \
        --disable-ffplay --disable-ffprobe \
        --enable-static --disable-shared \
        --enable-w32threads --enable-d3d11va --enable-dxva2 \
        --enable-amf --enable-ffnvcodec --enable-nvenc --enable-libvpl \
        --enable-libx264 --enable-libsvtav1 --enable-libdav1d --enable-libopus \
        --enable-protocol=file,pipe \
        --enable-indev=lavfi \
        --enable-demuxer=mov,concat \
        --enable-muxer=mp4,image2,null,framecrc \
        --enable-decoder=h264,hevc,libdav1d,aac,opus,wrapped_avframe,pcm_s16le \
        --enable-parser=h264,hevc,av1,aac,opus \
        --enable-encoder=libsvtav1,libx264,av1_amf,h264_amf,hevc_amf,av1_nvenc,h264_nvenc,hevc_nvenc,av1_qsv,h264_qsv,hevc_qsv,libopus,aac,mjpeg,wrapped_avframe,pcm_s16le \
        --enable-bsf=aac_adtstoasc,extract_extradata,h264_mp4toannexb,hevc_mp4toannexb,av1_frame_merge,av1_frame_split,setts,null \
        --enable-filter=trim,atrim,setpts,asetpts,concat,scale,format,aformat,aresample,null,anull,crop,transpose,hflip,vflip,testsrc2,sine
    make -j"$JOBS"
    done_step ffmpeg
fi

EXE=$BUILD/ffmpeg/ffmpeg.exe

# Every hardware and software encoder the app can pick has to be in there.
encoders=$("$EXE" -hide_banner -encoders)
for want in libsvtav1 libx264 av1_amf h264_amf hevc_amf av1_nvenc h264_nvenc hevc_nvenc av1_qsv h264_qsv hevc_qsv libopus aac mjpeg; do
    grep -q " $want " <<<"$encoders" || { echo "build-ffmpeg: encoder $want is missing from the build" >&2; exit 1; }
done
# The encoder probe's shape: lavfi in, encode, null out. It needs decoders for what lavfi emits
# and the auto-inserted conversion filters, none of which the encoder list above would catch.
"$EXE" -hide_banner -nostdin -v error -f lavfi -i testsrc2=size=320x180:rate=30 \
    -f lavfi -i sine=sample_rate=48000 -t 1 -c:v libx264 -c:a libopus -f null - \
    || { echo "build-ffmpeg: the encoder probe command fails on this build" >&2; exit 1; }
# A static build imports only Windows system DLLs. A mingw runtime DLL here would make the
# sidecar fail to start on every machine without MSYS2.
if objdump -p "$EXE" | grep -i 'DLL Name' | grep -Ei 'libwinpthread|libstdc\+\+|libgcc|libssp|libvpl|libdav1d|libopus|libx264|SvtAv1'; then
    echo "build-ffmpeg: ffmpeg.exe links a non-system DLL" >&2
    exit 1
fi

mkdir -p "$(dirname "$OUT")"
cp "$EXE" "$OUT"
echo "build-ffmpeg: $(du -h "$OUT" | cut -f1) $OUT"
