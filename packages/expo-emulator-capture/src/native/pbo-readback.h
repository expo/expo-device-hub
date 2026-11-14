// SPDX-License-Identifier: MIT
#pragma once
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstring>
#include <typeinfo>
#include <vector>
#include "log.h"
#include "frame-source.h"

namespace expo_capture {

// Adapted prefix of gfxstream's EGLDispatch, in RenderEGL_functions.h order.
// Source: ca9abf8fd1ef9dadedc4de1bdfc1b68beb7850a2/include/OpenGLESDispatch/.
// Apache-2.0 interface; see THIRD_PARTY_LICENSES.md. Experimental emulator-37 ABI.
struct PboEglDispatch {
  int (*error)();
  void* (*getDisplay)(void* nativeDisplay);
  void (*unused[14])();
  unsigned (*makeCurrent)(void*, void*, void*, void*);
  void* (*currentContext)();
  void* (*currentDisplay)();
  void* (*currentSurface)(int);
};

// One private shared GLES context. Submit under the renderer lock, then wait and map
// without that lock. The caller serializes captures, so a buffer is never reused in flight.
class PboReadback {
 public:
  explicit PboReadback(const Gfxstream& g) : g_(g) {}

  bool capture(uint32_t handle, CapturedFrame& out, std::string& error) {
    using Clock = std::chrono::steady_clock;
    auto start = Clock::now();
    void* fb = g_.getFB();
    if (!fb || !load(fb, error)) return false;
    void* oldContext = egl_->currentContext();
    void* oldDisplay = oldContext ? egl_->currentDisplay() : display_;
    void* oldDraw = egl_->currentSurface(0x3059);
    void* oldRead = egl_->currentSurface(0x305a);
    struct Restore {
      const PboEglDispatch* egl;
      void *display, *context, *draw, *read;
      ~Restore() { egl->makeCurrent(display, draw, read, context); }
    } restore{egl_, oldDisplay, oldContext, oldDraw, oldRead};
    if (!egl_->makeCurrent(display_, surface_, surface_, context_)) {
      error = "PBO: cannot bind the shared GLES context";
      return false;
    }
    void* fence = nullptr;
    int width = 0, height = 0;
    {
      struct Lock {
        const Gfxstream& g; void* fb;
        Lock(const Gfxstream& g, void* fb) : g(g), fb(fb) { g.lock(fb); }
        ~Lock() { g.unlock(fb); }
      } lock(g_, fb);
      auto cb = g_.findColorBuffer(fb, handle);
      if (!cb) { error = "PBO: posted color buffer disappeared"; return false; }
      void* gl = nullptr;
      auto info = borrowPboGlImage(g_, cb.get(), gl);
      if (!gl) { error = "PBO: cannot borrow the GLES color buffer"; return false; }
      if (!info || !strstr(typeid(*info).name(), "BorrowedImageInfoGl")) {
        error = "PBO: unexpected borrowed image"; return false;
      }
      auto* image = static_cast<BorrowedImageInfoGl*>(info.get());
      width = int(g_.colorBufferWidth(cb.get()));
      height = int(g_.colorBufferHeight(cb.get()));
      if (width < 2 || height < 2 || width > 16384 || height > 16384 ||
          image->width != uint32_t(width) || image->height != uint32_t(height) || !image->texture) {
        error = "PBO: invalid color buffer dimensions"; return false;
      }
      size_t bytes = size_t(width) * size_t(height) * 4;
      bindBuffer_(0x88eb, buffer_);  // GL_PIXEL_PACK_BUFFER
      if (bytes != bytes_) {
        bufferData_(0x88eb, ptrdiff_t(bytes), nullptr, 0x88e1);  // GL_STREAM_READ
        bytes_ = bytes;
      }
      bindFramebuffer_(0x8d40, fbo_);
      framebufferTexture_(0x8d40, 0x8ce0, 0x0de1, image->texture, 0);
      if (checkFramebuffer_(0x8d40) != 0x8cd5) {
        error = "PBO: incomplete read framebuffer"; return false;
      }
      // Server-side dependency on the producer, followed by the copy and our own fence.
      // @ref LLP 0023#pbo-experiment — release the FrameBuffer lock before waiting for completion
      g_.waitSync(gl, false);
      readPixels_(0, 0, width, height, 0x1908, 0x1401, nullptr);
      // Equivalent to BorrowedImageInfoGl::onCommandsIssued: publish the read's dependency
      // before releasing the color buffer, including to its next user after a fold.
      g_.setSync(gl, false);
      fence = fenceSync_(0x9117, 0);  // GL_SYNC_GPU_COMMANDS_COMPLETE
      flush_();
      if (!fence || getError_()) {
        if (fence) deleteSync_(fence);
        error = "PBO: read submission failed"; return false;
      }
    }
    struct Fence {
      void* value; void (*release)(void*);
      ~Fence() { release(value); }
    } ownedFence{fence, deleteSync_};
    auto submitted = Clock::now();
    for (;;) {
      // No FLUSH bit: the submitting context has already flushed. This wait holds no
      // renderer lock and runs only on a capture/encoder thread, never in a post.
      uint32_t status = clientWait_(fence, 0, 1000000);
      if (status == 0x911a || status == 0x911c) break;
      if (status != 0x911b || Clock::now() - submitted > std::chrono::seconds(2)) {
        error = "PBO: fence failed or timed out";
        // Deletion defers storage release until GL is done; never reuse an in-flight buffer.
        deleteBuffers_(1, &buffer_);
        genBuffers_(1, &buffer_);
        bytes_ = 0;
        return false;
      }
    }
    auto ready = Clock::now();
    FramePixels pixels;
    for (const auto& pooled : pool_) {
      if (pooled.use_count() == 1) {
        std::atomic_thread_fence(std::memory_order_acquire);
        pixels = pooled;
        break;
      }
    }
    if (!pixels) {
      pixels = std::make_shared<RgbaImage>();
      if (pool_.size() < 8) pool_.push_back(pixels);
    }
    pixels->width = width;
    pixels->height = height;
    pixels->data.resize(bytes_);
    bindBuffer_(0x88eb, buffer_);
    void* mapped = mapBuffer_(0x88eb, 0, ptrdiff_t(bytes_), 1);  // GL_MAP_READ_BIT
    if (!mapped) { error = "PBO: map failed"; return false; }
    memcpy(pixels->data.data(), mapped, bytes_);
    bool valid = unmapBuffer_(0x88eb);
    bindBuffer_(0x88eb, 0);
    if (!valid) { error = "PBO: buffer contents invalid"; return false; }
    out.pixels = std::move(pixels);
    out.width = width;
    out.height = height;
    out.path = FramePath::Cpu;
    out.waitMs = std::chrono::duration<double, std::milli>(ready - submitted).count();
    out.readMs = std::chrono::duration<double, std::milli>(Clock::now() - ready).count();
    out.captureMs = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
    if (++count_ % 120 == 0)
      logLine("PBO: submit %.3f ms, unlocked wait %.3f ms, map/copy %.3f ms",
              std::chrono::duration<double, std::milli>(submitted - start).count(),
              out.waitMs, out.readMs);
    return true;
  }

