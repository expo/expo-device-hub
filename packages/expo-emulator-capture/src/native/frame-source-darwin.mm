// SPDX-License-Identifier: MIT
#define GL_SILENCE_DEPRECATION
#include "frame-source.h"
#include "log.h"
#import <Foundation/Foundation.h>
#include <Accelerate/Accelerate.h>
#include <IOSurface/IOSurface.h>
#include <OpenGL/CGLIOSurface.h>
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>
#include <atomic>
#include <chrono>
#include <cstring>
#include <mutex>
#include <typeinfo>
#include <unordered_map>
#include <vector>

namespace expo_capture {
namespace {

constexpr int kEglDraw = 0x3059;
constexpr int kEglRead = 0x305A;
constexpr uint32_t kGlRgba = 0x1908;
constexpr uint32_t kGlUnsignedByte = 0x1401;
// Cached IOSurface targets. The stream and the recording each hold up to three frames (two
// pending, one encoding), and one more is being captured.
constexpr size_t kMaxTargets = 12;

using Clock = std::chrono::steady_clock;
double msSince(Clock::time_point start) {
  return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

// Restores the calling thread's renderer context on scope exit. The render thread
// enters with the guest's context current; other threads usually with none.
class SavedEglState {
 public:
  SavedEglState(const Gfxstream& g, void* fallbackDisplay)
      : g_(g),
        context_(g.eglGetCurrentContext()),
        display_(g.eglGetCurrentDisplay()),
        draw_(g.eglGetCurrentSurface(kEglDraw)),
        read_(g.eglGetCurrentSurface(kEglRead)),
        fallbackDisplay_(fallbackDisplay) {}
  ~SavedEglState() {
    void* display = display_ ? display_ : fallbackDisplay_;
    if (context_)
      g_.eglMakeCurrent(display, draw_, read_, context_);
    else
      g_.eglMakeCurrent(display, nullptr, nullptr, nullptr);
  }

 private:
  const Gfxstream& g_;
  void* context_;
  void* display_;
  void* draw_;
  void* read_;
  void* fallbackDisplay_;
};

struct FrameBufferLock {
  const Gfxstream& g;
  void* fb;
  FrameBufferLock(const Gfxstream& gfxstream, void* frameBuffer) : g(gfxstream), fb(frameBuffer) {
    g.lock(fb);
  }
  ~FrameBufferLock() { g.unlock(fb); }
};

std::string glError(const char* operation) {
  GLenum error = glGetError();
  if (error == GL_NO_ERROR) return "";
  char text[96];
  snprintf(text, sizeof(text), "%s failed with GL error 0x%04x", operation, error);
  return text;
}

// Copies posted color buffers into IOSurface-backed pixel buffers. GPU path: the
// renderer's native GL texture is blitted into an IOSurface on the GPU. CPU path:
// the renderer reads the pixels back, for software renderers.
class IOSurfaceFrameSource final : public FrameSource {
 public:
  explicit IOSurfaceFrameSource(const Gfxstream& gfxstream) : g_(gfxstream) {}
  bool capture(uint32_t handle, CapturedFrame& out, std::string& error) override;
  bool gpuUnavailable() const override { return gpuUnavailable_; }

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
  std::atomic<bool> gpuUnavailable_{false};
};

}  // namespace

std::unique_ptr<FrameSource> createFrameSource(const Gfxstream& gfxstream) {
  return std::make_unique<IOSurfaceFrameSource>(gfxstream);
}

bool IOSurfaceFrameSource::capture(uint32_t handle, CapturedFrame& out, std::string& error) {
  std::lock_guard<std::mutex> guard(mutex_);
  void* fb = g_.getFB();
  if (!fb) {
    error = "renderer is not initialized";
    return false;
  }
  auto start = Clock::now();
  bool ok = false;
  if (!gpuUnavailable_) {
    ok = captureGpu(fb, handle, out, error);
    if (!ok && !gpuUnavailable_) return false;  // A transient GPU error; do not mask it.
  }
  if (!ok) ok = captureCpu(fb, handle, out, error);
  if (ok) {
    // The capture is sRGB; tag it so that the encoders' transfers convert it with BT.709 terms.
    // Tagged here, before the stream and the recording read the buffer on their own threads.
    CVBufferSetAttachment(out.pixels.get(), kCVImageBufferColorPrimariesKey,
                          kCVImageBufferColorPrimaries_ITU_R_709_2,
                          kCVAttachmentMode_ShouldPropagate);
    CVBufferSetAttachment(out.pixels.get(), kCVImageBufferTransferFunctionKey,
                          kCVImageBufferTransferFunction_sRGB, kCVAttachmentMode_ShouldPropagate);
  }
  out.captureMs = msSince(start);
  return ok;
}

bool IOSurfaceFrameSource::captureGpu(void* fb, uint32_t handle, CapturedFrame& out, std::string& error) {
  if (!g_.gpuEntryPointsAvailable()) {
    disableGpu("renderer symbols for the GPU path are missing");
    return false;
  }
  // The renderer's texture names and EGL contexts are shared state; hold the
  // FrameBuffer lock as gfxstream's own display path does.
  FrameBufferLock lock(g_, fb);
  auto colorBuffer = g_.findColorBuffer(fb, handle);
  if (!colorBuffer) {
    error = "posted color buffer disappeared";
    return false;
  }
  void* colorBufferGl = g_.colorBufferGl(colorBuffer.get());
  if (!colorBufferGl) {
    disableGpu("color buffers have no OpenGL backing (Vulkan composition)");
    return false;
  }
  auto info = g_.borrowedImageInfo(colorBufferGl);
  BorrowedImageInfo* descriptor = info.get();
  if (!descriptor || !strstr(typeid(*descriptor).name(), "BorrowedImageInfoGl")) {
    disableGpu("renderer returned an unexpected image descriptor");
    return false;
  }
  auto* gl = static_cast<BorrowedImageInfoGl*>(descriptor);
  uint32_t width = g_.colorBufferWidth(colorBuffer.get());
  uint32_t height = g_.colorBufferHeight(colorBuffer.get());
  if (gl->width != width || gl->height != height || !gl->texture) {
    disableGpu("image descriptor does not match its color buffer");
    return false;
  }
  CVPixelBufferRef target = takeBuffer(int(width), int(height), error);
  if (!target) return false;
  if (!context_) {
    g_.createSharedTrivialContext(fb, &context_, &surface_);
    display_ = g_.getDisplay(fb);
    if (!context_ || !surface_ || !display_) {
      CVPixelBufferRelease(target);
      disableGpu("could not create a shared renderer context");
      return false;
    }
  }
  if (!blit(colorBufferGl, *gl, target, error)) {
    CVPixelBufferRelease(target);
    return false;
  }
  out.pixels = FramePixels(target);
  out.width = int(width);
  out.height = int(height);
  out.path = FramePath::Gpu;
  return true;
}

bool IOSurfaceFrameSource::blit(void* colorBufferGl, const BorrowedImageInfoGl& info,
                       CVPixelBufferRef target, std::string& error) {
  SavedEglState saved(g_, display_);
  if (!g_.eglMakeCurrent(display_, surface_, surface_, context_)) {
    error = "could not make the capture context current";
    return false;
  }
  CGLContextObj cgl = CGLGetCurrentContext();
  if (!cgl) {
    disableGpu("renderer does not use the host OpenGL backend (start the emulator with -gpu host)");
    return false;
  }
  if (flushTargets_ || targets_.size() > kMaxTargets) {
    for (auto& [id, cached] : targets_) deleteTarget(cached);
    targets_.clear();
    flushTargets_ = false;
  }
  // A GPU-side wait: later commands on this context run after the guest's frame.
  g_.waitSync(colorBufferGl, false);
  GLuint source = g_.getGlobalTexName(info.texture);
  if (!source) {
    error = "renderer texture has no native name";
    return false;
  }
  IOSurfaceRef surface = CVPixelBufferGetIOSurface(target);
  if (!surface) {
    error = "pixel buffer is not backed by an IOSurface";
    return false;
  }
  GLsizei width = GLsizei(info.width), height = GLsizei(info.height);
  Target& cached = targets_[IOSurfaceGetID(surface)];
  if (cached.surface != surface) {
    // A cached entry retains its IOSurface, so a matching ID with another
    // surface is unexpected; rebuild the entry instead of drawing elsewhere.
    deleteTarget(cached);
    cached = Target{};
  }
  if (!cached.texture) {
    cached.surface = (IOSurfaceRef)CFRetain(surface);
    glGenTextures(1, &cached.texture);
    glBindTexture(GL_TEXTURE_RECTANGLE, cached.texture);
    CGLError bound = CGLTexImageIOSurface2D(cgl, GL_TEXTURE_RECTANGLE, GL_RGBA, width, height,
                                            GL_BGRA, GL_UNSIGNED_INT_8_8_8_8_REV, surface, 0);
    glBindTexture(GL_TEXTURE_RECTANGLE, 0);
    glGenFramebuffers(1, &cached.framebuffer);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, cached.framebuffer);
    glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_RECTANGLE,
                           cached.texture, 0);
    GLenum status = glCheckFramebufferStatus(GL_DRAW_FRAMEBUFFER);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
    if (bound != kCGLNoError || status != GL_FRAMEBUFFER_COMPLETE) {
      deleteTarget(cached);
      targets_.erase(IOSurfaceGetID(surface));
      disableGpu("could not render into an IOSurface");
      return false;
    }
  }
  if (!readFramebuffer_) glGenFramebuffers(1, &readFramebuffer_);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, readFramebuffer_);
  glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, source, 0);
  GLenum readStatus = glCheckFramebufferStatus(GL_READ_FRAMEBUFFER);
  if (readStatus != GL_FRAMEBUFFER_COMPLETE) {
    glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
    error = "renderer texture cannot be read as a framebuffer";
    return false;
  }
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, cached.framebuffer);
  // Both textures keep row 0 first, so an unflipped copy keeps the image upright.
  glBlitFramebuffer(0, 0, width, height, 0, 0, width, height, GL_COLOR_BUFFER_BIT, GL_NEAREST);
  glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
  // @ref LLP 0020#synchronization — flush here, wait on the encoder thread
  // Submit without waiting: glFinish here held the guest's render thread for
  // about 1.2 ms per frame instead of 0.1 ms. The encoder thread waits for the
  // copy with IOSurfaceLock (waitForGpuCopy) before VideoToolbox reads it.
  glFlush();
  error = glError("GPU frame copy");
  return error.empty();
}

