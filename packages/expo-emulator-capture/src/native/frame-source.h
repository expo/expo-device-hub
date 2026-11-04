// SPDX-License-Identifier: MIT
#pragma once
#include <CoreVideo/CoreVideo.h>
#include <IOSurface/IOSurface.h>
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>
#include "gfxstream.h"

namespace expo_capture {

enum class FramePath { Gpu, Cpu };
inline const char* framePathName(FramePath path) { return path == FramePath::Gpu ? "gpu" : "cpu"; }

// A captured color buffer at its native size: 32BGRA, IOSurface-backed, retained.
struct CapturedFrame {
  CVPixelBufferRef pixels = nullptr;
  int width = 0;
  int height = 0;
  FramePath path = FramePath::Cpu;
  double captureMs = 0;
};

// Copies posted gfxstream color buffers into IOSurface-backed pixel buffers.
// GPU path: the renderer's native GL texture is blitted into an IOSurface on the
// GPU. CPU path: the renderer reads the pixels back, for software renderers.
class FrameSource {
 public:
  explicit FrameSource(const Gfxstream& gfxstream) : g_(gfxstream) {}
  // Captures one color buffer. The caller must not hold the FrameBuffer lock.
  // Safe to call from the render thread and from other threads.
  bool capture(uint32_t handle, CapturedFrame& out, std::string& error);
  // Reads a color buffer's native size without copying pixels.
  bool colorBufferSize(uint32_t handle, int& width, int& height);
  // True once the GPU path has failed or is unsupported for this renderer.
  bool gpuUnavailable() const { return gpuUnavailable_; }
  const std::string& gpuUnavailableReason() const { return gpuUnavailableReason_; }

 private:
  // An IOSurface bound to a GL texture and framebuffer in our renderer context.
  struct Target {
    IOSurfaceRef surface = nullptr;  // Retained.
    unsigned texture = 0;
    unsigned framebuffer = 0;
  };
  bool captureGpu(void* fb, uint32_t handle, CapturedFrame& out, std::string& error);
  bool captureCpu(void* fb, uint32_t handle, CapturedFrame& out, std::string& error);
  bool blit(void* colorBufferGl, const BorrowedImageInfoGl& info, CVPixelBufferRef target,
            std::string& error);
  CVPixelBufferRef takeBuffer(int width, int height, std::string& error);
  void deleteTarget(Target& target);
  void disableGpu(const std::string& reason);

  const Gfxstream& g_;
  std::mutex mutex_;
  CVPixelBufferPoolRef pool_ = nullptr;
  int poolWidth_ = 0, poolHeight_ = 0;
  // GPU state; touched only while our renderer context is current.
  void* display_ = nullptr;
  void* context_ = nullptr;
  void* surface_ = nullptr;
  unsigned readFramebuffer_ = 0;
  std::unordered_map<uint32_t, Target> targets_;  // By IOSurface ID.
  bool flushTargets_ = false;
  std::vector<uint8_t> scratch_;
  std::string gpuUnavailableReason_;  // Written once, before gpuUnavailable_.
  std::atomic<bool> gpuUnavailable_{false};
};

}  // namespace expo_capture
