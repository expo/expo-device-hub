// SPDX-License-Identifier: MIT
// Capture agent preloaded into the Android Emulator's QEMU process
// (DYLD_INSERT_LIBRARIES on macOS). It hooks gfxstream's
// display post, copies posted color buffers out of the renderer, encodes them to
// H.264, and serves one consumer on a Unix socket.
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include "encoder.h"
#include "callback.h"
#include "frame-source.h"
#include "frida-gum.h"
#include "gfxstream.h"
#include "log.h"
#include "protocol.h"
#include "socket-input.h"

// The package version; the build passes it from package.json.
#ifndef EXPO_EMULATOR_CAPTURE_VERSION
#define EXPO_EMULATOR_CAPTURE_VERSION "0.0.0-dev"
#endif

namespace expo_capture {

// Constant-initialized: the constructor below runs before dynamic initializers
// in this file, so `= stderr` here would overwrite the log file it opens.
FILE* logFile = nullptr;
std::mutex logMutex;

void logLine(const char* format, ...) noexcept {
  char line[1024];
  va_list args;
  va_start(args, format);
  vsnprintf(line, sizeof(line), format, args);
  va_end(args);
  try {
    std::lock_guard<std::mutex> guard(logMutex);
    FILE* out = logFile ? logFile : stderr;
    fprintf(out, "[expo-emulator-capture] %s\n", line);
    fflush(out);
  } catch (...) {
    // Logging an exception must not throw another one across a callback boundary.
  }
}

namespace {

constexpr const char* kPlatform = "darwin-arm64";
constexpr const char* kPreloadVariable = "DYLD_INSERT_LIBRARIES";
constexpr const char* kRendererModule = "libgfxstream_backend.dylib";
constexpr int kSendFlags = 0;  // SO_NOSIGPIPE is set on the socket instead.
const char* programName() { return getprogname(); }

using Clock = std::chrono::steady_clock;
constexpr int kNativeFps = 60;
// Above this, delta frames are dropped; a keyframe is requested once the queue drains to half.
constexpr size_t kMaxQueuedOutputBytes = 8 * 1024 * 1024;
// Keyframes and control records are never dropped. A consumer whose queue grows past this
// stopped reading, and the agent closes it.
constexpr size_t kMaxBufferedOutputBytes = 32 * 1024 * 1024;
constexpr int kSocketBufferBytes = 4 * 1024 * 1024;
constexpr size_t kMaxPendingFrames = 2;
constexpr auto kIdleKeyFrameDelay = std::chrono::milliseconds(40);

std::string jsonEscape(const std::string& text) {
  std::string out;
  for (char c : text) {
    if (c == '"' || c == '\\') out += '\\';
    if (uint8_t(c) < 0x20) continue;
    out += c;
  }
  return out;
}

struct OutputRecord {
  std::vector<uint8_t> bytes;  // Header and payload.
  uint64_t generation = 0;
  bool droppable = false;  // Delta frames may be dropped under backpressure.
};

struct PendingFrame {
  CapturedFrame frame;
  uint64_t ptsUs = 0;
};

double threadCpuSeconds() {
  timespec time{};
  if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &time) != 0) return 0;
  return double(time.tv_sec) + double(time.tv_nsec) / 1e9;
}

// Encoder thread timings, logged every 10 seconds while a consumer streams.
struct EncoderStats {
  uint64_t frames = 0;
  double captureMs = 0, encodeMs = 0, threadCpu = threadCpuSeconds();
  Clock::time_point since = Clock::now();

  void reset() { *this = EncoderStats{}; }
  void record(double frameCaptureMs, double frameEncodeMs) {
    frames++;
    captureMs += frameCaptureMs;
    encodeMs += frameEncodeMs;
    double wall = std::chrono::duration<double>(Clock::now() - since).count();
    if (wall < 10) return;
    double cpu = threadCpuSeconds();
    logLine("stats: %.1f fps, capture %.2f ms, encode %.2f ms, encoder thread %.0f%% CPU",
            frames / wall, captureMs / frames, encodeMs / frames, (cpu - threadCpu) / wall * 100);
    reset();
  }
};

