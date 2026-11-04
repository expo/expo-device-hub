// All destinations are loopback; the test guard classifies 127.0.0.1 as remote.
#include "../sendmsg-x.h"
#include "../policy.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/time.h>
#include <unistd.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "line %d: %s errno=%d\n", __LINE__, #x, errno); return 1; } } while (0)
static int receiver(struct sockaddr *address, socklen_t size) {
  int fd = socket(address->sa_family, SOCK_DGRAM, 0);
  struct timeval timeout = {0, 100000};
  if (fd < 0 || bind(fd, address, size) || getsockname(fd, address, &size) ||
      setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout)) return -1;
  return fd;
}
static int empty(int fd) {
  char byte;
  return recv(fd, &byte, 1, 0) == -1 && (errno == EAGAIN || errno == EWOULDBLOCK);
}
int main(int argc, char **argv) {
  CHECK(argc == 2);
  int file = open(argv[1], O_RDWR); CHECK(file >= 0);
  struct EgressPage *page = mmap(NULL, EG_PAGE_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, file, 0);
  CHECK(page != MAP_FAILED); close(file);
  struct sockaddr_in remote4 = {.sin_len = sizeof remote4, .sin_family = AF_INET,
    .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
  struct sockaddr_in6 local = {.sin6_len = sizeof local, .sin6_family = AF_INET6,
    .sin6_addr = IN6ADDR_LOOPBACK_INIT};
  int remote_peer = receiver((struct sockaddr *)&remote4, sizeof remote4);
  int local_peer = receiver((struct sockaddr *)&local, sizeof local);
  CHECK(remote_peer >= 0 && local_peer >= 0);
  struct sockaddr_in6 denied = {.sin6_len = sizeof denied, .sin6_family = AF_INET6,
    .sin6_port = remote4.sin_port};
  CHECK(inet_pton(AF_INET6, "::ffff:127.0.0.1", &denied.sin6_addr) == 1);
  int fd = socket(AF_INET6, SOCK_DGRAM, 0); CHECK(fd >= 0);
  int zero = 0; CHECK(setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &zero, sizeof zero) == 0);
  char byte = 'x', received;
  struct iovec iov = {&byte, 1};
  struct eg_msghdr_x batch[2] = {
    {.msg_name = &denied, .msg_namelen = sizeof denied, .msg_iov = &iov, .msg_iovlen = 1},
    {.msg_name = &denied, .msg_namelen = sizeof denied, .msg_iov = &iov, .msg_iovlen = 1},
  };
  atomic_store(&page->policy, (UINT64_C(2) << 2) | 1);
  CHECK(eg_sendmsg_x_original(fd, batch, 2, 0) == 2);
  CHECK(recv(remote_peer, &received, 1, 0) == 1);
  CHECK(recv(remote_peer, &received, 1, 0) == 1);
  CHECK(connect(fd, (struct sockaddr *)&denied, sizeof denied) == 0);
  int connected = fd;
  fd = socket(AF_INET6, SOCK_DGRAM, 0); CHECK(fd >= 0);
  CHECK(setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &zero, sizeof zero) == 0);
  atomic_store(&page->policy, (UINT64_C(3) << 2) | 2);
  struct eg_msghdr_x existing = {.msg_iov = &iov, .msg_iovlen = 1};
  CHECK(eg_sendmsg_x_original(connected, &existing, 1, 0) == 1);
  CHECK(recv(remote_peer, &received, 1, 0) == 1);
  batch[0].msg_name = &local;
  CHECK(eg_sendmsg_x_original(fd, batch, 2, 0) == -1 && errno == ECONNREFUSED);
  CHECK(empty(remote_peer) && empty(local_peer)); // The first permitted message was not sent.
  batch[1].msg_name = &local;
  CHECK(eg_sendmsg_x_original(fd, batch, 2, 0) == 2);
  CHECK(recv(local_peer, &received, 1, 0) == 1);
  CHECK(recv(local_peer, &received, 1, 0) == 1);
  void *unreadable = mmap(NULL, 4096, PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0);
  CHECK(unreadable != MAP_FAILED);
  CHECK(eg_sendmsg_x_original(fd, unreadable, 1, 0) == -1 && errno == EFAULT);
  batch[1].msg_name = unreadable;
  CHECK(eg_sendmsg_x_original(fd, batch, 2, 0) == -1 && errno == EFAULT);
  CHECK(empty(local_peer));
  CHECK(eg_sendmsg_x_original(fd, NULL, 1, 0) == -1 && errno == EFAULT);
  long system_page_size = sysconf(_SC_PAGESIZE); CHECK(system_page_size > 0);
  size_t page_size = (size_t)system_page_size;
  void *crossing = mmap(NULL, 2 * page_size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  CHECK(crossing != MAP_FAILED && mprotect((char *)crossing + page_size, page_size, PROT_NONE) == 0);
  struct eg_msghdr_x *partial = (struct eg_msghdr_x *)((char *)crossing + page_size - sizeof *partial);
  *partial = batch[0];
  CHECK(eg_sendmsg_x_original(fd, partial, 2, 0) == -1 && errno == EFAULT);
  CHECK(empty(local_peer));
  munmap(crossing, 2 * page_size);
  atomic_store(&page->policy, (UINT64_C(4) << 2) | 1);
  batch[0].msg_name = &denied;
  CHECK(eg_sendmsg_x_original(fd, batch, 1, 0) == 1);
  CHECK(recv(remote_peer, &received, 1, 0) == 1);
  munmap(unreadable, 4096); munmap(page, EG_PAGE_BYTES);
  close(fd); close(connected); close(remote_peer); close(local_peer);
  puts("sendmsg_x: pass-through, mixed batch refusal, local batch and pointer faults passed");
  return 0;
}
