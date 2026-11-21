// Inserted into every simulator process via launchd DYLD_INSERT_LIBRARIES, so
// it links libSystem only: a Foundation-linked insert crash-loops GSSCred, and
// loading UIKit from the constructor crashes Safari on headless boots. Capability
// dylibs load on the main queue after the constructor returns.
//
// Config format, one capability per line, written by the launch manager:
//   <user|all>\t<dylib>\t[KEY=VALUE;KEY=VALUE]\t<delay-ms>
// Startup images prefix their record with startup\t and register without dlopen.
//
// The launch manager sets SERVE_SIM_CAPABILITIES_CONFIG alongside the insert,
// per simulator, so the config can live with the rest of serve-sim's state
// rather than inside the installed package.

#include <dispatch/dispatch.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <mach-o/dyld.h>
#include <mach-o/loader.h>
#include <pthread.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <limits.h>

#include "wall-clock.h"

#define CONFIG_VAR "SERVE_SIM_CAPABILITIES_CONFIG"
#define MAX_CONFIG_BYTES (64 * 1024)
// A capability that links UIKit asks to be loaded late; one that links only
// libSystem does not have to wait for it.
#define MAX_LOAD_DELAY_MS 10000
#define MAX_CAPABILITIES 64

// ─── Wall clock ───
// The clock capability shifts the wall clock through these wrappers. They live here because
// dyld interposes only for images inserted at launch, never for a capability it loads later.
// With no offset set they pass straight through. Monotonic clocks are never shifted.

static _Atomic int64_t wall_clock_offset_ns;

// libdispatch reads the wall clock itself to judge its wall deadlines, and the kernel judges
// them with the real clock, so libdispatch's own reads stay real.
static uintptr_t dispatch_text_start, dispatch_text_end;

static void find_dispatch_text(void) {
  if (dispatch_text_end != 0) return;
  for (uint32_t i = 0; i < _dyld_image_count(); i++) {
    const char *name = _dyld_get_image_name(i);
    const char *base = name ? strrchr(name, '/') : NULL;
    if (base == NULL || strcmp(base, "/libdispatch.dylib") != 0) continue;
    const struct mach_header_64 *header = (const struct mach_header_64 *)_dyld_get_image_header(i);
    const struct load_command *command = (const struct load_command *)(header + 1);
    for (uint32_t c = 0; c < header->ncmds; c++) {
      const struct segment_command_64 *segment = (const struct segment_command_64 *)command;
      if (command->cmd == LC_SEGMENT_64 && strcmp(segment->segname, "__TEXT") == 0) {
        // __TEXT starts with the header.
        dispatch_text_start = (uintptr_t)header;
        dispatch_text_end = (uintptr_t)header + segment->vmsize;
        return;
      }
      command = (const struct load_command *)((const char *)command + command->cmdsize);
    }
    return;
  }
}

void serve_sim_set_wall_clock_offset(int64_t offset_ns) {
  find_dispatch_text();
  atomic_store_explicit(&wall_clock_offset_ns, offset_ns, memory_order_release);
}

/**
 * The offset for a read from `caller`: none for libdispatch. Known limit: a clock read that is
 * the last call of a dispatch block can compile to a tail call, which returns into libdispatch,
 * so that read is real.
 */
static int64_t offset_for(const void *caller) {
  int64_t offset_ns = atomic_load_explicit(&wall_clock_offset_ns, memory_order_acquire);
  uintptr_t address = (uintptr_t)caller;
  if (offset_ns != 0 && address >= dispatch_text_start && address < dispatch_text_end) return 0;
  return offset_ns;
}

