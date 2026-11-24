// SPDX-License-Identifier: MIT
// GL/CUDA interoperability and FFmpeg/NVENC input follow PR #107 (32a51830).
// The normal agent owns the hook, pacing, role queues, timestamps and socket protocol.
#include "encoder.h"
#include "frame-source.h"
#include "protocol.h"
#include "nvidia-probe.h"
#include "nvidia-ptx.h"
#include <dlfcn.h>
#include <algorithm>
#include <chrono>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <typeinfo>
#include <ffnvcodec/dynlink_cuda.h>
static_assert(offsetof(CUDA_MEMCPY2D, srcMemoryType) == 16);
static_assert(offsetof(CUDA_MEMCPY2D, dstMemoryType) == 72);
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/opt.h>
}

namespace expo_capture {
namespace {
using Clock = std::chrono::steady_clock;
void avCheck(int code, const char* operation) {
  if (code >= 0) return;
  char message[AV_ERROR_MAX_STRING_SIZE];
  av_strerror(code, message, sizeof(message));
  throw std::runtime_error(std::string(operation) + ": " + message);
}
void cuCheck(CUresult code, const char* operation) {
  if (code != CUDA_SUCCESS)
    throw std::runtime_error(std::string(operation) + ": CUDA error " + std::to_string(code));
}
template<class T> T symbol(void* library, const char* name) {
  auto address = dlsym(library, name);
  if (!address) throw std::runtime_error(std::string("NVIDIA driver is missing ") + name);
  return reinterpret_cast<T>(address);
}
// Public leading fields of FFmpeg AVCUDADeviceContext (LGPL-2.1+). As in #107,
// this avoids requiring the CUDA toolkit headers/runtime on the emulator host.
struct CudaDevicePrefix { CUcontext context; CUstream stream; };

struct Device {
  void* library = nullptr;
  AVBufferRef* hw = nullptr;
  CUcontext context = nullptr;
  tcuCtxPushCurrent_v2* push = nullptr;
  tcuCtxPopCurrent_v2* pop = nullptr;
  tcuGraphicsGLRegisterImage* reg = nullptr;
  tcuGraphicsUnregisterResource* unregister = nullptr;
  tcuGraphicsMapResources* map = nullptr;
  tcuGraphicsUnmapResources* unmap = nullptr;
  tcuGraphicsSubResourceGetMappedArray* array = nullptr;
  tcuMemcpy2D_v2* copy = nullptr;
  CUresult (CUDAAPI *describe)(CUDA_ARRAY_DESCRIPTOR*, CUarray) = nullptr;
  tcuStreamSynchronize* sync = nullptr;
  tcuModuleLoadData* moduleLoad = nullptr;
  tcuModuleUnload* moduleUnload = nullptr;
  tcuModuleGetFunction* function = nullptr;
  tcuLaunchKernel* launch = nullptr;