class Agent {
 public:
  bool initialize(GumModule* backend, std::string& error);
  void* postTarget() const { return g_.postImpl; }
  bool listen(const std::string& path, std::string& error);
  void serve();
  void onPost(uint32_t handle, bool needLockAndBind);

 private:
  void encoderLoop();
  void capturePost(uint32_t handle, bool needLockAndBind);
  bool captureNow(PendingFrame& out);
  void accept();
  void readCommands();
  void flushOutput();
  void sendReplaced();
  void disconnect(const char* reason);
  void sendRecord(uint64_t generation, uint32_t flags, uint32_t width, uint32_t height,
                  uint32_t fps, const uint8_t* payload, size_t length, uint64_t ptsUs = 0,
                  bool droppable = false);
  uint64_t nextPts();
  void wake();
  std::string helloJson();

  Gfxstream g_;
  std::unique_ptr<FrameSource> frames_;
  Clock::time_point start_ = Clock::now();

  // Capture state shared with the render thread.
  std::atomic<bool> active_{false};
  std::atomic<int> captureFps_{kNativeFps};
  std::atomic<uint64_t> posts_{0}, captured_{0}, skippedLocked_{0}, droppedBusy_{0},
      captureErrors_{0};
  std::mutex postMutex_;  // Guards pacer_ if more than one thread posts.
  FramePacer pacer_;

  // Encoder thread inputs, guarded by encodeMutex_. Only the encoder thread
  // owns the H264Encoder; its callbacks never take encodeMutex_.
  std::mutex encodeMutex_;
  std::condition_variable encodeWake_;
  std::deque<PendingFrame> pending_;
  StreamSettings settings_;
  int rotation_ = 0;  // Android display rotation from the consumer's 'R'; 0 to 3.
  bool settingsChanged_ = false;
  bool keyRequested_ = false;
  uint64_t generation_ = 0;  // Changes with every consumer connection.
  int announcedWidth_ = 0, announcedHeight_ = 0;  // Native size the consumer knows.
  std::atomic<bool> keyNeededByOutput_{false};
  uint64_t lastPts_ = 0;
  std::mutex ptsMutex_;

  // Socket state; the serve() thread owns the descriptors.
  std::string path_;
  int listener_ = -1;
  int client_ = -1;
  int socketLock_ = -1;
  int wakePipe_[2] = {-1, -1};
  std::vector<uint8_t> commands_;
  std::mutex outputMutex_;
  std::deque<OutputRecord> output_;
  size_t outputBytes_ = 0;
  size_t outputOffset_ = 0;  // Bytes of output_.front() already written.
  std::atomic<uint64_t> clientGeneration_{0};
  bool dropUntilKey_ = false;
  bool keyAfterDrain_ = false;  // Request a keyframe once the queue drains to half.
  std::atomic<bool> outputStalled_{false};
};

Agent* agent = nullptr;
// Set once the socket is bound; removed at a normal emulator exit so consumers
// do not find a socket that nothing serves. A killed emulator leaves it behind;
// consumers and the next agent treat an unanswered socket as gone.
char boundSocketPath[sizeof(sockaddr_un::sun_path)] = {};
void unlinkBoundSocket() {
  if (boundSocketPath[0]) unlink(boundSocketPath);
}

void onPostEnter(GumInvocationContext* context, gpointer) {
  // FrameBuffer::Impl::postImpl(this, handle, callback, needLockAndBind, repaint).
  auto handle = uint32_t(uintptr_t(gum_invocation_context_get_nth_argument(context, 1)));
  bool needLockAndBind = uintptr_t(gum_invocation_context_get_nth_argument(context, 3)) & 0xff;
  agent->onPost(handle, needLockAndBind);
}

bool Agent::initialize(GumModule* backend, std::string& error) {
  error = resolveGfxstream(backend, g_);
  if (!error.empty()) return false;
  frames_ = createFrameSource(g_);
  if (!g_.gpuEntryPointsAvailable())
    logLine("GPU frame path disabled: renderer symbols are missing; using CPU readback");
  if (pipe(wakePipe_) != 0) {
    error = "cannot create wake pipe";
    return false;
  }
  fcntl(wakePipe_[0], F_SETFL, O_NONBLOCK);
  fcntl(wakePipe_[1], F_SETFL, O_NONBLOCK);
  std::thread([this] {
    guardCallback("encoder stopped", [this] { encoderLoop(); });
  }).detach();
  return true;
}

