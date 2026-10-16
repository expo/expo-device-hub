#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

// Hide one required keyboard symbol without altering the digitizer or addon.
static void *without_keyboard(void *handle, const char *name) {
  if (strcmp(name, "$s10CoreDevice20HIDKeyboardUsageCodeVMa") == 0) {
    puts("[test] CoreDevice keyboard symbol hidden");
    return NULL;
  }
  return dlsym(handle, name);
}

__attribute__((used, section("__DATA,__interpose")))
static const struct { const void *replacement; const void *original; } interpose = {
  (const void *)without_keyboard, (const void *)dlsym,
};