// In seconds and nanoseconds apart, so no time overflows. A time the shift would take past
// the range, such as a "wait forever" deadline, stays as it is.
static void shift_wall_clock(struct timespec *time, int64_t offset_ns) {
  int64_t sec = offset_ns / (int64_t)NSEC_PER_SEC;
  long nsec = time->tv_nsec + (long)(offset_ns % (int64_t)NSEC_PER_SEC);
  if (nsec >= (long)NSEC_PER_SEC) {
    nsec -= (long)NSEC_PER_SEC;
    sec += 1;
  } else if (nsec < 0) {
    nsec += (long)NSEC_PER_SEC;
    sec -= 1;
  }
  time_t shifted;
  if (__builtin_add_overflow(time->tv_sec, (time_t)sec, &shifted)) return;
  time->tv_sec = shifted;
  time->tv_nsec = nsec;
}

// Calls from this image reach the real functions, so each wrapper shifts the time once.
static int shifted_clock_gettime(clockid_t clock, struct timespec *time) {
  int result = clock_gettime(clock, time);
  int64_t offset_ns = offset_for(__builtin_return_address(0));
  if (offset_ns != 0 && result == 0 && time != NULL && clock == CLOCK_REALTIME)
    shift_wall_clock(time, offset_ns);
  return result;
}

static uint64_t shifted_clock_gettime_nsec_np(clockid_t clock) {
  uint64_t ns = clock_gettime_nsec_np(clock);
  int64_t offset_ns = offset_for(__builtin_return_address(0));
  if (offset_ns == 0 || clock != CLOCK_REALTIME || ns == 0) return ns;
  return ns + (uint64_t)offset_ns;
}

static int shifted_gettimeofday(struct timeval *time, void *zone) {
  int result = gettimeofday(time, zone);
  int64_t offset_ns = offset_for(__builtin_return_address(0));
  if (offset_ns == 0 || result != 0 || time == NULL) return result;
  struct timespec spec = {time->tv_sec, (long)time->tv_usec * 1000};
  shift_wall_clock(&spec, offset_ns);
  time->tv_sec = spec.tv_sec;
  time->tv_usec = (suseconds_t)(spec.tv_nsec / 1000);
  return result;
}

static time_t shifted_time(time_t *out) {
  struct timespec now;
  if (clock_gettime(CLOCK_REALTIME, &now) != 0) return time(out);
  shift_wall_clock(&now, offset_for(__builtin_return_address(0)));
  if (out != NULL) *out = now.tv_sec;
  return now.tv_sec;
}

// libc's own calls to clock_gettime stay inside its image, where dyld does not interpose.
static int shifted_timespec_get(struct timespec *time, int base) {
  int result = timespec_get(time, base);
  int64_t offset_ns = offset_for(__builtin_return_address(0));
  if (offset_ns != 0 && result == TIME_UTC && time != NULL) shift_wall_clock(time, offset_ns);
  return result;
}

// Deadlines that callers build from the shifted clock move back by the offset, because
// libpthread and the kernel judge them with the real one. Without this a later time hangs a
// timed wait, and an earlier one ends it at once.
static int shifted_pthread_cond_timedwait(pthread_cond_t *cond, pthread_mutex_t *mutex,
                                          const struct timespec *deadline) {
  int64_t offset_ns = offset_for(__builtin_return_address(0));
  if (offset_ns == 0 || deadline == NULL) return pthread_cond_timedwait(cond, mutex, deadline);
  struct timespec real = *deadline;
  shift_wall_clock(&real, -offset_ns);
  return pthread_cond_timedwait(cond, mutex, &real);
}

// Without a time, libdispatch reads its own, real clock.
static dispatch_time_t shifted_dispatch_walltime(const struct timespec *when, int64_t delta) {
  int64_t offset_ns = offset_for(__builtin_return_address(0));
  if (offset_ns == 0 || when == NULL) return dispatch_walltime(when, delta);
  struct timespec real = *when;
  shift_wall_clock(&real, -offset_ns);
  return dispatch_walltime(&real, delta);
}

