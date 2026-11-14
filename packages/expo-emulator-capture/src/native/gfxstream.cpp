// SPDX-License-Identifier: MIT
#include "gfxstream.h"
#include <type_traits>
#include "frida-gum.h"

namespace expo_capture {

namespace {

// The mangled parameter type of uint64_t: unsigned long long on macOS, unsigned
// long on Linux x86-64.
constexpr const char* kReadColorBufferDeprecated =
    std::is_same<uint64_t, unsigned long long>::value
        ? "_ZN9gfxstream4host11FrameBuffer25readColorBufferDeprecatedEjiiiijjPvy"
        : "_ZN9gfxstream4host11FrameBuffer25readColorBufferDeprecatedEjiiiijjPvm";

template <class T> bool resolve(GumModule* module, const char* name, T& out, bool local = false) {
  GumAddress address = local ? gum_module_find_symbol_by_name(module, name)
                             : gum_module_find_export_by_name(module, name);
  out = reinterpret_cast<T>(address);
  return address != 0;
}


}  // namespace

bool colorBufferSize(const Gfxstream& g, uint32_t handle, int& width, int& height) {
  void* fb = g.getFB();
  if (!fb || !handle) return false;
  auto colorBuffer = g.findColorBuffer(fb, handle);
  if (!colorBuffer) return false;
  width = int(g.colorBufferWidth(colorBuffer.get()));
  height = int(g.colorBufferHeight(colorBuffer.get()));
  return width >= 2 && height >= 2;
}

uint32_t lastPostedHandle(const Gfxstream& g) {
  void* fb = g.getFB();
  if (!fb) return 0;
  g.lock(fb);
  uint32_t handle = g.lastPostedColorBuffer(fb);
  g.unlock(fb);
  return handle;
}

std::string resolveGfxstream(GumModule* module, Gfxstream& g) {
  g.path = gum_module_get_path(module);
  struct Required {
    const char* name;
    bool ok;
  };
  // Entry points that every capture path needs.
  Required required[] = {
      {"postImpl",
       resolve(module,
               "_ZN9gfxstream4host11FrameBuffer4Impl8postImplEjNSt3__18functionIFvNS3_"
               "13shared_futureIvEEEEEbb",
               g.postImpl)},
      {"getFB", resolve(module, "_ZN9gfxstream4host11FrameBuffer5getFBEv", g.getFB)},
      {"lock", resolve(module, "_ZN9gfxstream4host11FrameBuffer4lockEv", g.lock)},
      {"unlock", resolve(module, "_ZN9gfxstream4host11FrameBuffer6unlockEv", g.unlock)},
      {"findColorBuffer",
       resolve(module, "_ZN9gfxstream4host11FrameBuffer15findColorBufferEj", g.findColorBuffer)},
      {"getLastPostedColorBuffer",
       resolve(module, "_ZN9gfxstream4host11FrameBuffer24getLastPostedColorBufferEv",
               g.lastPostedColorBuffer)},
      {"getWidth", resolve(module, "_ZNK9gfxstream4host11FrameBuffer8getWidthEv", g.frameBufferWidth)},
      {"getHeight",
       resolve(module, "_ZNK9gfxstream4host11FrameBuffer9getHeightEv", g.frameBufferHeight)},
      {"readColorBufferDeprecated",
       resolve(module, kReadColorBufferDeprecated, g.readColorBuffer)},
      {"ColorBuffer::getWidth",
       resolve(module, "_ZNK9gfxstream4host11ColorBuffer8getWidthEv", g.colorBufferWidth)},
      {"ColorBuffer::getHeight",
       resolve(module, "_ZNK9gfxstream4host11ColorBuffer9getHeightEv", g.colorBufferHeight)},
  };
  for (const auto& entry : required) {
    if (!entry.ok)
      return std::string("unsupported emulator renderer: missing ") + entry.name + " in " + g.path;
  }

  // Entry points for the GPU frame path. Missing ones only disable that path.
  resolve(module, "_ZN9gfxstream4host11FrameBuffer26createSharedTrivialContextEPPvS3_",
          g.createSharedTrivialContext);
  resolve(module, "_ZNK9gfxstream4host11FrameBuffer10getDisplayEv", g.getDisplay);
  resolve(module, "_ZN9gfxstream4host11ColorBuffer16getColorBufferGlEv", g.colorBufferGl);
  resolve(module, "_ZN9gfxstream4host2gl13ColorBufferGl20getBorrowedImageInfoEv",
          g.borrowedImageInfo);
  resolve(module, "_ZN9gfxstream4host2gl13ColorBufferGl8waitSyncEb", g.waitSync);
  resolve(module, "_ZN10translator3egl14eglMakeCurrentEPvS1_S1_S1_", g.eglMakeCurrent, true);
  resolve(module, "_ZN10translator3egl20eglGetCurrentContextEv", g.eglGetCurrentContext, true);
  resolve(module, "_ZN10translator3egl20eglGetCurrentDisplayEv", g.eglGetCurrentDisplay, true);
  resolve(module, "_ZN10translator3egl20eglGetCurrentSurfaceEi", g.eglGetCurrentSurface, true);
  void* (*glesProc)(const char*) = nullptr;
  if (resolve(module, "_ZN9gfxstream4host2gl35gles2_dispatch_get_proc_func_staticEPKc", glesProc))
    g.getGlobalTexName = reinterpret_cast<decltype(g.getGlobalTexName)>(glesProc("glGetGlobalTexName"));
  return "";
}

}  // namespace expo_capture
