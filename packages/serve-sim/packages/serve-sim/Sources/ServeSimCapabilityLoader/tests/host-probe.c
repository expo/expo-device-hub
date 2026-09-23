// Loadable stand-in for a capability dylib, so the tests can prove the load loop
// reaches dlopen and that the environment is applied before it does.

#include <stdio.h>
#include <stdlib.h>

__attribute__((constructor))
static void host_probe_init(void) {
  const char *path = getenv("SERVE_SIM_HOST_PROBE_FILE");
  if (path == NULL || *path == '\0') return;
  FILE *file = fopen(path, "a");
  if (file == NULL) return;
  fputs("loaded\n", file);
  fclose(file);
}
