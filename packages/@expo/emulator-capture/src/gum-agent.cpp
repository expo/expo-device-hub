// SPDX-License-Identifier: MIT
// Experimental native agent. Loaded into an already-running emulator by
// FridaInjector, with no Frida session, GumJS, Python, or LD_PRELOAD.
#include "frida-gum.h"
#include "agent-abi.h"
#include <atomic>
#include <chrono>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include <sys/socket.h>
#include <sys/un.h>
#include <poll.h>
#include <unistd.h>

extern "C" {
int poc_init(const char *, const char *, int, int);
void poc_frame(void *, unsigned);
void poc_stop();
const char *poc_status();
void poc_audit_originals(void *, void *);
void poc_read_pixels(int, int, int, int, unsigned, unsigned, void *);
void poc_get_tex_image(unsigned, int, unsigned, unsigned, void *);
}

namespace {
using Clock = std::chrono::steady_clock;
std::once_flag gumOnce;
std::mutex agentMutex;
// Capture resources stay resident; the count-only baseline does not consume this attempt.
bool captureAttempted = false;

struct Agent {
    int statusSocket = -1;
    GumModule *backend = nullptr;
    GumInterceptor *interceptor = nullptr;
    GumInvocationListener *listener = nullptr;
    std::vector<gpointer> postHookTargets;
    gpointer readPixels = nullptr, getTexImage = nullptr;
    bool readPixelsHookInstalled = false, getTexImageHookInstalled = false,
         captureInitialized = false;
    bool countOnly = false;
    void *(*getFramebuffer)() = nullptr;

    // Renderer callbacks update timings; the agent thread reads them for status reports.
    std::atomic<uint64_t> postCount{0};
    std::mutex postTimingMutex;
    Clock::time_point firstPostAt{}, lastPostAt{};

    void report(const std::string &line) {
        auto data = line + "\n";
        // Tiny bounded status messages must never block the renderer/agent.
        size_t offset = 0;
        while (offset < data.size()) {
            auto n = send(statusSocket, data.data() + offset, data.size() - offset, MSG_NOSIGNAL);
            if (n <= 0)
                break;
            offset += static_cast<size_t>(n);
        }
    }

    template <class T> T symbol(const char *name) {
        auto address = gum_module_find_export_by_name(backend, name);
        if (!address)
            throw std::runtime_error(std::string("missing renderer symbol: ") + name);
        return reinterpret_cast<T>(address);
    }

    static gboolean collect(const GumExportDetails *item, gpointer user) {
        auto *self = static_cast<Agent *>(user);
        if (item->type == GUM_EXPORT_FUNCTION &&
            g_str_has_prefix(item->name, "_ZN9gfxstream4host11FrameBuffer4Impl8postImplE"))
            self->postHookTargets.push_back(reinterpret_cast<gpointer>(item->address));
        return TRUE;
    }

    static void onEnter(GumInvocationContext *context, gpointer user) {
        auto *self = static_cast<Agent *>(user);
        if (self->countOnly) {
            std::lock_guard<std::mutex> lock(self->postTimingMutex);
            auto now = Clock::now();
            if (self->postCount++ == 0)
                self->firstPostAt = now;
            self->lastPostAt = now;
        } else if (reinterpret_cast<uintptr_t>(
                       gum_invocation_context_get_nth_argument(context, 3)) &
                   255) {
            // Match the experiment: false means the nonrecursive renderer lock
            // may already be held. Never acquire it again on those calls.
            auto handle =
                reinterpret_cast<uintptr_t>(gum_invocation_context_get_nth_argument(context, 1));
            poc_frame(self->getFramebuffer(), static_cast<unsigned>(handle));
        }
    }

