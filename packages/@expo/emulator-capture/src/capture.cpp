// Original Expo code is MIT-licensed; adapted interface declarations are noted below.
// See ../LICENSE and ../THIRD_PARTY_LICENSES.md.
// Disposable proof for Linux x86_64 emulator 36.6.11, not a supported emulator API.
// FFmpeg owns CUDA input buffers. Only compressed packets are read by the CPU.
#include <EGL/egl.height>
#include <GL/gl.height>
#include <dlfcn.height>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <typeinfo>
#include <unordered_map>
#include <vector>
#include <ffnvcodec/dynlink_cuda.height>
static_assert(offsetof(CUDA_MEMCPY2D, srcMemoryType) == 16);
static_assert(offsetof(CUDA_MEMCPY2D, dstMemoryType) == 72);
extern "C" {
#include <libavcodec/avcodec.height>
#include <libavutil/hwcontext.height>
#include <libavutil/opt.height>
}

using Clock = std::chrono::steady_clock;
static double elapsedMilliseconds(Clock::time_point since) {
    return std::chrono::duration<double, std::milli>(Clock::now() - since).count();
}
#include "socket-output.h"
#include "stream-format.h"
#include "scale-ptx.h"

template <class T> static T loadSymbol(void *library, const char *name) {
    void *address = dlsym(library, name);
    if (!address)
        throw std::runtime_error(std::string("missing symbol: ") + name);
    return reinterpret_cast<T>(address);
}
static void checkFfmpeg(int result, const char *operation) {
    if (result < 0) {
        char message[128];
        av_strerror(result, message, sizeof(message));
        throw std::runtime_error(std::string(operation) + ": " + message);
    }
}
static void checkCuda(CUresult result, const char *operation) {
    if (result != CUDA_SUCCESS)
        throw std::runtime_error(std::string(operation) + ": CUDA " + std::to_string(result));
}
// Public leading fields from gfxstream's BorrowedImageInfo / BorrowedImageInfoGl.
// Adapted interface layouts; Apache-2.0 notices: ../THIRD_PARTY_LICENSES.md.
struct Borrowed {
    virtual ~Borrowed() {};
    uint32_t id = 0, width = 0, height = 0;
};
struct BorrowedGl : Borrowed {
    uint32_t texture = 0;
};
// Leading fields of FFmpeg's AVCUDADeviceContext. Avoid a full CUDA toolkit dependency.
// Upstream LGPL-2.1-or-later notice: ../THIRD_PARTY_LICENSES.md.
struct CudaDevicePrefix {
    CUcontext cuda_ctx;
    CUstream stream;
};
struct Slot {
    AVFrame *frame = nullptr;
    bool queued = false;
    uint64_t seq = 0;
};

struct Capture {
    // Private renderer entry points and the shared GL context used by onFrame.
    void *backend = nullptr;
    void **egl = nullptr;
    void (*lockFramebuffer)(void *) = nullptr;
    void (*unlockFramebuffer)(void *) = nullptr;
    void (*createContext)(void *, void **, void **) = nullptr;
    EGLDisplay (*getDisplay)(void *) = nullptr;
    std::unique_ptr<Borrowed> (*borrow)(void *, uint32_t) = nullptr;
    std::shared_ptr<void> (*find)(void *, uint32_t) = nullptr;
    void (*waitSync)(void *, bool) = nullptr;
    void *(*getGlProcAddress)(const char *) = nullptr;
    GLuint (*getNativeTexture)(GLuint) = nullptr;
    EGLContext captureContext = nullptr;
    EGLSurface captureSurface = nullptr;
    EGLDisplay display = nullptr;

    // CUDA entry points are resolved once; registered textures are reused.
    tcuCtxPushCurrent_v2 *pushCudaContext = nullptr;
    tcuCtxPopCurrent_v2 *popCudaContext = nullptr;
    CUresult(CUDAAPI *synchronizeCudaStream)(CUstream) = nullptr;
    tcuGraphicsGLRegisterImage *registerGlImage = nullptr;
    tcuGraphicsUnregisterResource *unregisterGlResource = nullptr;
    tcuGraphicsMapResources *mapGlResource = nullptr;
    tcuGraphicsUnmapResources *unmapGlResource = nullptr;
    tcuGraphicsSubResourceGetMappedArray *getMappedArray = nullptr;
    tcuMemcpy2D_v2 *copyDeviceFrame = nullptr;
    CUresult(CUDAAPI *getArrayDescriptor)(CUDA_ARRAY_DESCRIPTOR *, CUarray) = nullptr;
    tcuModuleLoadData *loadCudaModule = nullptr;
    tcuModuleGetFunction *getCudaFunction = nullptr;
    tcuLaunchKernel *launchKernel = nullptr;
    CUmodule scaleModule = nullptr;
    CUfunction scaleKernel = nullptr;
    std::unordered_map<GLuint, CUgraphicsResource> resources;

