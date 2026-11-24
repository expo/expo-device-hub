// SPDX-License-Identifier: MIT
#pragma once
#include <sys/socket.h>
#include <vector>
#include "protocol.h"

namespace expo_capture {

// @ref LLP 0020#socket-protocol — bounded work per poll, even if a peer never stops writing
inline ssize_t readCommandBatch(int socket, std::vector<uint8_t>& pending) {
  // Parsing the preceding batch leaves at most one incomplete command.
  if (pending.size() >= kSettingsCommandBytes)
    throw std::runtime_error("capture command buffer exceeded its limit");
  uint8_t bytes[256];
  ssize_t count = recv(socket, bytes, sizeof(bytes), 0);
  if (count > 0) pending.insert(pending.end(), bytes, bytes + count);
  return count;
}

}  // namespace expo_capture
