#ifndef SERVE_SIM_SENDMSG_X_H
#define SERVE_SIM_SENDMSG_X_H
#include <sys/socket.h>
#include <sys/uio.h>

// Private libSystem ABI from XNU bsd/sys/socket_private.h; absent from public SDKs.
// msg_datalen is ignored on send. Keep one layout for the guard and its self-check.
struct eg_msghdr_x {
  void *msg_name;
  socklen_t msg_namelen;
  struct iovec *msg_iov;
  int msg_iovlen;
  void *msg_control;
  socklen_t msg_controllen;
  int msg_flags;
  size_t msg_datalen;
};
extern ssize_t eg_sendmsg_x_original(int, const struct eg_msghdr_x *, unsigned int, int)
    __asm__("_sendmsg_x");
#endif