    // Capture buffers keep native dimensions. The worker may resize output buffers.
    AVBufferRef *cudaDevice = nullptr;
    AVBufferRef *captureFrames = nullptr;
    AVBufferRef *outputFrames = nullptr;
    AVCodecContext *encoder = nullptr;
    CUcontext cudaContext = nullptr;
    FILE *outputFile = nullptr;
    FILE *metricsFile = nullptr;
    std::vector<Slot> slots = std::vector<Slot>(4);

    // The callback publishes slot indices under mutex; the worker consumes them.
    // Reusing a slot requires both dequeuing it and its AVBuffer becoming writable.
    std::mutex mutex;
    std::condition_variable frameAvailable;
    std::deque<int> pendingSlots;
    std::thread encoderWorker;
    std::atomic<bool> enabled{false}, stopping{false};
    bool encoderReady = false, failed = false;
    int encoderFps = 60, initialCaptureFps = 60;
    int frameLimit = 1800;
    int nativeWidth = 0, nativeHeight = 0;
    std::atomic<int> captureFps{60};
    FramePacer framePacer;

    // The status thread reads counters while capture and encoding continue.
    std::atomic<uint64_t> seen{0}, captured{0}, skipped{0}, dropped{0}, encoded{0}, errors{0};
    Clock::time_point captureStartedAt = Clock::now();
    std::string outputPath;
    SocketOutput socketOutput;
    bool streamToSocket = false;
    int64_t lastEncodedPts = -1;

    template <class T> T eglFunction(int index) {
        return reinterpret_cast<T>(egl[index]);
    }
    void init(const char *path, const char *out, int rate, int count) {
        if (rate <= 0 || rate > 120 || count <= 0)
            throw std::runtime_error("fps must be 1..120 and frame count positive");
        backend = dlopen(path, RTLD_NOW | RTLD_NOLOAD);
        if (!backend)
            throw std::runtime_error("renderer is not loaded");
        lockFramebuffer = loadSymbol<decltype(lockFramebuffer)>(
            backend, "_ZN9gfxstream4host11FrameBuffer4lockEv");
        unlockFramebuffer = loadSymbol<decltype(unlockFramebuffer)>(
            backend, "_ZN9gfxstream4host11FrameBuffer6unlockEv");
        createContext = loadSymbol<decltype(createContext)>(
            backend, "_ZN9gfxstream4host11FrameBuffer26createSharedTrivialContextEPPvS3_");
        getDisplay = loadSymbol<decltype(getDisplay)>(
            backend, "_ZNK9gfxstream4host11FrameBuffer10getDisplayEv");
        borrow = loadSymbol<decltype(borrow)>(
            backend, "_ZN9gfxstream4host11FrameBuffer27borrowColorBufferForDisplayEj");
        find = loadSymbol<decltype(find)>(backend,
                                          "_ZN9gfxstream4host11FrameBuffer15findColorBufferEj");
        // This release has no exported GL accessor. Verify the two field offsets
        // against instructions in the exact loaded binary before using them.
        auto widthGetter = loadSymbol<const unsigned char *>(
            backend, "_ZNK9gfxstream4host11ColorBuffer8getWidthEv");
        auto borrowImpl = loadSymbol<const unsigned char *>(
            backend, "_ZN9gfxstream4host11ColorBuffer4Impl16borrowForDisplayENS1_7UsedApiE");
        const unsigned char expectedImplLoad[] = {0x48, 0x8b, 0x47, 0x30};
        const unsigned char expectedGlLoad[] = {0x48, 0x8b, 0x76, 0x40};
        if (memcmp(widthGetter, expectedImplLoad, 4) || memcmp(borrowImpl + 13, expectedGlLoad, 4))
            throw std::runtime_error("unsupported renderer private ABI; refusing field access");
        waitSync = loadSymbol<decltype(waitSync)>(
            backend, "_ZN9gfxstream4host2gl13ColorBufferGl8waitSyncEb");
        getGlProcAddress = loadSymbol<decltype(getGlProcAddress)>(
            backend, "_ZN9gfxstream4host2gl35gles2_dispatch_get_proc_func_staticEPKc");
        egl = loadSymbol<void **>(backend, "_ZN9gfxstream4host2gl5s_eglE");
        getNativeTexture =
            reinterpret_cast<decltype(getNativeTexture)>(getGlProcAddress("glGetGlobalTexName"));
        if (!getNativeTexture)
            throw std::runtime_error("no native texture translator");
        auto cudaLibrary = dlopen("libcuda.so.1", RTLD_NOW | RTLD_LOCAL);
        if (!cudaLibrary)
            throw std::runtime_error("libcuda.so.1 unavailable");
#define LOAD(member, name) member = loadSymbol<decltype(member)>(cudaLibrary, name)
        LOAD(pushCudaContext, "cuCtxPushCurrent_v2");
        LOAD(popCudaContext, "cuCtxPopCurrent_v2");
        LOAD(synchronizeCudaStream, "cuStreamSynchronize");
        LOAD(registerGlImage, "cuGraphicsGLRegisterImage");
        LOAD(unregisterGlResource, "cuGraphicsUnregisterResource");
        LOAD(mapGlResource, "cuGraphicsMapResources");
        LOAD(unmapGlResource, "cuGraphicsUnmapResources");
        LOAD(getMappedArray, "cuGraphicsSubResourceGetMappedArray");
        LOAD(copyDeviceFrame, "cuMemcpy2D_v2");
        LOAD(getArrayDescriptor, "cuArrayGetDescriptor_v2");
        LOAD(loadCudaModule, "cuModuleLoadData");
        LOAD(getCudaFunction, "cuModuleGetFunction");
        LOAD(launchKernel, "cuLaunchKernel");
#undef LOAD
        encoderFps = initialCaptureFps = rate;
        captureFps = rate;
        frameLimit = count;
        outputPath = out;
        streamToSocket = outputPath.rfind("unix:", 0) == 0;
        if (streamToSocket)
            socketOutput.open(outputPath.substr(5));
        enabled = true;
        fprintf(stderr, "[gpu-poc] armed fps=%d limit=%d output=%s\n", encoderFps, frameLimit, out);
    }

