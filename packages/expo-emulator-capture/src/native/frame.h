// SPDX-License-Identifier: MIT
// A captured color buffer, as the frame source hands it to the encoder.
#pragma once
#include <cstdint>
#include <memory>
#include <vector>
#if defined(__APPLE__)
#include <CoreVideo/CoreVideo.h>
#endif

namespace expo_capture {

enum class FramePath { Gpu, Cpu };
inline const char* framePathName(FramePath path) { return path == FramePath::Gpu ? "gpu" : "cpu"; }

#if defined(__APPLE__)
// An owned reference to a 32BGRA, IOSurface-backed pixel buffer. A copy retains the same buffer,
// so the stream and the recording share one captured frame; both only read it.
class FramePixels {
 public:
  FramePixels() = default;
  explicit FramePixels(CVPixelBufferRef adopted) : buffer_(adopted) {}
  FramePixels(FramePixels&& other) noexcept : buffer_(other.buffer_) { other.buffer_ = nullptr; }
  FramePixels& operator=(FramePixels&& other) noexcept {
    if (this != &other) {
      reset();
      buffer_ = other.buffer_;
      other.buffer_ = nullptr;
    }
    return *this;
  }
  FramePixels(const FramePixels& other) : buffer_(other.buffer_) {
    if (buffer_) CVPixelBufferRetain(buffer_);
  }
  FramePixels& operator=(const FramePixels& other) {
    if (this != &other) {
      reset();
      buffer_ = other.buffer_;
      if (buffer_) CVPixelBufferRetain(buffer_);
    }
    return *this;
  }
  ~FramePixels() { reset(); }

  void reset() {
    if (buffer_) CVPixelBufferRelease(buffer_);
    buffer_ = nullptr;
  }
  CVPixelBufferRef get() const { return buffer_; }
  explicit operator bool() const { return buffer_ != nullptr; }

 private:
  CVPixelBufferRef buffer_ = nullptr;
};
#else
// Tightly packed RGBA rows, top row first, as the renderer reads them back.
struct RgbaImage {
  std::vector<uint8_t> data;
  int width = 0;
  int height = 0;
};
// Shared with the frame source's pool, which reuses an image once no frame holds it, and between
// the stream and the recording, which only read it.
using FramePixels = std::shared_ptr<RgbaImage>;
#endif

// A captured color buffer at its native size.
struct CapturedFrame {
  FramePixels pixels;
  int width = 0;
  int height = 0;
  FramePath path = FramePath::Cpu;
  double captureMs = 0;
  // Parts of captureMs on the Linux readback: the 1x1 read that waits for the renderer (only
  // with the probe on) and the full read.
  double waitMs = 0, readMs = 0;
};

}  // namespace expo_capture
