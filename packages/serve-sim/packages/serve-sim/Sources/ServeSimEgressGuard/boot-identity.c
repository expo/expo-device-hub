// Host-only identity probe. It does not start or control a Simulator.
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <unistd.h>

static int device_id(const char *text) {
  if (strlen(text) != 36) return 0;
  for (size_t i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (text[i] != '-') return 0; }
    else if (!((text[i] >= '0' && text[i] <= '9') || (text[i] >= 'A' && text[i] <= 'F') ||
               (text[i] >= 'a' && text[i] <= 'f'))) return 0;
  }
  return 1;
}

static int same_process(const struct proc_bsdinfo *a, const struct proc_bsdinfo *b) {
  return a->pbi_pid == b->pbi_pid && a->pbi_start_tvsec == b->pbi_start_tvsec &&
         a->pbi_start_tvusec == b->pbi_start_tvusec;
}

// Require the launchd bootstrap argument's complete device suffix, not a UDID substring.
static int device_argument(int pid, const char *suffix) {
  int mib[] = { CTL_KERN, KERN_PROCARGS2, pid };
  size_t size = 0;
  int maximum = 0;
  size_t maximum_size = sizeof maximum;
  if (sysctlbyname("kern.argmax", &maximum, &maximum_size, NULL, 0) != 0 ||
      maximum <= 0 || maximum > 1024 * 1024) return -1;
  size = (size_t)maximum;
  char *buffer = calloc(1, size + 1);
  if (!buffer) return -1;
  if (sysctl(mib, 3, buffer, &size, NULL, 0) != 0 || size < sizeof(int)) { free(buffer); return -1; }
  int argc;
  memcpy(&argc, buffer, sizeof argc);
  char *cursor = buffer + sizeof argc, *end = buffer + size;
  // Executable path and padding precede argv[0].
  size_t length = strnlen(cursor, (size_t)(end - cursor));
  cursor += length;
  while (cursor < end && !*cursor) cursor++;
  int found = 0;
  for (int i = 0; i < argc && cursor < end; i++) {
    length = strnlen(cursor, (size_t)(end - cursor));
    if (length == (size_t)(end - cursor)) break;
    size_t wanted = strlen(suffix);
    if (length >= wanted && strcasecmp(cursor + length - wanted, suffix) == 0) found = 1;
    cursor += length + 1;
  }
  free(buffer);
  return found;
}

static int scan_failure(int *pids, int pid, const char *operation, int error) {
  free(pids);
  fprintf(stderr, "%s for process %d%s%s\n", operation, pid,
          error ? ": " : "", error ? strerror(error) : "");
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 2 || !device_id(argv[1])) { fprintf(stderr, "usage: serve-sim-egress-boot-identity UDID\n"); return 2; }
  char suffix[128];
  snprintf(suffix, sizeof suffix, "/Devices/%s/data/var/run/launchd_bootstrap.plist", argv[1]);
  int bytes = proc_listpids(PROC_UID_ONLY, getuid(), NULL, 0);
  if (bytes <= 0 || bytes > INT_MAX / 2) return scan_failure(NULL, 0, "cannot size process list", 0);
  int capacity = bytes * 2;
  int *pids = calloc(1, (size_t)capacity);
  if (!pids) return scan_failure(NULL, 0, "allocate process list", errno);
  bytes = proc_listpids(PROC_UID_ONLY, getuid(), pids, capacity);
  if (bytes <= 0 || bytes >= capacity) return scan_failure(pids, 0, "incomplete process list", 0);
  struct proc_bsdinfo selected = {0};
  for (size_t i = 0; i < (size_t)bytes / sizeof(int); i++) {
    if (pids[i] <= 1) continue;
    struct proc_bsdinfo before, after;
    errno = 0;
    int count = proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &before, sizeof before);
    if (count != (int)sizeof before) {
      if (errno == ESRCH) continue;
      return scan_failure(pids, pids[i], "read process identity", errno);
    }
    if (before.pbi_uid != getuid()) continue;
    char path[PROC_PIDPATHINFO_MAXSIZE];
    errno = 0;
    if (proc_pidpath(pids[i], path, sizeof path) <= 0) {
      if (errno == ESRCH) continue;
      return scan_failure(pids, pids[i], "read process path", errno);
    }
    const char *name = strrchr(path, '/');
    if (!name || strcmp(name + 1, "launchd_sim") != 0) continue;
    int matches = device_argument(pids[i], suffix);
    if (matches < 0) return scan_failure(pids, pids[i], "read Simulator boot arguments", errno);
    if (!matches) continue;
    if (proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &after, sizeof after) != (int)sizeof after ||
        !same_process(&before, &after) || selected.pbi_pid != 0)
      return scan_failure(pids, pids[i], "cannot confirm unique Simulator boot identity", 0);
    selected = after;
  }
  free(pids);
  if (!selected.pbi_pid) { puts("null"); return 0; }
  printf("{\"pid\":%u,\"startedAt\":\"%" PRIu64 ":%" PRIu64 "\"}\n",
         selected.pbi_pid, selected.pbi_start_tvsec, selected.pbi_start_tvusec);
  return 0;
}
