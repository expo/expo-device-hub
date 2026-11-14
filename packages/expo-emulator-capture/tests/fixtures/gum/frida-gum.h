// A symbol provider for tests of the real gfxstream resolver, without loading Gum or QEMU.
#pragma once
#include <cstdint>
using GumAddress = uintptr_t;
struct _GumModule {};
using GumModule = _GumModule;
const char* gum_module_get_path(GumModule* module);
void gum_module_ensure_initialized(GumModule* module);
GumAddress gum_module_find_symbol_by_name(GumModule* module, const char* name);
GumAddress gum_module_find_export_by_name(GumModule* module, const char* name);
GumModule* gum_process_find_module_by_name(const char* name);
GumAddress gum_module_find_global_export_by_name(const char* name);
void g_object_unref(GumModule* module);
