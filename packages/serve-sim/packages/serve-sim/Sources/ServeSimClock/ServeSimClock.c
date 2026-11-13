// Clock capability: follows the offset in the file serve-sim writes (milliseconds, 0 for the
// Mac's time), so an app sees a chosen date and time that keeps ticking. The capability loader
// shifts the wall clock functions that libc, Foundation and JavaScript `Date` read; this image
// only tells it the offset, because dyld does not interpose for an image the loader loads.
//
// A startup capability: inserted at exec, it sets the offset before app code runs, so it links
// libSystem only. Apps that were already running load it later. When the loader's config no
// longer lists this image, the session has ended, and the app goes back to the host time. A change posts
// NSSystemClockDidChangeNotification and the significant time change iOS sends when the clock
// is set; every process in the simulator receives that one.

#include <dispatch/dispatch.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <notify.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <unistd.h>

#include "../ServeSimCapabilityLoader/startup-capability.h"
#include "../ServeSimCapabilityLoader/wall-clock.h"

#define CLOCK_FILE_VAR "SERVE_SIM_CLOCK_FILE"
#define CONFIG_VAR "SERVE_SIM_CAPABILITIES_CONFIG"
#define MAX_CONFIG_BYTES (64 * 1024)
// About 200 years either way: past that the offset is not a date, and nanoseconds would overflow.
#define MAX_OFFSET_MS 6300000000000LL
#define CF_STRING_ENCODING_UTF8 0x08000100u

static char clockFile[1024];
static char configFile[1024];
// This image's path as dyld reports it, and resolved, as the loader compares paths.
static char imagePath[PATH_MAX];
static char imageRealPath[PATH_MAX];
static int64_t appliedMs;
static atomic_flag initialized = ATOMIC_FLAG_INIT;
static atomic_bool started;
// Set when the startup runs late, in an app that has already read the host time.
static atomic_bool lateStart;
static dispatch_source_t watchers[3];

// 0 and the offset, or -1 when the file cannot be read or is not an offset.
static int readOffset(int64_t *offsetMs) {
  char text[32];
  int fd = open(clockFile, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return -1;
  ssize_t n = read(fd, text, sizeof text - 1);
  close(fd);
  if (n <= 0) return -1;
  text[n] = '\0';
  char *end;
  errno = 0;
  long long value = strtoll(text, &end, 10);
  if (errno != 0 || end == text || (*end != '\0' && *end != '\n')) return -1;
  if (value > MAX_OFFSET_MS || value < -MAX_OFFSET_MS) return -1;
  *offsetMs = value;
  return 0;
}

// Whether a config record, startup or deferred, names this image.
static int namesThisImage(char *config) {
  char *line, *lines = config;
  while ((line = strsep(&lines, "\n")) != NULL) {
    char *fields = line;
    char *scope = strsep(&fields, "\t");
    if (scope != NULL && strcmp(scope, "startup") == 0) strsep(&fields, "\t");
    char *dylib = strsep(&fields, "\t");
    if (dylib == NULL || *dylib != '/') continue;
    if (strcmp(dylib, imagePath) == 0) return 1;
    char real[PATH_MAX];
    if (realpath(dylib, real) != NULL && strcmp(real, imageRealPath) == 0) return 1;
  }
  return 0;
}

// Whether the loader's config still names this image. A config that cannot be read counts as
// listed, so a failed read never drops the time.
static int stillListed(void) {
  int fd = open(configFile, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return errno != ENOENT;
  char *config = malloc(MAX_CONFIG_BYTES);
  if (config == NULL) {
    close(fd);
    return 1;
  }
  ssize_t n = read(fd, config, MAX_CONFIG_BYTES - 1);
  close(fd);
  int listed = n < 0 || n == MAX_CONFIG_BYTES - 1;
  if (n >= 0) {
    config[n] = '\0';
    listed = listed || namesThisImage(config);
  }
  free(config);
  return listed;
}

// An offset file newer than this process was set while it ran: an app that was already running
// loads this image when the clock is first set, and that is a change it must hear about.
static int changedSinceLaunch(void) {
  struct stat file;
  struct kinfo_proc process;
  size_t size = sizeof process;
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()};
  if (stat(clockFile, &file) != 0) return 0;
  if (sysctl(mib, 4, &process, &size, NULL, 0) != 0) return 1;
  struct timeval start = process.kp_proc.p_starttime;
  return file.st_mtimespec.tv_sec > start.tv_sec ||
         (file.st_mtimespec.tv_sec == start.tv_sec &&
          file.st_mtimespec.tv_nsec / 1000 > start.tv_usec);
}

// Through CoreFoundation's local center, which Foundation observers share. Looked up at run
// time, because a startup image links libSystem only; an app always has CoreFoundation.
static void postClockChange(void) {
  void *(*center)(void) = (void *(*)(void))dlsym(RTLD_DEFAULT, "CFNotificationCenterGetLocalCenter");
  void (*post)(void *, const void *, const void *, const void *, unsigned char) =
      (void (*)(void *, const void *, const void *, const void *, unsigned char))dlsym(
          RTLD_DEFAULT, "CFNotificationCenterPostNotification");
  const void *(*create)(const void *, const char *, uint32_t) =
      (const void *(*)(const void *, const char *, uint32_t))dlsym(RTLD_DEFAULT,
                                                                   "CFStringCreateWithCString");
  void (*release)(const void *) = (void (*)(const void *))dlsym(RTLD_DEFAULT, "CFRelease");
  if (center != NULL && post != NULL && create != NULL && release != NULL) {
    const void *name = create(NULL, "NSSystemClockDidChangeNotification", CF_STRING_ENCODING_UTF8);
    if (name != NULL) {
      post(center(), name, NULL, NULL, 1);
      release(name);
    }
  }
  // After the change, so this process refreshes at the new time even when another app posted first.
  notify_post("SignificantTimeChangeNotification");
}

static void applyOffset(int atLoad) {
  int64_t offsetMs = 0;
  if (stillListed() && readOffset(&offsetMs) != 0) return;
  if (offsetMs == appliedMs) return;
  appliedMs = offsetMs;
  serve_sim_set_wall_clock_offset(offsetMs * (int64_t)NSEC_PER_MSEC);
  if (atLoad && !changedSinceLaunch()) return;
  // Not from inside a constructor: observers run on the main queue.
  dispatch_async(dispatch_get_main_queue(), ^{ postClockChange(); });
}

// serve-sim and the loader replace their files by rename, so watch each directory.
static void watchDirectory(size_t slot, const char *file, dispatch_block_t handler) {
  char dir[sizeof clockFile];
  if (strlcpy(dir, file, sizeof dir) >= sizeof dir) return;
  char *slash = strrchr(dir, '/');
  if (slash == NULL || slash == dir) return;
  *slash = '\0';

  int fd = open(dir, O_EVTONLY);
  if (fd < 0) return;
  dispatch_source_t watcher = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_VNODE, (uintptr_t)fd, DISPATCH_VNODE_WRITE, dispatch_get_main_queue());
  if (watcher == NULL) {
    close(fd);
    return;
  }
  dispatch_source_set_event_handler(watcher, handler);
  dispatch_source_set_cancel_handler(watcher, ^{ close(fd); });
  dispatch_resume(watcher);
  watchers[slot] = watcher;
}

