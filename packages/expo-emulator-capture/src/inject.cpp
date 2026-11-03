// SPDX-License-Identifier: MIT
// Experimental native controller. Core supplies injection only; the target
// library uses Gum directly. No DeviceManager/Session/Script/GumJS API.
#include "frida-core.h"
#include "agent-abi.h"
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstring>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <poll.h>
#include <unistd.h>

static volatile sig_atomic_t interrupted = 0;
static void onSignal(int) { interrupted = 1; }
using Clock = std::chrono::steady_clock;

struct ReportSocket {
    std::string directory, path;
    int listener = -1, client = -1;
    ~ReportSocket() {
        if (client >= 0) close(client);
        if (listener >= 0) close(listener);
        if (!path.empty()) unlink(path.c_str());
        if (!directory.empty()) rmdir(directory.c_str());
    }
    void openFor(pid_t pid) {
        struct stat process{};
        if (stat(("/proc/" + std::to_string(pid)).c_str(), &process) != 0)
            throw std::runtime_error("target process does not exist");
        char pattern[] = "/tmp/gpu-poc-inject-XXXXXX";
        char* result = mkdtemp(pattern);
        if (!result) throw std::runtime_error("cannot create report directory");
        directory = result; path = directory + "/status.sock";
        listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
        sockaddr_un address{}; address.sun_family = AF_UNIX;
        std::strcpy(address.sun_path, path.c_str());
        if (listener < 0 || bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0 ||
            chmod(path.c_str(), 0600) != 0 || listen(listener, 1) != 0)
            throw std::runtime_error("cannot create report socket");
        // sudo attaches to an expo-owned emulator. Only that uid (and root)
        // should be able to connect to the status channel.
        if (geteuid() == 0 &&
            (chown(path.c_str(), process.st_uid, process.st_gid) != 0 ||
             chown(directory.c_str(), process.st_uid, process.st_gid) != 0))
            throw std::runtime_error("cannot assign report socket to emulator owner");
    }
};

static double number(const char* text, double minimum, double maximum) {
    char* end = nullptr; double value = std::strtod(text, &end);
    if (end == text || *end || !std::isfinite(value) || value < minimum || value > maximum)
        throw std::runtime_error(std::string("invalid number: ") + text);
    return value;
}
static int integer(const char* text, int minimum, int maximum) {
    double value = number(text, minimum, maximum);
    if (std::floor(value) != value) throw std::runtime_error("expected integer");
    return static_cast<int>(value);
}

