#include "policy.h"
#include <errno.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

int eg_valid_policy(uint64_t policy) {
  return eg_generation(policy) != 0 && (eg_mode(policy) == EG_PASSTHROUGH || eg_mode(policy) == EG_BLOCK);
}

struct EgressPage *eg_map_policy(const char *path, int writable, int *fd_out) {
  if (!path || path[0] != '/') { errno = EINVAL; return NULL; }
  int fd = open(path, (writable ? O_RDWR : O_RDONLY) | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0) return NULL;
  struct stat info;
  if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_size != EG_PAGE_BYTES ||
      info.st_uid != getuid() || (info.st_mode & 0777) != 0600) {
    close(fd); errno = EINVAL; return NULL;
  }
  struct EgressPage *page = mmap(NULL, EG_PAGE_BYTES, PROT_READ | (writable ? PROT_WRITE : 0), MAP_SHARED, fd, 0);
  if (page == MAP_FAILED) { int error = errno; close(fd); errno = error; return NULL; }
  if (atomic_load_explicit(&page->magic, memory_order_acquire) != EG_MAGIC ||
      !eg_valid_policy(atomic_load_explicit(&page->policy, memory_order_acquire)) ||
      (page->warmup != EG_PASSTHROUGH && page->warmup != EG_BLOCK)) {
    munmap(page, EG_PAGE_BYTES); close(fd); errno = EINVAL; return NULL;
  }
  *fd_out = fd;
  return page;
}
