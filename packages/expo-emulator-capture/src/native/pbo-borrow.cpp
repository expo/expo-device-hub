// SPDX-License-Identifier: MIT
#include "gfxstream.h"
#include "frida-gum.h"
#include <mutex>

namespace expo_capture {
namespace {
std::mutex hookMutex;
void* hookedTarget = nullptr;
thread_local void** borrowedGl = nullptr;

void onBorrow(GumInvocationContext* context, gpointer) {
  if (borrowedGl) {
    // unique_ptr is returned via a hidden result pointer: on x86-64 it precedes this;
    // arm64 carries it in x8, outside the normal argument registers.
#if defined(__x86_64__)
    *borrowedGl = gum_invocation_context_get_nth_argument(context, 1);
#else
    *borrowedGl = gum_invocation_context_get_nth_argument(context, 0);
#endif
  }
}
}  // namespace

bool preparePboBorrow(const Gfxstream& g, std::string& error) {
  if (g.colorBufferGl) return true;
  if (!g.borrowForDisplay || !g.canUseGlOps || !g.borrowedImageInfo) {
    error = "PBO: renderer lacks GL borrow entry points";
    return false;
  }
  // @ref LLP 0023#pbo-experiment — borrow the GL object without private field offsets
  // Linux emulator 37.1 exports borrowForDisplay but no getColorBufferGl. The borrow
  // calls ColorBufferGl::getBorrowedImageInfo: observe its this pointer only on the
  // calling capture thread. No ColorBuffer field offsets or foreign std::function ABI.
  std::lock_guard<std::mutex> guard(hookMutex);
  void* target = reinterpret_cast<void*>(g.borrowedImageInfo);
  if (hookedTarget == target) return true;
  if (hookedTarget) { error = "PBO: renderer changed after borrow hook installation"; return false; }
  auto* interceptor = gum_interceptor_obtain();
  auto* listener = gum_make_call_listener(onBorrow, nullptr, nullptr, nullptr);
  auto status = gum_interceptor_attach(interceptor, target, listener, nullptr);
  g_object_unref(listener);
  g_object_unref(interceptor);
  if (status != GUM_ATTACH_OK) { error = "PBO: cannot observe the renderer's GL borrow"; return false; }
  hookedTarget = target;
  return true;
}

std::unique_ptr<BorrowedImageInfo> borrowPboGlImage(const Gfxstream& g, void* cb, void*& gl) {
  if (g.colorBufferGl) {
    gl = g.colorBufferGl(cb);
    return gl ? g.borrowedImageInfo(gl) : nullptr;
  }
  if (!g.canUseGlOps(cb)) return nullptr;
  struct Restore {
    void** previous = borrowedGl;
    ~Restore() { borrowedGl = previous; }
  } restore;
  borrowedGl = &gl;
  return g.borrowForDisplay(cb, 0);  // ColorBuffer::UsedApi::kGl
}
}  // namespace expo_capture