  ~Device() {
    av_buffer_unref(&hw);
    if (library) dlclose(library);
  }
  void initialize() {
    library = dlopen("libcuda.so.1", RTLD_NOW | RTLD_LOCAL);
    if (!library) throw std::runtime_error("NVIDIA capture needs the NVIDIA driver (libcuda.so.1)");
#define LOAD(field, name) field = symbol<decltype(field)>(library, name)
    LOAD(push, "cuCtxPushCurrent_v2"); LOAD(pop, "cuCtxPopCurrent_v2");
    LOAD(reg, "cuGraphicsGLRegisterImage"); LOAD(unregister, "cuGraphicsUnregisterResource");
    LOAD(map, "cuGraphicsMapResources"); LOAD(unmap, "cuGraphicsUnmapResources");
    LOAD(array, "cuGraphicsSubResourceGetMappedArray"); LOAD(copy, "cuMemcpy2D_v2");
    LOAD(describe, "cuArrayGetDescriptor_v2"); LOAD(sync, "cuStreamSynchronize");
    LOAD(moduleLoad, "cuModuleLoadData"); LOAD(moduleUnload, "cuModuleUnload");
    LOAD(function, "cuModuleGetFunction"); LOAD(launch, "cuLaunchKernel");
#undef LOAD
    avCheck(av_hwdevice_ctx_create(&hw, AV_HWDEVICE_TYPE_CUDA, "0", nullptr, 0), "CUDA device 0");
    auto* device = reinterpret_cast<AVHWDeviceContext*>(hw->data);
    context = reinterpret_cast<CudaDevicePrefix*>(device->hwctx)->context;
    if (!context) throw std::runtime_error("FFmpeg returned no CUDA context");
  }
};

std::shared_ptr<Device> device() {
  static std::mutex mutex;
  static std::weak_ptr<Device> cached;
  std::lock_guard<std::mutex> guard(mutex);
  if (auto current = cached.lock()) return current;
  auto current = std::make_shared<Device>();
  current->initialize();  // Failed probes are not cached; a later session may retry.
  cached = current;
  return current;
}

class CurrentCuda {
 public:
  explicit CurrentCuda(Device& device) : device_(device) {
    cuCheck(device_.push(device_.context), "push CUDA context");
  }
  ~CurrentCuda() { CUcontext previous; device_.pop(&previous); }
 private:
  Device& device_;
};

struct FrameDeleter {
  void operator()(AVFrame* frame) const { av_frame_free(&frame); }
};
using Frame = std::unique_ptr<AVFrame, FrameDeleter>;
Frame allocateFrame(AVBufferRef* pool) {
  Frame frame(av_frame_alloc());
  if (!frame) throw std::runtime_error("allocating CUDA frame failed");
  avCheck(av_hwframe_get_buffer(pool, frame.get(), 0), "allocating CUDA image");
  return frame;
}
void makePool(Device& device, AVBufferRef*& pool, int width, int height) {
  AVBufferRef* replacement = av_hwframe_ctx_alloc(device.hw);
  if (!replacement) throw std::runtime_error("allocating CUDA frame pool failed");
  auto* frames = reinterpret_cast<AVHWFramesContext*>(replacement->data);
  frames->format = AV_PIX_FMT_CUDA;
  frames->sw_format = AV_PIX_FMT_0BGR32;
  frames->width = width;
  frames->height = height;
  frames->initial_pool_size = 8;
  int result = av_hwframe_ctx_init(replacement);
  if (result < 0) {
    av_buffer_unref(&replacement);
    avCheck(result, "initializing CUDA frame pool");
  }
  av_buffer_unref(&pool);
  pool = replacement;
}

class RendererContext {
 public:
  RendererContext(const Gfxstream& g, void* display, void* surface, void* context) : g_(g) {
    oldContext_ = g.eglGetCurrentContext();
    oldDisplay_ = g.eglGetCurrentDisplay();
    oldDraw_ = g.eglGetCurrentSurface(0x3059);
    oldRead_ = g.eglGetCurrentSurface(0x305A);
    display_ = display;
    if (!g.eglMakeCurrent(display, surface, surface, context))
      throw std::runtime_error("cannot bind the shared renderer GL context");
  }
  ~RendererContext() {
    g_.eglMakeCurrent(display_, nullptr, nullptr, nullptr);
    if (oldContext_) g_.eglMakeCurrent(oldDisplay_, oldDraw_, oldRead_, oldContext_);
  }
 private:
  const Gfxstream& g_;
  void* display_ = nullptr;
  void* oldContext_ = nullptr;
  void* oldDisplay_ = nullptr;
  void* oldDraw_ = nullptr;
  void* oldRead_ = nullptr;
};
struct RendererLock {
  const Gfxstream& g; void* fb;
  RendererLock(const Gfxstream& g, void* fb) : g(g), fb(fb) { g.lock(fb); }
  ~RendererLock() { g.unlock(fb); }
};

// Registers only while the renderer image is retained and locked. Unlike #107's
// texture-name cache, a fold/reallocated GL name cannot leave a stale CUDA registration.
struct MappedImage {
  Device& device;
  CUgraphicsResource resource = nullptr;
  bool mapped = false;
  explicit MappedImage(Device& device, unsigned texture) : device(device) {
    cuCheck(device.reg(&resource, texture, 0x0DE1, 1), "register renderer GL texture");
    auto code = device.map(1, &resource, nullptr);
    if (code != CUDA_SUCCESS) {
      device.unregister(resource);
      resource = nullptr;
      cuCheck(code, "map renderer GL texture");
    }
    mapped = true;
  }
  void finish() {
    cuCheck(device.unmap(1, &resource, nullptr), "unmap renderer GL texture");
    mapped = false;
    cuCheck(device.sync(nullptr), "complete GPU snapshot");
  }
  ~MappedImage() {
    if (mapped) { device.unmap(1, &resource, nullptr); device.sync(nullptr); }
    if (resource) device.unregister(resource);
  }
};
}  // namespace

struct CudaFrame {
  std::shared_ptr<Device> device;
  Frame image;
};

namespace {
// @ref LLP 0021#nvidia-capture — raw pixels stay in CUDA; one snapshot serves both roles
class NvidiaSource final : public FrameSource {
 public:
  explicit NvidiaSource(const Gfxstream& g) : g_(g) {}
  ~NvidiaSource() override { av_buffer_unref(&pool_); }
  bool gpuUnavailable() const override { return !g_.nvidiaEntryPointsAvailable(); }
  bool capture(uint32_t handle, CapturedFrame& out, std::string& error) override {
    std::lock_guard<std::mutex> guard(mutex_);
    try {
      if (!g_.nvidiaEntryPointsAvailable())
        throw std::runtime_error("NVIDIA capture needs gfxstream GL texture and EGL entry points");
      if (!device_) device_ = device();
      auto begin = Clock::now();
      void* fb = g_.getFB();
      if (!fb) throw std::runtime_error("renderer is not initialized");
      RendererLock lock(g_, fb);
      auto retained = g_.findColorBuffer(fb, handle);
      if (!retained) throw std::runtime_error("posted color buffer disappeared");
      // @ref LLP 0021#nvidia-capture — borrow through the exported renderer API on Linux
      auto borrowed = g_.borrowColorBufferForDisplay(fb, handle);
      auto* descriptor = borrowed.get();
      if (!descriptor || !strstr(typeid(*descriptor).name(), "BorrowedImageInfoGl"))
        throw std::runtime_error("renderer did not return a GL image descriptor");
      auto* info = static_cast<BorrowedImageInfoGl*>(borrowed.get());
      if (info->width != g_.colorBufferWidth(retained.get()) ||
          info->height != g_.colorBufferHeight(retained.get()) || !info->texture ||
          info->width < 2 || info->height < 2 || info->width > kMaxEdge || info->height > kMaxEdge)
        throw std::runtime_error("invalid renderer GL image dimensions");
      if (!context_) {
        display_ = g_.getDisplay(fb);
        g_.createSharedTrivialContext(fb, &context_, &surface_);
        if (!context_ || !surface_) throw std::runtime_error("cannot create shared renderer context");
      }
      RendererContext renderer(g_, display_, surface_, context_);
      unsigned texture = g_.getGlobalTexName(info->texture);
      if (!texture) throw std::runtime_error("renderer texture has no native GL name");
      if (!pool_ || width_ != int(info->width) || height_ != int(info->height)) {
        makePool(*device_, pool_, info->width, info->height);
        width_ = info->width; height_ = info->height;
      }
      auto snapshot = std::make_shared<CudaFrame>();
      snapshot->device = device_;
      snapshot->image = allocateFrame(pool_);
      CurrentCuda cuda(*device_);
      // CUDA mapping waits for preceding graphics work; the renderer stays locked until
      // the copy is complete and the image is unmapped, before graphics can reuse it.
      MappedImage mapped(*device_, texture);
      CUarray source = nullptr;
      cuCheck(device_->array(&source, mapped.resource, 0, 0), "get renderer CUDA array");
      CUDA_ARRAY_DESCRIPTOR desc{};
      cuCheck(device_->describe(&desc, source), "inspect renderer CUDA array");
      if (desc.Width != info->width || desc.Height != info->height ||
          desc.NumChannels != 4 || desc.Format != CU_AD_FORMAT_UNSIGNED_INT8)
        throw std::runtime_error("NVIDIA capture needs an RGBA8 renderer texture");
      CUDA_MEMCPY2D transfer{};
      transfer.srcMemoryType = CU_MEMORYTYPE_ARRAY;
      transfer.srcArray = source;
      transfer.dstMemoryType = CU_MEMORYTYPE_DEVICE;
      transfer.dstDevice = reinterpret_cast<CUdeviceptr>(snapshot->image->data[0]);
      transfer.dstPitch = snapshot->image->linesize[0];
      transfer.WidthInBytes = info->width * 4;
      transfer.Height = info->height;
      cuCheck(device_->copy(&transfer), "GPU-to-GPU snapshot");
      mapped.finish();
      out.pixels = std::move(snapshot);
      out.width = width_; out.height = height_; out.path = FramePath::Gpu;
      out.captureMs = std::chrono::duration<double, std::milli>(Clock::now() - begin).count();
      return true;
    } catch (const std::exception& e) { error = e.what(); return false; }
  }
 private:
  const Gfxstream& g_;
  std::mutex mutex_;
  std::shared_ptr<Device> device_;
  AVBufferRef* pool_ = nullptr;
  int width_ = 0, height_ = 0;
  void* context_ = nullptr;
  void* surface_ = nullptr;
  void* display_ = nullptr;
};

// @ref LLP 0021#nvidia-transform — per-role CUDA transforms and NVENC sessions
class NvidiaEncoder final : public H264Encoder {
 public:
  NvidiaEncoder(Sink sink, ErrorSink onError)
      : sink_(std::move(sink)), onError_(std::move(onError)) {}
  ~NvidiaEncoder() override { invalidate(); }
  bool hardware() const override { return true; }
  const std::string& encoderId() const override { return id_; }
  bool configure(const EncoderConfig& config, std::string& error) override {
    invalidate();
    try {
      const auto sizeProblem = nvidiaOutputSizeProblem(config.width, config.height);
      if (!sizeProblem.empty()) throw std::runtime_error(sizeProblem);
      if (config.width < 2 || config.height < 2 || config.width > kMaxEdge ||
          config.height > kMaxEdge || config.width % 2 || config.height % 2 ||
          config.fps < 1 || config.fps > kMaxFps || config.rotation < 0 || config.rotation > 3 ||
          config.keyFrameIntervalSeconds < 1 || config.keyFrameIntervalSeconds > 60 ||
          config.bitRate < int(kMinBitRate) || config.bitRate > int(kMaxBitRate))
        throw std::runtime_error("invalid NVIDIA encoder configuration");
      device_ = device();
      config_ = config;
      const AVCodec* codec = avcodec_find_encoder_by_name("h264_nvenc");
      if (!codec) throw std::runtime_error("this build has no FFmpeg h264_nvenc encoder");
      encoder_ = avcodec_alloc_context3(codec);
      if (!encoder_) throw std::runtime_error("allocating NVENC session failed");
      makePool(*device_, pool_, config.width, config.height);
      encoder_->width = config.width; encoder_->height = config.height;
      encoder_->pix_fmt = AV_PIX_FMT_CUDA;
      encoder_->time_base = AVRational{1, 1'000'000};
      encoder_->framerate = AVRational{config.fps, 1};
      encoder_->bit_rate = config.bitRate;
      encoder_->rc_max_rate = config.bitRate;
      encoder_->rc_buffer_size = config.bitRate;
      encoder_->gop_size = config.fps * config.keyFrameIntervalSeconds;
      encoder_->max_b_frames = 0;
      encoder_->color_primaries = AVCOL_PRI_BT709;
      encoder_->color_trc = AVCOL_TRC_BT709;
      // FFmpeg/NVENC converts packed RGB with a BT.601 matrix, and writes that
      // matrix to the VUI. Keep the requested metadata consistent with it.
      encoder_->colorspace = AVCOL_SPC_BT470BG;
      encoder_->color_range = AVCOL_RANGE_MPEG;
      encoder_->hw_frames_ctx = av_buffer_ref(pool_);
      if (!encoder_->hw_frames_ctx) throw std::runtime_error("retaining CUDA pool failed");
      avCheck(av_opt_set(encoder_->priv_data, "preset", "p1", 0), "NVENC preset");
      avCheck(av_opt_set(encoder_->priv_data, "tune", "ull", 0), "NVENC tuning");
      avCheck(av_opt_set(encoder_->priv_data, "profile", "baseline", 0), "NVENC profile");
      avCheck(av_opt_set(encoder_->priv_data, "rc", "cbr", 0), "NVENC rate control");
      avCheck(av_opt_set(encoder_->priv_data, "zerolatency", "1", 0), "NVENC zero latency");
      avCheck(av_opt_set(encoder_->priv_data, "delay", "0", 0), "NVENC output delay");
      avCheck(av_opt_set(encoder_->priv_data, "forced-idr", "1", 0), "NVENC IDR requests");
      // FFmpeg's NVENC backend repeats SPS/PPS when GLOBAL_HEADER is unset (the default).
      avCheck(av_opt_set(encoder_->priv_data, "rgb_mode", "yuv420", 0), "NVENC RGB conversion");
      avCheck(avcodec_open2(encoder_, codec, nullptr), "open NVIDIA H.264 encoder");
      CurrentCuda cuda(*device_);
      cuCheck(device_->moduleLoad(&module_, nvidiaPtx), "load CUDA transform");
      cuCheck(device_->function(&transform_, module_, "transformRgba"), "find CUDA transform");
      return true;
    } catch (const std::exception& e) { error = e.what(); invalidate(); return false; }
  }
  bool encode(const CapturedFrame& captured, uint64_t ptsUs, bool forceKey,
              std::string& error) override {
    try {
      if (!encoder_ || !captured.pixels || captured.pixels->device != device_)
        throw std::runtime_error("NVIDIA encoder has no compatible CUDA frame/session");
      Frame frame = allocateFrame(pool_);
      AVFrame* source = captured.pixels->image.get();
      auto size = uprightSize(captured.width, captured.height, config_.rotation);
      Rect placed = config_.letterbox
        ? placeOnCanvas(size.first, size.second, config_.width, config_.height)
        : Rect{0, 0, config_.width, config_.height};
      CurrentCuda cuda(*device_);
      CUdeviceptr src = reinterpret_cast<CUdeviceptr>(source->data[0]);
      CUdeviceptr dst = reinterpret_cast<CUdeviceptr>(frame->data[0]);
      unsigned long long sp = source->linesize[0], dp = frame->linesize[0];
      int sw = captured.width, sh = captured.height, dw = config_.width, dh = config_.height;
      int rotation = config_.rotation;
      void* args[] = {&src, &sp, &sw, &sh, &dst, &dp, &dw, &dh,
                      &placed.x, &placed.y, &placed.width, &placed.height, &rotation};
      cuCheck(device_->launch(transform_, (dw + 15) / 16, (dh + 15) / 16, 1,
                              16, 16, 1, 0, nullptr, args, nullptr), "CUDA frame transform");
      cuCheck(device_->sync(nullptr), "complete CUDA transform before NVENC");
      if (ptsUs > uint64_t(INT64_MAX)) throw std::runtime_error("NVIDIA timestamp overflow");
      int64_t pts = int64_t(ptsUs);
      if (pts <= lastPts_) {
        if (lastPts_ == INT64_MAX) throw std::runtime_error("NVIDIA timestamp overflow");
        pts = lastPts_ + 1;
      }
      lastPts_ = pts;
      bool key = forceKey || lastKeyPts_ < 0 ||
                 pts - lastKeyPts_ >= int64_t(config_.keyFrameIntervalSeconds) * 1'000'000;
      frame->pts = pts;
      frame->pict_type = key ? AV_PICTURE_TYPE_I : AV_PICTURE_TYPE_NONE;
      int submitted = avcodec_send_frame(encoder_, frame.get());
      if (submitted == AVERROR(EAGAIN)) {
        receive();
        submitted = avcodec_send_frame(encoder_, frame.get());
      }
      avCheck(submitted, "submit CUDA frame to NVENC");
      if (key) lastKeyPts_ = pts;
      receive();
      return true;
    } catch (const std::exception& e) { error = e.what(); return false; }
  }
  void invalidate() override {
    if (encoder_) {
      // No B-frames/lookahead; nevertheless deliver any packets retained by FFmpeg.
      try {
        if (avcodec_is_open(encoder_)) {
          avCheck(avcodec_send_frame(encoder_, nullptr), "flush NVENC");
          receive();
        }
      }
      catch (const std::exception& e) {
        try { if (onError_) onError_(e.what()); } catch (...) {}
      } catch (...) {}
      avcodec_free_context(&encoder_);
    }
    if (module_ && device_) {
      try { CurrentCuda cuda(*device_); device_->moduleUnload(module_); } catch (...) {}
    }
    module_ = nullptr; transform_ = nullptr;
    av_buffer_unref(&pool_);
    device_.reset();
    lastPts_ = lastKeyPts_ = -1;
  }
 private:
  void receive() {
    AVPacket* raw = av_packet_alloc();
    if (!raw) throw std::runtime_error("allocating NVENC packet failed");
    std::unique_ptr<AVPacket, void(*)(AVPacket*)> packet(raw, [](AVPacket* p) { av_packet_free(&p); });
    for (;;) {
      int status = avcodec_receive_packet(encoder_, raw);
      if (status == AVERROR(EAGAIN) || status == AVERROR_EOF) return;
      avCheck(status, "receive NVENC packet");
      if (raw->pts < 0) throw std::runtime_error("NVENC returned no valid timestamp");
      EncodedPacket output;
      output.data.assign(raw->data, raw->data + raw->size);
      output.ptsUs = uint64_t(raw->pts);
      output.key = raw->flags & AV_PKT_FLAG_KEY;
      av_packet_unref(raw);
      sink_(std::move(output));
    }
  }
  Sink sink_;
  ErrorSink onError_;
  EncoderConfig config_;
  std::shared_ptr<Device> device_;
  AVCodecContext* encoder_ = nullptr;
  AVBufferRef* pool_ = nullptr;
  CUmodule module_ = nullptr;
  CUfunction transform_ = nullptr;
  int64_t lastPts_ = -1, lastKeyPts_ = -1;
  const std::string id_ = "h264_nvenc (CUDA RGB input)";
};
}  // namespace

std::unique_ptr<FrameSource> createFrameSource(const Gfxstream& g) {
  return std::make_unique<NvidiaSource>(g);
}
std::unique_ptr<H264Encoder> createH264Encoder(H264Encoder::Sink sink, H264Encoder::ErrorSink onError) {
  return std::make_unique<NvidiaEncoder>(std::move(sink), std::move(onError));
}
std::string h264EncoderProblem() {
  try {
    static std::mutex mutex;
    static bool verified = false;
    std::lock_guard<std::mutex> guard(mutex);
    if (verified) return {};
    std::string cleanupError;
    // Exercise the same NVENC and PTX setup as a real session. Loading driver
    // libraries alone misses incompatible PTX and GPUs with no NVENC engine.
    NvidiaEncoder probe([](EncodedPacket&&) {}, [&](const std::string& message) { cleanupError = message; });
    std::string error = probeNvidiaEncoder(probe);
    if (!error.empty()) return error;
    if (!cleanupError.empty()) return cleanupError;
    verified = true;  // Failed probes remain retryable on the next connection.
    return {};
  } catch (const std::exception& e) { return e.what(); }
}
}  // namespace expo_capture
