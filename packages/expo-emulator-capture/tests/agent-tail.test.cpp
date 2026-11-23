// Compile with -fno-access-control to exercise the real agent's post/queue boundary.
// The renderer and driver are absent: only FrameSource is replaced with a fake.
#include "../src/native/agent.cpp"
#include <cassert>

void* gum_invocation_context_get_nth_argument(GumInvocationContext*, unsigned) { return nullptr; }
void gum_init_embedded() {}
GumModule* gum_process_find_module_by_name(const char*) { return nullptr; }
GumInterceptor* gum_interceptor_obtain() { return nullptr; }
GumInvocationListener* gum_make_call_listener(GumInvocationCallback, GumInvocationCallback,
                                             gpointer, gpointer) { return nullptr; }
int gum_interceptor_attach(GumInterceptor*, void*, GumInvocationListener*, gpointer) { return -1; }

namespace expo_capture {
std::string resolveGfxstream(GumModule*, Gfxstream&) { return "no renderer in this test"; }
uint32_t lastPostedHandle(const Gfxstream&) { return 0; }
std::unique_ptr<FrameSource> createFrameSource(const Gfxstream&) { return nullptr; }
std::unique_ptr<H264Encoder> createH264Encoder(H264Encoder::Sink, H264Encoder::ErrorSink) {
  return nullptr;
}
std::string h264EncoderProblem() { return "no encoder in this test"; }
}

class FakeSource final : public expo_capture::FrameSource {
 public:
  bool capture(uint32_t handle, expo_capture::CapturedFrame& out, std::string& error) override {
    handles.push_back(handle);
    if (failNext) {
      failNext = false;
      error = "injected capture failure";
      return false;
    }
    out.width = int(handle);
    out.height = 100;
    out.path = expo_capture::FramePath::Gpu;
    return true;
  }
  bool gpuUnavailable() const override { return false; }
  std::vector<uint32_t> handles;
  bool failNext = false;
};

int main() {
  using namespace expo_capture;
  Agent capture;
  auto source = std::make_unique<FakeSource>();
  auto* reads = source.get();
  capture.frames_ = std::move(source);
  capture.readMode_ = ReadMode::Post;
  capture.roles_[0].active = true;
  capture.roles_[0].fps = 60;
  capture.roles_[1].active = true;
  capture.roles_[1].fps = 30;
  capture.onPost(1, true);
  assert(reads->handles == std::vector<uint32_t>{1});
  assert(capture.roles_[0].pending.size() == 1);
  assert(capture.roles_[1].pending.size() == 1);
  // Both roles have just used their budget. The final update arrives before
  // either deadline, and the display then becomes still.
  for (auto& role : capture.roles_) role.pacer.nextUs = double(capture.clockUs() + 1'000'000);
  capture.onPost(2, true);
  assert(reads->handles.size() == 1);
  assert(capture.tail_.pending() && "a paced-out final post must schedule a tail read");
  auto final = capture.tail_.takeIfDue(int64_t(capture.clockUs()) + LagTail::delayUs);
  assert(final && final->handle == 2);
  int64_t budgetAt = int64_t(capture.roles_[1].pacer.nextUs);
  capture.captureTail(*final, final->postUs + LagTail::delayUs);
  assert(reads->handles.size() == 1 && capture.tail_.pending());
  auto due = capture.tail_.takeIfDue(budgetAt);
  assert(due && due->handle == 2);
  capture.captureTail(*due, budgetAt);
  assert((reads->handles == std::vector<uint32_t>{1, 2}));
  assert(capture.roles_[0].pending.back().frame.width == 2);
  assert(capture.roles_[1].pending.back().frame.width == 2);

  // An accepted post must not be sent twice when its idle deadline expires.
  for (auto& role : capture.roles_) {
    role.pending.clear();
    role.pacer.nextUs = 0;
  }
  capture.onPost(3, true);
  auto accepted = capture.tail_.takeIfDue(int64_t(capture.clockUs()) + LagTail::delayUs);
  assert(accepted);
  size_t copies = reads->handles.size();
  capture.captureTail(*accepted, accepted->postUs + LagTail::delayUs);
  assert(reads->handles.size() == copies && !capture.tail_.pending());
  for (auto& role : capture.roles_) assert(role.pending.size() == 1);

  // Only the slower role needs the tail; the stream must not get a duplicate.
  for (auto& role : capture.roles_) role.pending.clear();
  capture.roles_[0].pacer.nextUs = 0;
  capture.roles_[1].pacer.nextUs = double(capture.clockUs() + 1'000'000);
  budgetAt = int64_t(capture.roles_[1].pacer.nextUs);
  capture.onPost(4, true);
  auto mixed = capture.tail_.takeIfDue(int64_t(capture.clockUs()) + LagTail::delayUs);
  assert(mixed);
  copies = reads->handles.size();
  capture.captureTail(*mixed, mixed->postUs + LagTail::delayUs);
  assert(reads->handles.size() == copies);
  assert(capture.roles_[0].pending.size() == 1 && capture.roles_[1].pending.empty());
  due = capture.tail_.takeIfDue(budgetAt);
  assert(due);
  capture.captureTail(*due, budgetAt);
  assert(reads->handles.size() == copies + 1);
  for (auto& role : capture.roles_) {
    assert(role.pending.size() == 1 && role.pending.back().frame.width == 4);
    role.pending.clear();
    role.pacer.nextUs = 0;
  }

  // A failed immediate copy remains eligible; success, not reservation, marks
  // the post served. Its tail also replaces a full old queue with the final image.
  reads->failNext = true;
  capture.onPost(5, true);
  auto failed = capture.tail_.takeIfDue(int64_t(capture.clockUs()) + LagTail::delayUs);
  assert(failed);
  for (auto& role : capture.roles_) role.pending.resize(kMaxPendingFrames);
  capture.captureTail(*failed, failed->postUs + LagTail::delayUs);
  for (auto& role : capture.roles_) {
    assert(role.pending.size() == kMaxPendingFrames);
    assert(role.pending.back().frame.width == 5);
    role.pending.clear();
    role.pacer.nextUs = 0;
  }
  // A post skipped because another post owns the render-hook mutex still
  // publishes its final handle, without waiting on that mutex in the hook.
  {
    std::lock_guard<std::mutex> postGuard(capture.postMutex_);
    std::thread busyPost([&] { capture.onPost(6, true); });
    busyPost.join();
  }
  auto busy = capture.tail_.takeIfDue(int64_t(capture.clockUs()) + LagTail::delayUs);
  assert(busy && busy->handle == 6);
  capture.captureTail(*busy, busy->postUs + LagTail::delayUs);
  for (auto& role : capture.roles_) assert(role.pending.back().frame.width == 6);
  puts("real agent post/tail pacing, role deduplication, failure and full-queue checks passed");
}
