// SPDX-License-Identifier: MIT
#pragma once
#include <CoreVideo/CoreVideo.h>
#include <VideoToolbox/VideoToolbox.h>
#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace expo_capture {

struct EncodedPacket {
  std::vector<uint8_t> data;  // Annex-B; keyframes start with SPS and PPS.
  uint64_t ptsUs = 0;
  bool key = false;
};

// Hardware H.264 through VideoToolbox. Frames of any size are scaled and
// converted to NV12 by a VTPixelTransferSession before the encoder.
class H264Encoder {
 public:
  using Sink = std::function<void(EncodedPacket&&)>;
  using ErrorSink = std::function<void(const std::string&)>;
  H264Encoder(Sink sink, ErrorSink onError) : sink_(std::move(sink)), onError_(std::move(onError)) {}
  ~H264Encoder() { invalidate(); }
  H264Encoder(const H264Encoder&) = delete;
  H264Encoder& operator=(const H264Encoder&) = delete;

  // Creates a session; callbacks from an earlier session have finished on return.
  bool configure(int width, int height, int fps, int bitRate, std::string& error);
  bool encode(CVPixelBufferRef pixels, uint64_t ptsUs, bool forceKey, std::string& error);
  // Waits for queued frames, then releases the session.
  void invalidate();

  bool configured() const { return session_ != nullptr; }
  int width() const { return width_; }
  int height() const { return height_; }
  int fps() const { return fps_; }
  int bitRate() const { return bitRate_; }
  bool hardware() const { return hardware_; }
  const std::string& encoderId() const { return encoderId_; }

 private:
  static void didEncode(void* refcon, void* frameRefcon, OSStatus status, VTEncodeInfoFlags flags,
                        CMSampleBufferRef sample);
  void emit(CMSampleBufferRef sample);

  Sink sink_;
  ErrorSink onError_;
  VTCompressionSessionRef session_ = nullptr;
  VTPixelTransferSessionRef transfer_ = nullptr;
  int width_ = 0, height_ = 0, fps_ = 0, bitRate_ = 0;
  bool hardware_ = false;
  std::string encoderId_;
};

}  // namespace expo_capture
