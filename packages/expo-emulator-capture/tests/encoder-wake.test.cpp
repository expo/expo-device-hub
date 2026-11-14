#include "../src/native/encoder-wake.h"
#include <cassert>
#include <cstdio>
#include <future>
#include <thread>

int main() {
  using namespace expo_capture;
  using namespace std::chrono;
  std::mutex mutex;
  std::condition_variable wake;
  bool key = false;
  std::atomic<bool> outputKey{false};
  std::promise<void> entered, completed;
  auto done = completed.get_future();
  std::thread encoder([&] {
    std::unique_lock<std::mutex> lock(mutex);
    entered.set_value();
    waitForEncoderWork(wake, lock, key, outputKey, [] { return false; });
    completed.set_value();
  });
  entered.get_future().wait();
  {
    // This acquires the mutex only after the encoder entered its idle wait,
    // matching the socket thread's key-request update under encodeMutex_.
    std::lock_guard<std::mutex> lock(mutex);
    key = true;
  }
  wake.notify_one();
  const bool woke = done.wait_for(milliseconds(700)) == std::future_status::ready;
  encoder.join();
  if (!woke) {
    fputs("idle encoder ignored the keyframe notification\n", stderr);
    return 1;
  }
  // A request already pending at entry is a retry. It must back off rather than spin
  // while the minimum on-demand capture interval has not elapsed.
  auto start = steady_clock::now();
  {
    std::unique_lock<std::mutex> lock(mutex);
    waitForEncoderWork(wake, lock, key, outputKey, [] { return false; });
  }
  assert(steady_clock::now() - start >= milliseconds(20));
  // Output-drain key requests are atomic and may already be pending at loop entry.
  key = false;
  outputKey = true;
  start = steady_clock::now();
  {
    std::unique_lock<std::mutex> lock(mutex);
    waitForEncoderWork(wake, lock, key, outputKey, [] { return false; });
  }
  assert(steady_clock::now() - start < milliseconds(700));
  puts("encoder keyframe wake and idle retry checks passed");
}
