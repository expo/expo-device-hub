// Boot-resident guard with a shared policy page.
// @ref LLP 0007.000#new-outbound-attempts — existing sockets and in-flight calls are left alone
#include "policy.h"
#include "../ServeSimCapabilityLoader/startup-capability.h"
#include "destination.h"
#include <errno.h>
#include <mach/mach.h>
#include <stdlib.h>
#include <sys/uio.h>
#include <unistd.h>
#include <sys/stat.h>

static _Atomic(struct EgressPage *) policy_page;
static uint64_t page_device, page_inode;

static void eg_initialize(void) {
  int saved = errno, fd = -1;
  // The startup config supplies the immutable path before this callback runs.
  struct EgressPage *page = eg_map_policy(getenv("SERVE_SIM_EGRESS_POLICY_FILE"), 0, &fd);
  if (fd >= 0) {
    struct stat info;
    if (fstat(fd, &info) == 0) {
      page_device = (uint64_t)info.st_dev;
      page_inode = (uint64_t)info.st_ino;
    } else page = NULL;
    close(fd);
  }
  atomic_store_explicit(&policy_page, page, memory_order_release);
  errno = saved;
}

#ifdef SERVE_SIM_EGRESS_HOST_TEST
__attribute__((constructor)) static void eg_host_initialize(void) { eg_initialize(); }
#else
SERVE_SIM_STARTUP_ALL_PROCESSES(eg_initialize)
#endif

// Internal startup self-check. The acquire pairs with initialization above.
int serve_sim_egress_status(uint64_t *policy, uint64_t *device, uint64_t *inode) {
  struct EgressPage *page = atomic_load_explicit(&policy_page, memory_order_acquire);
  if (!page || atomic_load_explicit(&page->magic, memory_order_acquire) != EG_MAGIC) return 0;
  *policy = atomic_load_explicit(&page->policy, memory_order_acquire);
  *device = page_device; *inode = page_inode;
  return eg_valid_policy(*policy);
}

static int eg_passthrough(void) {
  struct EgressPage *page = atomic_load_explicit(&policy_page, memory_order_acquire);
  if (!page || atomic_load_explicit(&page->magic, memory_order_acquire) != EG_MAGIC) return 0;
  uint64_t value = atomic_load_explicit(&page->policy, memory_order_acquire);
  return eg_generation(value) != 0 && eg_mode(value) == EG_PASSTHROUGH;
}

// @ref LLP 0007.000#native-argument-handling — preserve syscall-style faults when inspecting caller memory
static int eg_copy(void *destination, const void *source, size_t size) {
  if (size == 0) return 1;
  vm_size_t copied = 0;
  if (!source || vm_read_overwrite(mach_task_self(), (vm_address_t)(uintptr_t)source,
      (vm_size_t)size, (vm_address_t)(uintptr_t)destination, &copied) != KERN_SUCCESS || copied != size) {
    errno = EFAULT; return 0;
  }
  return 1;
}

static int eg_copy_address(struct sockaddr_storage *destination, const struct sockaddr *source, socklen_t size) {
  memset(destination, 0, sizeof *destination);
  return !source || eg_copy(destination, source, size < sizeof *destination ? size : sizeof *destination);
}

static int eg_disconnect(int fd, const struct sockaddr *sa, socklen_t size) {
  if (!sa || size < 2 || sa->sa_family != AF_UNSPEC) return 0;
  int saved = errno, type = 0;
  socklen_t length = sizeof type;
  int disconnect = getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &length) == 0 && type == SOCK_DGRAM;
  errno = saved;
  return disconnect;
}

#define EG_REFUSE() do { errno = ECONNREFUSED; return -1; } while (0)

static int eg_check_send(const struct sockaddr *sa, socklen_t size) {
  struct sockaddr_storage address;
  if (!eg_copy_address(&address, sa, size)) return -1;
  if (eg_remote(sa ? (const struct sockaddr *)&address : NULL, size)) EG_REFUSE();
  return 0;
}