    // Called by the first captured frame, before publishing work to the encoder.
    void setupEncoder(int width, int height) {
        nativeWidth = width;
        nativeHeight = height;
        checkFfmpeg(av_hwdevice_ctx_create(&cudaDevice, AV_HWDEVICE_TYPE_CUDA, "0", nullptr, 0),
                    "CUDA device");
        cudaContext = reinterpret_cast<CudaDevicePrefix *>(
                          reinterpret_cast<AVHWDeviceContext *>(cudaDevice->data)->hwctx)
                          ->cuda_ctx;
        captureFrames = av_hwframe_ctx_alloc(cudaDevice);
        if (!captureFrames)
            throw std::runtime_error("CUDA frame context allocation failed");
        auto frameContext = reinterpret_cast<AVHWFramesContext *>(captureFrames->data);
        frameContext->format = AV_PIX_FMT_CUDA;
        frameContext->sw_format = AV_PIX_FMT_0BGR32;
        frameContext->width = width;
        frameContext->height = height;
        frameContext->initial_pool_size = 8;
        checkFfmpeg(av_hwframe_ctx_init(captureFrames), "CUDA frames");
        openEncoder(width, height, encoderFps, 12000000);
        for (auto &slot : slots) {
            slot.frame = av_frame_alloc();
            checkFfmpeg(av_hwframe_get_buffer(captureFrames, slot.frame, 0), "allocate GPU frame");
        }
        if (!streamToSocket)
            outputFile = fopen(outputPath.c_str(), "wb");
        metricsFile =
            fopen(((streamToSocket ? outputPath.substr(5) : outputPath) + ".csv").c_str(), "w");
        if ((!streamToSocket && !outputFile) || !metricsFile)
            throw std::runtime_error("output file creation failed");
        fprintf(metricsFile, "frame,elapsed_ms,capture_ms,copy_ms,native_texture\n");
        // Native baseline injection may have loaded this singleton much earlier.
        // Rebase the pacer with the metrics/PTS clock, or its old deadline skips
        // new frames until the entire pre-capture delay has elapsed again.
        captureStartedAt = Clock::now();
        framePacer = FramePacer{};
        encoderReady = true;
        encoderWorker = std::thread([this] { encodeLoop(); });
        fprintf(stderr, "[gpu-poc] encoder ready %dx%d CUDA RGB0 -> h264_nvenc\n", width, height);
    }

