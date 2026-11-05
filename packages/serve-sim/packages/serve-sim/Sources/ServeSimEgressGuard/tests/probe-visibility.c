// Deterministic visibility failures for the real probe's process enumeration.
#include <errno.h>
#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int proc_listpids(uint32_t type, uint32_t uid, void *buffer, int bytes) {
  if (type != PROC_UID_ONLY || uid != getuid()) {
    fprintf(stderr, "probe must enumerate only its own UID\n");
    errno = EINVAL;
    return -1;
  }
  if (!buffer) return (int)sizeof(int);
  if (bytes < (int)sizeof(int)) return -1;
  *(int *)buffer = 424242;
  return (int)sizeof(int);
}

int proc_pidinfo(int pid, int flavor, uint64_t argument, void *buffer, int bytes) {
  (void)pid; (void)flavor; (void)argument; (void)buffer; (void)bytes;
  const char *failure = getenv("EG_TEST_PROBE_ERROR");
  errno = failure && strcmp(failure, "ESRCH") == 0 ? ESRCH : EPERM;
  return 0;
}
