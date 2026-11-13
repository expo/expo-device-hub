// SPDX-License-Identifier: MIT
// Capture agent preloaded into the Android Emulator's QEMU process
// (DYLD_INSERT_LIBRARIES on macOS, LD_PRELOAD on Linux). It hooks gfxstream's
// display post, copies posted color buffers out of the renderer, encodes them to
// H.264, and serves two consumers on a Unix socket: the live stream and the recording, each
// with its own encoder.
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
#include <tuple>
#include <vector>
#include "encoder.h"
#include "encoder-wake.h"
#include "callback.h"
#include "frame-source.h"
#include "frida-gum.h"
#include "gfxstream.h"
#include "log.h"
#include "protocol.h"

// The package version; the build passes it from package.json.
#ifndef EXPO_EMULATOR_CAPTURE_VERSION
#define EXPO_EMULATOR_CAPTURE_VERSION "0.0.0-dev"
#endif

namespace expo_capture {

// Constant-initialized: the constructor below runs before dynamic initializers
// in this file, so `= stderr` here would overwrite the log file it opens.
FILE* logFile = nullptr;
std::mutex logMutex;

void logLine(const char* format, ...) {
  char line[1024];
  va_list args;
  va_start(args, format);
  vsnprintf(line, sizeof(line), format, args);
  va_end(args);
  std::lock_guard<std::mutex> guard(logMutex);
  FILE* out = logFile ? logFile : stderr;
  fprintf(out, "[expo-emulator-capture] %s\n", line);
  fflush(out);
}

namespace {

#if defined(__APPLE__)
constexpr const char* kPlatform = "darwin-arm64";
constexpr const char* kPreloadVariable = "DYLD_INSERT_LIBRARIES";
constexpr const char* kRendererModule = "libgfxstream_backend.dylib";
constexpr int kSendFlags = 0;  // SO_NOSIGPIPE is set on the socket instead.
const char* programName() { return getprogname(); }
#else
constexpr const char* kPlatform = "linux-x64";
constexpr const char* kPreloadVariable = "LD_PRELOAD";
constexpr const char* kRendererModule = "libgfxstream_backend.so";
constexpr int kSendFlags = MSG_NOSIGNAL;
const char* programName() { return program_invocation_short_name; }
#endif

using Clock = std::chrono::steady_clock;
constexpr int kNativeFps = 60;
// Per role: above the first limit, delta frames are dropped, and a keyframe is requested once the
// queue drains to half. Keyframes and control records are never dropped; a consumer whose queue
// grows past the second limit stopped reading, and the agent closes it. The recording's consumer
// writes to a local disk, so it gets more room before frames go missing from the file.
constexpr size_t kMaxQueuedOutputBytes[kRoleCount] = {8 * 1024 * 1024, 64 * 1024 * 1024};
constexpr size_t kMaxBufferedOutputBytes[kRoleCount] = {32 * 1024 * 1024, 128 * 1024 * 1024};
constexpr int kSocketBufferBytes = 4 * 1024 * 1024;
constexpr size_t kMaxPendingFrames = 2;
// Lag read: each post copies the frame of the post before, which the renderer has finished.
// The frame of a post that stays the last one for this long is copied on the capture thread
// (the tail rule), so a still screen shows its newest frame.
constexpr auto kLagTailDelay = std::chrono::milliseconds(50);
// One consumer per role, and a few connections that have not sent 'S' yet.
constexpr size_t kMaxConnections = kRoleCount + 4;
// @ref LLP 0018#recording-keyframes — keyframes at most a second apart, as serve-sim's recorder
constexpr int kRecordingKeyFrameIntervalSeconds = 1;
constexpr int kStreamKeyFrameIntervalSeconds = 10;

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
  bool droppable = false;      // Delta frames may be dropped under backpressure.
};

struct PendingFrame {
  CapturedFrame frame;
  uint64_t ptsUs = 0;
};

enum class ReadMode { Auto, Post, Lag, LagAsync };

const char* readModeName(ReadMode mode) {
  switch (mode) {
    case ReadMode::Post: return "post";
    case ReadMode::Lag: return "lag";
    case ReadMode::LagAsync: return "lag-async";
    default: return "auto";
  }
}

double threadCpuSeconds() {
  timespec time{};
  if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &time) != 0) return 0;
  return double(time.tv_sec) + double(time.tv_nsec) / 1e9;
}

// Encoder thread timings, logged every 10 seconds while a consumer streams.
struct EncoderStats {
  // The agent's counters: all posts, and the render thread's time inside them.
  const std::atomic<uint64_t>* posts = nullptr;
  const std::atomic<uint64_t>* postUs = nullptr;
  uint64_t frames = 0, postsSince = 0, postUsSince = 0;
  double captureMs = 0, waitMs = 0, readMs = 0, encodeMs = 0, convertMs = 0;
  double threadCpu = threadCpuSeconds();
  Clock::time_point since = Clock::now();

  void reset() {
    auto postCounter = posts;
    auto postTime = postUs;
    *this = EncoderStats{};
    posts = postCounter;
    postUs = postTime;
    postsSince = posts ? posts->load() : 0;
    postUsSince = postUs ? postUs->load() : 0;
  }
  void record(int role, const CapturedFrame& frame, double frameEncodeMs, double frameConvertMs) {
    frames++;
    captureMs += frame.captureMs;
    waitMs += frame.waitMs;
    readMs += frame.readMs;
    encodeMs += frameEncodeMs;
    convertMs += frameConvertMs;
    double wall = std::chrono::duration<double>(Clock::now() - since).count();
    if (wall < 10) return;
    double cpu = threadCpuSeconds();
    uint64_t postCount = posts ? posts->load() - postsSince : 0;
    double postMs = postUs ? double(postUs->load() - postUsSince) / 1000 : 0;
    logLine("stats (%s): %.1f fps, posts %.1f/s, render thread %.2f ms per post, capture %.2f ms "
            "(wait %.2f, read %.2f), encode %.2f ms (convert %.2f), encoder thread %.0f%% CPU",
            roleName(role), frames / wall, postCount / wall,
            postCount ? postMs / double(postCount) : 0, captureMs / frames, waitMs / frames,
            readMs / frames, encodeMs / frames, convertMs / frames,
            (cpu - threadCpu) / wall * 100);
    reset();
  }
};

