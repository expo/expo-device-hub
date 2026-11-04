// Host microbenchmark only. No non-loopback peer or Simulator use.
#include <arpa/inet.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>

static _Atomic int stopped;
static void *drain(void *context) {
  int fd = *(int *)context;
  char buffer[2048];
  while (!atomic_load_explicit(&stopped, memory_order_relaxed)) (void)recv(fd, buffer, sizeof buffer, 0);
  return NULL;
}
static uint64_t now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC_RAW, &t);
  return (uint64_t)t.tv_sec * UINT64_C(1000000000) + (uint64_t)t.tv_nsec;
}
static int udp(struct sockaddr_in *address) {
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  memset(address, 0, sizeof *address);
  address->sin_len = sizeof *address; address->sin_family = AF_INET;
  address->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  socklen_t size = sizeof *address;
  if (fd < 0 || bind(fd, (struct sockaddr *)address, size) || getsockname(fd, (struct sockaddr *)address, &size)) return -1;
  return fd;
}
static ssize_t file_write(int fd) { return write(fd, "x", 1); }
static ssize_t file_writev(int fd) { struct iovec v = {(void *)"x", 1}; return writev(fd, &v, 1); }
static ssize_t socket_send(int fd) { return send(fd, "x", 1, 0); }
static ssize_t socket_sendto(int fd) { return sendto(fd, "x", 1, 0, NULL, 0); }

int main(int argc, char **argv) {
  if (argc != 4) return 2;
  long iterations = strtol(argv[2], NULL, 10);
  if (iterations < 1000) return 2;
  int fd = -1, receiver = -1;
  int socket_case = strcmp(argv[1], "udp_send") == 0 || strcmp(argv[1], "udp_sendto") == 0;
  pthread_t thread;
  if (socket_case) {
    struct sockaddr_in from, to;
    fd = udp(&from); receiver = udp(&to);
    if (fd < 0 || receiver < 0 || connect(fd, (struct sockaddr *)&to, sizeof to) ||
        connect(receiver, (struct sockaddr *)&from, sizeof from) || pthread_create(&thread, NULL, drain, &receiver)) return 3;
  } else fd = open(strcmp(argv[1], "null_write") == 0 ? "/dev/null" : argv[3], O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) return 3;
  ssize_t (*operation)(int) = socket_case ? (strcmp(argv[1], "udp_sendto") == 0 ? socket_sendto : socket_send) :
                            strcmp(argv[1], "file_writev") == 0 ? file_writev : file_write;
  for (int i = 0; i < 1000; i++) if (operation(fd) != 1) return 4;
  uint64_t start = now();
  for (long i = 0; i < iterations; i++) if (operation(fd) != 1) return 4;
  uint64_t elapsed = now() - start;
  if (socket_case) {
    atomic_store_explicit(&stopped, 1, memory_order_relaxed);
    shutdown(receiver, SHUT_RD); pthread_join(thread, NULL); close(receiver);
  }
  close(fd);
  printf("%.3f\n", (double)elapsed / (double)iterations);
  return 0;
}
