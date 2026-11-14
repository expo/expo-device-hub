// SPDX-License-Identifier: MIT
#pragma once
#include <cstdint>
#include <optional>

namespace expo_capture {

// @ref LLP 0021#frame-path — the final post is read at its own deadline, once
// All methods run under the capture worker's mutex, including the condition-variable wait.
class LagTail {
 public:
  static constexpr int64_t delayUs = 50'000;
  struct Request {
    uint32_t handle;
    uint64_t sequence;
  };

  void post(uint32_t handle, int64_t nowUs) {
    request_ = {handle, request_.sequence + 1};
    dueUs_ = nowUs + delayUs;
    pending_ = true;
  }
  std::optional<Request> takeIfDue(int64_t nowUs) {
    if (!pending_ || nowUs < dueUs_) return std::nullopt;
    pending_ = false;
    return request_;
  }
  void retry(Request request, int64_t nowUs) {
    // A new post or a session reset supersedes an in-flight tail read.
    if (request.sequence != request_.sequence) return;
    pending_ = true;
    dueUs_ = nowUs + delayUs;
  }
  void reset() {
    pending_ = false;
    request_.sequence++;
  }
  bool pending() const { return pending_; }
  int64_t dueUs() const { return dueUs_; }

 private:
  Request request_{};
  int64_t dueUs_ = 0;
  bool pending_ = false;
};

}  // namespace expo_capture