    void start(int fps, int frames, const std::string &output) {
        // Resolve renderer hooks before arming capture or publishing callbacks.
        backend = gum_process_find_module_by_name("libgfxstream_backend.so");
        if (!backend)
            throw std::runtime_error(
                "renderer not loaded; wait for Android to boot before attaching");
        gum_module_enumerate_exports(backend, collect, this);
        if (postHookTargets.empty())
            throw std::runtime_error("no supported postImpl export; refusing capture");
        interceptor = gum_interceptor_obtain();
        getFramebuffer =
            symbol<decltype(getFramebuffer)>("_ZN9gfxstream4host11FrameBuffer5getFBEv");
        if (!countOnly) {
            if (captureAttempted)
                throw std::runtime_error(
                    "capture already attempted; restart the emulator before another capture");
            captureAttempted = true;
            if (poc_init(gum_module_get_path(backend), output.c_str(), fps, frames) != 0)
                throw std::runtime_error("native capture initialization failed; see emulator log");
            captureInitialized = true;
        }
        listener = gum_make_call_listener(onEnter, nullptr, this, nullptr);
        // Keep replacements and original trampoline publication in one Gum
        // transaction so render threads cannot call an uninitialized original.
        gum_interceptor_begin_transaction(interceptor);
        try {
            if (!countOnly) {
                auto getGlProcAddress = symbol<void *(*)(const char *)>(
                    "_ZN9gfxstream4host2gl35gles2_dispatch_get_proc_func_staticEPKc");
                readPixels = getGlProcAddress("glReadPixels");
                getTexImage = getGlProcAddress("glGetTexImage");
                if (!readPixels || !getTexImage)
                    throw std::runtime_error("capture audit GL functions missing");
                gpointer originalRead = nullptr, originalGet = nullptr;
                if (gum_interceptor_replace_fast(interceptor, readPixels,
                                                 reinterpret_cast<gpointer>(poc_read_pixels),
                                                 &originalRead, nullptr) != GUM_REPLACE_OK)
                    throw std::runtime_error("could not install glReadPixels audit");
                readPixelsHookInstalled = true;
                if (gum_interceptor_replace_fast(interceptor, getTexImage,
                                                 reinterpret_cast<gpointer>(poc_get_tex_image),
                                                 &originalGet, nullptr) != GUM_REPLACE_OK)
                    throw std::runtime_error("could not install glGetTexImage audit");
                getTexImageHookInstalled = true;
                poc_audit_originals(originalRead, originalGet);
            }
            for (auto target : postHookTargets)
                if (gum_interceptor_attach(interceptor, target, listener, nullptr) != GUM_ATTACH_OK)
                    throw std::runtime_error("could not attach postImpl listener");
        } catch (...) {
            // Roll back before committing partially configured audit hooks.
            gum_interceptor_detach(interceptor, listener);
            if (readPixelsHookInstalled)
                gum_interceptor_revert(interceptor, readPixels);
            if (getTexImageHookInstalled)
                gum_interceptor_revert(interceptor, getTexImage);
            readPixelsHookInstalled = getTexImageHookInstalled = false;
            gum_interceptor_end_transaction(interceptor);
            throw;
        }
        gum_interceptor_end_transaction(interceptor);
        report("READY " + std::string(countOnly ? "count-posts" : "capture") +
               " hooks=" + std::to_string(postHookTargets.size()));
    }

