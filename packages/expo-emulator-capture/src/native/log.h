// SPDX-License-Identifier: MIT
#pragma once

namespace expo_capture {

// Writes one line to the file named by EXPO_EMULATOR_CAPTURE_LOG, or to standard error.
void logLine(const char* format, ...) noexcept __attribute__((format(printf, 1, 2)));

}  // namespace expo_capture
