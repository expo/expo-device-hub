// SPDX-License-Identifier: MIT
#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>
#include "frame.h"

namespace expo_capture {

struct EncodedPacket {
  std::vector<uint8_t> data;  // Annex-B; keyframes start with SPS and PPS.
  uint64_t ptsUs = 0;
  bool key = false;
};

// Encodes captured frames to Constrained Baseline H.264 at the configured size.
// Only one thread uses an encoder; packets reach the sink in encode order.
class H264Encoder {
 public:
  using Sink = std::function<void(EncodedPacket&&)>;
  using ErrorSink = std::function<void(const std::string&)>;
  virtual ~H264Encoder() = default;

  // Creates a session; callbacks from an earlier session have finished on return.
  virtual bool configure(int width, int height, int fps, int bitRate, std::string& error) = 0;
  // Scales a frame of any size to the configured size and encodes it.
  virtual bool encode(const CapturedFrame& frame, uint64_t ptsUs, bool forceKey,
                      std::string& error) = 0;
  // Waits for queued frames, then releases the session.
  virtual void invalidate() = 0;

  virtual bool hardware() const = 0;
  virtual const std::string& encoderId() const = 0;
};

// macOS: VideoToolbox, on the hardware encoder when the Mac has one.
std::unique_ptr<H264Encoder> createH264Encoder(H264Encoder::Sink sink,
                                               H264Encoder::ErrorSink onError);

}  // namespace expo_capture