    void stop() {
        // Stop post callbacks first, then capture, then the readback audit hooks.
        if (interceptor && listener) {
            gum_interceptor_detach(interceptor, listener);
            // The stack-owned listener data must outlive all in-flight calls.
            while (!gum_interceptor_flush(interceptor))
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        if (captureInitialized) {
            poc_stop();
            captureInitialized = false;
        }
        if (interceptor) {
            if (readPixelsHookInstalled)
                gum_interceptor_revert(interceptor, readPixels);
            if (getTexImageHookInstalled)
                gum_interceptor_revert(interceptor, getTexImage);
            while (!gum_interceptor_flush(interceptor))
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        if (listener)
            g_object_unref(listener);
        if (interceptor)
            g_object_unref(interceptor);
        if (backend)
            g_object_unref(backend);
        listener = nullptr;
        interceptor = nullptr;
        backend = nullptr;
        readPixelsHookInstalled = getTexImageHookInstalled = false;
    }

    std::string status() {
        if (!countOnly)
            return poc_status();
        std::lock_guard<std::mutex> lock(postTimingMutex);
        double elapsed =
            std::chrono::duration<double, std::milli>(lastPostAt - firstPostAt).count();
        return "{\"count\":" + std::to_string(postCount.load()) +
               ",\"elapsedMs\":" + std::to_string(elapsed) + ",\"fps\":" +
               std::to_string(elapsed > 0 ? (postCount.load() - 1) * 1000.0 / elapsed : 0) + "}";
    }
};
} // namespace

extern "C" __attribute__((visibility("default"))) void poc_agent_main(const char *data,
                                                                      int *unloadPolicy, void *) {
    // Capture pools and Gum stay mapped until emulator exit, as in the old PoC.
    *unloadPolicy = kResidentUnloadPolicy;
    // The devkit's bundled GLib requires Gum initialization even before a
    // GKeyFile is created. Parsing first crashes in GLib's uninitialized state.
    std::call_once(gumOnce, [] { gum_init_embedded(); });
    Agent agent;
    std::unique_lock<std::mutex> lock(agentMutex, std::defer_lock);
    GKeyFile *config = g_key_file_new();
    try {
        GError *error = nullptr;
        if (!g_key_file_load_from_data(config, data, -1, G_KEY_FILE_NONE, &error)) {
            std::string message = error->message;
            g_error_free(error);
            throw std::runtime_error(message);
        }
        auto getString = [&](const char *key) {
            gchar *value = g_key_file_get_string(config, "capture", key, nullptr);
            if (!value)
                throw std::runtime_error(std::string("missing agent setting: ") + key);
            std::string result(value);
            g_free(value);
            return result;
        };
        auto statusSocketPath = getString("report");
        auto output = getString("output");
        int fps = g_key_file_get_integer(config, "capture", "fps", nullptr);
        int frames = g_key_file_get_integer(config, "capture", "frames", nullptr);
        double seconds = g_key_file_get_double(config, "capture", "seconds", nullptr);
        agent.countOnly = g_key_file_get_boolean(config, "capture", "count-only", nullptr);

        // Connect before validation/startup so the controller sees those failures.
        sockaddr_un address{};
        address.sun_family = AF_UNIX;
        if (statusSocketPath.size() >= sizeof(address.sun_path))
            throw std::runtime_error("report path too long");
        std::strcpy(address.sun_path, statusSocketPath.c_str());
        agent.statusSocket = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
        if (agent.statusSocket < 0 ||
            connect(agent.statusSocket, reinterpret_cast<sockaddr *>(&address), sizeof(address)) !=
                0)
            throw std::runtime_error("cannot connect to injector status socket");
        timeval timeout{1, 0};
        setsockopt(agent.statusSocket, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
        if (!(seconds > 0 && seconds <= 7200) || fps < 1 || fps > 120 || frames < 1)
            throw std::runtime_error("invalid capture bounds");
        if (!lock.try_lock())
            throw std::runtime_error("an injected agent is already active");

        agent.start(fps, frames, output);
        auto deadline = Clock::now() + std::chrono::duration<double>(seconds);
        auto nextStatusAt = Clock::now();
        // Sending a byte or closing the status channel asks this agent to stop.
        while (Clock::now() < deadline) {
            pollfd fd{agent.statusSocket, POLLIN, 0};
            if (poll(&fd, 1, 100) > 0 && fd.revents)
                break; // stop command or controller disconnected
            if (Clock::now() >= nextStatusAt) {
                agent.report("STATUS " + agent.status());
                nextStatusAt = Clock::now() + std::chrono::seconds(5);
            }
        }
        agent.stop();
        agent.report("DONE " + agent.status());
    } catch (const std::exception &error) {
        agent.stop();
        agent.report("ERROR " + std::string(error.what()));
        fprintf(stderr, "[gpu-poc] Gum agent error: %s\n", error.what());
    }
    g_key_file_free(config);
    if (agent.statusSocket >= 0)
        close(agent.statusSocket);
}
