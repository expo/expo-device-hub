// SPDX-License-Identifier: MIT
#pragma once
#include "encoder.h"

namespace expo_capture {

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
