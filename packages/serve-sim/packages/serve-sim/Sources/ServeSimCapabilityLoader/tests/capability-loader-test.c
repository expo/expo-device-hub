// Host-compiled tests for the capability loader's parsing. Includes the dylib source
// so the static helpers are reachable; the constructor is a no-op here because
// TMPDIR is not an app container.

#include <dispatch/dispatch.h>
#include <Block.h>
#include <dlfcn.h>

static dispatch_block_t scheduled[128];
static size_t scheduled_count;
static unsigned dlopen_count;

static void test_dispatch_after(dispatch_time_t when, dispatch_queue_t queue, dispatch_block_t block) {
  (void)when;
  (void)queue;
  if (scheduled_count == 128) __builtin_trap();
  scheduled[scheduled_count++] = Block_copy(block);
}

static void *test_dlopen(const char *path, int flags) {
  dlopen_count++;
  return dlopen(path, flags);
}

#define dispatch_after test_dispatch_after
#define dlopen test_dlopen
#include "../serve-sim-capability-loader.c"
#undef dispatch_after
#undef dlopen

static void run_scheduled(void) {
  size_t count = scheduled_count;
  dispatch_block_t ready[128];
  memcpy(ready, scheduled, count * sizeof ready[0]);
  scheduled_count = 0;
  for (size_t i = 0; i < count; i++) {
    ready[i]();
    Block_release(ready[i]);
  }
}

static void free_load(struct Load *load) {
  for (size_t i = 0; i < MAX_CAPABILITIES; i++) {
    free(load->capabilities[i].dylib);
    free(load->capabilities[i].env);
  }
  free(load);
}

#include <sys/stat.h>

static int failures = 0;

#define CHECK(cond, what)                                                       \
  do {                                                                          \
    if (!(cond)) {                                                              \
      fprintf(stdout, "FAIL %s (%s:%d)\n", (what), __FILE__, __LINE__);         \
      failures++;                                                               \
    }                                                                           \
  } while (0)

#define MAX_TEMPS 16
static char temps[MAX_TEMPS][1024];
static int temp_count = 0;

static char *write_temp(const char *name, const char *contents, size_t len) {
  if (temp_count >= MAX_TEMPS) {
    fprintf(stdout, "FAIL out of temp slots; raise MAX_TEMPS\n");
    abort();
  }
  char *path = temps[temp_count++];
  snprintf(path, sizeof temps[0], "/tmp/serve-sim-capability-loader-test-%d-%s", getpid(), name);
  FILE *file = fopen(path, "w");
  if (file == NULL) abort();
  size_t written = fwrite(contents, 1, len, file);
  if (written != len || fclose(file) != 0) abort();
  return path;
}

static void remove_temps(void) {
  for (int i = 0; i < temp_count; i++) unlink(temps[i]);
}

static void test_read_config(void) {
  char out[64];

  CHECK(read_config("/tmp/serve-sim-does-not-exist", out, sizeof out) == -1,
        "a missing config reports failure");

  const char *body = "a\tb\n";
  CHECK(read_config(write_temp("small", body, strlen(body)), out, sizeof out) == 0,
        "a config that fits reads whole");
  CHECK(strcmp(out, body) == 0, "the contents survive the read");

  char big[128];
  memset(big, 'x', sizeof big);
  CHECK(read_config(write_temp("big", big, sizeof big), out, sizeof out) == 1,
        "a config over the cap reports truncation");

  CHECK(read_config(write_temp("empty", "", 0), out, sizeof out) == 0,
        "an empty config is readable");
  CHECK(out[0] == '\0', "an empty config yields an empty string");
}

