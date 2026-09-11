#!/usr/bin/env bash
# Standalone, disposable Linux NVIDIA experiment; run on the test worker only.
set -euo pipefail
sudo env DEBIAN_FRONTEND=noninteractive apt-get update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  nvidia-driver-580-open ffmpeg libavcodec-dev libavutil-dev libavformat-dev \
  libegl1-mesa-dev libgl-dev libpulse0 libnss3 libxkbcommon-x11-0 libxcb-cursor0 \
  build-essential cmake pkg-config clang libc++-dev libc++abi-dev python3-venv xserver-xorg-core openjdk-21-jdk-headless unzip
sudo modprobe nvidia
# On a fresh worker the device nodes can become ready just after modprobe exits.
for attempt in {1..15}; do
  if nvidia-smi >/dev/null 2>&1; then break; fi
  sleep 2
done
nvidia-smi
python3 -m venv .venv
.venv/bin/pip install frida==17.18.0 nvidia-cuda-nvrtc-cu12==12.9.86
git clone --depth 1 --branch n13.0.19.0 https://github.com/FFmpeg/nv-codec-headers.git
