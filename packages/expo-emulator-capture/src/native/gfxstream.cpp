// SPDX-License-Identifier: MIT
#include "gfxstream.h"
#include <type_traits>
#include <chrono>
#include <thread>
#include "frida-gum.h"

namespace expo_capture {

#if !defined(_LIBCPP_VERSION)
void (*ColorBufferRef::releaseShared)(void* control) = nullptr;
#endif

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

#if !defined(_LIBCPP_VERSION)
// The renderer links the emulator's own libc++ (lib64/libc++.so on Linux).
bool resolveReleaseShared() {
  const char* symbol = "_ZNSt3__119__shared_weak_count16__release_sharedEv";
  GumAddress address = 0;
  for (const char* name : {"libc++.so", "libc++.so.1"}) {
    if (GumModule* libcxx = gum_process_find_module_by_name(name)) {
      address = gum_module_find_export_by_name(libcxx, symbol);
      g_object_unref(libcxx);
      if (address) break;
    }
  }
  if (!address) address = gum_module_find_global_export_by_name(symbol);
  ColorBufferRef::releaseShared = reinterpret_cast<void (*)(void*)>(address);
  return address != 0;
}
#endif

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
  // Discovery can see a partially loaded module. Do not call its exported APIs
  // until the loader has run its initializers.
  gum_module_ensure_initialized(module);
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
#if !defined(_LIBCPP_VERSION)
  if (!resolveReleaseShared())
    return "unsupported emulator renderer: libc++ __shared_weak_count::__release_shared not found";
#endif

  // @ref LLP 0020#hook-point — resolve lazy GLES dispatch only after FrameBuffer initialization
  // glGetGlobalTexName comes from s_gles2, not directly from a module export.
  // FrameBuffer initialization fills that table before publishing getFB(). Looking
  // it up at module discovery can cache a null pointer for this emulator's lifetime.
  for (int attempt = 0; attempt < 1200 && !g.getFB(); attempt++)
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  if (!g.getFB()) return "the renderer FrameBuffer was not created";

  // Entry points for the GPU frame path. Missing ones only disable that path.
  resolve(module, "_ZN9gfxstream4host11FrameBuffer26createSharedTrivialContextEPPvS3_",
          g.createSharedTrivialContext);
  resolve(module, "_ZNK9gfxstream4host11FrameBuffer10getDisplayEv", g.getDisplay);
  resolve(module, "_ZN9gfxstream4host11ColorBuffer16getColorBufferGlEv", g.colorBufferGl);
  resolve(module, "_ZN9gfxstream4host2gl13ColorBufferGl20getBorrowedImageInfoEv",
          g.borrowedImageInfo);
  resolve(module, "_ZN9gfxstream4host11ColorBuffer11canUseGlOpsEv", g.canUseGlOps);
  resolve(module, "_ZN9gfxstream4host11ColorBuffer16borrowForDisplayENS1_7UsedApiE", g.borrowForDisplay);
  resolve(module, "_ZN9gfxstream4host2gl13ColorBufferGl7setSyncEb", g.setSync);
  resolve(module, "_ZN9gfxstream4host2gl13ColorBufferGl8waitSyncEb", g.waitSync);
  resolve(module, "_ZN10translator3egl14eglMakeCurrentEPvS1_S1_S1_", g.eglMakeCurrent, true);
  resolve(module, "_ZN10translator3egl20eglGetCurrentContextEv", g.eglGetCurrentContext, true);
  resolve(module, "_ZN10translator3egl20eglGetCurrentDisplayEv", g.eglGetCurrentDisplay, true);
  resolve(module, "_ZN10translator3egl20eglGetCurrentSurfaceEi", g.eglGetCurrentSurface, true);
  resolve(module, "_ZN9gfxstream4host11FrameBuffer14getEglDispatchEv", g.getEglDispatch);
  auto& glesProc = g.glesProc;
  if (resolve(module, "_ZN9gfxstream4host2gl35gles2_dispatch_get_proc_func_staticEPKc", glesProc))
    g.getGlobalTexName = reinterpret_cast<decltype(g.getGlobalTexName)>(glesProc("glGetGlobalTexName"));
  return "";
}

}  // namespace expo_capture
