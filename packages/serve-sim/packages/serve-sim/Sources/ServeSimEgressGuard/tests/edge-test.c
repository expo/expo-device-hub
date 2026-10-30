// Native regression probes; all network peers are local, including the denied test peer.
#include "fixture.h"
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>

static int failures;
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "FAIL line %d: %s errno=%d\n", __LINE__, #x, errno); failures++; } } while (0)
#define REQUIRE(x) do { if (!(x)) { perror(#x); return 2; } } while (0)

static int bound(int type, struct sockaddr_in *address) {
  int fd = socket(AF_INET, type, 0);
  memset(address, 0, sizeof *address);
  address->sin_len = sizeof *address; address->sin_family = AF_INET;
  address->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  socklen_t size = sizeof *address;
  struct timeval timeout = {0, 100000};
  if (fd < 0 || bind(fd, (struct sockaddr *)address, size) || getsockname(fd, (struct sockaddr *)address, &size) ||
      setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout)) return -1;
  return fd;
}

static void fault(int signal_number) { (void)signal_number; _exit(98); }

static void allowed(ssize_t value, int receiver) {
  CHECK(value == 1);
  if (value == 1) { char byte; CHECK(recv(receiver, &byte, 1, 0) == 1); }
}

int main(int argc, char **argv) {
  REQUIRE(argc == 2);
  int page_fd = open(argv[1], O_RDWR); REQUIRE(page_fd >= 0);
  struct TestPage *page = mmap(NULL, TEST_PAGE_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, page_fd, 0);
  REQUIRE(page != MAP_FAILED); close(page_fd);
  struct sockaddr_in tcp_address, udp_address;
  int listener = bound(SOCK_STREAM, &tcp_address), receiver = bound(SOCK_DGRAM, &udp_address);
  REQUIRE(listener >= 0 && receiver >= 0 && listen(listener, 4) == 0);
  int tcp = socket(AF_INET, SOCK_STREAM, 0); REQUIRE(tcp >= 0);
  REQUIRE(connect(tcp, (struct sockaddr *)&tcp_address, sizeof tcp_address) == 0);
  int accepted = accept(listener, NULL, NULL); REQUIRE(accepted >= 0);
  atomic_store_explicit(&page->policy, (UINT64_C(2) << 2) | 2, memory_order_release);

  // The test-only classifier denies 127.0.0.1, while 127.0.0.2 remains permitted.
  struct sockaddr_in decoy = tcp_address; decoy.sin_addr.s_addr = htonl(UINT32_C(0x7f000002));
  ssize_t (*sendto_nc)(int, const void *, size_t, int, const struct sockaddr *, socklen_t) = dlsym(RTLD_DEFAULT, "sendto$NOCANCEL");
  ssize_t (*sendmsg_nc)(int, const struct msghdr *, int) = dlsym(RTLD_DEFAULT, "sendmsg$NOCANCEL");
  REQUIRE(sendto_nc && sendmsg_nc);
  struct iovec vec = {(void *)"x", 1};
  struct msghdr msg = {0}; msg.msg_name = &decoy; msg.msg_namelen = sizeof decoy;
  msg.msg_iov = &vec; msg.msg_iovlen = 1;
  // The narrowed contract does not inspect TCP's existing peer, even if the
  // kernel ignores this permitted supplied destination and uses that peer.
  allowed(sendto(tcp, "x", 1, 0, (struct sockaddr *)&decoy, sizeof decoy), accepted);
  allowed(sendmsg(tcp, &msg, 0), accepted);
  allowed(sendto_nc(tcp, "x", 1, 0, (struct sockaddr *)&decoy, sizeof decoy), accepted);
  allowed(sendmsg_nc(tcp, &msg, 0), accepted);

  int udp = socket(AF_INET, SOCK_DGRAM, 0); REQUIRE(udp >= 0);
  struct sockaddr_in unspec = udp_address; unspec.sin_family = AF_UNSPEC;
  sa_endpoints_t endpoints = {0}; endpoints.sae_dstaddr = (struct sockaddr *)&unspec;
  endpoints.sae_dstaddrlen = sizeof unspec;
  size_t sent = 0;
  CHECK(connectx(udp, &endpoints, SAE_ASSOCID_ANY, 0, &vec, 1, &sent, NULL) == -1 && errno == ECONNREFUSED);
  msg.msg_name = &udp_address;
  CHECK(sendmsg(udp, &msg, 0) == -1 && errno == ECONNREFUSED);
  CHECK(sendmsg_nc(udp, &msg, 0) == -1 && errno == ECONNREFUSED);
  CHECK(sendto_nc(udp, "x", 1, 0, (struct sockaddr *)&udp_address, sizeof udp_address) == -1 && errno == ECONNREFUSED);
  char byte;
  CHECK(recv(receiver, &byte, 1, 0) == -1 && (errno == EAGAIN || errno == EWOULDBLOCK));
  close(udp);

  // Rejecting unknown peers must not block addressed UDP to a permitted loopback peer.
  udp = socket(AF_INET, SOCK_DGRAM, 0); REQUIRE(udp >= 0);
  decoy.sin_port = udp_address.sin_port;
  CHECK(sendto(udp, "x", 1, 0, (struct sockaddr *)&decoy, sizeof decoy) == 1);
  close(udp);

  for (int operation = 0; operation < 5; operation++) {
    pid_t pid = fork(); REQUIRE(pid >= 0);
    if (pid == 0) {
      signal(SIGSEGV, fault); signal(SIGBUS, fault);
      void *unreadable = mmap(NULL, 4096, PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0);
      if (unreadable == MAP_FAILED) _exit(2);
      int fd = socket(AF_INET, SOCK_DGRAM, 0);
      ssize_t rc;
      if (operation == 0) rc = connect(fd, unreadable, sizeof(struct sockaddr_in));
      else if (operation == 1) rc = sendto(fd, "x", 1, 0, unreadable, sizeof(struct sockaddr_in));
      else if (operation == 2) rc = sendmsg(fd, unreadable, 0);
      else if (operation == 3) rc = connectx(fd, unreadable, SAE_ASSOCID_ANY, 0, NULL, 0, NULL, NULL);
      else { msg.msg_name = unreadable; rc = sendmsg(fd, &msg, 0); }
      _exit(rc == -1 && errno == EFAULT ? 0 : 3);
    }
    int status = 0; REQUIRE(waitpid(pid, &status, 0) == pid);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0);
  }
  close(tcp); close(accepted); close(listener); close(receiver); munmap(page, TEST_PAGE_BYTES);
  printf("%d edge failures\n", failures);
  return failures ? 1 : 0;
}
