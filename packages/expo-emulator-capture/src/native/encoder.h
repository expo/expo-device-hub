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

struct EncoderConfig {
  // The output size: the stream size, or the recording's canvas.
  int width = 0;
  int height = 0;
  int fps = 60;
  int bitRate = 12'000'000;
  // Android's display rotation (0 to 3): frames hold the picture turned that many quarter turns
  // clockwise in the panel's orientation, and the encoder turns them back to upright.
  int rotation = 0;
  // The longest time between keyframes, also on a static screen.
  int keyFrameIntervalSeconds = 10;
  // Place each frame on the output size with placeOnCanvas (protocol.h), with black borders,
  // instead of scaling it to fill. The recording keeps one size through a fold this way.
  bool letterbox = false;
};

// Encodes captured frames to Constrained Baseline H.264 at the configured size.
// Only one thread uses an encoder; packets reach the sink in encode order.
class H264Encoder {
 public:
  using Sink = std::function<void(EncodedPacket&&)>;
  using ErrorSink = std::function<void(const std::string&)>;
  virtual ~H264Encoder() = default;

  // Creates a session; callbacks from an earlier session have finished on return.
  virtual bool configure(const EncoderConfig& config, std::string& error) = 0;
  // Turns and scales a frame of any size to the configured size, or places it on the canvas when
  // the config letterboxes, and encodes it.
  virtual bool encode(const CapturedFrame& frame, uint64_t ptsUs, bool forceKey,
                      std::string& error) = 0;
  // Waits for queued frames, then releases the session.
  virtual void invalidate() = 0;

  virtual bool hardware() const = 0;
  virtual const std::string& encoderId() const = 0;
  // The last encode's pixel work before the encoder: turn, scale and convert. 0 when the
  // encoder does that work itself (VideoToolbox).
  virtual double lastConvertMs() const { return 0; }
};

// macOS: VideoToolbox, on the hardware encoder when the Mac has one.
// Linux: x264 build 165 from the system (libx264-165), loaded at run time.
std::unique_ptr<H264Encoder> createH264Encoder(H264Encoder::Sink sink,
                                               H264Encoder::ErrorSink onError);

// Why no encoder can start on this host, or an empty string. The hello record reports it,
// so that a consumer can tell the user what to install instead of waiting for frames.
std::string h264EncoderProblem();

}  // namespace expo_capture
