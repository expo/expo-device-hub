// SPDX-License-Identifier: MIT
#pragma once
#include <cstdint>
#include <memory>
#include <string>
#include "frame.h"
#include "gfxstream.h"

namespace expo_capture {

// Copies posted gfxstream color buffers out of the renderer.
class FrameSource {
 public:
  virtual ~FrameSource() = default;
  // Captures one color buffer at its native size. The caller must not hold the
  // FrameBuffer lock. Safe to call from the render thread and from other threads.
  virtual bool capture(uint32_t handle, CapturedFrame& out, std::string& error) = 0;
  // True once the GPU path has failed or is unsupported for this renderer.
  virtual bool gpuUnavailable() const = 0;
};

// macOS: copies on the GPU into IOSurfaces when the renderer uses host OpenGL,
// and reads the pixels back otherwise.
std::unique_ptr<FrameSource> createFrameSource(const Gfxstream& gfxstream);

}  // namespace expo_capture