__attribute__((used)) static const struct {
  const void *replacement;
  const void *original;
} wall_clock_interposers[] __attribute__((section("__DATA,__interpose"))) = {
    {(const void *)shifted_clock_gettime, (const void *)clock_gettime},
    {(const void *)shifted_clock_gettime_nsec_np, (const void *)clock_gettime_nsec_np},
    {(const void *)shifted_gettimeofday, (const void *)gettimeofday},
    {(const void *)shifted_time, (const void *)time},
    {(const void *)shifted_timespec_get, (const void *)timespec_get},
    {(const void *)shifted_pthread_cond_timedwait, (const void *)pthread_cond_timedwait},
    {(const void *)shifted_dispatch_walltime, (const void *)dispatch_walltime},
};

// 0 read the whole file, 1 the file did not fit, -1 could not read it.
static int read_config(const char *path, char *out, size_t cap) {
  int fd;
  do {
    fd = open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW);
  } while (fd < 0 && errno == EINTR);
  if (fd < 0) return -1;

  // Only a real file. A fifo or device would give this thread a read that never ends.
  struct stat info;
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode)) {
    close(fd);
    return -1;
  }

  size_t used = 0;
  int truncated = 0;
  for (;;) {
    ssize_t n = read(fd, out + used, cap - 1 - used);
    if (n < 0) {
      if (errno == EINTR) continue;
      close(fd);
      return -1;
    }
    if (n == 0) break;
    used += (size_t)n;
    if (used >= cap - 1) { truncated = 1; break; }
  }
  close(fd);
  out[used] = '\0';
  return truncated;
}

static int apply_env(char *pairs) {
  int failed = 0;
  char *pair, *rest = pairs;
  while ((pair = strsep(&rest, ";")) != NULL) {
    if (*pair == '\0') continue;
    char *eq = strchr(pair, '=');
    if (eq == NULL) continue;
    *eq = '\0';
    if (setenv(pair, eq + 1, 1) != 0) {
      fprintf(stderr, "[serve-sim] could not set %s for a capability\n", pair);
      failed = 1;
    }
  }
  return failed;
}

// An app the user installed lives under the device's own Bundle container; an
// Apple app ships inside the runtime, under RuntimeRoot.
#define USER_APP_MARKER "/Containers/Bundle/Application/"

static unsigned parse_delay_ms(const char *text) {
  if (text == NULL || *text == '\0') return 0;
  char *end = NULL;
  errno = 0;
  long value = strtol(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value < 0) return 0;
  if (value > MAX_LOAD_DELAY_MS) return MAX_LOAD_DELAY_MS;
  return (unsigned)value;
}

static int capability_applies(char *line, const char *exec_path, char **dylib_out,
                             char **env_out, unsigned *delay_ms_out) {
  if (*line == '\0' || *line == '#') return 0;

  char *fields = line;
  char *scope = strsep(&fields, "\t");
  char *dylib = strsep(&fields, "\t");
  char *env = strsep(&fields, "\t");
  char *delay = strsep(&fields, "\t");
  if (dylib == NULL || *dylib == '\0') return 0;
  if (*dylib != '/') {
    fprintf(stderr, "[serve-sim] ignoring capability path that is not absolute: %s\n", dylib);
    return 0;
  }

  // `all` needs no check of its own: the constructor already refused anything
  // that is not an app. An unknown scope loads nowhere.
  if (strcmp(scope, "user") == 0) {
    if (strstr(exec_path, USER_APP_MARKER) == NULL) return 0;
  } else if (strcmp(scope, "all") != 0) {
    fprintf(stderr, "[serve-sim] ignoring capability with unknown scope '%s': %s\n", scope, dylib);
    return 0;
  }

  *dylib_out = dylib;
  *env_out = env;
  *delay_ms_out = parse_delay_ms(delay);
  return 1;
}

struct CapabilityLoad {
  char *dylib;
  char *env;
  unsigned delay_ms;
  uint64_t generation;
  int loaded;
  int pending;
};

struct Load {
  char exec_path[1024];
  char config_path[1024];
  uint64_t next_generation;
  struct CapabilityLoad capabilities[MAX_CAPABILITIES];
};

static void load_capabilities(struct Load *load);