static void test_capability_applies(void) {
  const char *user_app = "/devices/UDID/data/Containers/Bundle/Application/ABC/Fixture.app/Fixture";
  const char *apple_app = "/runtimes/iOS.simruntime/Contents/Resources/RuntimeRoot/Applications/MobileSafari.app/MobileSafari";
  char *dylib = NULL;
  char *env = NULL;
  unsigned delay = 0;

  char all_in_user[] = "all\t/opt/probe.dylib\tK=V";
  CHECK(capability_applies(all_in_user, user_app, &dylib, &env, &delay) == 1, "all applies to a user app");
  CHECK(strcmp(dylib, "/opt/probe.dylib") == 0, "the dylib field is returned");
  CHECK(strcmp(env, "K=V") == 0, "the environment field is returned");

  char all_in_apple[] = "all\t/opt/probe.dylib\t";
  CHECK(capability_applies(all_in_apple, apple_app, &dylib, &env, &delay) == 1,
        "all applies to an Apple app too");

  char user_in_user[] = "user\t/opt/probe.dylib\t";
  CHECK(capability_applies(user_in_user, user_app, &dylib, &env, &delay) == 1,
        "user applies to an app the user installed");

  char user_in_apple[] = "user\t/opt/probe.dylib\t";
  CHECK(capability_applies(user_in_apple, apple_app, &dylib, &env, &delay) == 0,
        "user does not apply to an Apple app");

  // A config written by an older serve-sim carried a container path here.
  char stale_container[] = "/data/Containers/Data/Application/ABC\t/opt/probe.dylib\t";
  CHECK(capability_applies(stale_container, user_app, &dylib, &env, &delay) == 0,
        "a container path is not a scope, so nothing loads");

  char blank_scope[] = "\t/opt/probe.dylib\t";
  CHECK(capability_applies(blank_scope, user_app, &dylib, &env, &delay) == 0,
        "a missing scope does not load");

  char relative[] = "all\topt/probe.dylib\t";
  CHECK(capability_applies(relative, user_app, &dylib, &env, &delay) == 0, "a relative dylib path is refused");

  char empty[] = "";
  CHECK(capability_applies(empty, user_app, &dylib, &env, &delay) == 0, "a blank line is skipped");
  char comment[] = "# a note";
  CHECK(capability_applies(comment, user_app, &dylib, &env, &delay) == 0, "a comment is skipped");
  char no_dylib[] = "all\t\t";
  CHECK(capability_applies(no_dylib, user_app, &dylib, &env, &delay) == 0, "a line with no dylib is skipped");
  char truncated[] = "all";
  CHECK(capability_applies(truncated, user_app, &dylib, &env, &delay) == 0,
        "a line with no fields after the scope is skipped");

  char no_env[] = "all\t/opt/probe.dylib";
  CHECK(capability_applies(no_env, user_app, &dylib, &env, &delay) == 1, "the environment field is optional");
  CHECK(env == NULL, "a missing environment field is reported as absent");
  CHECK(delay == 0, "a line with no delay field loads straight away");

  char delayed[] = "all\t/opt/probe.dylib\t\t250";
  CHECK(capability_applies(delayed, user_app, &dylib, &env, &delay) == 1, "a delay is accepted");
  CHECK(delay == 250, "the delay is returned in milliseconds");

  char junk_delay[] = "all\t/opt/probe.dylib\t\tsoon";
  CHECK(capability_applies(junk_delay, user_app, &dylib, &env, &delay) == 1, "a junk delay still loads");
  CHECK(delay == 0, "a delay that does not parse means no delay");

  char negative_delay[] = "all\t/opt/probe.dylib\t\t-5";
  CHECK(capability_applies(negative_delay, user_app, &dylib, &env, &delay) == 1,
        "a negative delay still loads");
  CHECK(delay == 0, "a negative delay means no delay");

  char huge_delay[] = "all\t/opt/probe.dylib\t\t999999999";
  CHECK(capability_applies(huge_delay, user_app, &dylib, &env, &delay) == 1, "a huge delay is bounded");
  CHECK(delay == MAX_LOAD_DELAY_MS, "a delay past the ceiling is clamped");
}

