// Time-zone capability: follows the zone file serve-sim writes (an IANA name or
// "host"), so a running app switches zones without a restart. A change runs
// tzset (libc, Hermes `Date`), resetSystemTimeZone (Foundation, Hermes `Intl`)
// and posts NSSystemTimeZoneDidChangeNotification, which Foundation skips here.

#import <Foundation/Foundation.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <time.h>
#include <unistd.h>

#define ZONE_FILE_VAR "SERVE_SIM_TIME_ZONE_FILE"
#define HOST_ZONE "host"
// Longer than any IANA name; anything that does not fit is not a zone.
#define MAX_ZONE 128

static char zoneFile[1024];
// The zone this process runs in: its launch TZ, then each zone applied here.
static char applied[MAX_ZONE];
// Static because ARC would otherwise release the source when watchZoneFile returns.
static dispatch_source_t watcher;

// 0 and the trimmed contents, or -1 when the file cannot be read or is not a zone.
static int readZone(char *out, size_t cap) {
  int fd = open(zoneFile, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return -1;
  ssize_t n = read(fd, out, cap - 1);
  close(fd);
  if (n < 0) return -1;
  out[n] = '\0';
  while (n > 0 && (out[n - 1] == '\n' || out[n - 1] == ' ' || out[n - 1] == '\t')) out[--n] = '\0';
  if (n == 0 || (size_t)n >= cap - 1) return -1;
  return 0;
}

// A zone file older than this process was there when it launched, so its launchd TZ is newer:
// after a reboot clears TZ, the file still names the zone set before it.
static BOOL changedSinceLaunch(void) {
  struct stat file;
  struct kinfo_proc process;
  size_t size = sizeof process;
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()};
  if (stat(zoneFile, &file) != 0) return NO;
  if (sysctl(mib, 4, &process, &size, NULL, 0) != 0) return YES;
  struct timeval start = process.kp_proc.p_starttime;
  return file.st_mtimespec.tv_sec > start.tv_sec ||
         (file.st_mtimespec.tv_sec == start.tv_sec &&
          file.st_mtimespec.tv_nsec / 1000 > start.tv_usec);
}

static void applyZone(BOOL atLoad) {
  char zone[MAX_ZONE];
  if (readZone(zone, sizeof zone) != 0 || strcmp(zone, applied) == 0) return;
  if (atLoad && !changedSinceLaunch()) return;

  if (strcmp(zone, HOST_ZONE) == 0) {
    unsetenv("TZ");
  } else if (setenv("TZ", zone, 1) != 0) {
    fprintf(stderr, "[serve-sim] could not set TZ to %s\n", zone);
    return;
  }
  strlcpy(applied, zone, sizeof applied);
  tzset();
  [NSTimeZone resetSystemTimeZone];
  [NSNotificationCenter.defaultCenter postNotificationName:NSSystemTimeZoneDidChangeNotification
                                                    object:nil];
}

// serve-sim replaces the file by rename, so watch the directory, as the loader does.
static void watchZoneFile(void) {
  char dir[sizeof zoneFile];
  strlcpy(dir, zoneFile, sizeof dir);
  char *slash = strrchr(dir, '/');
  if (slash == NULL || slash == dir) return;
  *slash = '\0';

  int fd = open(dir, O_EVTONLY);
  if (fd < 0) return;
  watcher = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_VNODE, (uintptr_t)fd, DISPATCH_VNODE_WRITE, dispatch_get_main_queue());
  if (watcher == NULL) {
    close(fd);
    return;
  }
  dispatch_source_set_event_handler(watcher, ^{ applyZone(NO); });
  dispatch_source_set_cancel_handler(watcher, ^{ close(fd); });
  dispatch_resume(watcher);
}

// The loader runs this on the main queue, after the app is past dyld and ObjC setup.
__attribute__((constructor))
static void serve_sim_time_zone_init(void) {
  const char *path = getenv(ZONE_FILE_VAR);
  if (path == NULL || *path != '/') return;
  if (strlcpy(zoneFile, path, sizeof zoneFile) >= sizeof zoneFile) return;
  const char *tz = getenv("TZ");
  strlcpy(applied, tz != NULL && *tz != '\0' ? tz : HOST_ZONE, sizeof applied);
  watchZoneFile();
  applyZone(YES);
}