bool IOSurfaceFrameSource::captureCpu(void* fb, uint32_t handle, CapturedFrame& out, std::string& error) {
  int width = 0, height = 0;
  if (!colorBufferSize(g_, handle, width, height)) {
    error = "posted color buffer disappeared";
    return false;
  }
  size_t bytes = size_t(width) * size_t(height) * 4;
  scratch_.resize(bytes);
  g_.readColorBuffer(fb, handle, 0, 0, width, height, kGlRgba, kGlUnsignedByte, scratch_.data(),
                     bytes);
  CVPixelBufferRef target = takeBuffer(width, height, error);
  if (!target) return false;
  CVPixelBufferLockBaseAddress(target, 0);
  vImage_Buffer source{scratch_.data(), vImagePixelCount(height), vImagePixelCount(width),
                       size_t(width) * 4};
  vImage_Buffer destination{CVPixelBufferGetBaseAddress(target), vImagePixelCount(height),
                            vImagePixelCount(width), CVPixelBufferGetBytesPerRow(target)};
  const uint8_t rgbaToBgra[4] = {2, 1, 0, 3};
  vImage_Error permuted =
      vImagePermuteChannels_ARGB8888(&source, &destination, rgbaToBgra, kvImageNoFlags);
  CVPixelBufferUnlockBaseAddress(target, 0);
  if (permuted != kvImageNoError) {
    CVPixelBufferRelease(target);
    error = "could not convert renderer pixels";
    return false;
  }
  out.pixels = FramePixels(target);
  out.width = width;
  out.height = height;
  out.path = FramePath::Cpu;
  return true;
}

