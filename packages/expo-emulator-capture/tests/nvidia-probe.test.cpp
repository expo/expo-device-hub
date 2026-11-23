// The frame descriptor stays opaque; this exercises the real preflight policy
// against a fake encoder enforcing the documented Turing hardware dimensions.
#define EXPO_EMULATOR_CAPTURE_NVIDIA
#include "../src/native/nvidia-probe.h"
#include <cassert>
#include <cstdio>

class NvencCaps final : public expo_capture::H264Encoder {
 public:
  bool configure(const expo_capture::EncoderConfig& config, std::string& error) override {
    configured++;
    if (config.width < 145 || config.height < 1 || config.width % 2 || config.height % 2) {
      error = "input dimensions below NVENC capability";
      return false;
    }
    if (fail) { error = "PTX or NVENC initialization failed"; return false; }
    return true;
  }
  bool encode(const expo_capture::CapturedFrame&, uint64_t, bool, std::string&) override {
    assert(false && "readiness should not require a captured frame");
    return false;
  }
  void invalidate() override { invalidated++; }
  bool hardware() const override { return true; }
  const std::string& encoderId() const override { return id; }
  bool fail = false;
  int configured = 0, invalidated = 0;
  const std::string id = "test NVENC capabilities";
};

int main() {
  NvencCaps encoder;
  auto error = expo_capture::probeNvidiaEncoder(encoder);
  assert(error.empty() && "a supported NVENC device must not fail on undersized probe input");
  assert(encoder.configured == 1 && encoder.invalidated == 1);
  encoder.fail = true;
  assert(expo_capture::probeNvidiaEncoder(encoder) == "PTX or NVENC initialization failed");
  assert(encoder.configured == 2 && encoder.invalidated == 2);
  puts("NVIDIA preflight hardware dimensions, error propagation and cleanup checks passed");
}