extern int eg_connect_nc_original(int, const struct sockaddr *, socklen_t) __asm__("_connect$NOCANCEL");
extern ssize_t eg_sendto_nc_original(int, const void *, size_t, int, const struct sockaddr *, socklen_t) __asm__("_sendto$NOCANCEL");
extern ssize_t eg_sendmsg_nc_original(int, const struct msghdr *, int) __asm__("_sendmsg$NOCANCEL");

#define CONNECT_WRAPPER(name, original) \
static int name(int fd, const struct sockaddr *sa, socklen_t size) { \
  if (!eg_passthrough()) { \
    struct sockaddr_storage address; \
    if (!eg_copy_address(&address, sa, size)) return -1; \
    const struct sockaddr *checked = sa ? (const struct sockaddr *)&address : NULL; \
    if (!eg_disconnect(fd, checked, size) && eg_remote(checked, size)) EG_REFUSE(); \
  } \
  return original(fd, sa, size); \
}
CONNECT_WRAPPER(eg_connect, connect)
CONNECT_WRAPPER(eg_connect_nc, eg_connect_nc_original)

static int eg_connectx(int fd, const sa_endpoints_t *endpoints, sae_associd_t assoc, unsigned flags,
                       const struct iovec *iov, unsigned count, size_t *length, sae_connid_t *id) {
  if (!eg_passthrough() && endpoints) {
    sa_endpoints_t copied;
    struct sockaddr_storage address;
    if (!eg_copy(&copied, endpoints, sizeof copied) ||
        !eg_copy_address(&address, copied.sae_dstaddr, copied.sae_dstaddrlen)) return -1;
    // Unlike connect(), connectx translates AF_UNSPEC for UDP and may send its iovec.
    if (eg_remote(copied.sae_dstaddr ? (struct sockaddr *)&address : NULL, copied.sae_dstaddrlen)) EG_REFUSE();
  }
  return connectx(fd, endpoints, assoc, flags, iov, count, length, id);
}

#define SENDTO_WRAPPER(name, original) \
static ssize_t name(int fd, const void *buf, size_t size, int flags, const struct sockaddr *sa, socklen_t length) { \
  if (sa && !eg_passthrough() && eg_check_send(sa, length)) return -1; \
  return original(fd, buf, size, flags, sa, length); \
}
SENDTO_WRAPPER(eg_sendto, sendto)
SENDTO_WRAPPER(eg_sendto_nc, eg_sendto_nc_original)

#define SENDMSG_WRAPPER(name, original) \
static ssize_t name(int fd, const struct msghdr *msg, int flags) { \
  if (!eg_passthrough()) { \
    struct msghdr copied; \
    if (!eg_copy(&copied, msg, sizeof copied)) return -1; \
    if (eg_check_send(copied.msg_name, copied.msg_namelen)) return -1; \
  } \
  return original(fd, msg, flags); \
}
SENDMSG_WRAPPER(eg_sendmsg, sendmsg)
SENDMSG_WRAPPER(eg_sendmsg_nc, eg_sendmsg_nc_original)

#define EG_INTERPOSE(replacement, original) {(const void *)replacement, (const void *)original}
__attribute__((used)) static const struct { const void *replacement; const void *original; }
eg_interposers[] __attribute__((section("__DATA,__interpose"))) = {
  EG_INTERPOSE(eg_connect, connect), EG_INTERPOSE(eg_connect_nc, eg_connect_nc_original),
  EG_INTERPOSE(eg_connectx, connectx),
  EG_INTERPOSE(eg_sendto, sendto), EG_INTERPOSE(eg_sendto_nc, eg_sendto_nc_original),
  EG_INTERPOSE(eg_sendmsg, sendmsg), EG_INTERPOSE(eg_sendmsg_nc, eg_sendmsg_nc_original),
};