void Agent::onPost(uint32_t handle, bool needLockAndBind) {
  // This runs on the renderer's thread, inside its post. An exception that left it would end
  // QEMU, for example a failed allocation for a frame after a fold.
  try {
    capturePost(handle, needLockAndBind);
  } catch (...) {
    captureErrors_++;
  }
}

void Agent::capturePost(uint32_t handle, bool needLockAndBind) {
  posts_++;
  if (!active_.load(std::memory_order_relaxed)) return;
  if (!needLockAndBind) {
    // @ref LLP 0020#hook-point — the caller already holds the non-recursive FrameBuffer lock
    skippedLocked_++;
    return;
  }
  std::unique_lock<std::mutex> postLock(postMutex_, std::try_to_lock);
  if (!postLock.owns_lock()) {
    droppedBusy_++;
    return;
  }
  int64_t elapsedUs =
      std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - start_).count();
  if (!pacer_.take(elapsedUs, captureFps_.load())) return;
  {
    std::lock_guard<std::mutex> guard(encodeMutex_);
    if (pending_.size() >= kMaxPendingFrames) {
      droppedBusy_++;
      return;
    }
  }
  PendingFrame pending;
  std::string error;
  if (!frames_->capture(handle, pending.frame, error)) {
    if (captureErrors_++ % 300 == 0) logLine("frame capture failed: %s", error.c_str());
    return;
  }
  pending.ptsUs = nextPts();
  captured_++;
  {
    std::lock_guard<std::mutex> guard(encodeMutex_);
    pending_.push_back(std::move(pending));
  }
  encodeWake_.notify_one();
}

uint64_t Agent::nextPts() {
  std::lock_guard<std::mutex> guard(ptsMutex_);
  uint64_t now = uint64_t(
      std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - start_).count());
  lastPts_ = std::max(now, lastPts_ + 1);
  return lastPts_;
}

bool Agent::captureNow(PendingFrame& out) {
  uint32_t handle = lastPostedHandle(g_);
  if (!handle) return false;
  std::string error;
  if (!frames_->capture(handle, out.frame, error)) {
    logLine("on-demand capture failed: %s", error.c_str());
    return false;
  }
  out.ptsUs = nextPts();
  captured_++;
  return true;
}

