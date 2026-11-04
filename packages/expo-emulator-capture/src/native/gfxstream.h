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
// C++ methods are called through plain function pointers with `this` first;
// arm64 passes the indirect result (shared_ptr, unique_ptr) in x8 either way.
struct Gfxstream {
  std::string path;
  void* postImpl = nullptr;  // Hook target: FrameBuffer::Impl::postImpl.

  void* (*getFB)() = nullptr;
  void (*lock)(void* fb) = nullptr;
  void (*unlock)(void* fb) = nullptr;
  std::shared_ptr<void> (*findColorBuffer)(void* fb, uint32_t handle) = nullptr;
  uint32_t (*lastPostedColorBuffer)(void* fb) = nullptr;
  int (*frameBufferWidth)(const void* fb) = nullptr;
  int (*frameBufferHeight)(const void* fb) = nullptr;
  void (*createSharedTrivialContext)(void* fb, void** context, void** surface) = nullptr;
  void* (*getDisplay)(const void* fb) = nullptr;
  // @ref LLP 0017#locking — takes the FrameBuffer lock itself; never call it while holding lock()
  void (*readColorBuffer)(void* fb, uint32_t handle, int x, int y, int width, int height,
                          uint32_t format, uint32_t type, void* pixels, uint64_t size) = nullptr;

  uint32_t (*colorBufferWidth)(const void* colorBuffer) = nullptr;
  uint32_t (*colorBufferHeight)(const void* colorBuffer) = nullptr;
  void* (*colorBufferGl)(void* colorBuffer) = nullptr;
  std::unique_ptr<BorrowedImageInfo> (*borrowedImageInfo)(void* colorBufferGl) = nullptr;
  void (*waitSync)(void* colorBufferGl, bool debug) = nullptr;

  // GLES translator EGL entry points. They are local (non-exported) symbols, so a
  // stripped renderer leaves them null and only the CPU frame path is available.
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

}  // namespace expo_capture
