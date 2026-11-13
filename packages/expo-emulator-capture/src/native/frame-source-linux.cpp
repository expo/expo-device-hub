// SPDX-License-Identifier: MIT
// Linux frame source: the renderer reads each posted color buffer back into
// memory. It works with every gfxstream renderer, with or without a host GPU.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <mutex>
#include <vector>
#include "frame-source.h"

namespace expo_capture {
namespace {

constexpr uint32_t kGlRgba = 0x1908;
constexpr uint32_t kGlUnsignedByte = 0x1401;
// Frames in flight: two pending, one encoding, one capturing.
constexpr size_t kMaxPooledImages = 4;

using Clock = std::chrono::steady_clock;

// @ref LLP 0021#frame-path — CPU readback only; the encoder converts and scales
class ReadbackFrameSource final : public FrameSource {
 public:
  explicit ReadbackFrameSource(const Gfxstream& gfxstream) : g_(gfxstream) {}

  bool capture(uint32_t handle, CapturedFrame& out, std::string& error) override {
    std::lock_guard<std::mutex> guard(mutex_);
    void* fb = g_.getFB();
    if (!fb) {
      error = "renderer is not initialized";
      return false;
    }
    auto start = Clock::now();
    int width = 0, height = 0;
    if (!colorBufferSize(g_, handle, width, height)) {
      error = "posted color buffer disappeared";
      return false;
    }
    FramePixels image = takeImage(width, height);
    // Takes the FrameBuffer lock itself, so the caller must not hold it.
    g_.readColorBuffer(fb, handle, 0, 0, width, height, kGlRgba, kGlUnsignedByte,
                       image->data.data(), image->data.size());
    out.pixels = std::move(image);
    out.width = width;
    out.height = height;
    out.path = FramePath::Cpu;
    out.captureMs = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
    return true;
  }

  bool gpuUnavailable() const override { return true; }

 private:
  // Reuses an image that no frame holds any more. The pool keeps one reference, so
  // a use count of one means the encoder has released it.
  FramePixels takeImage(int width, int height) {
    pool_.erase(std::remove_if(pool_.begin(), pool_.end(),
                               [&](const FramePixels& image) {
                                 return image.use_count() == 1 &&
                                        (image->width != width || image->height != height);
                               }),
                pool_.end());
    for (const auto& image : pool_) {
      if (image.use_count() == 1 && image->width == width && image->height == height) {
        // use_count() reads the count without ordering; the encoder thread's last reads of the
        // image must happen before the readback writes it again.
        std::atomic_thread_fence(std::memory_order_acquire);
        return image;
      }
    }
    auto image = std::make_shared<RgbaImage>();
    image->width = width;
    image->height = height;
    image->data.resize(size_t(width) * size_t(height) * 4);
    if (pool_.size() < kMaxPooledImages) pool_.push_back(image);
    return image;
  }

  const Gfxstream& g_;
  std::mutex mutex_;
  std::vector<FramePixels> pool_;
};

}  // namespace

std::unique_ptr<FrameSource> createFrameSource(const Gfxstream& gfxstream) {
  return std::make_unique<ReadbackFrameSource>(gfxstream);
}

}  // namespace expo_capture