void Agent::encoderLoop() {
  // Owned by this thread alone. Resetting it waits for its VideoToolbox
  // callbacks, so never reset it while holding encodeMutex_.
  std::unique_ptr<H264Encoder> encoder;
  EncoderStats stats;
  uint64_t encoderGeneration = 0;
  int encoderNativeWidth = 0, encoderNativeHeight = 0;
  auto lastFrameAt = Clock::now() - std::chrono::hours(1);
  uint64_t lastEncodedPts = 0;
  for (;;) {
    try {
      PendingFrame pending;
      bool havePending = false, configure = false, forceKey = false, active = false;
      StreamSettings settings;
      int rotation = 0;
      uint64_t generation;
      int announcedWidth, announcedHeight;
      {
        std::unique_lock<std::mutex> lock(encodeMutex_);
        encodeWake_.wait_for(lock, keyRequested_ ? kIdleKeyFrameDelay : std::chrono::seconds(1),
                             [&] { return !pending_.empty() || settingsChanged_; });
        active = active_;
        generation = generation_;
        configure = settingsChanged_;
        settingsChanged_ = false;
        settings = settings_;
        rotation = rotation_;
        while (!pending_.empty()) {  // Keep only the newest frame.
          pending = std::move(pending_.front());
          pending_.pop_front();
          havePending = true;
        }
        forceKey = keyRequested_ || keyNeededByOutput_.exchange(false);
        keyRequested_ = false;
        announcedWidth = announcedWidth_;
        announcedHeight = announcedHeight_;
      }
      if (!active || generation != encoderGeneration || configure) {
        encoder.reset();  // Waits for packets of the old session.
        encoderGeneration = generation;
      }
      if (!active) continue;
      if (!havePending && (forceKey || !encoder) &&
          Clock::now() - lastFrameAt >= kIdleKeyFrameDelay) {
        // A static screen posts nothing; capture the last posted frame instead.
        havePending = captureNow(pending);
      }
      if (!havePending) {
        if (forceKey || !encoder) {
          std::lock_guard<std::mutex> guard(encodeMutex_);
          keyRequested_ = true;  // Retry once a frame is available.
        }
        continue;
      }
      // A frame that the render thread captured while this thread captured a newer one on
      // demand is older than the last encoded frame; consumers need increasing timestamps.
      if (pending.ptsUs <= lastEncodedPts) {
        if (forceKey) {
          std::lock_guard<std::mutex> guard(encodeMutex_);
          keyRequested_ = true;  // For the next frame.
        }
        continue;
      }
      lastFrameAt = Clock::now();
      if (!encoder || pending.frame.width != encoderNativeWidth ||
          pending.frame.height != encoderNativeHeight) {
        encoder.reset();
        auto [uprightWidth, uprightHeight] =
            uprightSize(pending.frame.width, pending.frame.height, rotation);
        auto [width, height] = streamSize(uprightWidth, uprightHeight, settings.maxSize);
        uint32_t fps = uint32_t(settings.fps);
        auto next = createH264Encoder(
            [this, generation, width = uint32_t(width), height = uint32_t(height),
             fps](EncodedPacket&& packet) {
              sendRecord(generation, packet.key ? kKeyFrame : kFrame, width, height, fps,
                         packet.data.data(), packet.data.size(), packet.ptsUs, !packet.key);
            },
            [](const std::string& message) { logLine("%s", message.c_str()); });
        std::string error;
        if (!next->configure(width, height, settings.fps, settings.bitRate, rotation, error)) {
          logLine("%s", error.c_str());
          std::this_thread::sleep_for(std::chrono::milliseconds(200));
          continue;
        }
        if (pending.frame.width != announcedWidth || pending.frame.height != announcedHeight) {
          {
            std::lock_guard<std::mutex> guard(encodeMutex_);
            if (generation == generation_) {
              announcedWidth_ = pending.frame.width;
              announcedHeight_ = pending.frame.height;
            }
          }
          sendRecord(generation, kResized, uint32_t(pending.frame.width),
                     uint32_t(pending.frame.height), fps, nullptr, 0);
        }
        std::string details = std::string("{\"framePath\":\"") + framePathName(pending.frame.path) +
                              "\",\"hardwareEncoder\":" + (next->hardware() ? "true" : "false") +
                              ",\"encoder\":\"" + jsonEscape(next->encoderId()) +
                              "\",\"rotation\":" + std::to_string(rotation) + "}";
        sendRecord(generation, kConfigured, uint32_t(width), uint32_t(height), fps,
                   reinterpret_cast<const uint8_t*>(details.data()), details.size());
        logLine("streaming %dx%d@%d from %dx%d native at rotation %d, %s frames, %s encoder %s",
                width, height, settings.fps, pending.frame.width, pending.frame.height, rotation,
                framePathName(pending.frame.path), next->hardware() ? "hardware" : "software",
                next->encoderId().c_str());
        encoder = std::move(next);
        encoderNativeWidth = pending.frame.width;
        encoderNativeHeight = pending.frame.height;
        forceKey = true;
        stats.reset();
      }
      std::string error;
      auto encodeStart = Clock::now();
      bool encoded = encoder->encode(pending.frame, pending.ptsUs, forceKey, error);
      lastEncodedPts = pending.ptsUs;
      stats.record(pending.frame.captureMs,
                   std::chrono::duration<double, std::milli>(Clock::now() - encodeStart).count());
      pending.frame.pixels = FramePixels();  // Back to the frame source's pool.
      if (!encoded) {
        logLine("%s", error.c_str());
        if (forceKey) {
          std::lock_guard<std::mutex> guard(encodeMutex_);
          keyRequested_ = true;
        }
      }
    } catch (const std::exception& error) {
      // An exception must not leave this thread: std::terminate would end QEMU.
      logLine("encoder error: %s", error.what());
      encoder.reset();
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }
  }
}

