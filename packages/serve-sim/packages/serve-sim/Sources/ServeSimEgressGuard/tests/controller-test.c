// A long-lived guarded process. Only the external control helper changes policy.
#include <arpa/inet.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <fcntl.h>
#include <unistd.h>

static int bound(int type, struct sockaddr_in *address) {
  int fd = socket(AF_INET, type, 0);
  memset(address, 0, sizeof *address);
  address->sin_len = sizeof *address; address->sin_family = AF_INET;
  address->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  socklen_t size = sizeof *address;
  if (fd < 0 || bind(fd, (struct sockaddr *)address, size) || getsockname(fd, (struct sockaddr *)address, &size)) return -1;
  return fd;
}

int main(int argc, char **argv) {
  (void)argv;
  struct sockaddr_in tcp_address, udp_address;
  int listener = bound(SOCK_STREAM, &tcp_address), receiver = bound(SOCK_DGRAM, &udp_address);
  if (listener < 0 || receiver < 0 || listen(listener, 4)) return 2;
  int tcp = socket(AF_INET, SOCK_STREAM, 0), udp = socket(AF_INET, SOCK_DGRAM, 0);
  if (argc > 1) {
    errno = 0;
    int result = connect(tcp, (struct sockaddr *)&tcp_address, sizeof tcp_address);
    int refused = result == -1 && errno == ECONNREFUSED;
    close(tcp); close(udp); close(listener); close(receiver);
    return refused ? 0 : 2;
  }
  if (tcp < 0 || udp < 0 || connect(tcp, (struct sockaddr *)&tcp_address, sizeof tcp_address) ||
      connect(udp, (struct sockaddr *)&udp_address, sizeof udp_address)) return 2;
  int accepted = accept(listener, NULL, NULL);
  if (accepted < 0) return 2;
  puts("ready"); fflush(stdout);
  char command[32];
  while (fgets(command, sizeof command, stdin)) {
    int block = strcmp(command, "block\n") == 0;
    if (!block && strcmp(command, "passthrough\n") != 0) return 3;
    int senders[] = {tcp, udp}, receivers[] = {accepted, receiver};
    for (int i = 0; i < 2; i++) {
      errno = 0;
      ssize_t sent = send(senders[i], "x", 1, 0);
      {
        char byte;
        if (sent != 1 || recv(receivers[i], &byte, 1, 0) != 1 || byte != 'x') return 5;
      }
      struct iovec vector = {(void *)"w", 1};
      char byte;
      if (writev(senders[i], &vector, 1) != 1 || recv(receivers[i], &byte, 1, 0) != 1) return 6;
    }
    int fresh = socket(AF_INET, SOCK_STREAM, 0);
    errno = 0;
    int connected = connect(fresh, (struct sockaddr *)&tcp_address, sizeof tcp_address);
    if (block ? connected != -1 || errno != ECONNREFUSED : connected != 0) return 7;
    if (!block) { int incoming = accept(listener, NULL, NULL); if (incoming < 0) return 8; close(incoming); }
    close(fresh);
    int addressed_udp = socket(AF_INET, SOCK_DGRAM, 0);
    if (addressed_udp < 0) return 9;
    errno = 0;
    ssize_t addressed = sendto(addressed_udp, "a", 1, 0, (struct sockaddr *)&udp_address, sizeof udp_address);
    if (block ? addressed != -1 || errno != ECONNREFUSED : addressed != 1) return 9;
    if (!block) { char byte; if (recv(receiver, &byte, 1, 0) != 1) return 10; }
    close(addressed_udp);
    int file = open("/dev/null", O_WRONLY);
    if (file < 0 || write(file, "x", 1) != 1) return 11;
    close(file);
    printf("ok %s", command); fflush(stdout);
  }
  close(tcp); close(udp); close(accepted); close(listener); close(receiver);
  return 0;
}
