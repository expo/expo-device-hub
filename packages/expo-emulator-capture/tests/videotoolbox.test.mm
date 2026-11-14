#include "../src/native/encoder.h"
#include "../src/native/log.h"
#include <atomic>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <stdexcept>

static std::atomic<int> errors{0};
namespace expo_capture {
void logLine(const char*, ...) noexcept { errors++; }
}  // namespace expo_capture

int main() {
  using namespace expo_capture;
  std::atomic<int> packets{0};
  auto encoder = createH264Encoder(
      [&](EncodedPacket&&) {
        packets++;
        throw std::runtime_error("consumer allocation failed");
      },
      [](const std::string&) { assert(false && "unexpected encoder error"); });
  std::string error;
  assert(encoder->configure(EncoderConfig{32, 32, 30, 1'000'000}, error));
  CVPixelBufferRef pixels = nullptr;
  assert(CVPixelBufferCreate(kCFAllocatorDefault, 32, 32, kCVPixelFormatType_32BGRA,
                             nullptr, &pixels) == kCVReturnSuccess);
  assert(CVPixelBufferLockBaseAddress(pixels, 0) == kCVReturnSuccess);
  memset(CVPixelBufferGetBaseAddress(pixels), 128, CVPixelBufferGetBytesPerRow(pixels) * 32);
  CVPixelBufferUnlockBaseAddress(pixels, 0);
  CapturedFrame frame;
  frame.pixels = FramePixels(pixels);
  frame.width = frame.height = 32;
  assert(encoder->encode(frame, 1, true, error));
  // Wait for the real VideoToolbox callback. A thrown sink must not terminate this process.
  encoder->invalidate();
  assert(packets > 0 && errors == packets);
  puts("VideoToolbox contains exceptions from the packet sink");
}
