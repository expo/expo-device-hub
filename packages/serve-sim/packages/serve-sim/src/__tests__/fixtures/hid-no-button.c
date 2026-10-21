#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

// Hide one required button symbol without altering the digitizer or addon.
static void *without_button(void *handle, const char *name) {
  if (strcmp(name, "$s10CoreDevice9HIDButtonP16sendCustomButton9usagePage0G4Code5stateySi_SiAA0C5StateOtKFTj") == 0) {
    puts("[test] CoreDevice button symbol hidden");
    return NULL;
  }
  return dlsym(handle, name);
}

__attribute__((used, section("__DATA,__interpose")))
static const struct { const void *replacement; const void *original; } interpose = {
  (const void *)without_button, (const void *)dlsym,
};
