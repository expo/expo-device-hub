// Host-only probe: count actual peer checks for one allowed connected UDP send.
#include <sys/socket.h>

#ifdef SERVE_SIM_PEER_COUNTER
#include <stdatomic.h>
static _Atomic unsigned checks;
unsigned serve_sim_test_peer_checks(void) { return atomic_exchange(&checks, 0); }
static int counted_peer(int fd, struct sockaddr *address, socklen_t *size) {
  atomic_fetch_add(&checks, 1);
  return getpeername(fd, address, size);
}
__attribute__((used)) static const struct { const void *replacement; const void *original; }
interposers[] __attribute__((section("__DATA,__interpose"))) = {
  {(const void *)counted_peer, (const void *)getpeername},
};
#else
#include <arpa/inet.h>
#include <dlfcn.h>
#include <stdio.h>
#include <unistd.h>
#define REQUIRE(x) do { if (!(x)) return 2; } while (0)
int main(void) {
  unsigned (*count)(void) = dlsym(RTLD_DEFAULT, "serve_sim_test_peer_checks");
  REQUIRE(count);
  int receiver = socket(AF_INET, SOCK_DGRAM, 0), sender = socket(AF_INET, SOCK_DGRAM, 0);
  REQUIRE(receiver >= 0 && sender >= 0);
  struct sockaddr_in address = {0};
  address.sin_len = sizeof address; address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  socklen_t size = sizeof address;
  REQUIRE(bind(receiver, (struct sockaddr *)&address, size) == 0);
  REQUIRE(getsockname(receiver, (struct sockaddr *)&address, &size) == 0);
  REQUIRE(connect(sender, (struct sockaddr *)&address, size) == 0);
  (void)count();
  REQUIRE(send(sender, "x", 1, 0) == 1);
  unsigned send_checks = count();
  char byte;
  REQUIRE(recv(receiver, &byte, 1, 0) == 1 && byte == 'x');
  REQUIRE(sendto(sender, "y", 1, 0, NULL, 0) == 1);
  unsigned sendto_checks = count();
  REQUIRE(recv(receiver, &byte, 1, 0) == 1 && byte == 'y');
  ssize_t (*send_nc)(int, const void *, size_t, int) = dlsym(RTLD_DEFAULT, "send$NOCANCEL");
  REQUIRE(send_nc && send_nc(sender, "z", 1, 0) == 1);
  unsigned send_nc_checks = count();
  REQUIRE(recv(receiver, &byte, 1, 0) == 1 && byte == 'z');
  printf("{\"send\":%u,\"sendto\":%u,\"send_nocancel\":%u}\n", send_checks, sendto_checks, send_nc_checks);
  close(sender); close(receiver);
  return 0;
}
#endif
