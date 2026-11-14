// SPDX-License-Identifier: MIT
#include <cassert>
#include <cstdio>
#include <cstring>
#include <memory>
#include <vector>
#include "../src/native/pbo-readback.h"
using namespace expo_capture;
static bool locked = false;
static int waits = 0, reads = 0, maps = 0;
static int width = 4, height = 2;
static bool failMap = false;
static bool failFence = false;
static std::vector<unsigned char> storage;
static void* current = nullptr;
static void* context = reinterpret_cast<void*>(1);
static void* fb() { return context; }
static void lock(void*) { assert(!locked); locked = true; }
static void unlock(void*) { assert(locked); locked = false; }
static uint32_t w(const void*) { return width; }
static uint32_t h(const void*) { return height; }
static void* gl(void*) { return context; }
static std::unique_ptr<BorrowedImageInfo> image(void*) {
  auto info = std::make_unique<BorrowedImageInfoGl>();
  info->width = width; info->height = height; info->texture = 1;
  return info;
}
static unsigned makeCurrent(void*, void*, void*, void* ctx) { current = ctx; return 1; }
static void* getCurrent() { return current; }
static void* display() { return context; }
static void* surface(int) { return nullptr; }
static void* defaultDisplay(void*) { return context; }
static PboEglDispatch egl{nullptr, defaultDisplay, {}, makeCurrent, getCurrent, display, surface};
static const void* dispatch(void*) { return &egl; }
static void create(void*, void** ctx, void** surf) { assert(locked); *ctx = context; *surf = context; }
static void* getDisplay(const void*) { return context; }
static void gen(int, uint32_t* id) { *id = 1; }
static void del(int, const uint32_t*) {}
static void bind(uint32_t, uint32_t) {}
static void buffer(uint32_t, ptrdiff_t size, const void*, uint32_t) { storage.resize(size); }
static void attach(uint32_t, uint32_t, uint32_t, uint32_t, int) { assert(locked); }
static uint32_t complete(uint32_t) { return 0x8cd5; }
static void sync(void*, bool) { assert(locked); }
static void read(int, int, int, int, uint32_t, uint32_t, void*) {
  assert(locked); reads++;
  memset(storage.data(), reads, storage.size());
}
static void* fence(uint32_t, uint32_t) { assert(locked); return context; }
static void flush() { assert(locked); }
static uint32_t wait(void*, uint32_t flags, uint64_t) {
  assert(!locked && flags == 0); waits++;
  if (failFence) return 0x911d;
  return waits % 2 ? 0x911b : 0x911c;
}
static void release(void*) { assert(!locked); }
static void* map(uint32_t, ptrdiff_t, ptrdiff_t size, uint32_t) {
  assert(!locked && size == ptrdiff_t(storage.size())); maps++;
  return failMap ? nullptr : storage.data();
}
static unsigned char unmap(uint32_t) { assert(!locked); return 1; }
static uint32_t noError() { return 0; }
static void* proc(const char* name) {
#define PROC(n, fn) if (!strcmp(name, n)) return reinterpret_cast<void*>(&fn)
  PROC("glGenBuffers", gen); PROC("glDeleteBuffers", del); PROC("glBindBuffer", bind);
  PROC("glBufferData", buffer); PROC("glGenFramebuffers", gen); PROC("glBindFramebuffer", bind);
  PROC("glFramebufferTexture2D", attach); PROC("glCheckFramebufferStatus", complete);
  PROC("glReadPixels", read); PROC("glFenceSync", fence); PROC("glFlush", flush);
  PROC("glClientWaitSync", wait); PROC("glDeleteSync", release); PROC("glMapBufferRange", map);
  PROC("glUnmapBuffer", unmap); PROC("glGetError", noError);
  return nullptr;
}
namespace expo_capture {
void logLine(const char*, ...) noexcept {}
bool preparePboBorrow(const Gfxstream&, std::string&) { return true; }
std::unique_ptr<BorrowedImageInfo> borrowPboGlImage(const Gfxstream& g, void* cb, void*& gl) {
  gl = g.colorBufferGl(cb);
  return g.borrowedImageInfo(gl);
}
void (*ColorBufferRef::releaseShared)(void*) = nullptr;
}
// Match the renderer's libc++ shared_ptr return without requiring libc++ in this test.
static void find(void* result, void*, uint32_t) {
  // SysV C++ ABI: a non-trivial class result is the hidden first pointer.
  void* fields[] = {context, nullptr};
  memcpy(result, fields, sizeof(fields));
}
int main() {
  Gfxstream g;
  g.getFB = fb; g.lock = lock; g.unlock = unlock; g.findColorBuffer = reinterpret_cast<decltype(g.findColorBuffer)>(&find);
  g.colorBufferWidth = w; g.colorBufferHeight = h; g.colorBufferGl = gl;
  g.borrowedImageInfo = image; g.waitSync = sync; g.setSync = sync;
  g.getEglDispatch = dispatch; g.glesProc = proc;
  g.createSharedTrivialContext = create; g.getDisplay = getDisplay;
  PboReadback source(g);
  CapturedFrame first, second;
  std::string error;
  assert(source.capture(1, first, error));
  assert(!locked && !current && waits == 2 && maps == 1);
  assert(first.width == 4 && first.height == 2 && first.pixels->data[0] == 1);
  auto recording = first;  // Both roles retain the first frame across resize/reuse.
  width = 2; height = 8;
  assert(source.capture(2, second, error));
  assert(second.width == 2 && second.height == 8 && second.pixels->data.size() == 64);
  assert(first.pixels->data[0] == 1 && recording.pixels == first.pixels);
  failFence = true;
  int oldMaps = maps;
  assert(!source.capture(2, second, error));
  assert(maps == oldMaps && !locked && !current);
  failFence = false; failMap = true;
  assert(!source.capture(2, second, error));
  assert(!locked && !current);
  failMap = false;
  assert(source.capture(2, second, error));
  puts("PBO waits and maps outside the framebuffer lock, preserves retained frames, and survives errors/resizes");
}
