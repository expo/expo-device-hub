// Runs inside the selected Simulator with its boot-resident images.
#include <dlfcn.h>
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
  printf("{\"publishedGeneration\":%" PRIu64 ",\"policy\":\"%s\",\"pageIdentity\":\"%" PRIu64 ":%" PRIu64 "\"}\n",
         eg_generation(policy), eg_mode(policy) == EG_PASSTHROUGH ? "passthrough" : "block", device, inode);
  return 0;
}
