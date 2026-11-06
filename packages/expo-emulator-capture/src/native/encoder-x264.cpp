// SPDX-License-Identifier: MIT
// H.264 in software with x264 from the host system, for Linux. The agent does not bundle
// x264: it loads the system library at run time, as the macOS agent uses VideoToolbox.
// x264 puts its build number into the library and function names, and its interface
// changes between builds, so the agent supports one build: 165 (Ubuntu's libx264-165).
#include <dlfcn.h>
#include <algorithm>
#include <cctype>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
extern "C" {
#include <x264.h>
}
#include "encoder.h"
#include "log.h"
#include "yuv.h"

static_assert(X264_BUILD == 165, "the agent supports x264 build 165 only; install libx264-dev 165");

namespace expo_capture {
namespace {

constexpr const char* kX264Library = "libx264.so.165";
constexpr const char* kX264Missing =
    "x264 build 165 (libx264.so.165) is missing. Install it with: sudo apt install libx264-165 "
    "(Ubuntu 26.04 or later)";

// The x264 functions that the encoder calls, from the system library.
struct X264 {
  decltype(&x264_param_default_preset) paramDefaultPreset = nullptr;
  decltype(&x264_param_apply_profile) paramApplyProfile = nullptr;
  decltype(&x264_encoder_open) encoderOpen = nullptr;  // x264_encoder_open_165
  decltype(&x264_encoder_encode) encoderEncode = nullptr;
  decltype(&x264_encoder_close) encoderClose = nullptr;
  decltype(&x264_picture_init) pictureInit = nullptr;
};

template <typename Function>
bool resolve(void* handle, const char* name, Function& out) {
  out = reinterpret_cast<Function>(dlsym(handle, name));
  return out != nullptr;
}

// Loads x264 once and keeps it loaded. A failed load is tried again at the next call, so a
// library that the user installs while the emulator runs works from the next session.
bool loadX264(X264& out, std::string& error) {
  static std::mutex mutex;
  static X264 loaded;
  std::lock_guard<std::mutex> guard(mutex);
  if (!loaded.encoderOpen) {
    void* handle = dlopen(kX264Library, RTLD_NOW | RTLD_LOCAL);
    if (!handle) {
      const char* reason = dlerror();
      std::string detail = reason ? reason : "";
      std::string lower = detail;
      std::transform(lower.begin(), lower.end(), lower.begin(),
                     [](unsigned char c) { return char(std::tolower(c)); });
      // glibc: "libx264.so.165: cannot open shared object file: No such file or directory".
      error = detail.empty() || lower.find("no such file") != std::string::npos
                  ? std::string(kX264Missing)
                  : "loading " + std::string(kX264Library) + " failed: " + detail;
      return false;
    }
    X264 next;
    if (!resolve(handle, "x264_param_default_preset", next.paramDefaultPreset) ||
        !resolve(handle, "x264_param_apply_profile", next.paramApplyProfile) ||
        !resolve(handle, "x264_encoder_open_165", next.encoderOpen) ||
        !resolve(handle, "x264_encoder_encode", next.encoderEncode) ||
        !resolve(handle, "x264_encoder_close", next.encoderClose) ||
        !resolve(handle, "x264_picture_init", next.pictureInit)) {
      dlclose(handle);
      error = std::string(kX264Library) + " lacks the x264 build 165 functions";
      return false;
    }
    loaded = next;
  }
  out = loaded;
  return true;
}

// x264's warnings and errors go to the agent log, which the Hub keeps, not to the emulator's
// standard error, which it discards.
void x264Log(void*, int level, const char* format, va_list args) {
  char line[512];
  vsnprintf(line, sizeof(line), format, args);
  size_t length = strlen(line);
  while (length > 0 && (line[length - 1] == '\n' || line[length - 1] == '\r')) line[--length] = 0;
  logLine("x264 %s: %s", level <= X264_LOG_ERROR ? "error" : "warning", line);
}

// Without frames to encode (a static screen), a frame count is no clock: a keyframe also comes
// after this time.
constexpr int64_t kMaxKeyFrameIntervalUs = 10'000'000;

// A quarter of the cores, at most four: the emulator itself needs the rest.
int encoderThreads() {
  return std::max(1, std::min(4, int(std::thread::hardware_concurrency()) / 4));
}

I420Planes planesIn(std::vector<uint8_t>& buffer, int width, int height) {
  I420Planes planes;
  planes.y = buffer.data();
  planes.u = planes.y + size_t(width) * size_t(height);
  planes.v = planes.u + size_t(width / 2) * size_t(height / 2);
  planes.yStride = width;
  planes.uvStride = width / 2;
  planes.width = width;
  planes.height = height;
  return planes;
}

// @ref LLP 0018#encoder — ultrafast and zerolatency, with sliced threads
class X264Encoder final : public H264Encoder {
 public:
  // Errors return from configure and encode, so the error sink is not needed.
  explicit X264Encoder(Sink sink) : sink_(std::move(sink)) {}
  ~X264Encoder() override { invalidate(); }
  X264Encoder(const X264Encoder&) = delete;
  X264Encoder& operator=(const X264Encoder&) = delete;