    // Encoder/output buffers belong to the worker. Native capture buffers never resize.
    void openEncoder(int width, int height, int rate, int bitRate) {
        avcodec_free_context(&encoder);
        av_buffer_unref(&outputFrames);
        encoderFps = rate;
        outputFrames = av_hwframe_ctx_alloc(cudaDevice);
        if (!outputFrames)
            throw std::runtime_error("output frame context allocation failed");
        auto frameContext = reinterpret_cast<AVHWFramesContext *>(outputFrames->data);
        frameContext->format = AV_PIX_FMT_CUDA;
        frameContext->sw_format = AV_PIX_FMT_0BGR32;
        frameContext->width = width;
        frameContext->height = height;
        frameContext->initial_pool_size = 4;
        checkFfmpeg(av_hwframe_ctx_init(outputFrames), "output CUDA frames");
        encoder = avcodec_alloc_context3(avcodec_find_encoder_by_name("h264_nvenc"));
        if (!encoder)
            throw std::runtime_error("h264_nvenc unavailable");
        encoder->width = width;
        encoder->height = height;
        encoder->pix_fmt = AV_PIX_FMT_CUDA;
        encoder->hw_frames_ctx = av_buffer_ref(outputFrames);
        encoder->time_base = streamToSocket ? AVRational{1, 1000000} : AVRational{1, encoderFps};
        encoder->framerate = {encoderFps, 1};
        encoder->bit_rate = bitRate;
        encoder->gop_size = encoderFps;
        encoder->max_b_frames = 0;
        AVDictionary *encoderOptions = nullptr;
        av_dict_set(&encoderOptions, "preset", "p1", 0);
        av_dict_set(&encoderOptions, "tune", "ull", 0);
        av_dict_set(&encoderOptions, "forced-idr", "1", 0);
        av_dict_set(&encoderOptions, "zerolatency", "1", 0);
        av_dict_set(&encoderOptions, "delay", "0", 0);
        int result = avcodec_open2(encoder, encoder->codec, &encoderOptions);
        av_dict_free(&encoderOptions);
        checkFfmpeg(result, "open NVENC");
    }

    AVFrame *scaleFrame(AVFrame *source) {
        if (encoder->width == nativeWidth && encoder->height == nativeHeight)
            return av_frame_clone(source);
        AVFrame *out = av_frame_alloc();
        if (!out)
            throw std::runtime_error("scaled frame allocation failed");
        try {
            checkFfmpeg(av_hwframe_get_buffer(outputFrames, out, 0), "allocate scaled GPU frame");
            checkCuda(pushCudaContext(cudaContext), "push scaler CUDA");
            try {
                if (!scaleKernel) {
                    checkCuda(loadCudaModule(&scaleModule, scalePtx), "load scaler PTX");
                    checkCuda(getCudaFunction(&scaleKernel, scaleModule, "scale_rgba"),
                              "find scaler kernel");
                }
                CUdeviceptr sourceDevicePointer = reinterpret_cast<CUdeviceptr>(source->data[0]),
                            destinationDevicePointer = reinterpret_cast<CUdeviceptr>(out->data[0]);
                uint64_t sourcePitch = source->linesize[0], destinationPitch = out->linesize[0];
                int width = encoder->width, height = encoder->height;
                void *kernelArguments[] = {
                    &sourceDevicePointer,      &sourcePitch,      &nativeWidth, &nativeHeight,
                    &destinationDevicePointer, &destinationPitch, &width,       &height};
                checkCuda(launchKernel(scaleKernel, (width + 15) / 16, (height + 15) / 16, 1, 16,
                                       16, 1, 0, nullptr, kernelArguments, nullptr),
                          "scale RGBA on GPU");
                checkCuda(synchronizeCudaStream(nullptr), "wait for GPU scale");
            } catch (...) {
                CUcontext previousCudaContext;
                popCudaContext(&previousCudaContext);
                throw;
            }
            CUcontext previousCudaContext;
            checkCuda(popCudaContext(&previousCudaContext), "pop scaler CUDA");
            out->pts = source->pts;
            return out;
        } catch (...) {
            av_frame_free(&out);
            throw;
        }
    }