// One socket connection. The serve() thread owns the descriptor and the commands; the output
// fields are guarded by outputMutex_, because the encoder threads queue records.
struct Connection {
  int fd = -1;
  uint64_t generation = 0;  // Unique for each connection.
  int role = -1;            // Assigned by the first 'S'; -1 before.
  // Requested before the first 'S'.
  int requestedRole = kRoleStream;  // A consumer without 'U' is a stream consumer.
  int rotation = 0;
  int canvasWidth = 0, canvasHeight = 0;
  int helloWidth = 0, helloHeight = 0;  // The native size that hello announced.
  std::vector<uint8_t> commands;
  std::deque<OutputRecord> output;
  size_t outputBytes = 0;
  size_t outputOffset = 0;  // Bytes of output.front() already written.
  bool dropUntilKey = false;
  bool keyAfterDrain = false;  // Request a keyframe once the queue drains to half.
  bool stalled = false;
};

// What one role encodes, and for which connection. Guarded by encodeMutex_ unless noted.
struct RoleState {
  std::condition_variable wake;
  std::deque<PendingFrame> pending;
  StreamSettings settings;
  int rotation = 0;                       // The stream's display rotation; the recording keeps 0.
  int canvasWidth = 0, canvasHeight = 0;  // The recording's canvas; 0 until known.
  bool settingsChanged = false;
  bool keyRequested = false;
  uint64_t generation = 0;  // The connection that this role serves; 0 when none.
  int announcedWidth = 0, announcedHeight = 0;  // Native size the consumer knows.
  // Read by the render thread without encodeMutex_.
  std::atomic<bool> active{false};
  std::atomic<int> fps{kNativeFps};
  std::atomic<bool> keyNeededByOutput{false};
  // The last keyframe's timestamp, from the encoder thread and the encoder's callback.
  std::atomic<uint64_t> lastKeyPts{0};
  FramePacer pacer;  // Render thread, under postMutex_.
};

class Agent {
 public:
  bool initialize(GumModule* backend, std::string& error);
  void* postTarget() const { return g_.postImpl; }
  bool listen(const std::string& path, std::string& error);
  void serve();
  void onPost(uint32_t handle, bool needLockAndBind);

 private:
  void encoderLoop(int role);
  void captureLoop();
  void capturePost(uint32_t handle, bool needLockAndBind);
  void deliver(PendingFrame& pending, const bool (&take)[kRoleCount]);
  void deliverTail();
  ReadMode effectiveReadMode() const;
  void chooseCaptureModes();
  std::string sessionOption(const char* file, const char* variable) const;
  bool captureNow(PendingFrame& out);
  void accept();
  void readCommands(Connection& connection);
  void assignRole(Connection& connection, const StreamSettings& settings);
  void flushOutput(Connection& connection);
  void sendReplaced(Connection& connection);
  void disconnect(uint64_t generation, const char* reason);
  Connection* find(uint64_t generation);
  void sendRecord(uint64_t generation, uint32_t flags, uint32_t width, uint32_t height,
                  uint32_t fps, const uint8_t* payload, size_t length, uint64_t ptsUs = 0,
                  bool droppable = false);
  uint64_t nextPts();
  uint64_t clockUs() const;
  void wake();
  std::string helloJson();

  Gfxstream g_;
  std::unique_ptr<FrameSource> frames_;
  Clock::time_point start_ = Clock::now();

  std::atomic<uint64_t> posts_{0}, captured_{0}, skippedLocked_{0}, droppedBusy_{0},
      captureErrors_{0};
  std::mutex postMutex_;  // Serializes concurrent posts and their previous handle.
  std::mutex pacerMutex_;  // Shared by posts and tail reads.
  std::atomic<uint64_t> postUs_{0};  // The render thread's time inside captured posts.

  // How posts read frames, chosen at each consumer's settings (see chooseCaptureModes()).
  std::atomic<ReadMode> readMode_{ReadMode::Auto};
  uint32_t previousHandle_ = 0;  // Lag read; guarded by postMutex_.
  std::atomic<uint64_t> lagTails_{0};
  // Lag read: what captureLoop() reads next, guarded by asyncMutex_. A request is the newest
  // frame for the roles that took it; the tail is the last post's frame, read once no post
  // came for kLagTailDelay.
  std::mutex asyncMutex_;
  std::condition_variable asyncWake_;
  uint32_t asyncHandle_ = 0;
  uint64_t asyncPts_ = 0;
  bool asyncTake_[kRoleCount] = {};
  bool tailPending_ = false;
  int64_t tailPostUs_ = 0;
  std::atomic<uint64_t> asyncReplaced_{0};  // Requests replaced before captureLoop() took them.

  // Encoder thread inputs. Only each role's encoder thread owns its H264Encoder; the
  // encoders' callbacks never take encodeMutex_.
  std::mutex encodeMutex_;
  RoleState roles_[kRoleCount];
  uint64_t lastPts_ = 0;
  std::mutex ptsMutex_;