 private:
  bool load(void* fb, std::string& error) {
    if (context_) return true;
#define REQUIRE(member) \
    if (!g_.member) { error = "PBO: missing renderer entry point " #member; return false; }
    REQUIRE(getEglDispatch);
    REQUIRE(glesProc);
    REQUIRE(createSharedTrivialContext);
    REQUIRE(borrowedImageInfo);
    REQUIRE(waitSync);
    REQUIRE(setSync);
#undef REQUIRE
    egl_ = static_cast<const PboEglDispatch*>(g_.getEglDispatch(fb));
    if (!egl_ || !egl_->makeCurrent || !egl_->currentContext || !egl_->currentDisplay || !egl_->currentSurface || !egl_->getDisplay) {
      error = "PBO: EGL dispatch unavailable"; return false;
    }
    if (!preparePboBorrow(g_, error)) return false;
#define LOAD(member, name) \
    member = reinterpret_cast<decltype(member)>(g_.glesProc(name)); \
    if (!member) { error = "PBO: missing " name; return false; }
    LOAD(genBuffers_, "glGenBuffers");
    LOAD(deleteBuffers_, "glDeleteBuffers");
    LOAD(bindBuffer_, "glBindBuffer");
    LOAD(bufferData_, "glBufferData");
    LOAD(genFramebuffers_, "glGenFramebuffers");
    LOAD(bindFramebuffer_, "glBindFramebuffer");
    LOAD(framebufferTexture_, "glFramebufferTexture2D");
    LOAD(checkFramebuffer_, "glCheckFramebufferStatus");
    LOAD(readPixels_, "glReadPixels");
    LOAD(fenceSync_, "glFenceSync");
    LOAD(clientWait_, "glClientWaitSync");
    LOAD(deleteSync_, "glDeleteSync");
    LOAD(flush_, "glFlush");
    LOAD(mapBuffer_, "glMapBufferRange");
    LOAD(unmapBuffer_, "glUnmapBuffer");
    LOAD(getError_, "glGetError");
#undef LOAD
    // Context creation touches gfxstream's shared context/config state.
    g_.lock(fb);
    g_.createSharedTrivialContext(fb, &context_, &surface_);
    display_ = egl_->getDisplay(nullptr);
    g_.unlock(fb);
    if (!context_ || !surface_ || !display_) {
      context_ = nullptr;
      error = "PBO: cannot create a shared GLES context"; return false;
    }
    // Buffer names are initialized lazily with the new context current.
    void* oldContext = egl_->currentContext();
    void* oldDisplay = oldContext ? egl_->currentDisplay() : display_;
    void* oldDraw = egl_->currentSurface(0x3059);
    void* oldRead = egl_->currentSurface(0x305a);
    if (!egl_->makeCurrent(display_, surface_, surface_, context_)) {
      context_ = nullptr;
      error = "PBO: cannot initialize GLES resources"; return false;
    }
    genBuffers_(1, &buffer_);
    genFramebuffers_(1, &fbo_);
    egl_->makeCurrent(oldDisplay, oldDraw, oldRead, oldContext);
    return true;
  }

  const Gfxstream& g_;
  const PboEglDispatch* egl_ = nullptr;
  void *context_ = nullptr, *surface_ = nullptr, *display_ = nullptr;
  uint32_t buffer_ = 0, fbo_ = 0;
  size_t bytes_ = 0;
  uint64_t count_ = 0;
  std::vector<FramePixels> pool_;
  void (*genBuffers_)(int, uint32_t*) = nullptr;
  void (*deleteBuffers_)(int, const uint32_t*) = nullptr;
  void (*bindBuffer_)(uint32_t, uint32_t) = nullptr;
  void (*bufferData_)(uint32_t, ptrdiff_t, const void*, uint32_t) = nullptr;
  void (*genFramebuffers_)(int, uint32_t*) = nullptr;
  void (*bindFramebuffer_)(uint32_t, uint32_t) = nullptr;
  void (*framebufferTexture_)(uint32_t, uint32_t, uint32_t, uint32_t, int) = nullptr;
  uint32_t (*checkFramebuffer_)(uint32_t) = nullptr;
  void (*readPixels_)(int, int, int, int, uint32_t, uint32_t, void*) = nullptr;
  void* (*fenceSync_)(uint32_t, uint32_t) = nullptr;
  uint32_t (*clientWait_)(void*, uint32_t, uint64_t) = nullptr;
  void (*deleteSync_)(void*) = nullptr;
  void (*flush_)() = nullptr;
  void* (*mapBuffer_)(uint32_t, ptrdiff_t, ptrdiff_t, uint32_t) = nullptr;
  unsigned char (*unmapBuffer_)(uint32_t) = nullptr;
  uint32_t (*getError_)() = nullptr;
};
}  // namespace expo_capture