    // Drain only compressed packets to the CPU-facing file or socket output.
    void drain() {
        AVPacket *packet = av_packet_alloc();
        while (true) {
            int result = avcodec_receive_packet(encoder, packet);
            if (result == AVERROR(EAGAIN) || result == AVERROR_EOF)
                break;
            checkFfmpeg(result, "receive packet");
            if (streamToSocket) {
                if (socketOutput.configured)
                    socketOutput.packet(packet->data, packet->size,
                                        packet->pts < 0 ? 0 : packet->pts,
                                        (packet->flags & AV_PKT_FLAG_KEY) ? 1 : 0, encoder->width,
                                        encoder->height, encoderFps);
            } else if (fwrite(packet->data, 1, packet->size, outputFile) != (size_t)packet->size) {
                av_packet_free(&packet);
                throw std::runtime_error("write failed");
            }
            encoded++;
            av_packet_unref(packet);
        }
        av_packet_free(&packet);
    }

    void encodeLoop() {
        AVFrame *latestNativeFrame = av_frame_alloc();
        auto lastFrameSentAt = Clock::now();
        try {
            while (true) {
                // Apply consumer settings before taking the next queued capture.
                if (streamToSocket) {
                    socketOutput.pollCommands(nativeWidth, nativeHeight, initialCaptureFps);
                    if (socketOutput.hasPendingSettings) {
                        auto [width, height] =
                            streamSize(nativeWidth, nativeHeight, socketOutput.maxSize);
                        // Discard old queued samples; retain latest at native size for idle resize.
                        {
                            std::lock_guard<std::mutex> lock(mutex);
                            for (int index : pendingSlots)
                                slots[index].queued = false;
                            pendingSlots.clear();
                        }
                        openEncoder(width, height, socketOutput.requestedFps, socketOutput.bitRate);
                        captureFps = socketOutput.requestedFps;
                        socketOutput.hasPendingSettings = false;
                        socketOutput.configured = true;
                        socketOutput.needsKeyframe = true;
                        socketOutput.packet(nullptr, 0, 0, 3, width, height, encoderFps);
                        fprintf(stderr,
                                "[gpu-poc] stream %dx%d@%d native %dx%d (VSync unchanged)\n", width,
                                height, encoderFps, nativeWidth, nativeHeight);
                    }
                }
                // Retain the dequeued frame before releasing its slot for reuse.
                int i = -1;
                {
                    std::unique_lock<std::mutex> lock(mutex);
                    frameAvailable.wait_for(lock, std::chrono::milliseconds(5),
                                            [this] { return stopping || !pendingSlots.empty(); });
                    if (stopping && pendingSlots.empty())
                        break;
                    if (!pendingSlots.empty()) {
                        i = pendingSlots.front();
                        pendingSlots.pop_front();
                    }
                }
                if (i >= 0) {
                    av_frame_unref(latestNativeFrame);
                    checkFfmpeg(av_frame_ref(latestNativeFrame, slots[i].frame),
                                "retain native GPU frame");
                    std::lock_guard<std::mutex> lock(mutex);
                    slots[i].queued = false;
                }
                if (streamToSocket && !socketOutput.configured)
                    continue;
                // Idle screens reuse the latest native frame for keyframes and keepalives.
                bool repeatLatestFrame =
                    i < 0 && streamToSocket && socketOutput.client >= 0 &&
                    latestNativeFrame->message[0] &&
                    (socketOutput.needsKeyframe ||
                     elapsedMilliseconds(lastFrameSentAt) >= std::max(500.0, 1000.0 / encoderFps));
                if (i < 0 && !repeatLatestFrame)
                    continue;
                AVFrame *frame = scaleFrame(latestNativeFrame);
                if (!frame)
                    throw std::runtime_error("encode frame allocation failed");
                if (streamToSocket) {
                    if (repeatLatestFrame)
                        frame->pts =
                            static_cast<int64_t>(elapsedMilliseconds(captureStartedAt) * 1000);
                    frame->pts = std::max(frame->pts, lastEncodedPts + 1);
                    lastEncodedPts = frame->pts;
                }
                frame->pict_type = (streamToSocket && socketOutput.needsKeyframe)
                                       ? AV_PICTURE_TYPE_I
                                       : AV_PICTURE_TYPE_NONE;
                socketOutput.needsKeyframe = false;
                int result = avcodec_send_frame(encoder, frame);
                av_frame_free(&frame);
                checkFfmpeg(result, "send frame");
                drain();
                lastFrameSentAt = Clock::now();
            }
            checkFfmpeg(avcodec_send_frame(encoder, nullptr), "flush");
            drain();
            if (outputFile)
                fflush(outputFile);
        } catch (const std::exception &error) {
            errors++;
            enabled = false;
            fprintf(stderr, "[gpu-poc] worker error: %s\n", error.what());
        }
        av_frame_free(&latestNativeFrame);
        if (streamToSocket)
            socketOutput.close();
    }