static void test_apply_env(void) {
  char pairs[] = "SERVE_SIM_TEST_A=1;SERVE_SIM_TEST_B=two";
  CHECK(apply_env(pairs) == 0, "well-formed pairs are applied");
  CHECK(getenv("SERVE_SIM_TEST_A") != NULL && strcmp(getenv("SERVE_SIM_TEST_A"), "1") == 0,
        "the first pair reaches the environment");
  CHECK(getenv("SERVE_SIM_TEST_B") != NULL && strcmp(getenv("SERVE_SIM_TEST_B"), "two") == 0,
        "the last pair reaches the environment");

  char messy[] = ";;SERVE_SIM_TEST_C=3;no-equals-sign;";
  CHECK(apply_env(messy) == 0, "empty and malformed pairs are skipped");
  CHECK(getenv("SERVE_SIM_TEST_C") != NULL, "a good pair after a malformed one still applies");
  CHECK(getenv("no-equals-sign") == NULL, "a pair with no '=' sets nothing");

  char with_equals[] = "SERVE_SIM_TEST_D=a=b";
  CHECK(apply_env(with_equals) == 0, "a value containing '=' is allowed");
  CHECK(getenv("SERVE_SIM_TEST_D") != NULL && strcmp(getenv("SERVE_SIM_TEST_D"), "a=b") == 0,
        "only the first '=' separates the name from the value");

  char bad_name[] = "=novalue";
  CHECK(apply_env(bad_name) != 0, "a pair setenv refuses is reported as a failure");
}

