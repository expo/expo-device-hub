// Compare libc cancellation entrypoints using only a local socketpair.
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

extern ssize_t send_nc(int, const void *, size_t, int) __asm__("_send$NOCANCEL");
static _Atomic int ready, proceed;
static int fd, nocancel;
static void *worker(void *unused) {
  (void)unused;
  atomic_store(&ready, 1);
  while (!atomic_load(&proceed)) { }
  ssize_t result = nocancel ? send_nc(fd, "x", 1, 0) : send(fd, "x", 1, 0);
  return result == 1 ? (void *)1 : (void *)2;
}
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  nocancel = strcmp(argv[1], "nocancel") == 0;
  int pair[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair)) return 2;
  fd = pair[0];
  pthread_t thread;
  if (pthread_create(&thread, NULL, worker, NULL)) return 2;
  while (!atomic_load(&ready)) { }
  if (pthread_cancel(thread)) return 2;
  atomic_store(&proceed, 1);
  void *result = NULL;
  if (pthread_join(thread, &result)) return 2;
  close(pair[0]); close(pair[1]);
  int correct = nocancel ? result == (void *)1 : result == PTHREAD_CANCELED;
  printf("%s: %s\n", argv[1], correct ? "PASS" : "FAIL");
  return correct ? 0 : 1;
}