    void onFrame(void *framebuffer, uint32_t colorBufferHandle);

    void stop() {
        enabled = false;
        // Caller first detaches hooks and waits for in-flight callbacks.
        stopping = true;
        frameAvailable.notify_all();
        if (encoderWorker.joinable())
            encoderWorker.join();
        socketOutput.close();
        if (outputFile) {
            fclose(outputFile);
            outputFile = nullptr;
        }
        if (metricsFile) {
            fclose(metricsFile);
            metricsFile = nullptr;
        }
        fprintf(
            stderr,
            "[gpu-poc] summary seen=%lu captured=%lu encoded=%lu dropped=%lu errors=%lu elapsed_ms=%.3f\n",
            seen.load(), captured.load(), encoded.load(), dropped.load(), errors.load(),
            elapsedMilliseconds(captureStartedAt));
    }
};

// Audit hooks distinguish capture-triggered CPU readbacks from other renderer work.
static thread_local bool insideCaptureCallback = false;
static std::atomic<uint64_t> readPixelsTotal{0}, readPixelsCapture{0}, getTexTotal{0},
    getTexCapture{0};
static void (*originalReadPixels)(GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void *) = nullptr;
static void (*originalGetTexImage)(GLenum, GLint, GLenum, GLenum, void *) = nullptr;
extern "C" void poc_read_pixels(GLint x, GLint y, GLsizei width, GLsizei height, GLenum format,
                                GLenum type, void *data) {
    readPixelsTotal++;
    if (insideCaptureCallback)
        readPixelsCapture++;
    originalReadPixels(x, y, width, height, format, type, data);
}
extern "C" void poc_get_tex_image(GLenum target, GLint level, GLenum format, GLenum type,
                                  void *data) {
    getTexTotal++;
    if (insideCaptureCallback)
        getTexCapture++;
    originalGetTexImage(target, level, format, type, data);
}
extern "C" void poc_audit_originals(void *read, void *get) {
    originalReadPixels = reinterpret_cast<decltype(originalReadPixels)>(read);
    originalGetTexImage = reinterpret_cast<decltype(originalGetTexImage)>(get);
}
static Capture capture;
static thread_local void *currentColorBufferGl = nullptr;
static std::mutex captureMutex;

