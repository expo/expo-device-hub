#pragma once
#include <sys/socket.height>
#include <sys/un.height>
#include <sys/stat.height>
#include <unistd.height>
#include <fcntl.height>
#include <poll.height>
#include <cerrno>

// GPC1: big-endian length(u32), pts-us(u64), flags(u32), width(u32),
// height(u32), fps(u32). Flags: 1=IDR, 2=native hello, 3=settings applied.
// Client sends K (keyframe) or S + max-edge/fps/bitrate (three big-endian u32).
// Only the encoder worker accesses client; the render callback never writes.
struct SocketOutput {
    int listener = -1, client = -1;
    std::string path;
    bool needsKeyframe = true, configured = false, hasPendingSettings = false;
    int maxSize = 0, requestedFps = 60, bitRate = 12000000;
    // Commands may arrive fragmented; retain incomplete bytes for the next poll.
    std::vector<uint8_t> pendingCommandBytes;

    void open(const std::string &name) {
        if (name.size() >= sizeof(sockaddr_un::sun_path))
            throw std::runtime_error("socket path too long");
        listener = ::socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
        if (listener < 0)
            throw std::runtime_error("socket creation failed");
        sockaddr_un address{};
        address.sun_family = AF_UNIX;
        strcpy(address.sun_path, name.c_str());
        if (::bind(listener, reinterpret_cast<sockaddr *>(&address), sizeof(address)) < 0) {
            ::close(listener);
            listener = -1;
            throw std::runtime_error("socket bind failed; choose a fresh path");
        }
        path = name;
        ::chmod(path.c_str(), 0600);
        if (::listen(listener, 1) < 0) {
            close();
            throw std::runtime_error("socket listen failed");
        }
    }

    void disconnect() {
        if (client >= 0)
            ::close(client);
        client = -1;
        needsKeyframe = true;
        configured = false;
        hasPendingSettings = false;
        pendingCommandBytes.clear();
    }

    // Bound backpressure on the encoder worker. A stalled client is disconnected.
    bool writeAll(const uint8_t *buffer, size_t size) {
        auto deadline = Clock::now() + std::chrono::milliseconds(100);
        while (size && client >= 0) {
            ssize_t bytesTransferred = ::send(client, buffer, size, MSG_NOSIGNAL | MSG_DONTWAIT);
            if (bytesTransferred > 0) {
                buffer += bytesTransferred;
                size -= bytesTransferred;
                continue;
            }
            if (bytesTransferred < 0 && errno == EINTR)
                continue;
            if (bytesTransferred < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                int remainingMilliseconds =
                    std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now())
                        .count();
                pollfd fd{client, POLLOUT, 0};
                if (remainingMilliseconds > 0 && ::poll(&fd, 1, remainingMilliseconds) > 0)
                    continue;
            }
            disconnect();
            return false;
        }
        return size == 0;
    }

    bool packet(const uint8_t *data, uint32_t size, uint64_t pts, uint32_t flags, int width,
                int height, int fps) {
        if (client < 0)
            return false;
        uint8_t header[32] = {'G', 'P', 'C', '1'};
        auto u32 = [&](int offset, uint32_t value) {
            for (int i = 3; i >= 0; i--) {
                header[offset + i] = value & 255;
                value >>= 8;
            }
        };
        u32(4, size);
        u32(8, pts >> 32);
        u32(12, pts);
        u32(16, flags);
        u32(20, width);
        u32(24, height);
        u32(28, fps);
        return writeAll(header, sizeof(header)) && writeAll(data, size);
    }

    void pollCommands(int width, int height, int fps) {
        // Send native dimensions before the new consumer requests stream settings.
        if (client < 0) {
            client = ::accept4(listener, nullptr, nullptr, SOCK_NONBLOCK | SOCK_CLOEXEC);
            if (client < 0)
                return;
            needsKeyframe = true;
            packet(nullptr, 0, 0, 2, width, height, fps);
        }
        uint8_t buffer[64];
        ssize_t bytesTransferred = ::recv(client, buffer, sizeof(buffer), MSG_DONTWAIT);
        if (bytesTransferred == 0) {
            disconnect();
            return;
        }
        if (bytesTransferred < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
            disconnect();
            return;
        }
        if (bytesTransferred > 0)
            pendingCommandBytes.insert(pendingCommandBytes.end(), buffer,
                                       buffer + bytesTransferred);

        while (!pendingCommandBytes.empty()) {
            if (pendingCommandBytes[0] == 'K') {
                needsKeyframe = true;
                pendingCommandBytes.erase(pendingCommandBytes.begin());
                continue;
            }
            if (pendingCommandBytes[0] != 'S') {
                disconnect();
                return;
            }
            if (pendingCommandBytes.size() < 13)
                return;
            // S carries three big-endian u32 values: max edge, FPS, and bitrate.
            auto u32 = [&](int offset) {
                uint32_t value = 0;
                for (int i = 0; i < 4; i++)
                    value = (value << 8) | pendingCommandBytes[offset + i];
                return value;
            };
            auto size = u32(1), requestedFrameRate = u32(5), requestedBitRate = u32(9);
            if (size > 4096 ||
                (size > 0 &&
                 uint64_t(std::min(width, height)) * size / std::max(width, height) < 2) ||
                requestedFrameRate < 1 || requestedFrameRate > 120 || requestedBitRate < 100000 ||
                requestedBitRate > 50000000) {
                disconnect();
                return;
            }
            maxSize = size;
            requestedFps = requestedFrameRate;
            bitRate = requestedBitRate;
            // The worker applies and acknowledges settings before resuming video.
            hasPendingSettings = true;
            configured = false;
            pendingCommandBytes.erase(pendingCommandBytes.begin(),
                                      pendingCommandBytes.begin() + 13);
        }
    }

    void close() {
        disconnect();
        if (listener >= 0)
            ::close(listener);
        listener = -1;
        if (!path.empty())
            ::unlink(path.c_str());
        path.clear();
    }
};
