#include "../src/native/lag-tail.h"
#include <cassert>
#include <cstdio>

int main() {
  using namespace expo_capture;
  LagTail tail;
  assert(!tail.pending() && !tail.takeIfDue(1'000'000));
  // The very first post still has a deadline when there is no previous-frame request.
  tail.post(7, 10);
  assert(tail.pending() && tail.dueUs() == 50'010);
  assert(!tail.takeIfDue(50'009));
  auto first = tail.takeIfDue(50'010);
  assert(first && first->handle == 7);
  assert(!tail.takeIfDue(100'000));
  // Posting during a read starts an independent deadline. Completing the old read
  // must not erase that post, and retrying a failed old read must not replace it.
  tail.post(8, 60'000);
  tail.retry(*first, 70'000);
  assert(tail.dueUs() == 110'000);
  auto second = tail.takeIfDue(110'000);
  assert(second && second->handle == 8);
  tail.retry(*second, 120'000);
  assert(!tail.takeIfDue(169'999));
  assert(tail.takeIfDue(170'000)->handle == 8);
  tail.reset();
  tail.retry(*second, 180'000);
  assert(!tail.pending());
  // Continuously arriving posts postpone the tail; only the newest handle is read.
  for (int i = 1; i < 100; i++) {
    tail.post(uint32_t(i), i * 1'000);
    assert(!tail.takeIfDue(i * 1'000));
  }
  assert(tail.takeIfDue(149'000)->handle == 99);
  puts("lag tail deadlines, replacement, retries and reset checks passed");
}
