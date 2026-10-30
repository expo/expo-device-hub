#include <TargetConditionals.h>
#if !TARGET_OS_SIMULATOR
#error This fixture must target the iOS Simulator.
#endif
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <ifaddrs.h>
#include <mach-o/dyld.h>
#include <net/if.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <unistd.h>
extern ssize_t send_nc(int, const void *, size_t, int) __asm__("_send$NOCANCEL");

#define REQUIRE(x) do { if (!(x)) { fprintf(stderr, "line %d: %s errno=%d\n", __LINE__, #x, errno); return 2; } } while (0)

static int mapped(const char *expected) {
  char target[4096], actual[4096];
  if (!realpath(expected, target)) return 0;
  for (uint32_t i = 0; i < _dyld_image_count(); i++) {
    const char *name = _dyld_get_image_name(i);
    if (name && realpath(name, actual) && strcmp(actual, target) == 0) return 1;
  }
  return 0;
}

static ssize_t transmit(int fd, int method) {
  char byte = 'x';
  struct iovec vector = {&byte, 1};
  struct msghdr message = {0};
  message.msg_iov = &vector; message.msg_iovlen = 1;
  switch (method) {
    case 0: return send(fd, &byte, 1, 0);
    case 1: return write(fd, &byte, 1);
    case 2: return writev(fd, &vector, 1);
    case 3: return sendto(fd, &byte, 1, 0, NULL, 0);
    case 5: return send_nc(fd, &byte, 1, 0);
    default: return sendmsg(fd, &message, 0);
  }
}

static int phase(int tcp, int accepted, int udp, int receiver) {
  int senders[] = {tcp, udp}, receivers[] = {accepted, receiver};
  for (int pair = 0; pair < 2; pair++) {
    for (int method = 0; method < 6; method++) {
      errno = 0;
      ssize_t sent = transmit(senders[pair], method);
      {
        REQUIRE(sent == 1);
        char byte;
        REQUIRE(recv(receivers[pair], &byte, 1, 0) == 1 && byte == 'x');
      }
    }
  }
  int file = open("/dev/null", O_WRONLY);
  REQUIRE(file >= 0 && write(file, "x", 1) == 1);
  REQUIRE(close(file) == 0);
  return 0;
}

int main(int argc, char **argv) {
  REQUIRE(argc == 4 || (argc == 5 && strcmp(argv[4], "block-only") == 0));
  REQUIRE(mapped(argv[1]) && mapped(argv[2]));
  const char *page = getenv("SERVE_SIM_EGRESS_POLICY_FILE");
  REQUIRE(page && strcmp(page, argv[3]) == 0);
  // No policy path is passed in the environment by the runner. The shipped loader callback
  // must supply it from the startup record, including for this non-app executable.
  struct ifaddrs *interfaces = NULL;
  REQUIRE(getifaddrs(&interfaces) == 0);
  struct sockaddr_in peer = {0};
  for (struct ifaddrs *item = interfaces; item; item = item->ifa_next) {
    if (item->ifa_addr && item->ifa_addr->sa_family == AF_INET &&
        (item->ifa_flags & IFF_UP) && !(item->ifa_flags & IFF_LOOPBACK)) {
      peer = *(struct sockaddr_in *)item->ifa_addr;
      if (peer.sin_addr.s_addr != INADDR_ANY) break;
    }
  }
  freeifaddrs(interfaces);
  REQUIRE(peer.sin_addr.s_addr != INADDR_ANY && (ntohl(peer.sin_addr.s_addr) >> 24) != 127);
  peer.sin_port = 0;
  int listener = socket(AF_INET, SOCK_STREAM, 0), receiver = socket(AF_INET, SOCK_DGRAM, 0);
  REQUIRE(listener >= 0 && receiver >= 0);
  REQUIRE(bind(listener, (struct sockaddr *)&peer, sizeof peer) == 0 && listen(listener, 1) == 0);
  struct sockaddr_in tcp_address = peer, udp_address = peer;
  socklen_t size = sizeof peer;
  REQUIRE(getsockname(listener, (struct sockaddr *)&tcp_address, &size) == 0);
  REQUIRE(bind(receiver, (struct sockaddr *)&peer, sizeof peer) == 0);
  size = sizeof peer;
  REQUIRE(getsockname(receiver, (struct sockaddr *)&udp_address, &size) == 0);
  int tcp = socket(AF_INET, SOCK_STREAM, 0), udp = socket(AF_INET, SOCK_DGRAM, 0);
  REQUIRE(tcp >= 0 && udp >= 0);
  if (argc == 5) {
    errno = 0;
    REQUIRE(connect(tcp, (struct sockaddr *)&tcp_address, sizeof tcp_address) == -1 && errno == ECONNREFUSED);
    errno = 0;
    REQUIRE(connect(udp, (struct sockaddr *)&udp_address, sizeof udp_address) == -1 && errno == ECONNREFUSED);
    errno = 0;
    REQUIRE(sendto(udp, "x", 1, 0, (struct sockaddr *)&udp_address, sizeof udp_address) == -1 && errno == ECONNREFUSED);
    close(tcp); close(udp); close(listener); close(receiver);
    puts("{\"phase\":\"block-only\"}");
    return 0;
  }
  // Both peers were successfully bound in this process before either connect. No outbound peer.
  REQUIRE(connect(tcp, (struct sockaddr *)&tcp_address, sizeof tcp_address) == 0);
  int accepted = accept(listener, NULL, NULL);
  REQUIRE(accepted >= 0 && connect(udp, (struct sockaddr *)&udp_address, sizeof udp_address) == 0);
  REQUIRE(phase(tcp, accepted, udp, receiver) == 0);
  char address[INET_ADDRSTRLEN];
  REQUIRE(inet_ntop(AF_INET, &peer.sin_addr, address, sizeof address));
  printf("{\"phase\":\"passthrough\",\"pid\":%d,\"localPeer\":\"%s\"}\n", getpid(), address);
  fflush(stdout);
  char command;
  REQUIRE(read(STDIN_FILENO, &command, 1) == 1 && command == 'b');
  REQUIRE(phase(tcp, accepted, udp, receiver) == 0);
  int fresh = socket(AF_INET, SOCK_STREAM, 0);
  REQUIRE(fresh >= 0);
  errno = 0;
  REQUIRE(connect(fresh, (struct sockaddr *)&tcp_address, sizeof tcp_address) == -1 && errno == ECONNREFUSED);
  close(fresh);
  puts("{\"phase\":\"block\"}"); fflush(stdout);
  REQUIRE(read(STDIN_FILENO, &command, 1) == 1 && command == 'p');
  REQUIRE(phase(tcp, accepted, udp, receiver) == 0);
  puts("{\"phase\":\"passthrough-again\"}"); fflush(stdout);
  close(tcp); close(accepted); close(udp); close(receiver); close(listener);
  return 0;
}