int main(int argc, char** argv) {
    if (argc < 2 || std::string(argv[1]) == "--help") {
        std::cout << "Usage: ./inject PID [--seconds 35] [--fps 60] [--frames 1800]\n"
                     "  [--output /absolute/file.h264|unix:/absolute/socket]\n"
                     "  [--library /absolute/libgpu_capture.so] [--count-posts]\n"
                     "Attaches to a running emulator. Restart it before a second capture.\n";
        return argc < 2 ? 1 : 0;
    }
    FridaInjector* injector = nullptr;
    bool initialized = false;
    int result = 1;
    try {
        int pid = integer(argv[1], 1, std::numeric_limits<int>::max());
        int fps = 60, frames = 1800; double seconds = 35;
        bool countOnly = false;
        char executable[4096];
        ssize_t length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
        if (length < 0) throw std::runtime_error("cannot locate injector executable");
        executable[length] = 0;
        std::string base(executable); base.resize(base.rfind('/'));
        std::string library = base + "/libgpu_capture.so", output = base + "/capture.h264";
        for (int i = 2; i < argc; ++i) {
            std::string flag(argv[i]);
            if (flag == "--count-posts") { countOnly = true; continue; }
            if (++i >= argc) throw std::runtime_error("missing value for " + flag);
            if (flag == "--seconds") seconds = number(argv[i], 0.01, 7200);
            else if (flag == "--fps") fps = integer(argv[i], 1, 120);
            else if (flag == "--frames") frames = integer(argv[i], 1, std::numeric_limits<int>::max());
            else if (flag == "--output") output = argv[i];
            else if (flag == "--library") library = argv[i];
            else throw std::runtime_error("unknown argument: " + flag);
        }
        if (library.empty() || library[0] != '/' || access(library.c_str(), R_OK) != 0)
            throw std::runtime_error("library must be an existing absolute path");
        if (output.empty() || (output[0] != '/' && output.rfind("unix:/", 0) != 0))
            throw std::runtime_error("output must be absolute or unix:/absolute/path");
        ReportSocket report; report.openFor(pid);
        std::signal(SIGINT, onSignal); std::signal(SIGTERM, onSignal);
        frida_init(); initialized = true;
        GKeyFile* config = g_key_file_new();
        g_key_file_set_string(config, "capture", "report", report.path.c_str());
        g_key_file_set_string(config, "capture", "output", output.c_str());
        g_key_file_set_integer(config, "capture", "fps", fps);
        g_key_file_set_integer(config, "capture", "frames", frames);
        g_key_file_set_double(config, "capture", "seconds", seconds);
        g_key_file_set_boolean(config, "capture", "count-only", countOnly);
        gchar* data = g_key_file_to_data(config, nullptr, nullptr);
        g_key_file_free(config);
        injector = frida_injector_new();
        GError* error = nullptr;
        guint id = frida_injector_inject_library_file_sync(injector, pid, library.c_str(), kAgentEntrypoint, data, nullptr, &error);
        g_free(data);
        if (error) {
            std::string message(error->message); g_error_free(error); throw std::runtime_error(message);
        }
        std::cout << "INJECTED id=" << id << " pid=" << pid << " (native FridaInjector + Gum)" << std::endl;
        auto startupDeadline = Clock::now() + std::chrono::seconds(15);
        auto deadline = Clock::now() + std::chrono::duration<double>(seconds + 30);
        std::string pending; bool ready = false, done = false, failed = false, sentStop = false;
        while (Clock::now() < deadline && !done && !failed) {
            if (!ready && Clock::now() > startupDeadline) throw std::runtime_error("agent readiness timed out");
            if (report.client < 0) {
                pollfd fd{report.listener, POLLIN, 0};
                if (poll(&fd, 1, 100) > 0) report.client = accept4(report.listener, nullptr, nullptr, SOCK_CLOEXEC | SOCK_NONBLOCK);
                continue;
            }
            if (interrupted && !sentStop) {
                send(report.client, "S", 1, MSG_NOSIGNAL); sentStop = true;
                deadline = Clock::now() + std::chrono::seconds(15);
            }
            pollfd fd{report.client, POLLIN, 0};
            if (poll(&fd, 1, 100) <= 0) continue;
            char bytes[2048]; ssize_t n = recv(report.client, bytes, sizeof(bytes), 0);
            if (n <= 0) {
                if (n < 0 && (errno == EAGAIN || errno == EINTR)) continue;
                break;
            }
            pending.append(bytes, n);
            if (pending.size() > 16384) throw std::runtime_error("oversized agent status");
            size_t newline;
            while ((newline = pending.find('\n')) != std::string::npos) {
                auto line = pending.substr(0, newline); pending.erase(0, newline + 1);
                std::cout << line << std::endl;
                if (line.rfind("READY ", 0) == 0) ready = true;
                if (line.rfind("ERROR ", 0) == 0) failed = true;
                if (line.rfind("DONE ", 0) == 0) {
                    done = true;
                    if (!countOnly && line.find("\"errors\":0") == std::string::npos) failed = true;
                }
            }
        }
        if (!ready || !done || failed) throw std::runtime_error("native capture failed or ended without completion");
        result = 0;
    } catch (const std::exception& error) {
        std::cerr << "ERROR " << error.what() << std::endl;
    }
    if (injector) {
        GError* error = nullptr;
        frida_injector_close_sync(injector, nullptr, &error);
        if (error) { std::cerr << "ERROR closing injector: " << error->message << std::endl; g_error_free(error); result = 1; }
        g_object_unref(injector);
    }
    if (initialized) frida_deinit();
    return result;
}
