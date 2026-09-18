// SPDX-License-Identifier: MIT
// Prototype: count real gfxstream postImpl calls without capture or GPU APIs.
#include "frida-gum.h"
#include "../../src/agent-abi.h"
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

namespace {
using Clock = std::chrono::steady_clock;
std::once_flag gumOnce;
std::mutex sessionMutex;
constexpr const char* postPrefix = "_ZN9gfxstream4host11FrameBuffer4Impl8postImplE";

std::string jsonString(const std::string& value) {
    std::string result = "\"";
    for (unsigned char byte : value) {
        if (byte == '\"' || byte == '\\') {
            result += '\\';
            result += static_cast<char>(byte);
        } else if (byte < 0x20) {
            char escaped[7];
            std::snprintf(escaped, sizeof(escaped), "\\u%04x", static_cast<unsigned>(byte));
            result += escaped;
        } else {
            result += static_cast<char>(byte);
        }
    }
    return result + "\"";
}

struct HookAgent {
    int channel = -1;
    GumModule* module = nullptr;
    GumInterceptor* interceptor = nullptr;
    GumInvocationListener* listener = nullptr;
    std::vector<gpointer> targets;
    std::string modulePath;
    std::atomic<uint64_t> count{0};
    Clock::time_point started{};

    ~HookAgent() {
        stop();
        if (channel >= 0) close(channel);
    }

    void report(const std::string& line) {
        const auto message = line + "\n";
        size_t offset = 0;
        while (offset < message.size()) {
            auto sent = send(channel, message.data() + offset, message.size() - offset, MSG_NOSIGNAL);
            if (sent < 0 && errno == EINTR) continue;
            if (sent <= 0) return;
            offset += static_cast<size_t>(sent);
        }
    }

    void connectReport(const std::string& path) {
        sockaddr_un address{};
        address.sun_family = AF_UNIX;
        if (path.empty() || path.size() >= sizeof(address.sun_path))
            throw std::runtime_error("invalid injector report socket path");
        std::memcpy(address.sun_path, path.c_str(), path.size() + 1);
        channel = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
        if (channel < 0 || connect(channel, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0)
            throw std::runtime_error("cannot connect to injector report socket");
        timeval timeout{1, 0};
        setsockopt(channel, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    }

    static gboolean collect(const GumExportDetails* item, gpointer user) {
        auto* self = static_cast<HookAgent*>(user);
        if (item->type == GUM_EXPORT_FUNCTION && g_str_has_prefix(item->name, postPrefix)) {
            auto address = reinterpret_cast<gpointer>(item->address);
            if (std::find(self->targets.begin(), self->targets.end(), address) == self->targets.end())
                self->targets.push_back(address);
        }
        return TRUE;
    }

    static void onEnter(GumInvocationContext*, gpointer user) {
        static_cast<HookAgent*>(user)->count.fetch_add(1, std::memory_order_relaxed);
    }

    void start() {
        module = gum_process_find_module_by_name("libgfxstream_backend.so");
        if (!module) throw std::runtime_error("libgfxstream_backend.so is not loaded");
        modulePath = gum_module_get_path(module);
        gum_module_enumerate_exports(module, collect, this);
        if (targets.empty()) throw std::runtime_error("no gfxstream FrameBuffer::Impl::postImpl export found");
        interceptor = gum_interceptor_obtain();
        listener = gum_make_call_listener(onEnter, nullptr, this, nullptr);
        started = Clock::now();
        gum_interceptor_begin_transaction(interceptor);
        bool attached = true;
        for (auto target : targets) {
            if (gum_interceptor_attach(interceptor, target, listener, nullptr) != GUM_ATTACH_OK) {
                attached = false;
                break;
            }
        }
        if (!attached) gum_interceptor_detach(interceptor, listener);
        gum_interceptor_end_transaction(interceptor);
        if (!attached) throw std::runtime_error("could not attach the postImpl listener");
        report("READY gfxstream-hook " + status());
    }

    void stop() {
        if (interceptor && listener) {
            gum_interceptor_detach(interceptor, listener);
            // Listener callbacks must finish before their stack-owned data dies.
            while (!gum_interceptor_flush(interceptor))
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        if (listener) g_object_unref(listener);
        if (interceptor) g_object_unref(interceptor);
        if (module) g_object_unref(module);
        listener = nullptr;
        interceptor = nullptr;
        module = nullptr;
    }

    std::string status() const {
        const auto elapsed = std::chrono::duration<double, std::milli>(Clock::now() - started).count();
        return "{\"count\":" + std::to_string(count.load(std::memory_order_relaxed)) +
            ",\"elapsedMs\":" + std::to_string(elapsed) +
            ",\"hooks\":" + std::to_string(targets.size()) +
            ",\"module\":" + jsonString(modulePath) + ",\"errors\":0}";
    }
};
}

extern "C" __attribute__((visibility("default")))
void poc_agent_main(const char* data, int* unloadPolicy, void*) {
    *unloadPolicy = kResidentUnloadPolicy;
    std::call_once(gumOnce, [] { gum_init_embedded(); });
    HookAgent agent;
    std::unique_lock<std::mutex> lock(sessionMutex, std::defer_lock);
    GKeyFile* config = g_key_file_new();
    try {
        GError* error = nullptr;
        if (!data || !g_key_file_load_from_data(config, data, -1, G_KEY_FILE_NONE, &error)) {
            std::string reason = error ? error->message : "missing injector settings";
            if (error) g_error_free(error);
            throw std::runtime_error(reason);
        }
        gchar* reportPath = g_key_file_get_string(config, "capture", "report", nullptr);
        if (!reportPath) throw std::runtime_error("missing injector report socket");
        std::string path(reportPath);
        g_free(reportPath);
        agent.connectReport(path);
        const double seconds = g_key_file_get_double(config, "capture", "seconds", nullptr);
        if (!std::isfinite(seconds) || seconds <= 0 || seconds > 7200)
            throw std::runtime_error("invalid hook duration");
        if (!lock.try_lock()) throw std::runtime_error("a prototype hook is already active");
        agent.start();
        const auto deadline = Clock::now() + std::chrono::duration<double>(seconds);
        auto nextStatus = Clock::now();
        while (Clock::now() < deadline) {
            pollfd descriptor{agent.channel, POLLIN, 0};
            const int result = poll(&descriptor, 1, 100);
            if (result > 0 && descriptor.revents) break;
            if (result < 0 && errno != EINTR) throw std::runtime_error("report socket poll failed");
            if (Clock::now() >= nextStatus) {
                agent.report("STATUS " + agent.status());
                nextStatus = Clock::now() + std::chrono::seconds(1);
            }
        }
        agent.stop();
        agent.report("DONE " + agent.status());
    } catch (const std::exception& error) {
        agent.stop();
        agent.report("ERROR " + jsonString(error.what()));
        std::fprintf(stderr, "[gfxstream-hook] %s\n", error.what());
    }
    g_key_file_free(config);
}