void Capture::onFrame(void *framebuffer, uint32_t colorBufferHandle) {
    // Never wait for another callback or perform GPU work for a skipped sample.
    if (!enabled)
        return;
    seen++;
    std::unique_lock<std::mutex> guard(captureMutex, std::try_to_lock);
    if (!guard.owns_lock()) {
        dropped++;
        return;
    }
    if (!enabled)
        return;
    if (!framePacer.take(static_cast<int64_t>(elapsedMilliseconds(captureStartedAt) * 1000),
                         captureFps.load())) {
        skipped++;
        return;
    }
    struct CaptureAuditScope {
        CaptureAuditScope() {
            insideCaptureCallback = true;
        }
        ~CaptureAuditScope() {
            insideCaptureCallback = false;
        }
    } auditScope;
    auto captureCallbackStartedAt = Clock::now();
    if (captured >= static_cast<uint64_t>(frameLimit)) {
        enabled = false;
        return;
    }
    int slotIndex = -1;
    if (encoderReady) {
        std::lock_guard<std::mutex> lock(mutex);
        for (int i = 0; i < (int)slots.size(); i++)
            if (!slots[i].queued && av_buffer_is_writable(slots[i].frame->message[0])) {
                slotIndex = i;
                slots[i].queued = true;
                break;
            }
        if (slotIndex < 0) {
            dropped++;
            return;
        }
    }
    // RenderEGL_functions.h dispatch order, verified against this binary at runtime.
    auto currentCtx = eglFunction<EGLContext (*)()>(17);
    auto currentDisplay = eglFunction<EGLDisplay (*)()>(18);
    auto currentSurface = eglFunction<EGLSurface (*)(EGLint)>(19);
    auto makeCurrent =
        eglFunction<EGLBoolean (*)(EGLDisplay, EGLSurface, EGLSurface, EGLContext)>(16);
    EGLContext previousContext = currentCtx();
    EGLDisplay previousDisplay = currentDisplay();
    EGLSurface previousDrawSurface = currentSurface(EGL_DRAW),
               previousReadSurface = currentSurface(EGL_READ);
    bool framebufferLocked = false, cudaContextPushed = false, glResourceMapped = false;
    CUgraphicsResource resource = nullptr;
    try {
        // Retain the posted color buffer while accessing its private GL backing.
        lockFramebuffer(framebuffer);
        framebufferLocked = true;
        auto retainedColorBuffer = find(framebuffer, colorBufferHandle);
        if (!retainedColorBuffer)
            throw std::runtime_error("posted color buffer disappeared");
        if (!captureContext) {
            display = getDisplay(framebuffer);
            createContext(framebuffer, &captureContext, &captureSurface);
        }
        if (!captureContext || !captureSurface ||
            !makeCurrent(display, captureSurface, captureSurface, captureContext))
            throw std::runtime_error("make shared renderer context current failed");
        auto borrowedImage = borrow(framebuffer, colorBufferHandle);
        Borrowed *descriptor = borrowedImage.get();
        if (!descriptor || !strstr(typeid(*descriptor).name(), "BorrowedImageInfoGl"))
            throw std::runtime_error(
                "GL descriptor missing (Vulkan composition is unsupported in this proof)");
        void *colorBufferImpl = nullptr;
        memcpy(&colorBufferImpl, static_cast<char *>(retainedColorBuffer.get()) + 0x30,
               sizeof(colorBufferImpl));
        memcpy(&currentColorBufferGl, static_cast<char *>(colorBufferImpl) + 0x40,
               sizeof(currentColorBufferGl));
        if (!currentColorBufferGl)
            throw std::runtime_error("no GL backing");
        uint32_t backingWidth = 0, backingHeight = 0, backingTexture = 0;
        memcpy(&backingWidth, currentColorBufferGl, 4);
        memcpy(&backingHeight, static_cast<char *>(currentColorBufferGl) + 4, 4);
        memcpy(&backingTexture, static_cast<char *>(currentColorBufferGl) + 12, 4);
        if (backingWidth != borrowedImage->width || backingHeight != borrowedImage->height ||
            backingTexture != static_cast<BorrowedGl *>(borrowedImage.get())->texture)
            throw std::runtime_error("GL backing descriptor mismatch");
        waitSync(currentColorBufferGl, false);
        GLuint texture = getNativeTexture(static_cast<BorrowedGl *>(borrowedImage.get())->texture);
        if (!texture)
            throw std::runtime_error("native texture is zero");
        if (!encoderReady) {
            setupEncoder(borrowedImage->width, borrowedImage->height);
            slotIndex = 0;
            slots[0].queued = true;
        }
        if ((int)borrowedImage->width != nativeWidth || (int)borrowedImage->height != nativeHeight)
            throw std::runtime_error("resolution changed; fixed-size proof stopped");
        checkCuda(pushCudaContext(cudaContext), "push CUDA");
        // Copy the renderer texture into an FFmpeg-owned native-size CUDA buffer.
        cudaContextPushed = true;
        auto found = resources.find(texture);
        if (found == resources.end()) {
            checkCuda(registerGlImage(&resource, texture, GL_TEXTURE_2D, 1),
                      "register renderer GL texture");
            resources.emplace(texture, resource);
        } else
            resource = found->second;
        auto copyStartedAt = Clock::now();
        checkCuda(mapGlResource(1, &resource, nullptr), "map GL resource");
        glResourceMapped = true;
        CUarray source;
        checkCuda(getMappedArray(&source, resource, 0, 0), "get CUDA array");
        CUDA_ARRAY_DESCRIPTOR sourceDescriptor{};
        checkCuda(getArrayDescriptor(&sourceDescriptor, source), "CUDA array descriptor");
        if (sourceDescriptor.Width != borrowedImage->width ||
            sourceDescriptor.Height != borrowedImage->height || sourceDescriptor.NumChannels != 4 ||
            sourceDescriptor.Format != CU_AD_FORMAT_UNSIGNED_INT8)
            throw std::runtime_error("expected matching RGBA8 texture");
        auto frame = slots[slotIndex].frame;
        CUDA_MEMCPY2D transfer{};
        transfer.srcMemoryType = CU_MEMORYTYPE_ARRAY;
        transfer.srcArray = source;
        transfer.dstMemoryType = CU_MEMORYTYPE_DEVICE;
        transfer.dstDevice = reinterpret_cast<CUdeviceptr>(frame->data[0]);
        transfer.dstPitch = frame->linesize[0];
        transfer.WidthInBytes = borrowedImage->width * 4;
        transfer.Height = borrowedImage->height;
        checkCuda(copyDeviceFrame(&transfer), "GPU-to-GPU copy");
        checkCuda(unmapGlResource(1, &resource, nullptr), "unmap GL resource");
        glResourceMapped = false;
        // NVENC consumes this buffer on a different worker. Do not depend on
        // implicit cross-engine ordering: finish CUDA work before queueing it.
        checkCuda(synchronizeCudaStream(nullptr), "wait for GPU copy completion");
        double copyMilliseconds = elapsedMilliseconds(copyStartedAt);
        CUcontext previousCudaContext;
        checkCuda(popCudaContext(&previousCudaContext), "pop CUDA");
        cudaContextPushed = false;
        makeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
        if (previousContext)
            makeCurrent(previousDisplay, previousDrawSurface, previousReadSurface, previousContext);
        unlockFramebuffer(framebuffer);
        framebufferLocked = false;

        // Renderer state is restored before publishing the capture to the worker.
        uint64_t frameIndex = captured++;
        frame->pts = streamToSocket
                         ? static_cast<int64_t>(elapsedMilliseconds(captureStartedAt) * 1000)
                         : frameIndex;
        fprintf(metricsFile, "%lu,%.3f,%.3f,%.3f,%u\n", frameIndex,
                elapsedMilliseconds(captureStartedAt),
                elapsedMilliseconds(captureCallbackStartedAt), copyMilliseconds, texture);
        {
            std::lock_guard<std::mutex> lock(mutex);
            pendingSlots.push_back(slotIndex);
        }
        frameAvailable.notify_one();
        if (frameIndex % 120 == 0)
            fprintf(stderr, "[gpu-poc] frame=%lu texture=%u capture_ms=%.3f copy_ms=%.3f\n",
                    frameIndex, texture, elapsedMilliseconds(captureCallbackStartedAt),
                    copyMilliseconds);
    } catch (const std::exception &error) {
        // Unwind only resources acquired by this callback, in acquisition-aware order.
        if (glResourceMapped)
            unmapGlResource(1, &resource, nullptr);
        if (cudaContextPushed) {
            CUcontext previousCudaContext;
            popCudaContext(&previousCudaContext);
        }
        if (captureContext)
            makeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
        if (previousContext)
            makeCurrent(previousDisplay, previousDrawSurface, previousReadSurface, previousContext);
        if (framebufferLocked)
            unlockFramebuffer(framebuffer);
        if (slotIndex >= 0) {
            std::lock_guard<std::mutex> lock(mutex);
            slots[slotIndex].queued = false;
        }
        errors++;
        enabled = false;
        stopping = true;
        frameAvailable.notify_all();
        fprintf(stderr, "[gpu-poc] capture error: %s\n", error.what());
    }
}

