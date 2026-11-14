// SPDX-License-Identifier: MIT
#pragma once
#include <exception>
#include "log.h"

namespace expo_capture {

// @ref LLP 0020#loading — no exception may cross into QEMU or a system callback
template <class Callback>
void guardCallback(const char* operation, Callback&& callback) noexcept {
  try {
    callback();
  } catch (const std::exception& error) {
    logLine("%s: %s", operation, error.what());
  } catch (...) {
    logLine("%s: unknown exception", operation);
  }
}

}  // namespace expo_capture
