// Test capability. Appends "<pid>\t<executable path>" to SERVE_SIM_PROBE_FILE.

#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

__attribute__((constructor))
static void serve_sim_probe_init(void) {
  const char *path = getenv("SERVE_SIM_PROBE_FILE");
  if (path == NULL || *path == '\0') return;

  char executable[1024];
  uint32_t size = sizeof executable;
  if (_NSGetExecutablePath(executable, &size) != 0) return;

  FILE *file = fopen(path, "a");
  if (file == NULL) return;
  int written = fprintf(file, "%d\t%s\n", getpid(), executable);
  if (fclose(file) != 0 || written < 0) {
    fprintf(stderr, "[serve-sim] probe could not record its load in %s\n", path);
  }
}