// Runs immediate and scheduled loads and captures their diagnostics.
static char *load_and_capture(const char *config_body) {
  static char captured[4096];
  char log_path[1024];
  snprintf(log_path, sizeof log_path, "/tmp/serve-sim-capability-loader-test-%d-stderr", getpid());

  char *config_path = write_temp("load-config", config_body, strlen(config_body));
  struct Load *load = calloc(1, sizeof *load);
  if (load == NULL) abort();
  snprintf(load->exec_path, sizeof load->exec_path, "%s",
           "/devices/UDID/data/Containers/Bundle/Application/ABC/Fixture.app/Fixture");
  snprintf(load->config_path, sizeof load->config_path, "%s", config_path);

  fflush(stderr);
  int saved = dup(STDERR_FILENO);
  if (saved < 0) abort();
  int sink = open(log_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (sink < 0) abort();
  if (dup2(sink, STDERR_FILENO) < 0) abort();
  close(sink);

  load_capabilities(load);
  run_scheduled();
  free_load(load);

  fflush(stderr);
  if (dup2(saved, STDERR_FILENO) < 0) abort();
  close(saved);

  FILE *file = fopen(log_path, "r");
  if (file == NULL) abort();
  size_t n = fread(captured, 1, sizeof captured - 1, file);
  captured[n] = '\0';
  fclose(file);
  unlink(log_path);
  return captured;
}


static void test_load_capabilities(void) {
  char *out = load_and_capture("all\t/opt/serve-sim-missing.dylib\t\n");
  CHECK(strstr(out, "could not load /opt/serve-sim-missing.dylib") != NULL,
        "a dylib that will not load is reported");

  out = load_and_capture("all\t/opt/serve-sim-missing.dylib\t=novalue\n");
  CHECK(strstr(out, "not loading /opt/serve-sim-missing.dylib") != NULL,
        "an environment that cannot be applied blocks the load");
  CHECK(strstr(out, "could not load") == NULL,
        "a blocked load is not attempted anyway");

  out = load_and_capture("user\t/opt/other.dylib\t\n");
  CHECK(strstr(out, "could not load /opt/other.dylib") != NULL,
        "a user-scoped capability is attempted in a user app");

  out = load_and_capture("nonsense\t/opt/other.dylib\t\n");
  CHECK(strstr(out, "unknown scope 'nonsense'") != NULL, "an unknown scope is reported");

  char loaded_marker[1024];
  snprintf(loaded_marker, sizeof loaded_marker, "/tmp/serve-sim-host-probe-%d.txt", getpid());
  unlink(loaded_marker);
  char line[4096];
  snprintf(line, sizeof line, "all\t%s\tSERVE_SIM_HOST_PROBE_FILE=%s\n",
           SERVE_SIM_TEST_DYLIB, loaded_marker);
  out = load_and_capture(line);
  CHECK(out[0] == '\0', "a capability that loads reports nothing");
  FILE *marker = fopen(loaded_marker, "r");
  CHECK(marker != NULL, "the capability dylib was dlopened");
  if (marker != NULL) fclose(marker);
  unlink(loaded_marker);

  // Listed late but with no delay, so it must still be attempted first.
  out = load_and_capture("all\t/opt/serve-sim-late.dylib\t\t400\n"
                         "all\t/opt/serve-sim-early.dylib\t\t0\n");
  {
    char *early = strstr(out, "/opt/serve-sim-early.dylib");
    char *late = strstr(out, "/opt/serve-sim-late.dylib");
    CHECK(early != NULL && late != NULL, "both capabilities were attempted");
    CHECK(early != NULL && late != NULL && early < late,
          "a capability with no delay is loaded before a delayed one");
  }

  char many[MAX_CONFIG_BYTES] = "";
  snprintf(line, sizeof line, "all\t%s\t\n", SERVE_SIM_TEST_DYLIB);
  for (size_t i = 0; i < MAX_CAPABILITIES; i++) strcat(many, line);
  out = load_and_capture(many);
  CHECK(strstr(out, "ignoring the rest") == NULL, "exactly 64 applicable entries do not warn");
  strcat(many, line);
  out = load_and_capture(many);
  CHECK(strstr(out, "more than 64 capabilities apply; ignoring the rest") != NULL,
        "extra applicable entries report truncation");

  char oversized[MAX_CONFIG_BYTES + 16];
  memset(oversized, 'x', sizeof oversized);
  oversized[sizeof oversized - 1] = '\0';
  out = load_and_capture(oversized);
  CHECK(strstr(out, "no capabilities loaded") != NULL,
        "a config over the limit loads nothing");
}

static void test_delayed_reload(void) {
  struct Load *load = calloc(1, sizeof *load);
  if (load == NULL) abort();
  char line[4096];
  snprintf(line, sizeof line, "all\t%s\tSERVE_SIM_DELAY_TEST=old\t10000\n", SERVE_SIM_TEST_DYLIB);
  char *path = write_temp("delayed", line, strlen(line));
  snprintf(load->config_path, sizeof load->config_path, "%s", path);
  unsigned before = dlopen_count;
  load_capabilities(load);
  CHECK(scheduled_count == 1, "delayed load returns with a scheduled callback");
  CHECK(dlopen_count == before, "delay does not load synchronously");
  load_capabilities(load);
  CHECK(scheduled_count == 1, "unchanged config does not duplicate pending loads");

  snprintf(line, sizeof line, "all\t%s\tSERVE_SIM_DELAY_TEST=new\t10000\n", SERVE_SIM_TEST_DYLIB);
  FILE *file = fopen(path, "w");
  if (!file) abort();
  fputs(line, file);
  fclose(file);
  run_scheduled();
  CHECK(dlopen_count == before, "pending callback refuses reconfigured contents");
  CHECK(scheduled_count == 1, "replacement gets its own delay");
  run_scheduled();
  CHECK(dlopen_count == before + 1, "replacement loads once");
  CHECK(strcmp(getenv("SERVE_SIM_DELAY_TEST"), "new") == 0, "only the replacement environment applies");
  load_capabilities(load);
  CHECK(scheduled_count == 0 && dlopen_count == before + 1, "loaded capability is not scheduled or dlopened again");
  free_load(load);

  load = calloc(1, sizeof *load);
  if (load == NULL) abort();
  snprintf(load->config_path, sizeof load->config_path, "%s", path);
  load_capabilities(load);
  unlink(path);
  run_scheduled();
  CHECK(dlopen_count == before + 1, "removing config cancels a pending load even before a watch event");
  free_load(load);
}

int main(void) {
  test_read_config();
  test_capability_applies();
  test_apply_env();
  test_load_capabilities();
  test_delayed_reload();
  remove_temps();
  if (failures == 0) fprintf(stdout, "ok\n");
  return failures == 0 ? 0 : 1;
}