  // Socket state. The serve() thread owns the descriptors and changes connections_ under
  // outputMutex_, so encoder threads can find a connection by generation.
  std::string path_;
  int listener_ = -1;
  int socketLock_ = -1;
  int wakePipe_[2] = {-1, -1};
  std::mutex outputMutex_;
  std::vector<std::unique_ptr<Connection>> connections_;
  uint64_t nextGeneration_ = 0;
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
#if defined(__APPLE__)
  if (!g_.gpuEntryPointsAvailable())
    logLine("GPU frame path disabled: renderer symbols are missing; using CPU readback");
#endif
  if (pipe(wakePipe_) != 0) {
    error = "cannot create wake pipe";
    return false;
  }
  fcntl(wakePipe_[0], F_SETFL, O_NONBLOCK);
  fcntl(wakePipe_[1], F_SETFL, O_NONBLOCK);
  for (int role = 0; role < kRoleCount; role++) std::thread([this, role] { encoderLoop(role); }).detach();
  std::thread([this] { captureLoop(); }).detach();
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

ReadMode Agent::effectiveReadMode() const {
  ReadMode mode = readMode_.load(std::memory_order_relaxed);
  if (mode != ReadMode::Auto) return mode;
#if defined(__linux__)
  // @ref LLP 0021#frame-path — on Linux, the render thread does not wait for the read
  // The read of this post's frame waits for the renderer to finish it, and the copy takes
  // several ms. The frame of the post before is finished, so the capture thread reads it.
  return ReadMode::LagAsync;
#else
  // On macOS, the GPU copy takes 0.1 ms, and SwANGLE's CPU read waits for the renderer even
  // for the frame before, so both stay in the post.
  return ReadMode::Post;
#endif
}

void Agent::capturePost(uint32_t handle, bool needLockAndBind) {
  posts_++;
  bool anyActive = false;
  for (const RoleState& role : roles_) anyActive |= role.active.load(std::memory_order_relaxed);
  if (!anyActive) return;
  if (!needLockAndBind) {
    // @ref LLP 0020#hook-point — the caller already holds the non-recursive FrameBuffer lock
    skippedLocked_++;
    return;
  }
  auto entered = Clock::now();
  struct PostTimer {
    std::atomic<uint64_t>& total;
    Clock::time_point entered;
    ~PostTimer() {
      total += uint64_t(
          std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - entered).count());
    }
  } timer{postUs_, entered};
  std::unique_lock<std::mutex> postLock(postMutex_, std::try_to_lock);
  if (!postLock.owns_lock()) {
    droppedBusy_++;
    return;
  }
  int64_t elapsedUs =
      std::chrono::duration_cast<std::chrono::microseconds>(entered - start_).count();
  ReadMode mode = effectiveReadMode();
  const bool lag = mode == ReadMode::Lag || mode == ReadMode::LagAsync;
  uint32_t readHandle = handle;
  if (lag) {
    // The frame of this post waits for the next post, or for the tail rule in captureLoop().
    readHandle = previousHandle_;
    previousHandle_ = handle;
  }
  // @ref LLP 0023#agent-protocol-3 — one copy for every role that takes the post
  // Each role paces itself, so the copy runs at the highest rate of the active roles.
  bool take[kRoleCount] = {};
  bool anyTaken = false;
  if (readHandle) {
    std::lock_guard<std::mutex> guard(pacerMutex_);
    for (int role = 0; role < kRoleCount; role++) {
      RoleState& state = roles_[role];
      take[role] = state.active.load() && state.pacer.take(elapsedUs, state.fps.load());
      anyTaken |= take[role];
    }
  }
  if (anyTaken) {
    std::lock_guard<std::mutex> guard(encodeMutex_);
    anyTaken = false;
    for (int role = 0; role < kRoleCount; role++) {
      if (take[role] && roles_[role].pending.size() >= kMaxPendingFrames) {
        droppedBusy_++;
        take[role] = false;
      }
      anyTaken |= take[role];
    }
  }
  if (lag) {
    {
      std::lock_guard<std::mutex> guard(asyncMutex_);
      tailPending_ = true;
      tailPostUs_ = elapsedUs;
      if (mode == ReadMode::LagAsync && anyTaken) {
        // captureLoop() copies the frame, so the post does not wait for the read. A newer
        // request replaces one that it has not taken, for the roles of both.
        if (asyncHandle_) asyncReplaced_++;
        asyncHandle_ = readHandle;
        asyncPts_ = nextPts();
        for (int role = 0; role < kRoleCount; role++) asyncTake_[role] |= take[role];
      }
    }
    asyncWake_.notify_one();
    if (mode == ReadMode::LagAsync) return;
  }
  if (!anyTaken) return;
  PendingFrame pending;
  std::string error;
  if (!frames_->capture(readHandle, pending.frame, error)) {
    if (captureErrors_++ % 300 == 0) logLine("frame capture failed: %s", error.c_str());
    return;
  }
  pending.ptsUs = nextPts();
  captured_++;
  deliver(pending, take);
}

// Queues one captured frame for every active role that took it.
void Agent::deliver(PendingFrame& pending, const bool (&take)[kRoleCount]) {
  bool queued[kRoleCount] = {};
  {
    std::lock_guard<std::mutex> guard(encodeMutex_);
    for (int role = 0; role < kRoleCount; role++) {
      RoleState& state = roles_[role];
      if (!take[role] || !state.active) continue;
      if (state.pending.size() >= kMaxPendingFrames) {
        droppedBusy_++;
        continue;
      }
      state.pending.push_back(pending);
      queued[role] = true;
    }
  }
  for (int role = 0; role < kRoleCount; role++)
    if (queued[role]) roles_[role].wake.notify_one();
}

// The tail rule: no post came after the last one, so no post reads its frame. Every active role
// gets it, past its pacer, in place of its oldest pending frame when its queue is full.
void Agent::deliverTail() {
  PendingFrame pending;
  if (!captureNow(pending)) return;
  lagTails_++;
  bool queued[kRoleCount] = {};
  {
    std::lock_guard<std::mutex> guard(encodeMutex_);
    for (int role = 0; role < kRoleCount; role++) {
      RoleState& state = roles_[role];
      if (!state.active) continue;
      if (state.pending.size() >= kMaxPendingFrames) state.pending.pop_front();
      state.pending.push_back(pending);
      queued[role] = true;
    }
  }
  for (int role = 0; role < kRoleCount; role++)
    if (queued[role]) roles_[role].wake.notify_one();
}