static void load_one(struct CapabilityLoad *capability) {
  capability->pending = 0;
  char *env = strdup(capability->env);
  if (env == NULL) return;
  int failed = apply_env(env);
  free(env);
  if (failed) {
    fprintf(stderr, "[serve-sim] not loading %s: its environment is incomplete\n",
            capability->dylib);
    return;
  }
  if (dlopen(capability->dylib, RTLD_NOW | RTLD_LOCAL) == NULL) {
    fprintf(stderr, "[serve-sim] could not load %s: %s\n", capability->dylib, dlerror());
    return;
  }
  capability->loaded = 1;
}

static void load_capabilities(struct Load *load) {
  char *config = malloc(MAX_CONFIG_BYTES);
  if (config == NULL) return;
  int status = read_config(load->config_path, config, MAX_CONFIG_BYTES);
  if (status != 0) {
    if (status > 0) {
      fprintf(stderr, "[serve-sim] %s exceeds %d bytes; no capabilities loaded.\n",
              load->config_path, MAX_CONFIG_BYTES);
    }
    config[0] = '\0';
  }

  struct CapabilityLoad desired[MAX_CAPABILITIES];
  size_t count = 0;
  char *line, *lines = config;
  while ((line = strsep(&lines, "\n")) != NULL) {
    if (strncmp(line, "startup\t", 8) == 0) continue;
    char *dylib, *env;
    unsigned delay_ms;
    if (!capability_applies(line, load->exec_path, &dylib, &env, &delay_ms)) continue;
    if (count == MAX_CAPABILITIES) {
      fprintf(stderr, "[serve-sim] more than %d capabilities apply; ignoring the rest.\n",
              MAX_CAPABILITIES);
      break;
    }
    desired[count++] = (struct CapabilityLoad){
      .dylib = dylib, .env = env ? env : "", .delay_ms = delay_ms,
    };
  }
  for (size_t i = 0; i < MAX_CAPABILITIES; i++) {
    struct CapabilityLoad *capability = &load->capabilities[i];
    if (capability->dylib == NULL || capability->loaded) continue;
    size_t j = 0;
    while (j < count && strcmp(capability->dylib, desired[j].dylib) != 0) j++;
    if (j == count) {
      free(capability->dylib);
      free(capability->env);
      *capability = (struct CapabilityLoad){0};
    }
  }
  for (size_t entry = 0; entry < count; entry++) {
    char *dylib = desired[entry].dylib;
    char *env = desired[entry].env;
    unsigned delay_ms = desired[entry].delay_ms;
    struct CapabilityLoad *capability = NULL;
    for (size_t i = 0; i < MAX_CAPABILITIES; i++) {
      if (load->capabilities[i].dylib && strcmp(load->capabilities[i].dylib, dylib) == 0) {
        capability = &load->capabilities[i];
        break;
      }
    }
    if (capability && (capability->loaded ||
        (capability->pending && capability->delay_ms == delay_ms && strcmp(capability->env, env) == 0))) {
      continue;
    }
    if (capability == NULL) {
      for (size_t i = 0; i < MAX_CAPABILITIES; i++) {
        if (load->capabilities[i].dylib == NULL) {
          capability = &load->capabilities[i];
          break;
        }
      }
    }
    if (capability == NULL) {
      fprintf(stderr, "[serve-sim] capability load limit reached; ignoring %s\n", dylib);
      continue;
    }
    char *dylib_copy = strdup(dylib);
    char *env_copy = strdup(env);
    if (dylib_copy == NULL || env_copy == NULL) {
      free(dylib_copy);
      free(env_copy);
      continue;
    }
    free(capability->dylib);
    free(capability->env);
    *capability = (struct CapabilityLoad){
      .dylib = dylib_copy, .env = env_copy, .delay_ms = delay_ms,
      .generation = ++load->next_generation,
    };
    if (delay_ms == 0) {
      load_one(capability);
    } else {
      capability->pending = 1;
      uint64_t generation = capability->generation;
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)delay_ms * (int64_t)NSEC_PER_MSEC),
                     dispatch_get_main_queue(), ^{
        load_capabilities(load);
        if (capability->generation == generation && capability->dylib && !capability->loaded)
          load_one(capability);
      });
    }
  }
  free(config);
}

