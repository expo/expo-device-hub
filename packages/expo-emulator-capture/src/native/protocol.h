// SPDX-License-Identifier: MIT
// GPC1 capture socket protocol shared by the agent and its unit tests.
#pragma once
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <utility>

namespace expo_capture {

// Every record is a 32-byte big-endian header followed by `length` payload bytes:
// magic "GPC1", length u32, pts u64 (microseconds), flags u32, width u32,
// height u32, fps u32.
// @ref LLP 0017#socket-protocol — record and command meanings
constexpr size_t kHeaderBytes = 32;
constexpr uint32_t kMaxPayloadBytes = 8 * 1024 * 1024;
constexpr int kMaxEdge = 4096;
constexpr int kMaxFps = 120;

enum RecordFlags : uint32_t {
  kFrame = 0,       // H.264 access unit, Annex-B.
  kKeyFrame = 1,    // IDR access unit that starts with SPS and PPS.
  kHello = 2,       // Native display size; payload is a JSON object.
  kConfigured = 3,  // Stream settings in effect; width and height are the stream size.
  kResized = 4,     // Native display size changed; a kConfigured record follows.
};

// Commands from the consumer: 'K' requests a keyframe. 'S' is followed by three
// big-endian u32 values: longest stream edge (0 = native), FPS, and bit rate.
// 'R' is followed by one big-endian u32: Android's display rotation, 0 to 3
// (Surface.ROTATION_0 to ROTATION_270). Hello's "protocol" is 2 or more when the
// agent accepts 'R'.
constexpr uint8_t kCommandKeyFrame = 'K';
constexpr uint8_t kCommandSettings = 'S';
constexpr uint8_t kCommandRotation = 'R';
constexpr size_t kSettingsCommandBytes = 13;
constexpr size_t kRotationCommandBytes = 5;
constexpr int kProtocolVersion = 2;
constexpr uint32_t kMinBitRate = 100'000;
constexpr uint32_t kMaxBitRate = 50'000'000;

inline void writeU32(uint8_t* out, uint32_t value) {
  for (int i = 3; i >= 0; i--) {
    out[i] = value & 255;
    value >>= 8;
  }
}

inline uint32_t readU32(const uint8_t* in) {
  return (uint32_t(in[0]) << 24) | (uint32_t(in[1]) << 16) | (uint32_t(in[2]) << 8) | in[3];
}

inline void encodeHeader(uint8_t* out, uint32_t length, uint64_t ptsUs, uint32_t flags,
                         uint32_t width, uint32_t height, uint32_t fps) {
  out[0] = 'G';
  out[1] = 'P';
  out[2] = 'C';
  out[3] = '1';
  writeU32(out + 4, length);
  writeU32(out + 8, uint32_t(ptsUs >> 32));
  writeU32(out + 12, uint32_t(ptsUs));
  writeU32(out + 16, flags);
  writeU32(out + 20, width);
  writeU32(out + 24, height);
  writeU32(out + 28, fps);
}

struct StreamSettings {
  int maxSize = 0;
  int fps = 60;
  int bitRate = 12'000'000;
};

// Returns false when the command is outside the protocol bounds.
inline bool parseSettings(const uint8_t* command, StreamSettings& out) {
  if (command[0] != kCommandSettings) return false;
  uint32_t maxSize = readU32(command + 1), fps = readU32(command + 5),
           bitRate = readU32(command + 9);
  if (maxSize > uint32_t(kMaxEdge) || fps < 1 || fps > uint32_t(kMaxFps) ||
      bitRate < kMinBitRate || bitRate > kMaxBitRate)
    return false;
  out.maxSize = int(maxSize);
  out.fps = int(fps);
  out.bitRate = int(bitRate);
  return true;
}

// Returns false unless the command is 'R' with a rotation from 0 to 3.
inline bool parseRotation(const uint8_t* command, int& out) {
  if (command[0] != kCommandRotation) return false;
  uint32_t rotation = readU32(command + 1);
  if (rotation > 3) return false;
  out = int(rotation);
  return true;
}

// @ref LLP 0017#rotation — the panel-sized color buffer holds the turned picture
// The upright size of a native color buffer at an Android display rotation: the
// color buffer keeps the panel's orientation, so rotations 1 and 3 swap the edges.
inline std::pair<int, int> uprightSize(int width, int height, int rotation) {
  return rotation % 2 ? std::make_pair(height, width) : std::make_pair(width, height);
}

// Even-sized, aspect-preserving cap on the longest edge, as in the Linux experiment.
inline std::pair<int, int> streamSize(int width, int height, int maxSize) {
  if (maxSize < 0 || maxSize > kMaxEdge || width < 2 || height < 2)
    throw std::runtime_error("invalid stream size");
  int edge = std::max(width, height);
  int target = maxSize > 0 ? std::min(maxSize, edge) : edge;
  target = std::min(target, kMaxEdge);
  int w = int(int64_t(width) * target / edge) / 2 * 2;
  int h = int(int64_t(height) * target / edge) / 2 * 2;
  if (w < 2 || h < 2) throw std::runtime_error("stream size too small for H.264");
  return {w, h};
}

// Clock-paced sampling before GPU work; tolerates callback jitter without drift.
// It never sleeps and never bursts to catch up after a stall.
struct FramePacer {
  int previousFps = 0;
  double nextUs = 0;
  bool take(int64_t elapsedUs, int fps) {
    double period = 1000000.0 / fps;
    if (previousFps != fps) {
      previousFps = fps;
      nextUs = double(elapsedUs);
    }
    if (double(elapsedUs) + std::min(1000.0, period * 0.05) < nextUs) return false;
    nextUs += period;
    if (nextUs <= double(elapsedUs)) nextUs = double(elapsedUs) + period;
    return true;
  }
};

}  // namespace expo_capture