// Lag read: copies the frame of the post before on its own thread (lag + async), and the last
// post's frame by the tail rule (lag and lag + async). One read serves every role that took the
// frame. The frame source serializes reads, and the renderer's read takes the FrameBuffer lock
// itself.
void Agent::captureLoop() {
  for (;;) {
    uint32_t handle = 0;
    uint64_t ptsUs = 0;
    bool take[kRoleCount] = {};
    bool tail = false;
    {
      std::unique_lock<std::mutex> lock(asyncMutex_);
      for (;;) {
        if (asyncHandle_) {
          handle = asyncHandle_;
          ptsUs = asyncPts_;
          for (int role = 0; role < kRoleCount; role++) {
            take[role] = asyncTake_[role];
            asyncTake_[role] = false;
          }
          asyncHandle_ = 0;
          break;
        }
        if (!tailPending_) {
          asyncWake_.wait(lock);
          continue;
        }
        auto due = start_ + std::chrono::microseconds(tailPostUs_) + kLagTailDelay;
        if (Clock::now() >= due) {
          tailPending_ = false;
          tail = true;
          break;
        }
        asyncWake_.wait_until(lock, due);
      }
    }
    try {
      bool anyActive = false;
      for (const RoleState& role : roles_) anyActive |= role.active.load();
      if (!anyActive) continue;
      if (tail) {
        ReadMode mode = effectiveReadMode();
        if (mode == ReadMode::Lag || mode == ReadMode::LagAsync) deliverTail();
        continue;
      }
      PendingFrame pending;
      std::string error;
      if (!frames_->capture(handle, pending.frame, error)) {
        if (captureErrors_++ % 300 == 0) logLine("frame capture failed: %s", error.c_str());
        continue;
      }
      pending.ptsUs = ptsUs;
      captured_++;
      deliver(pending, take);
    } catch (...) {
      // An exception must not leave this thread: std::terminate would end QEMU.
      captureErrors_++;
    }
  }
}

uint64_t Agent::clockUs() const {
  return uint64_t(
      std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - start_).count());
}

uint64_t Agent::nextPts() {
  std::lock_guard<std::mutex> guard(ptsMutex_);
  lastPts_ = std::max(clockUs(), lastPts_ + 1);
  return lastPts_;
}

