// Policy controller. Publication is not an all-process drain or admission ack.
#include "policy.h"
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>
#include <sys/mman.h>
#include <unistd.h>

static uint64_t mode(const char *text) {
  return strcmp(text, "passthrough") == 0 ? EG_PASSTHROUGH : strcmp(text, "block") == 0 ? EG_BLOCK : 0;
}

int main(int argc, char **argv) {
  int creating = argc == 4 && strcmp(argv[1], "create") == 0;
  int updating = argc == 4 && strcmp(argv[1], "set") == 0;
  int status = argc == 3 && strcmp(argv[1], "status") == 0;
  uint64_t requested = argc == 4 ? mode(argv[3]) : 0;
  if ((!creating && !updating && !status) || ((creating || updating) && !requested) || argv[2][0] != '/') {
    fprintf(stderr, "usage: egress-control create|set /absolute/page passthrough|block; status /absolute/page\n"); return 2;
  }
  int fd = -1;
  struct EgressPage *page = NULL;
  if (creating) {
    fd = open(argv[2], O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd < 0) { perror("create policy"); return 1; }
    if (ftruncate(fd, EG_PAGE_BYTES) == 0) page = mmap(NULL, EG_PAGE_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (!page || page == MAP_FAILED) { perror("initialize policy"); close(fd); unlink(argv[2]); return 1; }
    page->warmup = requested;
    atomic_init(&page->policy, (UINT64_C(1) << 2) | requested);
    atomic_store_explicit(&page->magic, EG_MAGIC, memory_order_release);
  } else {
    page = eg_map_policy(argv[2], updating, &fd);
    if (!page) { perror("open policy"); return 1; }
  }
  if (updating) {
    if (flock(fd, LOCK_EX) != 0) { perror("lock policy"); return 1; }
    uint64_t previous = atomic_load_explicit(&page->policy, memory_order_acquire);
    if (!eg_valid_policy(previous) || eg_generation(previous) == (UINT64_MAX >> 2)) {
      fprintf(stderr, "invalid or exhausted policy generation\n"); return 1;
    }
    atomic_store_explicit(&page->policy, ((eg_generation(previous) + 1) << 2) | requested, memory_order_release);
  }
  uint64_t value = atomic_load_explicit(&page->policy, memory_order_acquire);
  printf("{\"publishedGeneration\":%" PRIu64 ",\"policy\":\"%s\",\"warmupPolicy\":\"%s\"}\n",
         eg_generation(value), eg_mode(value) == EG_PASSTHROUGH ? "passthrough" : "block",
         page->warmup == EG_PASSTHROUGH ? "passthrough" : "block");
  munmap(page, EG_PAGE_BYTES); close(fd); return 0;
}
