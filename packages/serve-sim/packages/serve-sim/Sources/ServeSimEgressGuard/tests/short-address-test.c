#include "../destination.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <unistd.h>

static int failures;
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "FAIL line %d: %s errno=%d\n", __LINE__, #x, errno); failures++; } } while (0)

static void probe(int denied) {
  struct sockaddr_in server = {0};
  server.sin_len = sizeof server; server.sin_family = AF_INET; server.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int listener = socket(AF_INET, SOCK_STREAM, 0);
  CHECK(listener >= 0 && bind(listener, (struct sockaddr *)&server, sizeof server) == 0 && listen(listener, 16) == 0);
  socklen_t size = sizeof server;
  CHECK(getsockname(listener, (struct sockaddr *)&server, &size) == 0);
  CHECK(fcntl(listener, F_SETFL, O_NONBLOCK) == 0);
  struct sockaddr_in6 mapped = {0};
  mapped.sin6_len = sizeof mapped; mapped.sin6_family = AF_INET6; mapped.sin6_port = server.sin_port;
  CHECK(inet_pton(AF_INET6, "::ffff:127.0.0.1", &mapped.sin6_addr) == 1);
  // IPv4 short shapes are rejected by this host's kernel; preserve that boundary.
  for (socklen_t length = 8; length < sizeof server; length++) {
    int fd = socket(AF_INET, SOCK_STREAM, 0); CHECK(fd >= 0);
    CHECK(connect(fd, (struct sockaddr *)&server, length) == -1 && errno == EINVAL);
    close(fd);
  }
  int connected = 0;
  // These carry the full IPv6 address, but omit some/all scope-id bytes.
  for (socklen_t length = 24; length < sizeof mapped; length++) {
    int fd = socket(AF_INET6, SOCK_STREAM, 0); CHECK(fd >= 0);
    CHECK(fcntl(fd, F_SETFL, O_NONBLOCK) == 0);
    int rc = connect(fd, (struct sockaddr *)&mapped, length), error = errno;
    if (denied) CHECK(rc == -1 && error == ECONNREFUSED);
    else CHECK(rc == 0 || (rc == -1 && error == EINPROGRESS));
    if (rc == 0 || (rc == -1 && error == EINPROGRESS)) {
      struct pollfd ready = {listener, POLLIN, 0};
      CHECK(poll(&ready, 1, 1000) == 1);
      int accepted = accept(listener, NULL, NULL);
      CHECK(accepted >= 0);
      if (accepted >= 0) { connected++; close(accepted); }
    }
    close(fd);
  }
  printf("short mapped-IPv6 connections completed: %d (denied=%d)\n", connected, denied);
  CHECK(connected == (denied ? 0 : 4));
  close(listener);
}

int main(int argc, char **argv) {
  if (argc != 2 || (strcmp(argv[1], "denied") && strcmp(argv[1], "loopback"))) return 2;
  // No network calls to these documentation-only remote addresses.
  struct sockaddr_in remote = {0}; remote.sin_family = AF_INET;
  CHECK(inet_pton(AF_INET, "192.0.2.1", &remote.sin_addr) == 1);
  CHECK(eg_remote((struct sockaddr *)&remote, sizeof remote));
  struct sockaddr_in6 remote6 = {0}; remote6.sin6_family = AF_INET6;
  CHECK(inet_pton(AF_INET6, "::ffff:192.0.2.1", &remote6.sin6_addr) == 1);
  CHECK(eg_remote((struct sockaddr *)&remote6, 24));
  probe(strcmp(argv[1], "denied") == 0);
  return failures ? 1 : 0;
}