  bool configure(int width, int height, int fps, int bitRate, int rotation,
                 std::string& error) override {
    invalidate();
    if (!loadX264(x264_, error)) return false;
    x264_param_t param;
    // zerolatency: no lookahead and no B-frames, so each call returns its own frame.
    if (x264_.paramDefaultPreset(&param, "ultrafast", "zerolatency") < 0) {
      error = "x264 has no ultrafast preset";
      return false;
    }
    int threads = encoderThreads();
    param.i_threads = threads;
    param.b_sliced_threads = threads > 1 ? 1 : 0;
    param.i_width = width;
    param.i_height = height;
    param.i_csp = X264_CSP_I420;
    param.i_fps_num = uint32_t(std::max(1, fps));
    param.i_fps_den = 1;
    param.i_timebase_num = 1;
    param.i_timebase_den = 1000000;
    param.b_vfr_input = 0;
    // Late joiners request keyframes, so periodic ones can be rare (as with scrcpy).
    param.i_keyint_max = std::max(1, fps) * 10;
    param.rc.i_rc_method = X264_RC_ABR;
    param.rc.i_bitrate = std::max(1, bitRate / 1000);
    param.rc.i_vbv_max_bitrate = param.rc.i_bitrate;
    param.rc.i_vbv_buffer_size = param.rc.i_bitrate;
    param.b_repeat_headers = 1;  // SPS and PPS before each keyframe.
    param.b_annexb = 1;
    param.i_log_level = X264_LOG_WARNING;
    param.pf_log = x264Log;
    // BT.709 limited range, as the conversion in yuv.h writes it.
    param.vui.i_colorprim = 1;
    param.vui.i_transfer = 1;
    param.vui.i_colmatrix = 1;
    param.vui.b_fullrange = 0;
    if (x264_.paramApplyProfile(&param, "baseline") < 0) {
      error = "x264 cannot apply the baseline profile";
      return false;
    }
    encoder_ = x264_.encoderOpen(&param);
    if (!encoder_) {
      error = "opening x264 for " + std::to_string(width) + "x" + std::to_string(height) +
              " failed";
      return false;
    }
    width_ = width;
    height_ = height;
    rotation_ = rotation;
    planes_.resize(size_t(width) * size_t(height) * 3 / 2);
    // Frames are scaled in the panel's orientation, then turned upright.
    if (rotation != 0) panelPlanes_.resize(planes_.size());
    encoderId_ = "x264-165 ultrafast (" + std::to_string(threads) +
                 (threads == 1 ? " thread)" : " threads)");
    return true;
  }

  bool encode(const CapturedFrame& frame, uint64_t ptsUs, bool forceKey,
              std::string& error) override {
    if (!encoder_) {
      error = "encoder is not configured";
      return false;
    }
    const RgbaImage& image = *frame.pixels;
    I420Planes upright = planesIn(planes_, width_, height_);
    if (rotation_ == 0) {
      converter_.convert(image.data.data(), image.width, image.height, size_t(image.width) * 4,
                         upright);
    } else {
      bool turned = rotation_ % 2 != 0;
      I420Planes panel =
          planesIn(panelPlanes_, turned ? height_ : width_, turned ? width_ : height_);
      converter_.convert(image.data.data(), image.width, image.height, size_t(image.width) * 4,
                         panel);
      rotateI420(panel, rotation_, upright);
    }
    x264_picture_t picture;
    x264_picture_t output;
    x264_.pictureInit(&picture);
    picture.img.i_csp = X264_CSP_I420;
    picture.img.i_plane = 3;
    picture.img.plane[0] = upright.y;
    picture.img.plane[1] = upright.u;
    picture.img.plane[2] = upright.v;
    picture.img.i_stride[0] = upright.yStride;
    picture.img.i_stride[1] = upright.uvStride;
    picture.img.i_stride[2] = upright.uvStride;
    // x264 needs increasing timestamps.
    int64_t pts = int64_t(ptsUs);
    if (pts <= lastPts_) pts = lastPts_ + 1;
    lastPts_ = pts;
    picture.i_pts = pts;
    // The frame-count interval above counts encoded frames, which a static screen does not
    // post; this keeps at most 10 s between keyframes, as VideoToolbox does on macOS.
    bool keyDue = lastKeyPts_ < 0 || pts - lastKeyPts_ >= kMaxKeyFrameIntervalUs;
    picture.i_type = forceKey || keyDue ? X264_TYPE_IDR : X264_TYPE_AUTO;
    x264_nal_t* nals = nullptr;
    int count = 0;
    // x264 copies the planes into its own frame during the call.
    int size = x264_.encoderEncode(encoder_, &nals, &count, &picture, &output);
    if (size < 0) {
      error = "x264 encoding failed";
      return false;
    }
    if (size > 0 && count > 0) {
      EncodedPacket packet;
      packet.key = output.b_keyframe != 0;
      packet.ptsUs = uint64_t(output.i_pts);
      if (packet.key) lastKeyPts_ = output.i_pts;
      // The NAL units of one call are contiguous in memory, with Annex-B start codes.
      packet.data.assign(nals[0].p_payload, nals[0].p_payload + size);
      sink_(std::move(packet));
    }
    return true;
  }

  void invalidate() override {
    if (encoder_) {
      x264_.encoderClose(encoder_);
      encoder_ = nullptr;
    }
    width_ = height_ = rotation_ = 0;
    lastPts_ = lastKeyPts_ = -1;
    encoderId_.clear();
  }

  bool hardware() const override { return false; }
  const std::string& encoderId() const override { return encoderId_; }

 private:
  Sink sink_;
  X264 x264_;
  x264_t* encoder_ = nullptr;
  int width_ = 0, height_ = 0, rotation_ = 0;
  int64_t lastPts_ = -1, lastKeyPts_ = -1;
  std::vector<uint8_t> planes_, panelPlanes_;
  RgbaToI420 converter_;
  std::string encoderId_;
};

}  // namespace

std::unique_ptr<H264Encoder> createH264Encoder(H264Encoder::Sink sink, H264Encoder::ErrorSink) {
  return std::make_unique<X264Encoder>(std::move(sink));
}

std::string h264EncoderProblem() {
  X264 library;
  std::string error;
  return loadX264(library, error) ? std::string() : error;
}

}  // namespace expo_capture
