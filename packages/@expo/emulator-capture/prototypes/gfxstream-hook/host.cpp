// SPDX-License-Identifier: MIT
// Disposable native host for the real upstream gfxstream renderer.
#include "frame_buffer.h"
#include "gfxstream/host/features.h"
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include <unistd.h>

int main(int argc, char** argv) {
    using namespace gfxstream::host;
    using Clock = std::chrono::steady_clock;
    try {
        int seconds = 15;
        if (argc == 3 && std::string(argv[1]) == "--seconds") seconds = std::stoi(argv[2]);
        else if (argc != 1) throw std::runtime_error("Usage: gfxstream-demo-host [--seconds 15]");
        if (seconds < 1 || seconds > 120) throw std::runtime_error("seconds must be 1..120");

        constexpr int width = 64, height = 64;
        constexpr auto format = GfxstreamFormat::R8G8B8A8_UNORM;
        FeatureSet features{};
        features.Vulkan.setEnabled(false);
        features.GuestVulkanOnly.setEnabled(false);
        // Use native GLES shader syntax through Mesa EGL; desktop GL translation
        // would additionally require the optional ANGLE shader parser.
        features.EglOnEgl.setEnabled(true);
        setenv("ANDROID_EMU_HEADLESS", "1", 1); // Upstream renderer's headless switch.
        if (!FrameBuffer::initialize(width, height, features, false))
            throw std::runtime_error("standalone gfxstream initialization failed");
        auto* framebuffer = FrameBuffer::getFB();
        const auto color = framebuffer->createColorBuffer(width, height, format);
        if (!color) throw std::runtime_error("gfxstream color-buffer creation failed");
        if (framebuffer->openColorBuffer(color)) throw std::runtime_error("cannot retain color buffer");

        std::vector<unsigned char> pixels(width * height * 4);
        for (size_t i = 0; i < pixels.size(); i += 4) {
            pixels[i] = 64; pixels[i + 1] = 128; pixels[i + 2] = 192; pixels[i + 3] = 255;
        }
        if (!framebuffer->updateColorBuffer(color, 0, 0, width, height, format, pixels.data()))
            throw std::runtime_error("gfxstream pixel upload failed");
        std::vector<unsigned char> readback(pixels.size());
        framebuffer->readColorBuffer(color, 0, 0, width, height, format, readback.data(), readback.size());
        if (readback != pixels) throw std::runtime_error("gfxstream pixel round-trip mismatch");
        std::cout << "HOST_READY pid=" << getpid() << " colorBuffer=" << color
                  << " size=64x64 pixel_roundtrip=true" << std::endl;

        unsigned posts = 0;
        const auto deadline = Clock::now() + std::chrono::seconds(seconds);
        while (Clock::now() < deadline) {
            for (size_t i = 0; i < pixels.size(); i += 4) pixels[i] = posts % 256;
            if (!framebuffer->updateColorBuffer(color, 0, 0, width, height, format, pixels.data()) ||
                !framebuffer->post(color))
                throw std::runtime_error("gfxstream update/post failed");
            ++posts;
            if (posts % 10 == 0) std::cout << "HOST_POSTS " << posts << std::endl;
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        framebuffer->closeColorBuffer(color);
        FrameBuffer::finalize();
        std::cout << "HOST_DONE posts=" << posts << std::endl;
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "HOST_ERROR " << error.what() << std::endl;
        return 1;
    }
}
