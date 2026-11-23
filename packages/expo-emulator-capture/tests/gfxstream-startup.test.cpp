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
static bool missingEglTable = false;
static bool missingColorBufferAccessor = false;
static bool missingDisplayBorrower = false;
static void* eglDispatch[20];

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
  if (missingColorBufferAccessor && strstr(name, "ColorBuffer16getColorBufferGl")) return 0;
  if (missingDisplayBorrower && strstr(name, "FrameBuffer27borrowColorBufferForDisplay")) return 0;
  if (strstr(name, "2gl5s_eglE"))
    return missingEglTable ? 0 : reinterpret_cast<GumAddress>(eglDispatch);
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
  for (auto& entry : eglDispatch) entry = reinterpret_cast<void*>(&unused);
  Gfxstream delayed;
  assert(resolveGfxstream(&module, delayed).empty());
  if (!delayed.gpuEntryPointsAvailable()) {
    fputs("GPU frame path disabled: dispatch was resolved before renderer readiness\n", stderr);
    return 1;
  }
  assert(initialized && polls >= 3 && earlyDispatchLookups == 0);

#if defined(EXPO_EMULATOR_CAPTURE_NVIDIA)
  // Linux emulator 37.1.11 exports the display borrower, but no ColorBufferGl accessor.
  missingColorBufferAccessor = true;
  Gfxstream linuxRenderer;
  assert(resolveGfxstream(&module, linuxRenderer).empty());
  assert(linuxRenderer.nvidiaEntryPointsAvailable());
  assert(!linuxRenderer.gpuEntryPointsAvailable());
  missingDisplayBorrower = true;
  Gfxstream unsupportedLinuxRenderer;
  assert(resolveGfxstream(&module, unsupportedLinuxRenderer).find("borrowColorBufferForDisplay") !=
         std::string::npos);
  missingDisplayBorrower = false;
  missingColorBufferAccessor = false;
#endif

  // A renderer that really lacks the optional symbols still supports CPU fallback.
  missingOptional = true;
  Gfxstream cpuOnly;
  assert(resolveGfxstream(&module, cpuOnly).empty());
#if defined(EXPO_EMULATOR_CAPTURE_NVIDIA)
  assert(cpuOnly.gpuEntryPointsAvailable());  // Exported dispatch works without local symbols.
  missingEglTable = true;
  Gfxstream noEgl;
  assert(resolveGfxstream(&module, noEgl).find("NVIDIA capture needs") != std::string::npos);
#else
  assert(!cpuOnly.gpuEntryPointsAvailable());
#endif
  // A missing required symbol disables capture rather than calling a null function.
  missingRequired = true;
  Gfxstream unsupported;
  assert(resolveGfxstream(&module, unsupported).find("missing getFB") != std::string::npos);
  puts("gfxstream waits for initialized renderer dispatch and preserves CPU fallback");
}
