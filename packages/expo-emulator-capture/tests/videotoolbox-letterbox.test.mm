#include "../src/native/encoder.h"
#include "../src/native/log.h"
#import <Foundation/Foundation.h>
#include <VideoToolbox/VideoToolbox.h>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <mutex>

namespace expo_capture {
void logLine(const char*, ...) noexcept {}
}  // namespace expo_capture

using namespace expo_capture;

// Decode the encoder's actual Annex-B output, so the test covers placement, conversion and encode.
static CVPixelBufferRef decode(const EncodedPacket& packet) {
  const auto& data = packet.data;
  std::vector<size_t> starts;
  for (size_t i = 0; i + 4 <= data.size(); ++i) {
    if (data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 0 && data[i + 3] == 1)
      starts.push_back(i);
  }
  starts.push_back(data.size());
  const uint8_t* parameters[2] = {};
  size_t parameterSizes[2] = {};
  std::vector<uint8_t> avcc;
  for (size_t i = 0; i + 1 < starts.size(); ++i) {
    size_t begin = starts[i] + 4, length = starts[i + 1] - begin;
    assert(length > 0);
    int type = data[begin] & 31;
    if (type == 7 || type == 8) {
      int index = type == 7 ? 0 : 1;
      parameters[index] = data.data() + begin;
      parameterSizes[index] = length;
    } else {
      avcc.insert(avcc.end(), {uint8_t(length >> 24), uint8_t(length >> 16),
                               uint8_t(length >> 8), uint8_t(length)});
      avcc.insert(avcc.end(), data.begin() + begin, data.begin() + begin + length);
    }
  }
  assert(parameters[0] && parameters[1] && !avcc.empty());
  CMVideoFormatDescriptionRef format = nullptr;
  assert(CMVideoFormatDescriptionCreateFromH264ParameterSets(
             kCFAllocatorDefault, 2, parameters, parameterSizes, 4, &format) == noErr);
  CMBlockBufferRef block = nullptr;
  assert(CMBlockBufferCreateWithMemoryBlock(kCFAllocatorDefault, nullptr, avcc.size(),
                                           kCFAllocatorDefault, nullptr, 0, avcc.size(), 0,
                                           &block) == noErr);
  assert(CMBlockBufferReplaceDataBytes(avcc.data(), block, 0, avcc.size()) == noErr);
  CMSampleBufferRef sample = nullptr;
  size_t sampleSize = avcc.size();
  assert(CMSampleBufferCreateReady(kCFAllocatorDefault, block, format, 1, 0, nullptr,
                                   1, &sampleSize, &sample) == noErr);
  struct Decoded {
    CVPixelBufferRef pixels = nullptr;
  } decoded;
  VTDecompressionOutputCallbackRecord callback = {
      [](void* context, void*, OSStatus status, VTDecodeInfoFlags, CVImageBufferRef image,
         CMTime, CMTime) {
        assert(status == noErr && image);
        static_cast<Decoded*>(context)->pixels = CVPixelBufferRetain(image);
      },
      &decoded};
  NSDictionary* attributes = @{
    (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),
    (id)kCVPixelBufferIOSurfacePropertiesKey : @{},
  };
  VTDecompressionSessionRef decoder = nullptr;
  assert(VTDecompressionSessionCreate(kCFAllocatorDefault, format, nullptr,
                                      (__bridge CFDictionaryRef)attributes, &callback,
                                      &decoder) == noErr);
  assert(VTDecompressionSessionDecodeFrame(decoder, sample, 0, nullptr, nullptr) == noErr);
  assert(VTDecompressionSessionFinishDelayedFrames(decoder) == noErr);
  assert(VTDecompressionSessionWaitForAsynchronousFrames(decoder) == noErr);
  assert(decoded.pixels);
  VTDecompressionSessionInvalidate(decoder);
  CFRelease(decoder);
  CFRelease(sample);
  CFRelease(block);
  CFRelease(format);
  return decoded.pixels;
}

static CapturedFrame whiteFrame(int width, int height) {
  CVPixelBufferRef pixels = nullptr;
  NSDictionary* attributes = @{(id)kCVPixelBufferIOSurfacePropertiesKey : @{}};
  assert(CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
                             (__bridge CFDictionaryRef)attributes, &pixels) == kCVReturnSuccess);
  assert(CVPixelBufferLockBaseAddress(pixels, 0) == kCVReturnSuccess);
  memset(CVPixelBufferGetBaseAddress(pixels), 255,
         CVPixelBufferGetBytesPerRow(pixels) * height);
  CVPixelBufferUnlockBaseAddress(pixels, 0);
  CapturedFrame frame;
  frame.pixels = FramePixels(pixels);
  frame.width = width;
  frame.height = height;
  return frame;
}

int main() {
  std::mutex mutex;
  std::condition_variable ready;
  std::vector<EncodedPacket> packets;
  auto encoder = createH264Encoder(
      [&](EncodedPacket&& packet) {
        std::lock_guard<std::mutex> lock(mutex);
        packets.push_back(std::move(packet));
        ready.notify_one();
      },
      [](const std::string&) { assert(false && "unexpected encoder error"); });
  EncoderConfig config{128, 160, 30, 5'000'000};
  config.letterbox = true;
  std::string error;
  assert(encoder->configure(config, error));
  struct Placement {
    int width, height, x, y, placedWidth, placedHeight;
  };
  // Prime the output pool with white, then change panels and scale down on the same encoder.
  const Placement cases[] = {
      {128, 160, 0, 0, 128, 160},
      {64, 160, 32, 0, 64, 160},
      {128, 128, 0, 16, 128, 128},
      {256, 128, 0, 48, 128, 64},
      {64, 160, 32, 0, 64, 160},
  };
  size_t index = 0;
  for (const auto& placement : cases) {
    auto frame = whiteFrame(placement.width, placement.height);
    assert(encoder->encode(frame, (++index) * 33'333, true, error));
    EncodedPacket packet;
    {
      std::unique_lock<std::mutex> lock(mutex);
      assert(ready.wait_for(lock, std::chrono::seconds(5), [&] { return packets.size() >= index; }));
      packet = packets[index - 1];
    }
    CVPixelBufferRef pixels = decode(packet);
    assert(CVPixelBufferGetWidth(pixels) == 128 && CVPixelBufferGetHeight(pixels) == 160);
    assert(CVPixelBufferLockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly) == kCVReturnSuccess);
    const auto* luma = static_cast<const uint8_t*>(CVPixelBufferGetBaseAddressOfPlane(pixels, 0));
    size_t stride = CVPixelBufferGetBytesPerRowOfPlane(pixels, 0);
    for (int y = 4; y < 160; y += 8) {
      for (int x = 4; x < 128; x += 8) {
        bool inside = x >= placement.x && x < placement.x + placement.placedWidth &&
                      y >= placement.y && y < placement.y + placement.placedHeight;
        int value = luma[y * stride + x];
        // Compression can slightly change the levels; black bars must never retain old white.
        assert(inside ? value > 200 : value < 24);
      }
    }
    CVPixelBufferUnlockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);
    CVPixelBufferRelease(pixels);
  }
  encoder->invalidate();
  puts("VideoToolbox recording preserves its canvas and clears borders through panel changes");
}