void Agent::sendRecord(uint64_t generation, uint32_t flags, uint32_t width, uint32_t height,
                       uint32_t fps, const uint8_t* payload, size_t length, uint64_t ptsUs,
                       bool droppable) {
  if (length > kMaxPayloadBytes) {
    logLine("dropping an oversized %zu byte record", length);
    return;
  }
  OutputRecord record;
  record.generation = generation;
  record.droppable = droppable;
  record.bytes.resize(kHeaderBytes + length);
  encodeHeader(record.bytes.data(), uint32_t(length), ptsUs, flags, width, height, fps);
  if (length) memcpy(record.bytes.data() + kHeaderBytes, payload, length);
  {
    std::lock_guard<std::mutex> guard(outputMutex_);
    if (generation != clientGeneration_) return;
    if (flags == kKeyFrame) dropUntilKey_ = keyAfterDrain_ = false;
    if (droppable && dropUntilKey_) return;
    if (droppable && outputBytes_ + record.bytes.size() > kMaxQueuedOutputBytes) {
      // The consumer is behind: drop delta frames until the next keyframe, and ask for it
      // only once the queue drains, so a consumer that stopped reading gets no keyframes.
      dropUntilKey_ = keyAfterDrain_ = true;
      return;
    }
    if (outputBytes_ + record.bytes.size() > kMaxBufferedOutputBytes) {
      outputStalled_ = true;  // serve() closes the consumer.
    } else {
      outputBytes_ += record.bytes.size();
      output_.push_back(std::move(record));
    }
  }
  wake();
}

void Agent::wake() {
  uint8_t byte = 1;
  // A full pipe already holds a wake-up, so a failed write needs no handling.
  if (write(wakePipe_[1], &byte, 1) < 0) return;
}

std::string Agent::helloJson() {
  // posts counts every display post since the agent started, with or without a
  // consumer, so two hellos give the renderer's frame rate without capture.
  return std::string("{\"protocol\":") + std::to_string(kProtocolVersion) + ",\"version\":\"" +
         EXPO_EMULATOR_CAPTURE_VERSION + "\",\"platform\":\"" + kPlatform +
         "\",\"gpuAvailable\":" +
         (g_.gpuEntryPointsAvailable() && !frames_->gpuUnavailable() ? "true" : "false") +
         ",\"renderer\":\"" + jsonEscape(g_.path) + "\",\"posts\":" +
         std::to_string(posts_.load()) + "}";
}

