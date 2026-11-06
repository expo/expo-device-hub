// SPDX-License-Identifier: MIT
// Private gfxstream renderer entry points used by the capture agent.
// These are emulator internals, not a supported API: every symbol is resolved by
// name at runtime, and a missing symbol disables capture instead of guessing.
#pragma once
#include <cstdint>
#include <memory>
#include <string>

typedef struct _GumModule GumModule;

namespace expo_capture {

#if defined(_LIBCPP_VERSION)
// The agent and the renderer both use libc++, so the types match.
using ColorBufferRef = std::shared_ptr<void>;
#else
// @ref LLP 0018#c-runtime — the renderer's libc++ std::shared_ptr, held by its layout
// The renderer returns std::shared_ptr<ColorBuffer> from libc++, and this agent is
// built against another C++ library. This class has the same layout (element,
// control block) and, like it, is returned through a hidden pointer, because its
// destructor is user-provided. It drops its reference through the renderer's libc++.
class ColorBufferRef {
 public:
  ColorBufferRef() = default;
  ColorBufferRef(const ColorBufferRef&) = delete;
  ColorBufferRef& operator=(const ColorBufferRef&) = delete;
  ~ColorBufferRef() {
    if (control_) releaseShared(control_);
  }
  void* get() const { return element_; }
  explicit operator bool() const { return element_ != nullptr; }

  // std::__1::__shared_weak_count::__release_shared(), from the renderer's libc++.
  static void (*releaseShared)(void* control);

 private:
  void* element_ = nullptr;
  void* control_ = nullptr;
};
#endif

// Leading fields of gfxstream's BorrowedImageInfo and BorrowedImageInfoGl.
// Adapted interface layout (Apache-2.0); see ../../THIRD_PARTY_LICENSES.md.
struct BorrowedImageInfo {
  virtual ~BorrowedImageInfo() = default;
  uint32_t id = 0;
  uint32_t width = 0;
  uint32_t height = 0;
};
struct BorrowedImageInfoGl : BorrowedImageInfo {
  uint32_t texture = 0;
};

// The public FrameBuffer methods take the FrameBuffer singleton from getFB().
// C++ methods are called through plain function pointers with `this` first. A
// class result (shared_ptr, unique_ptr) comes back through a hidden pointer either
// way: in x8 on arm64, and as a first argument before `this` on x86-64.
struct Gfxstream {
  std::string path;
  void* postImpl = nullptr;  // Hook target: FrameBuffer::Impl::postImpl.

  void* (*getFB)() = nullptr;
  void (*lock)(void* fb) = nullptr;
  void (*unlock)(void* fb) = nullptr;
  ColorBufferRef (*findColorBuffer)(void* fb, uint32_t handle) = nullptr;
  uint32_t (*lastPostedColorBuffer)(void* fb) = nullptr;
  int (*frameBufferWidth)(const void* fb) = nullptr;
  int (*frameBufferHeight)(const void* fb) = nullptr;
  void (*createSharedTrivialContext)(void* fb, void** context, void** surface) = nullptr;
  void* (*getDisplay)(const void* fb) = nullptr;
  // @ref LLP 0020#locking — takes the FrameBuffer lock itself; never call it while holding lock()
  void (*readColorBuffer)(void* fb, uint32_t handle, int x, int y, int width, int height,
                          uint32_t format, uint32_t type, void* pixels, uint64_t size) = nullptr;

  uint32_t (*colorBufferWidth)(const void* colorBuffer) = nullptr;
  uint32_t (*colorBufferHeight)(const void* colorBuffer) = nullptr;
  void* (*colorBufferGl)(void* colorBuffer) = nullptr;
  std::unique_ptr<BorrowedImageInfo> (*borrowedImageInfo)(void* colorBufferGl) = nullptr;
  void (*waitSync)(void* colorBufferGl, bool debug) = nullptr;

  // GLES translator EGL entry points, for the macOS GPU path. They are local
  // (non-exported) symbols, so a stripped renderer leaves them null and only the CPU
  // frame path is available.
  unsigned (*eglMakeCurrent)(void* display, void* draw, void* read, void* context) = nullptr;
  void* (*eglGetCurrentContext)() = nullptr;
  void* (*eglGetCurrentDisplay)() = nullptr;
  void* (*eglGetCurrentSurface)(int which) = nullptr;
  unsigned (*getGlobalTexName)(unsigned localName) = nullptr;

  bool gpuEntryPointsAvailable() const {
    return eglMakeCurrent && eglGetCurrentContext && eglGetCurrentDisplay &&
           eglGetCurrentSurface && getGlobalTexName && createSharedTrivialContext && getDisplay &&
           colorBufferGl && borrowedImageInfo && waitSync;
  }
};

// Resolves the renderer entry points. Returns an empty string on success, or the
// reason capture cannot run with this emulator build.
std::string resolveGfxstream(GumModule* module, Gfxstream& out);

// Reads a color buffer's native size without copying pixels.
bool colorBufferSize(const Gfxstream& g, uint32_t handle, int& width, int& height);

// The renderer's last-post field is not atomic; readers outside the renderer take its lock.
uint32_t lastPostedHandle(const Gfxstream& g);

}  // namespace expo_capture
