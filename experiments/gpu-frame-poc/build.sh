#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
clang++ -std=c++17 -stdlib=libc++ -shared -fPIC -O2 -g -Wall -Wextra \
  -I nv-codec-headers/include -I ffmpeg-source capture.cpp -o "${1:-libgpu_capture.so}" \
  -Wl,-Bsymbolic -Wl,--exclude-libs,ALL \
  ffmpeg-source/libavcodec/libavcodec.a ffmpeg-source/libavutil/libavutil.a -ldl -pthread -lm
