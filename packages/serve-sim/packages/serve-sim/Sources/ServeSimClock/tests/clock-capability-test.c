// Exercise the shipped capability's file/lifecycle behavior without a Simulator.
// The weak startup entry point is absent, so its constructor remains inert.
#include "../ServeSimClock.c"

static int failures;
static int64_t lastOffset;
static unsigned offsetWrites;

void serve_sim_set_wall_clock_offset(int64_t offset_ns) {
  lastOffset = offset_ns;
  offsetWrites++;
}

#define CHECK(condition, description)                              \
  do {                                                            \
    if (!(condition)) {                                           \
      fprintf(stderr, "FAIL %s (line %d)\n", description, __LINE__); \
      failures++;                                                 \
    }                                                             \
  } while (0)

static void writeFile(const char *path, const char *contents) {
  FILE *file = fopen(path, "w");
  if (file == NULL || fputs(contents, file) == EOF || fclose(file) != 0) abort();
}

int main(void) {
  char directory[] = "/tmp/serve-sim-clock-test-XXXXXX";
  if (mkdtemp(directory) == NULL) abort();
  snprintf(clockFile, sizeof clockFile, "%s/offset", directory);
  snprintf(configFile, sizeof configFile, "%s/config", directory);
  strlcpy(imagePath, "/test/libServeSimClock.dylib", sizeof imagePath);
  strlcpy(imageRealPath, imagePath, sizeof imageRealPath);

  int64_t offset = 42;
  CHECK(readOffset(&offset) == -1 && offset == 42,
        "a missing offset leaves the caller's value unchanged");
  const char *valid[] = {"0", "1234\n", "-1234", "6300000000000", "-6300000000000"};
  const int64_t expected[] = {0, 1234, -1234, MAX_OFFSET_MS, -MAX_OFFSET_MS};
  for (size_t i = 0; i < sizeof valid / sizeof valid[0]; i++) {
    writeFile(clockFile, valid[i]);
    CHECK(readOffset(&offset) == 0 && offset == expected[i], "valid offsets retain their sign and range");
  }
  const char *invalid[] = {"", "not a number", "1.5", "123junk", "6300000000001",
                           "-6300000000001", "999999999999999999999999999999"};
  for (size_t i = 0; i < sizeof invalid / sizeof invalid[0]; i++) {
    writeFile(clockFile, invalid[i]);
    offset = 42;
    CHECK(readOffset(&offset) == -1 && offset == 42, "invalid offsets never replace the prior value");
  }

  const char *listed[] = {
      "all\t/test/libServeSimClock.dylib\t\t0\n",
      "startup\tall\t/test/libServeSimClock.dylib\t\t0\n",
      "user\t/test/other.dylib\t\t0\nall\t/test/libServeSimClock.dylib\t\t0\n"};
  for (size_t i = 0; i < sizeof listed / sizeof listed[0]; i++) {
    writeFile(configFile, listed[i]);
    CHECK(stillListed(), "startup and deferred config records retain the clock");
  }
  writeFile(configFile, "all\t/test/libServeSimClock.dylib-extra\t\t0\n");
  CHECK(!stillListed(), "a path prefix does not retain the clock");

  writeFile(configFile, listed[0]);
  writeFile(clockFile, "1234");
  applyOffset(0);
  CHECK(lastOffset == 1234 * (int64_t)NSEC_PER_MSEC && offsetWrites == 1,
        "a listed capability applies a valid offset in nanoseconds");
  applyOffset(0);
  CHECK(offsetWrites == 1, "unchanged files do not reapply the clock");
  writeFile(clockFile, "invalid");
  applyOffset(0);
  CHECK(lastOffset == 1234 * (int64_t)NSEC_PER_MSEC && offsetWrites == 1,
        "a malformed replacement preserves the running clock");
  unlink(clockFile);
  char otherFile[1024];
  snprintf(otherFile, sizeof otherFile, "%s/other", directory);
  writeFile(otherFile, "5678");
  if (symlink(otherFile, clockFile) != 0) abort();
  applyOffset(0);
  CHECK(offsetWrites == 1, "a symlink cannot replace the running clock's offset file");
  unlink(clockFile);
  applyOffset(0);
  CHECK(offsetWrites == 1, "a missing offset preserves the running clock while still listed");
  unlink(configFile);
  if (symlink(otherFile, configFile) != 0) abort();
  applyOffset(0);
  CHECK(offsetWrites == 1, "an unreadable config preserves the running clock");
  unlink(configFile);
  writeFile(configFile, "all\t/test/other.dylib\t\t0\n");
  applyOffset(0);
  CHECK(lastOffset == 0 && offsetWrites == 2, "withdrawing the config returns to host time");
  writeFile(clockFile, "-1234");
  writeFile(configFile, listed[1]);
  applyOffset(0);
  CHECK(lastOffset == -1234 * (int64_t)NSEC_PER_MSEC && offsetWrites == 3,
        "re-enabling the clock applies a new negative offset");
  unlink(configFile);
  applyOffset(0);
  CHECK(lastOffset == 0 && offsetWrites == 4, "removing session config returns to host time");

  unlink(clockFile);
  unlink(otherFile);
  rmdir(directory);
  if (failures == 0) puts("clock capability ok");
  return failures != 0;
}