bool Agent::captureNow(PendingFrame& out) {
  void* fb = g_.getFB();
  uint32_t handle = fb ? g_.lastPostedColorBuffer(fb) : 0;
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

std::string configuredJson(int role, const CapturedFrame& frame, const H264Encoder& encoder,
                           int rotation, const Rect* contentRect, uint64_t fromPts) {
  std::string details = std::string("{\"role\":\"") + roleName(role) + "\",\"framePath\":\"" +
                        framePathName(frame.path) + "\",\"hardwareEncoder\":" +
                        (encoder.hardware() ? "true" : "false") + ",\"encoder\":\"" +
                        jsonEscape(encoder.encoderId()) +
                        "\",\"rotation\":" + std::to_string(rotation);
  if (contentRect) {
    // Where the native frame sits on the recording canvas, from the frame at fromPts on.
    details += ",\"contentRect\":{\"x\":" + std::to_string(contentRect->x) +
               ",\"y\":" + std::to_string(contentRect->y) +
               ",\"width\":" + std::to_string(contentRect->width) +
               ",\"height\":" + std::to_string(contentRect->height) +
               "},\"fromPts\":" + std::to_string(fromPts);
  }
  return details + "}";
}

void Agent::encoderLoop(int role) {
  RoleState& state = roles_[role];
  const bool recording = role == kRoleRecording;
  // Owned by this thread alone. Resetting it waits for its VideoToolbox
  // callbacks, so never reset it while holding encodeMutex_.
  std::unique_ptr<H264Encoder> encoder;
  EncoderStats stats;
  uint64_t encoderGeneration = 0;
  int encoderNativeWidth = 0, encoderNativeHeight = 0;
  int encoderWidth = 0, encoderHeight = 0;
  auto lastFrameAt = Clock::now() - std::chrono::hours(1);
  uint64_t lastEncodedPts = 0;
  std::string lastConfigureError;
  stats.posts = &posts_;
  stats.postUs = &postUs_;
  stats.reset();
  for (;;) {
    try {
      PendingFrame pending;
      bool havePending = false, configure = false, forceKey = false, active = false;
      StreamSettings settings;
      int rotation = 0, canvasWidth = 0, canvasHeight = 0;
      uint64_t generation;
      int announcedWidth, announcedHeight;
      {
        std::unique_lock<std::mutex> lock(encodeMutex_);
        waitForEncoderWork(state.wake, lock, state.keyRequested, state.keyNeededByOutput,
                           [&] { return !state.pending.empty() || state.settingsChanged; });
        active = state.active;
        generation = state.generation;
        configure = state.settingsChanged;
        state.settingsChanged = false;
        settings = state.settings;
        rotation = state.rotation;
        canvasWidth = state.canvasWidth;
        canvasHeight = state.canvasHeight;
        while (!state.pending.empty()) {  // Keep only the newest frame.
          pending = std::move(state.pending.front());
          state.pending.pop_front();
          havePending = true;
        }
        forceKey = state.keyNeededByOutput.exchange(false) || state.keyRequested;
        state.keyRequested = false;
        announcedWidth = state.announcedWidth;
        announcedHeight = state.announcedHeight;
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
          state.keyRequested = true;  // Retry once a frame is available.
        }
        continue;
      }
      // A frame that a post or the capture thread captured while this thread captured a newer
      // one on demand is older than the last encoded frame; consumers need increasing timestamps.
      if (pending.ptsUs <= lastEncodedPts) {
        if (forceKey) {
          std::lock_guard<std::mutex> guard(encodeMutex_);
          state.keyRequested = true;  // For the next frame.
        }
        continue;
      }
      lastFrameAt = Clock::now();
      bool resized =
          pending.frame.width != encoderNativeWidth || pending.frame.height != encoderNativeHeight;
      // The stream follows the native size. The recording keeps its canvas and places each
      // frame on it, so a fold does not change its size or its encoder.
      if (!encoder || (resized && !recording)) {
        encoder.reset();
        int width, height;
        if (recording) {
          if (canvasWidth == 0) {
            // A recording consumer without 'C' gets the first frame's size as its canvas.
            std::tie(canvasWidth, canvasHeight) =
                streamSize(pending.frame.width, pending.frame.height, settings.maxSize);
            std::lock_guard<std::mutex> guard(encodeMutex_);
            if (generation == state.generation) {
              state.canvasWidth = canvasWidth;
              state.canvasHeight = canvasHeight;
            }
          }
          width = canvasWidth;
          height = canvasHeight;
          rotation = 0;  // The recording keeps the panel orientation.
        } else {
          auto [uprightWidth, uprightHeight] =
              uprightSize(pending.frame.width, pending.frame.height, rotation);
          std::tie(width, height) = streamSize(uprightWidth, uprightHeight, settings.maxSize);
        }
        uint32_t fps = uint32_t(settings.fps);
        state.lastKeyPts = 0;
        auto next = createH264Encoder(
            [this, &state, generation, width = uint32_t(width), height = uint32_t(height),
             fps](EncodedPacket&& packet) {
              if (packet.key) {
                uint64_t previous = state.lastKeyPts.load();
                while (packet.ptsUs > previous &&
                       !state.lastKeyPts.compare_exchange_weak(previous, packet.ptsUs)) {
                }
              }
              sendRecord(generation, packet.key ? kKeyFrame : kFrame, width, height, fps,
                         packet.data.data(), packet.data.size(), packet.ptsUs, !packet.key);
            },
            [](const std::string& message) { logLine("%s", message.c_str()); });
        EncoderConfig config;
        config.width = width;
        config.height = height;
        config.fps = settings.fps;
        config.bitRate = settings.bitRate;
        config.rotation = rotation;
        config.keyFrameIntervalSeconds =
            recording ? kRecordingKeyFrameIntervalSeconds : kStreamKeyFrameIntervalSeconds;
        config.letterbox = recording;
        std::string error;
        if (!next->configure(config, error)) {
          // A missing encoder fails every 200 ms until the host changes; log each error once.
          if (error != lastConfigureError) logLine("%s", error.c_str());
          lastConfigureError = error;
          std::this_thread::sleep_for(std::chrono::milliseconds(200));
          continue;
        }
        lastConfigureError.clear();
        encoder = std::move(next);
        encoderWidth = width;
        encoderHeight = height;
        encoderNativeWidth = encoderNativeHeight = 0;  // Announce the native size below.
        resized = true;
        stats.reset();
        logLine("%s: encoding %dx%d@%d at rotation %d, %s encoder %s", roleName(role), width,
                height, settings.fps, rotation, encoder->hardware() ? "hardware" : "software",
                encoder->encoderId().c_str());
      }
      if (resized) {
        uint32_t fps = uint32_t(settings.fps);
        if (pending.frame.width != announcedWidth || pending.frame.height != announcedHeight) {
          {
            std::lock_guard<std::mutex> guard(encodeMutex_);
            if (generation == state.generation) {
              state.announcedWidth = pending.frame.width;
              state.announcedHeight = pending.frame.height;
            }
          }
          sendRecord(generation, kResized, uint32_t(pending.frame.width),
                     uint32_t(pending.frame.height), fps, nullptr, 0);
        }
        Rect placement;
        if (recording)
          placement =
              placeOnCanvas(pending.frame.width, pending.frame.height, encoderWidth, encoderHeight);
        std::string details =
            configuredJson(role, pending.frame, *encoder, recording ? 0 : rotation,
                           recording ? &placement : nullptr, pending.ptsUs);
        sendRecord(generation, kConfigured, uint32_t(encoderWidth), uint32_t(encoderHeight), fps,
                   reinterpret_cast<const uint8_t*>(details.data()), details.size());
        logLine("%s: %dx%d native, %s frames", roleName(role), pending.frame.width,
                pending.frame.height, framePathName(pending.frame.path));
        encoderNativeWidth = pending.frame.width;
        encoderNativeHeight = pending.frame.height;
        forceKey = true;  // A resized and a configured record are followed by an IDR.
      }
      if (recording && !forceKey) {
        // gfxstream posts only when the screen changes, so a count of frames does not bound
        // the time between keyframes; the timestamps do. Half a frame allows for jitter.
        uint64_t interval = uint64_t(kRecordingKeyFrameIntervalSeconds) * 1'000'000 -
                            uint64_t(500'000 / std::max(1, settings.fps));
        forceKey = pending.ptsUs - state.lastKeyPts.load() >= interval;
      }
      if (forceKey) state.lastKeyPts = pending.ptsUs;
      std::string error;
      auto encodeStart = Clock::now();
      bool encoded = encoder->encode(pending.frame, pending.ptsUs, forceKey, error);
      lastEncodedPts = pending.ptsUs;
      stats.record(role, pending.frame,
                   std::chrono::duration<double, std::milli>(Clock::now() - encodeStart).count(),
                   encoder->lastConvertMs());
      pending.frame.pixels = FramePixels();  // Back to the frame source's pool.
      if (!encoded) {
        logLine("%s", error.c_str());
        if (forceKey) {
          std::lock_guard<std::mutex> guard(encodeMutex_);
          state.keyRequested = true;
        }
      }
    } catch (const std::exception& error) {
      // An exception must not leave this thread: std::terminate would end QEMU.
      logLine("%s encoder error: %s", roleName(role), error.what());
      encoder.reset();
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }
  }
}

Connection* Agent::find(uint64_t generation) {
  for (auto& connection : connections_)
    if (connection->generation == generation) return connection.get();
  return nullptr;
}

void Agent::sendRecord(uint64_t generation, uint32_t flags, uint32_t width, uint32_t height,
                       uint32_t fps, const uint8_t* payload, size_t length, uint64_t ptsUs,
                       bool droppable) {
  if (length > kMaxPayloadBytes) {
    logLine("dropping an oversized %zu byte record", length);
    return;
  }
  OutputRecord record;
  record.droppable = droppable;
  record.bytes.resize(kHeaderBytes + length);
  encodeHeader(record.bytes.data(), uint32_t(length), ptsUs, flags, width, height, fps);
  if (length) memcpy(record.bytes.data() + kHeaderBytes, payload, length);
  {
    std::lock_guard<std::mutex> guard(outputMutex_);
    Connection* connection = find(generation);
    if (!connection) return;
    int role = connection->role < 0 ? kRoleStream : connection->role;
    if (flags == kKeyFrame) connection->dropUntilKey = connection->keyAfterDrain = false;
    if (droppable && connection->dropUntilKey) return;
    if (droppable &&
        connection->outputBytes + record.bytes.size() > kMaxQueuedOutputBytes[role]) {
      // The consumer is behind: drop delta frames until the next keyframe, and ask for it
      // only once the queue drains, so a consumer that stopped reading gets no keyframes.
      connection->dropUntilKey = connection->keyAfterDrain = true;
      return;
    }
    if (connection->outputBytes + record.bytes.size() > kMaxBufferedOutputBytes[role]) {
      connection->stalled = true;
      outputStalled_ = true;  // serve() closes the consumer.
    } else {
      connection->outputBytes += record.bytes.size();
      connection->output.push_back(std::move(record));
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
  // consumer, so two hellos give the renderer's frame rate without capture. clockUs is the
  // agent's timestamp clock now, so a consumer can place frame timestamps on its own clock.
  std::string hello =
      std::string("{\"protocol\":") + std::to_string(kProtocolVersion) + ",\"version\":\"" +
      EXPO_EMULATOR_CAPTURE_VERSION + "\",\"platform\":\"" + kPlatform + "\",\"gpuAvailable\":" +
      (g_.gpuEntryPointsAvailable() && !frames_->gpuUnavailable() ? "true" : "false") +
      ",\"renderer\":\"" + jsonEscape(g_.path) + "\",\"posts\":" + std::to_string(posts_.load()) +
      ",\"clockUs\":" + std::to_string(clockUs());
  // A consumer that sees encoderError stops: no session can start until the host has the
  // encoder (on Linux, x264 build 165).
  std::string encoderError = h264EncoderProblem();
  if (!encoderError.empty()) hello += ",\"encoderError\":\"" + jsonEscape(encoderError) + "\"";
  return hello + "}";
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
  std::vector<pollfd> fds;
  std::vector<uint64_t> generations;
  for (;;) {
    try {
      fds.clear();
      generations.clear();
      fds.push_back({listener_, POLLIN, 0});
      fds.push_back({wakePipe_[0], POLLIN, 0});
      {
        std::lock_guard<std::mutex> guard(outputMutex_);
        for (auto& connection : connections_) {
          fds.push_back({connection->fd,
                         short(POLLIN | (connection->output.empty() ? 0 : POLLOUT)), 0});
          generations.push_back(connection->generation);
        }
      }
      if (poll(fds.data(), nfds_t(fds.size()), 1000) < 0) {
        if (errno == EINTR) continue;
        logLine("poll failed: %s", strerror(errno));
        return;
      }
      if (fds[1].revents) {
        uint8_t drain[64];
        while (read(wakePipe_[0], drain, sizeof(drain)) > 0) {
        }
      }
      if (outputStalled_.exchange(false)) {
        std::vector<uint64_t> stalled;
        {
          std::lock_guard<std::mutex> guard(outputMutex_);
          for (auto& connection : connections_)
            if (connection->stalled) stalled.push_back(connection->generation);
        }
        for (uint64_t generation : stalled) disconnect(generation, "consumer stopped reading");
      }
      if (fds[0].revents & POLLIN) accept();
      for (size_t index = 0; index < generations.size(); index++) {
        Connection* connection = find(generations[index]);
        if (!connection) continue;  // Replaced or closed meanwhile.
        short revents = fds[index + 2].revents;
        if (revents & (POLLERR | POLLNVAL)) {
          disconnect(connection->generation, "socket error");
          continue;
        }
        if (revents & (POLLIN | POLLHUP)) {
          readCommands(*connection);
          connection = find(generations[index]);
          if (!connection) continue;
        }
        flushOutput(*connection);
      }
    } catch (const std::exception& error) {
      // An exception must not leave this thread either: std::terminate would end QEMU.
      logLine("socket error: %s", error.what());
      std::vector<uint64_t> all;
      {
        std::lock_guard<std::mutex> guard(outputMutex_);
        for (auto& connection : connections_) all.push_back(connection->generation);
      }
      for (uint64_t generation : all) disconnect(generation, "agent error");
    }
  }
}

void Agent::accept() {
  int next = ::accept(listener_, nullptr, nullptr);
  if (next < 0) return;
  // A connection takes a role only with its first 'S', so a connection that never sends it
  // replaces nobody. Keep a few of them; the oldest goes first.
  if (connections_.size() >= kMaxConnections) {
    uint64_t oldest = 0;
    for (auto& connection : connections_) {
      if (connection->role < 0) {
        oldest = connection->generation;
        break;
      }
    }
    if (oldest) disconnect(oldest, "too many consumers without settings");
  }
  fcntl(next, F_SETFD, FD_CLOEXEC);
  fcntl(next, F_SETFL, O_NONBLOCK);
  int size = kSocketBufferBytes;
#if defined(SO_NOSIGPIPE)
  int one = 1;
  setsockopt(next, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
  setsockopt(next, SOL_SOCKET, SO_SNDBUF, &size, sizeof(size));
  auto connection = std::make_unique<Connection>();
  connection->fd = next;
  int width = 0, height = 0;
  void* fb = g_.getFB();
  if (!fb || !colorBufferSize(g_, g_.lastPostedColorBuffer(fb), width, height)) {
    width = fb ? g_.frameBufferWidth(fb) : 0;
    height = fb ? g_.frameBufferHeight(fb) : 0;
  }
  connection->helloWidth = width;
  connection->helloHeight = height;
  uint64_t generation;
  {
    std::lock_guard<std::mutex> guard(outputMutex_);
    generation = connection->generation = ++nextGeneration_;
    connections_.push_back(std::move(connection));
  }
  std::string hello = helloJson();
  sendRecord(generation, kHello, uint32_t(width), uint32_t(height), kNativeFps,
             reinterpret_cast<const uint8_t*>(hello.data()), hello.size());
  logLine("consumer connected; native %dx%d", width, height);
}

// @ref LLP 0023#agent-protocol-3 — a consumer replaces only the consumer of its own role
// The connection's first 'S' gives it its role. A consumer of that role that was there
// before gets a replaced record and closes; the other role goes on.
void Agent::assignRole(Connection& connection, const StreamSettings& settings) {
  int role = connection.requestedRole;
  uint64_t generation = connection.generation;
  uint64_t previous;
  {
    std::lock_guard<std::mutex> guard(encodeMutex_);
    previous = roles_[role].generation;
  }
  if (previous != 0 && previous != generation) {
    if (Connection* replaced = find(previous)) {
      sendReplaced(*replaced);
      disconnect(previous, "replaced by a new consumer");
    }
  }
  Connection* self = find(generation);
  if (!self) return;
  {
    std::lock_guard<std::mutex> guard(outputMutex_);
    self->role = role;
  }
  RoleState& state = roles_[role];
  {
    std::lock_guard<std::mutex> guard(encodeMutex_);
    state.generation = generation;
    state.settings = settings;
    state.rotation = role == kRoleStream ? self->rotation : 0;
    state.canvasWidth = role == kRoleRecording ? self->canvasWidth : 0;
    state.canvasHeight = role == kRoleRecording ? self->canvasHeight : 0;
    state.announcedWidth = self->helloWidth;
    state.announcedHeight = self->helloHeight;
    state.pending.clear();
    state.settingsChanged = true;
    state.keyRequested = true;
    state.keyNeededByOutput = false;
    state.fps = settings.fps;
    state.active = true;
  }
  state.wake.notify_one();
  logLine("consumer is the %s", roleName(role));
}

void Agent::readCommands(Connection& connection) {
  const uint64_t generation = connection.generation;
  uint8_t bytes[256];
  for (;;) {
    ssize_t n = recv(connection.fd, bytes, sizeof(bytes), 0);
    if (n == 0) {
      disconnect(generation, "consumer closed the socket");
      return;
    }
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) break;
      disconnect(generation, "read failed");
      return;
    }
    connection.commands.insert(connection.commands.end(), bytes, bytes + n);
  }
  std::vector<uint8_t>& commands = connection.commands;
  while (!commands.empty()) {
    const int role = connection.role;
    RoleState* state = role >= 0 ? &roles_[role] : nullptr;
    if (commands[0] == kCommandKeyFrame) {
      commands.erase(commands.begin());
      if (state) {
        {
          std::lock_guard<std::mutex> guard(encodeMutex_);
          state->keyRequested = true;
        }
        state->wake.notify_one();
      }
      continue;
    }
    if (commands[0] == kCommandRotation) {
      if (commands.size() < kRotationCommandBytes) return;
      int rotation = 0;
      if (!parseRotation(commands.data(), rotation)) {
        disconnect(generation, "invalid rotation");
        return;
      }
      commands.erase(commands.begin(), commands.begin() + kRotationCommandBytes);
      if (!state) {
        connection.rotation = rotation;
      } else if (role == kRoleStream) {
        {
          std::lock_guard<std::mutex> guard(encodeMutex_);
          if (rotation != state->rotation) {
            state->rotation = rotation;
            state->settingsChanged = true;  // A new session at the upright size, from an IDR.
            state->keyRequested = true;
          }
        }
        state->wake.notify_one();
      }
      // The recording keeps the panel orientation and ignores rotations.
      continue;
    }
    if (commands[0] == kCommandRole) {
      if (commands.size() < kRoleCommandBytes) return;
      int requested = 0;
      if (!parseRole(commands.data(), requested) || (state && requested != role)) {
        disconnect(generation, state ? "a consumer cannot change its role" : "invalid role");
        return;
      }
      commands.erase(commands.begin(), commands.begin() + kRoleCommandBytes);
      connection.requestedRole = requested;
      continue;
    }
    if (commands[0] == kCommandCanvas) {
      if (commands.size() < kCanvasCommandBytes) return;
      int width = 0, height = 0;
      if (!parseCanvas(commands.data(), width, height)) {
        disconnect(generation, "invalid canvas");
        return;
      }
      commands.erase(commands.begin(), commands.begin() + kCanvasCommandBytes);
      if (!state) {
        connection.canvasWidth = width;
        connection.canvasHeight = height;
      } else if (role == kRoleRecording) {
        {
          std::lock_guard<std::mutex> guard(encodeMutex_);
          if (width != state->canvasWidth || height != state->canvasHeight) {
            state->canvasWidth = width;
            state->canvasHeight = height;
            state->settingsChanged = true;
            state->keyRequested = true;
          }
        }
        state->wake.notify_one();
      }
      // The stream follows the native size and ignores a canvas.
      continue;
    }
    if (commands[0] != kCommandSettings) {
      disconnect(generation, "unknown command");
      return;
    }
    if (commands.size() < kSettingsCommandBytes) return;
    StreamSettings settings;
    if (!parseSettings(commands.data(), settings)) {
      disconnect(generation, "invalid settings");
      return;
    }
    commands.erase(commands.begin(), commands.begin() + kSettingsCommandBytes);
    chooseCaptureModes();
    if (!state) {
      assignRole(connection, settings);
      // A replaced consumer is gone, and this one may be too if the replace failed.
      if (!find(generation)) return;
      continue;
    }
    {
      std::lock_guard<std::mutex> guard(encodeMutex_);
      state->settings = settings;
      state->settingsChanged = true;
      state->keyRequested = true;
      state->fps = settings.fps;
    }
    state->wake.notify_one();
  }
}

void Agent::flushOutput(Connection& connection) {
  for (;;) {
    const uint8_t* data;
    size_t remaining;
    {
      std::lock_guard<std::mutex> guard(outputMutex_);
      if (connection.output.empty()) return;
      data = connection.output.front().bytes.data() + connection.outputOffset;
      remaining = connection.output.front().bytes.size() - connection.outputOffset;
    }
    ssize_t n = send(connection.fd, data, remaining, kSendFlags);
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return;
      disconnect(connection.generation, "write failed");
      return;
    }
    int requestRole = -1;
    {
      std::lock_guard<std::mutex> guard(outputMutex_);
      connection.outputOffset += size_t(n);
      if (connection.outputOffset == connection.output.front().bytes.size()) {
        connection.outputBytes -= connection.output.front().bytes.size();
        connection.output.pop_front();
        connection.outputOffset = 0;
        int role = connection.role < 0 ? kRoleStream : connection.role;
        if (connection.keyAfterDrain &&
            connection.outputBytes <= kMaxQueuedOutputBytes[role] / 2) {
          connection.keyAfterDrain = false;
          if (connection.role >= 0) requestRole = role;
        }
      }
    }
    if (requestRole >= 0) {
      // Publish under the waiter's mutex after releasing outputMutex_.
      std::lock_guard<std::mutex> guard(encodeMutex_);
      roles_[requestRole].keyNeededByOutput = true;
      roles_[requestRole].wake.notify_one();
    }
  }
}

// @ref LLP 0020#socket-protocol — a replaced consumer learns why it closes
// Tells a consumer that a new one of its role replaces it, so that it does not take the agent
// back at once: two consumers would otherwise replace each other in a loop. Best effort on the
// non-blocking socket: it finishes a partly sent record first, and a consumer that stopped
// reading gets only the close.
void Agent::sendReplaced(Connection& connection) {
  std::vector<uint8_t> bytes;
  {
    std::lock_guard<std::mutex> guard(outputMutex_);
    if (connection.outputOffset > 0 && !connection.output.empty())
      bytes.assign(connection.output.front().bytes.begin() + ptrdiff_t(connection.outputOffset),
                   connection.output.front().bytes.end());
  }
  size_t start = bytes.size();
  bytes.resize(start + kHeaderBytes);
  encodeHeader(bytes.data() + start, 0, 0, kReplaced, 0, 0, 0);
  size_t sent = 0;
  while (sent < bytes.size()) {
    ssize_t n = send(connection.fd, bytes.data() + sent, bytes.size() - sent, kSendFlags);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return;
    sent += size_t(n);
  }
}

void Agent::disconnect(uint64_t generation, const char* reason) {
  std::unique_ptr<Connection> closed;
  {
    std::lock_guard<std::mutex> guard(outputMutex_);
    for (auto it = connections_.begin(); it != connections_.end(); ++it) {
      if ((*it)->generation == generation) {
        closed = std::move(*it);
        connections_.erase(it);
        break;
      }
    }
  }
  if (!closed) return;
  close(closed->fd);
  if (closed->role >= 0) {
    RoleState& state = roles_[closed->role];
    {
      std::lock_guard<std::mutex> guard(encodeMutex_);
      if (state.generation == generation) {
        state.generation = 0;
        state.active = false;
        state.keyRequested = false;
        state.pending.clear();  // Back to the frame source's pool.
      }
    }
    state.wake.notify_one();
  }
  logLine(
      "%s consumer disconnected: %s (posts=%llu captured=%llu busy=%llu locked=%llu errors=%llu "
      "tails=%llu replaced=%llu)",
      closed->role >= 0 ? roleName(closed->role) : "unassigned", reason,
      (unsigned long long)posts_.load(), (unsigned long long)captured_.load(),
      (unsigned long long)droppedBusy_.load(), (unsigned long long)skippedLocked_.load(),
      (unsigned long long)captureErrors_.load(), (unsigned long long)lagTails_.load(),
      (unsigned long long)asyncReplaced_.load());
}

// A session option: the file <socket><suffix> wins over the variable. Both are for
// diagnosis and measurements; without them the agent picks the read itself.
std::string Agent::sessionOption(const char* suffix, const char* variable) const {
  const char* value = getenv(variable);
  std::string option = value ? value : "";
  if (FILE* file = fopen((path_ + suffix).c_str(), "r")) {
    char text[32] = {};
    if (fgets(text, sizeof(text), file)) option = text;
    fclose(file);
  }
  while (!option.empty() && (option.back() == '\n' || option.back() == ' ')) option.pop_back();
  return option;
}

void Agent::chooseCaptureModes() {
  std::string read = sessionOption(".read", "EXPO_EMULATOR_CAPTURE_READ");
  ReadMode mode = read == "post"        ? ReadMode::Post
                  : read == "lag"       ? ReadMode::Lag
                  : read == "lag-async" ? ReadMode::LagAsync
                                        : ReadMode::Auto;
  CaptureOptions options;
  options.probe = sessionOption(".probe", "EXPO_EMULATOR_CAPTURE_PROBE") == "1";
  bool anyActive = false;
  for (const RoleState& role : roles_) anyActive |= role.active.load();
  if (!anyActive || mode != readMode_.load()) {
    // The frame of the post before belongs to an earlier session or read; the next post starts
    // again. A settings change for a running role keeps it, so the other role loses no frame.
    {
      std::lock_guard<std::mutex> postGuard(postMutex_);
      previousHandle_ = 0;
    }
    std::lock_guard<std::mutex> guard(asyncMutex_);
    tailPending_ = false;
  }
  readMode_ = mode;
  frames_->setOptions(options);
  logLine("capture modes: read %s, probe %s", readModeName(mode), options.probe ? "on" : "off");
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
  // initialize() waits for FrameBuffer and resolves dispatch before the hook is installed.
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
  std::thread(expo_capture::runAgent, std::string(socketPath)).detach();
}

// The only exported symbol: lets tools confirm which agent build is loaded.
extern "C" __attribute__((visibility("default"))) const char* expo_emulator_capture_version() {
  return EXPO_EMULATOR_CAPTURE_VERSION;
}
