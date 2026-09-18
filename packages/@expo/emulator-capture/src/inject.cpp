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
static void onSignal(int) {
    interrupted = 1;
}
using Clock = std::chrono::steady_clock;

struct ReportSocket {
    // The controller owns both descriptors and the private status-socket directory.
    std::string directory, path;
    int listener = -1, client = -1;
    ~ReportSocket() {
        if (client >= 0)
            close(client);
        if (listener >= 0)
            close(listener);
        if (!path.empty())
            unlink(path.c_str());
        if (!directory.empty())
            rmdir(directory.c_str());
    }

    void openFor(pid_t pid) {
        struct stat process{};
        if (stat(("/proc/" + std::to_string(pid)).c_str(), &process) != 0)
            throw std::runtime_error("target process does not exist");
        char pattern[] = "/tmp/gpu-poc-inject-XXXXXX";
        char *result = mkdtemp(pattern);
        if (!result)
            throw std::runtime_error("cannot create report directory");
        directory = result;
        path = directory + "/status.sock";
        listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
        sockaddr_un address{};
        address.sun_family = AF_UNIX;
        std::strcpy(address.sun_path, path.c_str());
        if (listener < 0 ||
            bind(listener, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0 ||
            chmod(path.c_str(), 0600) != 0 || listen(listener, 1) != 0)
            throw std::runtime_error("cannot create report socket");
        // sudo attaches to an expo-owned emulator. Only that uid (and root)
        // should be able to connect to the status channel.
        if (geteuid() == 0 && (chown(path.c_str(), process.st_uid, process.st_gid) != 0 ||
                               chown(directory.c_str(), process.st_uid, process.st_gid) != 0))
            throw std::runtime_error("cannot assign report socket to emulator owner");
    }
};

static double parseNumber(const char *text, double minimum, double maximum) {
    char *end = nullptr;
    double value = std::strtod(text, &end);
    if (end == text || *end || !std::isfinite(value) || value < minimum || value > maximum)
        throw std::runtime_error(std::string("invalid number: ") + text);
    return value;
}
static int parseInteger(const char *text, int minimum, int maximum) {
    double value = parseNumber(text, minimum, maximum);
    if (std::floor(value) != value)
        throw std::runtime_error("expected integer");
    return static_cast<int>(value);
}

int main(int argc, char **argv) {
    if (argc < 2 || std::string(argv[1]) == "--help") {
        std::cout << "Usage: ./inject PID [--seconds 35] [--fps 60] [--frames 1800]\n"
                     "  [--output /absolute/file.h264|unix:/absolute/socket]\n"
                     "  [--library /absolute/libgpu_capture.so] [--count-posts]\n"
                     "Attaches to a running emulator. Restart it before a second capture.\n";
        return argc < 2 ? 1 : 0;
    }
    FridaInjector *injector = nullptr;
    bool fridaInitialized = false;
    int result = 1;
    try {
        // Resolve defaults beside the executable, then validate command-line overrides.
        int pid = parseInteger(argv[1], 1, std::numeric_limits<int>::max());
        int fps = 60, frames = 1800;
        double seconds = 35;
        bool countOnly = false;
        char executable[4096];
        ssize_t length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
        if (length < 0)
            throw std::runtime_error("cannot locate injector executable");
        executable[length] = 0;
        std::string executableDirectory(executable);
        executableDirectory.resize(executableDirectory.rfind('/'));
        std::string library = executableDirectory + "/libgpu_capture.so",
                    output = executableDirectory + "/capture.h264";
        for (int i = 2; i < argc; ++i) {
            std::string flag(argv[i]);
            if (flag == "--count-posts") {
                countOnly = true;
                continue;
            }
            if (++i >= argc)
                throw std::runtime_error("missing value for " + flag);
            if (flag == "--seconds")
                seconds = parseNumber(argv[i], 0.01, 7200);
            else if (flag == "--fps")
                fps = parseInteger(argv[i], 1, 120);
            else if (flag == "--frames")
                frames = parseInteger(argv[i], 1, std::numeric_limits<int>::max());
            else if (flag == "--output")
                output = argv[i];
            else if (flag == "--library")
                library = argv[i];
            else
                throw std::runtime_error("unknown argument: " + flag);
        }
        if (library.empty() || library[0] != '/' || access(library.c_str(), R_OK) != 0)
            throw std::runtime_error("library must be an existing absolute path");
        if (output.empty() || (output[0] != '/' && output.rfind("unix:/", 0) != 0))
            throw std::runtime_error("output must be absolute or unix:/absolute/path");

        // Create the report channel before injecting an agent that will connect to it.
        ReportSocket reportSocket;
        reportSocket.openFor(pid);
        std::signal(SIGINT, onSignal);
        std::signal(SIGTERM, onSignal);
        frida_init();
        fridaInitialized = true;
        GKeyFile *config = g_key_file_new();
        g_key_file_set_string(config, "capture", "report", reportSocket.path.c_str());
        g_key_file_set_string(config, "capture", "output", output.c_str());
        g_key_file_set_integer(config, "capture", "fps", fps);
        g_key_file_set_integer(config, "capture", "frames", frames);
        g_key_file_set_double(config, "capture", "seconds", seconds);
        g_key_file_set_boolean(config, "capture", "count-only", countOnly);
        gchar *data = g_key_file_to_data(config, nullptr, nullptr);
        g_key_file_free(config);

        injector = frida_injector_new();
        GError *error = nullptr;
        guint injectionId = frida_injector_inject_library_file_sync(
            injector, pid, library.c_str(), kAgentEntrypoint, data, nullptr, &error);
        g_free(data);
        if (error) {
            std::string message(error->message);
            g_error_free(error);
            throw std::runtime_error(message);
        }
        std::cout << "INJECTED id=" << injectionId << " pid=" << pid
                  << " (native FridaInjector + Gum)" << std::endl;

        // Readiness has its own deadline; the overall deadline allows shutdown time too.
        auto startupDeadline = Clock::now() + std::chrono::seconds(15);
        auto deadline = Clock::now() + std::chrono::duration<double>(seconds + 30);
        std::string pendingStatusBytes;
        bool agentReady = false, agentDone = false, agentFailed = false, stopRequested = false;
        while (Clock::now() < deadline && !agentDone && !agentFailed) {
            if (!agentReady && Clock::now() > startupDeadline)
                throw std::runtime_error("agent readiness timed out");
            if (reportSocket.client < 0) {
                pollfd fd{reportSocket.listener, POLLIN, 0};
                if (poll(&fd, 1, 100) > 0)
                    reportSocket.client = accept4(reportSocket.listener, nullptr, nullptr,
                                                  SOCK_CLOEXEC | SOCK_NONBLOCK);
                continue;
            }
            if (interrupted && !stopRequested) {
                send(reportSocket.client, "S", 1, MSG_NOSIGNAL);
                stopRequested = true;
                deadline = Clock::now() + std::chrono::seconds(15);
            }
            pollfd fd{reportSocket.client, POLLIN, 0};
            if (poll(&fd, 1, 100) <= 0)
                continue;
            char bytes[2048];
            ssize_t n = recv(reportSocket.client, bytes, sizeof(bytes), 0);
            if (n <= 0) {
                if (n < 0 && (errno == EAGAIN || errno == EINTR))
                    continue;
                break;
            }
            pendingStatusBytes.append(bytes, n);
            if (pendingStatusBytes.size() > 16384)
                throw std::runtime_error("oversized agent status");
            // Newline-delimited status records may span multiple socket reads.
            size_t newline;
            while ((newline = pendingStatusBytes.find('\n')) != std::string::npos) {
                auto line = pendingStatusBytes.substr(0, newline);
                pendingStatusBytes.erase(0, newline + 1);
                std::cout << line << std::endl;
                if (line.rfind("READY ", 0) == 0)
                    agentReady = true;
                if (line.rfind("ERROR ", 0) == 0)
                    agentFailed = true;
                if (line.rfind("DONE ", 0) == 0) {
                    agentDone = true;
                    if (!countOnly && line.find("\"errors\":0") == std::string::npos)
                        agentFailed = true;
                }
            }
        }
        if (!agentReady || !agentDone || agentFailed)
            throw std::runtime_error("native capture failed or ended without completion");
        result = 0;
    } catch (const std::exception &error) {
        std::cerr << "ERROR " << error.what() << std::endl;
    }

    // Close the injector before shutting down Frida, including on failure.
    if (injector) {
        GError *error = nullptr;
        frida_injector_close_sync(injector, nullptr, &error);
        if (error) {
            std::cerr << "ERROR closing injector: " << error->message << std::endl;
            g_error_free(error);
            result = 1;
        }
        g_object_unref(injector);
    }
    if (fridaInitialized)
        frida_deinit();
    return result;
}
