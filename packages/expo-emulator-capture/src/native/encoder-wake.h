// SPDX-License-Identifier: MIT
#pragma once
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>

namespace expo_capture {

constexpr auto kIdleKeyFrameDelay = std::chrono::milliseconds(40);

// @ref LLP 0020#socket-protocol — wake for a new key request while backing off a pending retry
template <class Ready>
void waitForEncoderWork(std::condition_variable& wake, std::unique_lock<std::mutex>& lock,
                        bool& keyRequested, const std::atomic<bool>& outputKeyRequested,
                        Ready&& ready) {
  const bool keyOnEntry = keyRequested;
  wake.wait_for(lock, keyOnEntry ? kIdleKeyFrameDelay : std::chrono::seconds(1),
                [&] {
                  return ready() || (!keyOnEntry && keyRequested) || outputKeyRequested.load();
                });
}

}  // namespace expo_capture
