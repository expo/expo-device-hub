// SPDX-License-Identifier: MIT
// A captured color buffer, as the frame source hands it to the encoder.
#pragma once
#include <cstdint>
#include <CoreVideo/CoreVideo.h>

namespace expo_capture {

enum class FramePath { Gpu, Cpu };
inline const char* framePathName(FramePath path) { return path == FramePath::Gpu ? "gpu" : "cpu"; }

// An owned reference to a 32BGRA, IOSurface-backed pixel buffer.
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
  FramePixels(const FramePixels&) = delete;
  FramePixels& operator=(const FramePixels&) = delete;
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

// A captured color buffer at its native size.
struct CapturedFrame {
  FramePixels pixels;
  int width = 0;
  int height = 0;
  FramePath path = FramePath::Cpu;
  double captureMs = 0;
};

}  // namespace expo_capture
