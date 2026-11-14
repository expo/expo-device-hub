#include "../src/native/lag-tail.h"
#include <cassert>
#include <cstdio>
#include <vector>

int main() {
  using namespace expo_capture;
  LagTail tail;
  assert(!tail.pending() && !tail.takeIfDue(1'000'000));
  // The very first post still has a deadline when there is no previous-frame request.
  tail.post(7, 10);
  assert(tail.pending() && tail.dueUs() == 50'010);
  assert(!tail.takeIfDue(50'009));
  auto first = tail.takeIfDue(50'010);
  assert(first && first->handle == 7 && first->postUs == 10);
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
  // Sparse posts (100 ms apart) exceed the 50 ms idle threshold. Both normal
  // posts and tails must share the 1 FPS budget, while retaining the final post.
  LagTail sparse;
  FramePacer pacer;
  std::vector<int64_t> sentAt;
  uint32_t previous = 0, lastDelivered = 0;
  for (int64_t now = 0; now <= 2'100'000; now += 1'000) {
    if (now < 1'000'000 && now % 100'000 == 0) {
      uint32_t handle = uint32_t(now / 100'000) + 1;
      if (previous && pacer.take(now, 1)) {
        sentAt.push_back(now);
        lastDelivered = previous;
      }
      sparse.post(handle, now);
      previous = handle;
    }
    if (auto request = sparse.takeIfDue(now)) {
      if (sparse.pace(*request, pacer, now, 1)) {
        sentAt.push_back(now);
        lastDelivered = request->handle;
      }
    }
  }
  assert(sentAt.size() == 2 && lastDelivered == 10 && !sparse.pending());
  assert(sentAt[1] - sentAt[0] >= 999'000);
  // A shared tail can serve a fast role while a slower role keeps its deadline.
  LagTail roles;
  FramePacer fast, slow;
  assert(slow.take(0, 1));
  roles.post(11, 10);
  auto shared = roles.takeIfDue(50'010);
  assert(shared && roles.pace(*shared, fast, 50'010, 30));
  assert(!roles.pace(*shared, slow, 50'010, 1));
  assert(roles.dueUs() == 1'000'000);
  auto deferred = roles.takeIfDue(1'000'000);
  assert(deferred && roles.pace(*deferred, slow, 1'000'000, 1));
  roles.post(12, 1'000'001);
  assert(!roles.pace(*shared, fast, 2'000'000, 30));
  assert(roles.dueUs() == 1'050'001);
  puts("lag tail deadlines, replacement, retries, pacing and reset checks passed");
}
