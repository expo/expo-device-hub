#include "../src/native/protocol.h"
#include <cassert>
#include <cstring>
#include <iostream>

using namespace expo_capture;

static void streamSizes() {
  assert(streamSize(1080, 2424, 0) == std::make_pair(1080, 2424));
  assert(streamSize(1080, 2424, 1212) == std::make_pair(540, 1212));
  assert(streamSize(1080, 2424, 1280) == std::make_pair(570, 1280));
  assert(streamSize(1080, 2424, 4096) == std::make_pair(1080, 2424));
  assert(streamSize(2424, 1080, 1280) == std::make_pair(1280, 570));
  // Pixel 9 Pro Fold: unfolded and folded displays.
  assert(streamSize(2076, 2152, 1280) == std::make_pair(1234, 1280));
  assert(streamSize(1080, 2424, 1280) == std::make_pair(570, 1280));
  bool rejected = false;
  try {
    streamSize(1080, 2424, 1);
  } catch (...) {
    rejected = true;
  }
  assert(rejected);
}

static void pacing() {
  for (int fps : {5, 20, 30, 60, 120}) {
    FramePacer pacer;
    int captured = 0;
    for (int i = 0; i < 1200; i++) captured += pacer.take(int64_t(i) * 1000000 / 120, fps);
    assert(captured == fps * 10);
  }
  FramePacer pacer;
  assert(pacer.take(0, 30));
  assert(!pacer.take(1000, 30));
  assert(pacer.take(10000000, 30));
  assert(!pacer.take(10000001, 30));  // No catch-up burst after a stall.
  assert(pacer.take(10000002, 60));
  assert(!pacer.take(10000003, 60));  // A settings change restarts pacing.
}

static void header() {
  uint8_t bytes[kHeaderBytes];
  encodeHeader(bytes, 0x01020304, 0x0000000500000006ull, kResized, 2076, 2152, 60);
  const uint8_t expected[kHeaderBytes] = {'G', 'P', 'C', '1', 1, 2, 3, 4, 0, 0, 0, 5, 0, 0, 0, 6,
                                          0,   0,   0,   4,   0, 0, 8, 28, 0, 0, 8, 104, 0, 0, 0, 60};
  assert(memcmp(bytes, expected, kHeaderBytes) == 0);
}

static void settings() {
  uint8_t command[kSettingsCommandBytes] = {'S'};
  writeU32(command + 1, 1280);
  writeU32(command + 5, 60);
  writeU32(command + 9, 8'000'000);
  StreamSettings parsed;
  assert(parseSettings(command, parsed));
  assert(parsed.maxSize == 1280 && parsed.fps == 60 && parsed.bitRate == 8'000'000);
  writeU32(command + 5, 121);
  assert(!parseSettings(command, parsed));
  writeU32(command + 5, 60);
  writeU32(command + 9, 99'999);
  assert(!parseSettings(command, parsed));
  command[0] = 'K';
  assert(!parseSettings(command, parsed));
}

int main() {
  streamSizes();
  pacing();
  header();
  settings();
  std::cout << "native protocol, stream size, and pacing checks passed\n";
}