CVPixelBufferRef IOSurfaceFrameSource::takeBuffer(int width, int height, std::string& error) {
  if (!pool_ || poolWidth_ != width || poolHeight_ != height) {
    if (pool_) CVPixelBufferPoolRelease(pool_);
    pool_ = nullptr;
    // Deleting the old targets needs our GL context, so blit() does it.
    flushTargets_ = true;
    CVReturn created;
    @autoreleasepool {
      NSDictionary* poolAttributes = @{(id)kCVPixelBufferPoolMinimumBufferCountKey : @4,
                                       (id)kCVPixelBufferPoolMaximumBufferAgeKey : @0};
      NSDictionary* bufferAttributes = @{
        (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
        (id)kCVPixelBufferWidthKey : @(width),
        (id)kCVPixelBufferHeightKey : @(height),
        (id)kCVPixelBufferIOSurfacePropertiesKey : @{},
        (id)kCVPixelBufferOpenGLCompatibilityKey : @YES,
        (id)kCVPixelBufferMetalCompatibilityKey : @YES,
      };
      created = CVPixelBufferPoolCreate(kCFAllocatorDefault, (__bridge CFDictionaryRef)poolAttributes,
                                        (__bridge CFDictionaryRef)bufferAttributes, &pool_);
    }
    if (created != kCVReturnSuccess) {
      pool_ = nullptr;
      error = "could not create IOSurface pixel buffers";
      return nullptr;
    }
    poolWidth_ = width;
    poolHeight_ = height;
  }
  CVPixelBufferRef buffer = nullptr;
  if (CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool_, &buffer) != kCVReturnSuccess) {
    error = "IOSurface pixel buffer pool is exhausted";
    return nullptr;
  }
  return buffer;
}

void IOSurfaceFrameSource::deleteTarget(Target& target) {
  if (target.framebuffer) glDeleteFramebuffers(1, &target.framebuffer);
  if (target.texture) glDeleteTextures(1, &target.texture);
  if (target.surface) CFRelease(target.surface);
  target = Target{};
}

void IOSurfaceFrameSource::disableGpu(const std::string& reason) {
  if (gpuUnavailable_) return;
  gpuUnavailable_ = true;
  logLine("GPU frame path unavailable: %s; using CPU readback", reason.c_str());
}

}  // namespace expo_capture