// The loader calls this for an app it applies to, with this capability's environment set.
static void initializeClock(void) {
  if (atomic_flag_test_and_set(&initialized)) return;
  atomic_store(&started, true);
  // Only the loader can shift the clock.
  if (serve_sim_set_wall_clock_offset == NULL) return;
  const char *path = getenv(CLOCK_FILE_VAR);
  const char *config = getenv(CONFIG_VAR);
  Dl_info image;
  if (path == NULL || *path != '/' || config == NULL || *config != '/') return;
  if (!dladdr((const void *)initializeClock, &image) || image.dli_fname == NULL) return;
  if (strlcpy(clockFile, path, sizeof clockFile) >= sizeof clockFile ||
      strlcpy(configFile, config, sizeof configFile) >= sizeof configFile ||
      strlcpy(imagePath, image.dli_fname, sizeof imagePath) >= sizeof imagePath) {
    return;
  }
  if (realpath(imagePath, imageRealPath) == NULL) strlcpy(imageRealPath, imagePath, sizeof imageRealPath);
  // Watch first, then read, so a change between the two is not missed.
  watchDirectory(0, clockFile, ^{ applyOffset(0); });
  watchDirectory(1, configFile, ^{ applyOffset(0); });
  applyOffset(atomic_load(&lateStart) ? 0 : 1);
}

// The loader may insert this image before it writes the config record that names it, so in an
// app that starts in between, each config change tries the startup again until it runs.
__attribute__((constructor)) static void registerClock(void) {
  if (serve_sim_startup == NULL) return;
  serve_sim_startup(initializeClock);
  if (atomic_load(&started)) return;
  const char *tmp = getenv("TMPDIR");
  const char *config = getenv(CONFIG_VAR);
  if (tmp == NULL || strstr(tmp, "/Containers/Data/Application/") == NULL) return;
  if (config == NULL || *config != '/') return;
  watchDirectory(2, config, ^{
    if (atomic_load(&started)) return;
    atomic_store(&lateStart, true);
    serve_sim_startup(initializeClock);
    if (atomic_load(&started)) dispatch_source_cancel(watchers[2]);
  });
}
