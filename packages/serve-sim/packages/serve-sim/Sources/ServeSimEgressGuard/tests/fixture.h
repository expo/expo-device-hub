#pragma once
#include <stdatomic.h>
#include <stdint.h>

// Test fixture for the proposed control-page wire format, independent of the guard.
#define TEST_PAGE_BYTES 4096
#define TEST_MAGIC UINT64_C(0x5353454755415244)
struct TestPage {
  uint64_t magic;
  _Atomic uint64_t policy; // generation << 2 | mode (1 pass-through, 2 block)
  uint64_t warmup;
};