bool Agent::listen(const std::string& path, std::string& error) {
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  if (path.empty() || path[0] != '/' || path.size() >= sizeof(address.sun_path)) {
    error = "socket path must be absolute and shorter than " +
            std::to_string(sizeof(address.sun_path)) + " bytes";
    return false;
  }
  snprintf(address.sun_path, sizeof(address.sun_path), "%s", path.c_str());
  std::string directory = path.substr(0, path.rfind('/'));
  if (!directory.empty()) {
    // @ref LLP 0020#loading — the socket directory must belong to this user alone
    // On a shared /tmp, another user could otherwise create the directory first and replace
    // the socket.
    mkdir(directory.c_str(), 0700);
    struct stat info {};
    if (lstat(directory.c_str(), &info) != 0 || !S_ISDIR(info.st_mode) ||
        info.st_uid != geteuid() || (info.st_mode & 077) != 0) {
      error = directory + " must be a directory that only this user can access (mode 0700)";
      return false;
    }
  }
  // Refuse a socket that another live agent serves. A lock next to the socket, held for the
  // agent's lifetime, says so without a connection, which the live agent would take for a new
  // consumer that replaces its current one.
  std::string lockPath = path + ".lock";
  int lock = open(lockPath.c_str(), O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (lock < 0) {
    error = "cannot open " + lockPath + ": " + strerror(errno);
    return false;
  }
  if (flock(lock, LOCK_EX | LOCK_NB) != 0) {
    close(lock);
    error = "another capture agent already serves " + path;
    return false;
  }
  socketLock_ = lock;  // Released when the process exits.
  unlink(path.c_str());
  listener_ = socket(AF_UNIX, SOCK_STREAM, 0);
  if (listener_ < 0 || bind(listener_, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0 ||
      chmod(path.c_str(), 0600) != 0 || ::listen(listener_, 4) != 0) {
    error = std::string("cannot listen on ") + path + ": " + strerror(errno);
    if (listener_ >= 0) close(listener_);
    listener_ = -1;
    return false;
  }
  fcntl(listener_, F_SETFD, FD_CLOEXEC);
  fcntl(listener_, F_SETFL, O_NONBLOCK);
  path_ = path;
  snprintf(boundSocketPath, sizeof(boundSocketPath), "%s", path.c_str());
  atexit(unlinkBoundSocket);
  return true;
}

void Agent::serve() {
  for (;;) {
    try {
      pollfd fds[3] = {{listener_, POLLIN, 0}, {wakePipe_[0], POLLIN, 0}, {client_, 0, 0}};
      nfds_t count = 2;
      if (client_ >= 0) {
        std::lock_guard<std::mutex> guard(outputMutex_);
        fds[2].events = short(POLLIN | (output_.empty() ? 0 : POLLOUT));
        count = 3;
      }
      if (poll(fds, count, 1000) < 0) {
        if (errno == EINTR) continue;
        logLine("poll failed: %s", strerror(errno));
        return;
      }
      if (fds[1].revents) {
        uint8_t drain[64];
        while (read(wakePipe_[0], drain, sizeof(drain)) > 0) {
        }
      }
      if (outputStalled_.exchange(false)) disconnect("consumer stopped reading");
      if (client_ >= 0 && count == 3) {
        if (fds[2].revents & (POLLERR | POLLNVAL)) {
          disconnect("socket error");
          continue;
        }
        if (fds[2].revents & (POLLIN | POLLHUP)) readCommands();
        if (client_ >= 0) flushOutput();
      }
      // Handle the polled consumer before replacing it. Its POLLERR/POLLHUP belongs to
      // the old connection and must never disconnect a newly accepted consumer.
      if (fds[0].revents & POLLIN) accept();
    } catch (const std::exception& error) {
      // An exception must not leave this thread either: std::terminate would end QEMU.
      logLine("socket error: %s", error.what());
      disconnect("agent error");
    }
  }
}

void Agent::accept() {
  int next = ::accept(listener_, nullptr, nullptr);
  if (next < 0) return;
  if (client_ >= 0) {
    sendReplaced();
    disconnect("replaced by a new consumer");
  }
  fcntl(next, F_SETFD, FD_CLOEXEC);
  fcntl(next, F_SETFL, O_NONBLOCK);
  int size = kSocketBufferBytes;
#if defined(SO_NOSIGPIPE)
  int one = 1;
  setsockopt(next, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
  setsockopt(next, SOL_SOCKET, SO_SNDBUF, &size, sizeof(size));
  client_ = next;
  commands_.clear();
  uint64_t generation;
  {
    std::lock_guard<std::mutex> guard(encodeMutex_);
    generation = ++generation_;
    rotation_ = 0;  // A new consumer starts upright until it sends 'R'.
  }
  {
    std::lock_guard<std::mutex> guard(outputMutex_);
    clientGeneration_ = generation;
    dropUntilKey_ = false;
  }
  int width = 0, height = 0;
  void* fb = g_.getFB();
  if (!fb || !colorBufferSize(g_, lastPostedHandle(g_), width, height)) {
    width = fb ? g_.frameBufferWidth(fb) : 0;
    height = fb ? g_.frameBufferHeight(fb) : 0;
  }
  {
    std::lock_guard<std::mutex> guard(encodeMutex_);
    announcedWidth_ = width;
    announcedHeight_ = height;
  }
  std::string hello = helloJson();
  sendRecord(generation, kHello, uint32_t(width), uint32_t(height), kNativeFps,
             reinterpret_cast<const uint8_t*>(hello.data()), hello.size());
  logLine("consumer connected; native %dx%d", width, height);
}

void Agent::readCommands() {
  {
    ssize_t n = readCommandBatch(client_, commands_);
    if (n == 0) {
      disconnect("consumer closed the socket");
      return;
    }
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return;
      disconnect("read failed");
      return;
    }
  }
  while (!commands_.empty()) {
    if (commands_[0] == kCommandKeyFrame) {
      commands_.erase(commands_.begin());
      {
        std::lock_guard<std::mutex> guard(encodeMutex_);
        keyRequested_ = true;
      }
      encodeWake_.notify_one();
      continue;
    }
    if (commands_[0] == kCommandRotation) {
      if (commands_.size() < kRotationCommandBytes) return;
      int rotation = 0;
      if (!parseRotation(commands_.data(), rotation)) {
        disconnect("invalid rotation");
        return;
      }
      commands_.erase(commands_.begin(), commands_.begin() + kRotationCommandBytes);
      {
        std::lock_guard<std::mutex> guard(encodeMutex_);
        if (rotation != rotation_) {
          rotation_ = rotation;
          settingsChanged_ = true;  // A new session at the upright size, from an IDR.
          keyRequested_ = true;
        }
      }
      encodeWake_.notify_one();
      continue;
    }
    if (commands_[0] != kCommandSettings) {
      disconnect("unknown command");
      return;
    }
    if (commands_.size() < kSettingsCommandBytes) return;
    StreamSettings settings;
    if (!parseSettings(commands_.data(), settings)) {
      disconnect("invalid settings");
      return;
    }
    commands_.erase(commands_.begin(), commands_.begin() + kSettingsCommandBytes);
    {
      std::lock_guard<std::mutex> guard(encodeMutex_);
      settings_ = settings;
      settingsChanged_ = true;
      keyRequested_ = true;
      captureFps_ = settings.fps;
      active_ = true;
    }
    encodeWake_.notify_one();
  }
}

void Agent::flushOutput() {
  for (;;) {
    const uint8_t* data;
    size_t remaining;
    {
      std::lock_guard<std::mutex> guard(outputMutex_);
      while (!output_.empty() && output_.front().generation != clientGeneration_) {
        outputBytes_ -= output_.front().bytes.size();
        output_.pop_front();
        outputOffset_ = 0;
      }
      if (output_.empty()) return;
      data = output_.front().bytes.data() + outputOffset_;
      remaining = output_.front().bytes.size() - outputOffset_;
    }
    ssize_t n = send(client_, data, remaining, kSendFlags);
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return;
      disconnect("write failed");
      return;
    }
    std::lock_guard<std::mutex> guard(outputMutex_);
    outputOffset_ += size_t(n);
    if (outputOffset_ == output_.front().bytes.size()) {
      outputBytes_ -= output_.front().bytes.size();
      output_.pop_front();
      outputOffset_ = 0;
      if (keyAfterDrain_ && outputBytes_ <= kMaxQueuedOutputBytes / 2) {
        keyAfterDrain_ = false;
        keyNeededByOutput_ = true;
        encodeWake_.notify_one();
      }
    }
  }
}

// @ref LLP 0020#socket-protocol — a replaced consumer learns why it closes
// Tells the current consumer that a new one replaces it, so that it does not take the agent
// back at once: two consumers would otherwise replace each other in a loop. Best effort on the
// non-blocking socket: it finishes a partly sent record first, and a consumer that stopped
// reading gets only the close.
void Agent::sendReplaced() {
  std::vector<uint8_t> bytes;
  {
    std::lock_guard<std::mutex> guard(outputMutex_);
    if (outputOffset_ > 0 && !output_.empty())
      bytes.assign(output_.front().bytes.begin() + ptrdiff_t(outputOffset_),
                   output_.front().bytes.end());
  }
  size_t start = bytes.size();
  bytes.resize(start + kHeaderBytes);
  encodeHeader(bytes.data() + start, 0, 0, kReplaced, 0, 0, 0);
  size_t sent = 0;
  while (sent < bytes.size()) {
    ssize_t n = send(client_, bytes.data() + sent, bytes.size() - sent, kSendFlags);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return;
    sent += size_t(n);
  }
}

void Agent::disconnect(const char* reason) {
  if (client_ < 0) return;
  close(client_);
  client_ = -1;
  active_ = false;
  {
    std::lock_guard<std::mutex> guard(encodeMutex_);
    generation_++;
    keyRequested_ = false;
  }
  {
    std::lock_guard<std::mutex> guard(outputMutex_);
    clientGeneration_ = 0;
    output_.clear();
    outputBytes_ = 0;
    outputOffset_ = 0;
    dropUntilKey_ = keyAfterDrain_ = false;
  }
  outputStalled_ = false;
  encodeWake_.notify_one();
  logLine("consumer disconnected: %s (posts=%llu captured=%llu busy=%llu locked=%llu errors=%llu)",
          reason, (unsigned long long)posts_.load(), (unsigned long long)captured_.load(),
          (unsigned long long)droppedBusy_.load(), (unsigned long long)skippedLocked_.load(),
          (unsigned long long)captureErrors_.load());
}

void removeFromPreload() {
  // Children such as crashpad_handler and netsimd must not inherit the agent.
  Dl_info info{};
  const char* inserted = getenv(kPreloadVariable);
  if (!inserted || !dladdr(reinterpret_cast<void*>(&removeFromPreload), &info) ||
      !info.dli_fname)
    return;
  std::string self = info.dli_fname, remaining, entry;
  std::string list = inserted;
  // LD_PRELOAD also separates entries with spaces.
  const char* separators = kPreloadVariable[0] == 'L' ? ": " : ":";
  size_t start = 0;
  while (start <= list.size()) {
    size_t end = list.find_first_of(separators, start);
    if (end == std::string::npos) end = list.size();
    entry = list.substr(start, end - start);
    if (!entry.empty() && entry != self) remaining += (remaining.empty() ? "" : ":") + entry;
    start = end + 1;
  }
  if (remaining.empty())
    unsetenv(kPreloadVariable);
  else
    setenv(kPreloadVariable, remaining.c_str(), 1);
}

void runAgent(std::string socketPath) {
  gum_init_embedded();
  GumModule* backend = nullptr;
  for (int attempt = 0; attempt < 1200 && !backend; attempt++) {
    backend = gum_process_find_module_by_name(kRendererModule);
    if (!backend) std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  if (!backend) {
    logLine("capture disabled: the gfxstream renderer did not load");
    return;
  }
  agent = new Agent();
  std::string error;
  if (!agent->initialize(backend, error)) {
    logLine("capture disabled: %s", error.c_str());
    return;
  }
  // The renderer creates its FrameBuffer once the GPU emulation starts.
  void* (*getFB)() = reinterpret_cast<void* (*)()>(
      gum_module_find_export_by_name(backend, "_ZN9gfxstream4host11FrameBuffer5getFBEv"));
  for (int attempt = 0; attempt < 1200 && !getFB(); attempt++)
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  if (!getFB()) {
    logLine("capture disabled: the renderer FrameBuffer was not created");
    return;
  }
  GumInterceptor* interceptor = gum_interceptor_obtain();
  GumInvocationListener* listener = gum_make_call_listener(onPostEnter, nullptr, nullptr, nullptr);
  if (gum_interceptor_attach(interceptor, agent->postTarget(), listener, nullptr) !=
      GUM_ATTACH_OK) {
    logLine("capture disabled: could not hook the renderer's display post");
    return;
  }
  if (!agent->listen(socketPath, error)) {
    logLine("capture disabled: %s", error.c_str());
    return;
  }
  logLine("ready on %s", socketPath.c_str());
  agent->serve();
}

}  // namespace
}  // namespace expo_capture

