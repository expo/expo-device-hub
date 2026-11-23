// SPDX-License-Identifier: MIT
#pragma once
#include "encoder.h"

namespace expo_capture {

inline std::string nvidiaOutputSizeProblem(int width, int height) {
  // @ref LLP 0009#videotoolbox-results — Turing and newer NVENC require width >= 145
  if (width < 146)
    return "NVIDIA H.264 output " + std::to_string(width) + "x" + std::to_string(height) +
           " is too narrow; its even output width must be at least 146 pixels. "
           "Increase maxSize (or use 0 for native size) or the recording canvas width.";
  return {};
}

inline std::string probeNvidiaEncoder(H264Encoder& encoder) {
  EncoderConfig config;
  // @ref LLP 0009#videotoolbox-results — 128-wide probes falsely reject Turing NVENC
  config.width = config.height = 256;
  config.fps = 30;
  config.bitRate = 1'000'000;
  std::string error;
  bool available = encoder.configure(config, error);
  encoder.invalidate();
  return available ? std::string{} : (error.empty() ? "NVIDIA encoder probe failed" : error);
}

}  // namespace expo_capture