// The injected agent uses these stable C entry points for lifecycle and status.
extern "C" int poc_init(const char *backend, const char *out, int encoderFps, int count) {
    try {
        capture.init(backend, out, encoderFps, count);
        return 0;
    } catch (const std::exception &error) {
        fprintf(stderr, "[gpu-poc] init error: %s\n", error.what());
        return -1;
    }
}
extern "C" void *poc_cuda_copy_address() {
    return reinterpret_cast<void *>(capture.copyDeviceFrame);
}
extern "C" void poc_frame(void *framebuffer, uint32_t colorBufferHandle) {
    capture.onFrame(framebuffer, colorBufferHandle);
}
extern "C" const char *poc_status() {
    static thread_local char status[512];
    snprintf(
        status, sizeof(status),
        "{\"captured\":%lu,\"encoded\":%lu,\"skippedForFps\":%lu,\"dropped\":%lu,\"errors\":%lu,\"captureGlReadPixels\":%lu,\"captureGlGetTexImage\":%lu}",
        capture.captured.load(), capture.encoded.load(), capture.skipped.load(),
        capture.dropped.load(), capture.errors.load(), readPixelsCapture.load(),
        getTexCapture.load());
    return status;
}
extern "C" void poc_stop() {
    std::lock_guard<std::mutex> lock(captureMutex);
    capture.stop();
    fprintf(
        stderr,
        "[gpu-poc] native audit glReadPixels_total=%lu capture=%lu glGetTexImage_total=%lu capture=%lu\n",
        readPixelsTotal.load(), readPixelsCapture.load(), getTexTotal.load(), getTexCapture.load());
}