static int config_dir(const char *path, char *out, size_t cap) {
  int n = snprintf(out, cap, "%s", path);
  if (n < 0 || (size_t)n >= cap) return -1;
  char *slash = strrchr(out, '/');
  if (slash == NULL || slash == out) return -1;
  *slash = '\0';
  return 0;
}

// Watch the directory because config updates replace the file by rename.
static void watch_config(struct Load *load) {
  char dir[sizeof load->config_path];
  if (config_dir(load->config_path, dir, sizeof dir) != 0) return;

  int fd = open(dir, O_EVTONLY);
  if (fd < 0) return;

  dispatch_source_t source = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_VNODE, (uintptr_t)fd, DISPATCH_VNODE_WRITE, dispatch_get_main_queue());
  if (source == NULL) {
    close(fd);
    return;
  }
  dispatch_source_set_event_handler(source, ^{ load_capabilities(load); });
  dispatch_source_set_cancel_handler(source, ^{ close(fd); });
  dispatch_resume(source);
}

// getenv and access are safe in a constructor; the dlopen is not.
__attribute__((constructor))
static void serve_sim_capability_loader_init(void) {
  const char *tmp = getenv("TMPDIR");
  if (tmp == NULL || strstr(tmp, "/Containers/Data/Application/") == NULL) return;

  // Absolute only. A relative path would resolve against the app's working
  // directory, which is not ours to guess.
  const char *config = getenv(CONFIG_VAR);
  if (config == NULL || *config != '/') return;

  struct Load *load = calloc(1, sizeof *load);
  if (load == NULL) return;
  char dir[sizeof load->config_path];

  int n = snprintf(load->config_path, sizeof load->config_path, "%s", config);
  if (n < 0 || (size_t)n >= sizeof load->config_path) {
    free(load);
    return;
  }
  // The file need not exist yet: a capability turned on later creates it, and
  // the watch is on the directory. Requiring the file here would mean an app
  // started before the first capability could never receive one.
  if (config_dir(load->config_path, dir, sizeof dir) != 0 || access(dir, R_OK | X_OK) != 0) {
    free(load);
    return;
  }
  uint32_t exec_size = sizeof load->exec_path;
  if (_NSGetExecutablePath(load->exec_path, &exec_size) != 0) {
    free(load);
    return;
  }

  // Concurrent dlopen during construction can invert the dyld/ObjC load locks.
  // Defer capability loads to the main queue after construction completes.
  dispatch_async(dispatch_get_main_queue(), ^{
    watch_config(load);
    load_capabilities(load);
  });
}

void serve_sim_startup(void (*initialize)(void)) {
  const char *tmp = getenv("TMPDIR");
  const char *config_path = getenv(CONFIG_VAR);
  if (!tmp || !strstr(tmp, "/Containers/Data/Application/") || !config_path || *config_path != '/') return;
  char executable[1024];
  uint32_t size = sizeof executable;
  if (_NSGetExecutablePath(executable, &size) != 0) return;
  Dl_info image;
  char actual[PATH_MAX];
  if (!dladdr((const void *)initialize, &image) || !realpath(image.dli_fname, actual)) return;
  char *config = malloc(MAX_CONFIG_BYTES);
  if (!config) return;
  if (read_config(config_path, config, MAX_CONFIG_BYTES) == 0) {
    char *line, *lines = config;
    while ((line = strsep(&lines, "\n")) != NULL) {
      if (strncmp(line, "startup\t", 8) != 0) continue;
      char *dylib, *env;
      unsigned delay;
      if (!capability_applies(line + 8, executable, &dylib, &env, &delay) || delay != 0) continue;
      char expected[PATH_MAX];
      if (!realpath(dylib, expected) || strcmp(expected, actual) != 0) continue;
      if (!env || apply_env(env) == 0) initialize();
      break;
    }
  }
  free(config);
}
