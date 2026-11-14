#include "../src/native/gfxstream.h"
#include "fixtures/gum/frida-gum.h"
#include <cassert>
#include <cstdio>
#include <cstring>

static GumModule module;
static bool initialized = false;
static bool ready = false;
static bool missingRequired = false;
static bool missingOptional = false;
static int polls = 0;
static int earlyDispatchLookups = 0;

static void unused() {}
static unsigned textureName(unsigned name) { return name; }
static void* frameBuffer() {
  assert(initialized && "renderer APIs must not run before its module initializers");
  if (++polls >= 3) ready = true;
  return ready ? &module : nullptr;
}
static void* glesProc(const char*) {
  // As with the renderer's lazy GLES dispatch, this is not populated at module discovery.
  if (!ready) {
    earlyDispatchLookups++;
    return nullptr;
  }
  return reinterpret_cast<void*>(&textureName);
}

const char* gum_module_get_path(GumModule*) { return "/test/libgfxstream_backend"; }
void gum_module_ensure_initialized(GumModule*) { initialized = true; }
GumAddress gum_module_find_export_by_name(GumModule*, const char* name) {
  if (strstr(name, "FrameBuffer5getFB"))
    return missingRequired ? 0 : reinterpret_cast<GumAddress>(&frameBuffer);
  if (strstr(name, "gles2_dispatch_get_proc_func_static"))
    return reinterpret_cast<GumAddress>(&glesProc);
  return reinterpret_cast<GumAddress>(&unused);
}
GumAddress gum_module_find_symbol_by_name(GumModule*, const char*) {
  return missingOptional ? 0 : reinterpret_cast<GumAddress>(&unused);
}
GumModule* gum_process_find_module_by_name(const char*) { return &module; }
GumAddress gum_module_find_global_export_by_name(const char*) {
  return reinterpret_cast<GumAddress>(&unused);
}
void g_object_unref(GumModule*) {}

int main() {
  using namespace expo_capture;
  Gfxstream delayed;
  assert(resolveGfxstream(&module, delayed).empty());
  if (!delayed.gpuEntryPointsAvailable()) {
    fputs("GPU frame path disabled: dispatch was resolved before renderer readiness\n", stderr);
    return 1;
  }
  assert(initialized && polls >= 3 && earlyDispatchLookups == 0);

  // A renderer that really lacks the optional symbols still supports CPU fallback.
  missingOptional = true;
  Gfxstream cpuOnly;
  assert(resolveGfxstream(&module, cpuOnly).empty());
  assert(!cpuOnly.gpuEntryPointsAvailable());
  // A missing required symbol disables capture rather than calling a null function.
  missingRequired = true;
  Gfxstream unsupported;
  assert(resolveGfxstream(&module, unsupported).find("missing getFB") != std::string::npos);
  puts("gfxstream waits for initialized renderer dispatch and preserves CPU fallback");
}
