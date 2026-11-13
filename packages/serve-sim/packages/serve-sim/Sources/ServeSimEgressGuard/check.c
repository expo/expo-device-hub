// Runs inside the selected Simulator with its boot-resident images.
#include <dlfcn.h>
#include <arpa/inet.h>
#include <errno.h>
#include "sendmsg-x.h"
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include "policy.h"

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  int (*status)(uint64_t *, uint64_t *, uint64_t *) = dlsym(RTLD_DEFAULT, "serve_sim_egress_status");
  Dl_info image;
  char actual[4096], expected[4096];
  uint64_t policy, device, inode;
  struct stat page;
  if (!status || !dladdr((const void *)status, &image) || !image.dli_fname ||
      !realpath(image.dli_fname, actual) || !realpath(argv[1], expected) || strcmp(actual, expected) ||
      !status(&policy, &device, &inode) || stat(argv[2], &page) ||
      device != (uint64_t)page.st_dev || inode != (uint64_t)page.st_ino) {
    fprintf(stderr, "Resident egress startup self-check failed\n"); return 1;
  }
  // No socket is opened: the interposer must refuse the named remote destination
  // before the invalid descriptor reaches the kernel. Pass-through must yield EBADF.
  struct sockaddr_in remote = {.sin_len = sizeof remote, .sin_family = AF_INET,
    .sin_port = htons(9), .sin_addr.s_addr = htonl(UINT32_C(0xc0000201))};
  struct eg_msghdr_x batch = {.msg_name = &remote, .msg_namelen = sizeof remote};
  errno = 0;
  ssize_t sent = eg_sendmsg_x_original(-1, &batch, 1, 0);
  int expected_error = eg_mode(policy) == EG_BLOCK ? ECONNREFUSED : EBADF;
  if (sent != -1 || errno != expected_error) {
    fprintf(stderr, "Resident egress sendmsg_x self-check failed\n"); return 1;
  }
  printf("{\"publishedGeneration\":%" PRIu64 ",\"policy\":\"%s\",\"pageIdentity\":\"%" PRIu64 ":%" PRIu64 "\"}\n",
         eg_generation(policy), eg_mode(policy) == EG_PASSTHROUGH ? "passthrough" : "block", device, inode);
  return 0;
}
