#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
root=$PWD
make -C nv-codec-headers PREFIX="$root/deps" install
if [[ ! -d ffmpeg-source ]]; then
  git clone --depth 1 --branch n8.0.1 https://github.com/FFmpeg/FFmpeg.git ffmpeg-source
fi
cd ffmpeg-source
PKG_CONFIG_PATH="$root/deps/lib/pkgconfig" ./configure \
  --disable-everything --disable-autodetect --disable-programs --disable-doc \
  --disable-shared --enable-static --enable-pic --disable-x86asm \
  --disable-avdevice --disable-avfilter --disable-avformat --disable-swscale --disable-swresample \
  --enable-ffnvcodec --enable-cuda --enable-nvenc --enable-encoder=h264_nvenc \
  --extra-cflags=-fvisibility=hidden
make -j4
