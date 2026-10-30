#pragma once
#include <stdatomic.h>
#include <stdint.h>

#define EG_PAGE_BYTES 4096
#define EG_MAGIC UINT64_C(0x5353454755415244)
#define EG_PASSTHROUGH UINT64_C(1)
#define EG_BLOCK UINT64_C(2)

static inline uint64_t eg_mode(uint64_t policy) { return policy & UINT64_C(3); }
static inline uint64_t eg_generation(uint64_t policy) { return policy >> 2; }

struct EgressPage {
  _Atomic uint64_t magic;
  _Atomic uint64_t policy; // generation << 2 | mode
  uint64_t warmup; // immutable explicit initial choice
};

_Static_assert(ATOMIC_LLONG_LOCK_FREE == 2, "Shared policy needs lock-free 64-bit atomics");
_Static_assert(sizeof(struct EgressPage) <= EG_PAGE_BYTES, "Policy must fit in one page");

// Keeps the descriptor open for the controller's advisory lock; readers can close it.
struct EgressPage *eg_map_policy(const char *path, int writable, int *fd_out);
int eg_valid_policy(uint64_t policy);