// @ref LLP 0020#loading — preloaded at launch; only QEMU runs the agent, and its children do not inherit it
__attribute__((constructor)) static void expoEmulatorCaptureInit() {
  expo_capture::guardCallback("capture disabled during startup", [] {
    const char* name = expo_capture::programName();
    if (!name || strncmp(name, "qemu-system", 11) != 0) return;
    expo_capture::removeFromPreload();
    const char* socketPath = getenv("EXPO_EMULATOR_CAPTURE_SOCKET");
    if (const char* logPath = getenv("EXPO_EMULATOR_CAPTURE_LOG")) {
      // O_NOFOLLOW: a symlink at the log path must not redirect the writes to another file.
      int fd = open(logPath, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
      if (fd >= 0) {
        if (FILE* file = fdopen(fd, "a"))
          expo_capture::logFile = file;
        else
          close(fd);
      }
    }
    if (!socketPath || !*socketPath) {
      expo_capture::logLine("capture disabled: EXPO_EMULATOR_CAPTURE_SOCKET is not set");
      return;
    }
    std::thread([path = std::string(socketPath)] {
      expo_capture::guardCallback("capture disabled during startup", [&] {
        expo_capture::runAgent(path);
      });
    }).detach();
  });
}

// The only exported symbol: lets tools confirm which agent build is loaded.
extern "C" __attribute__((visibility("default"))) const char* expo_emulator_capture_version() {
  return EXPO_EMULATOR_CAPTURE_VERSION;
}
