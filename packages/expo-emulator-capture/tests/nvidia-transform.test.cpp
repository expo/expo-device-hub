// Portable coordinate checks only. This does not execute a CUDA kernel or NVENC.
#include "../src/native/nvidia-transform.h"
#include "../src/native/protocol.h"
#include <cassert>
#include <cmath>
#include <iostream>
#include <vector>

// Execute the kernel's scalar body as C++ to check addressing, borders and sampling on a CPU.
// CUDA launch compilation and GPU execution remain separate staging/CI requirements.
struct Index { unsigned x = 0, y = 0; };
static Index blockIdx, blockDim, threadIdx;
using std::min;
#define __global__
#include "../src/native/nvidia-transform.cu"
#undef __global__

int main() {
  using namespace expo_capture;
  // A uniquely numbered 6x4 panel: the inverse mapping must undo each clockwise turn.
  for (int rotation = 0; rotation < 4; rotation++) {
    auto size = uprightSize(6, 4, rotation);
    for (int y = 0; y < size.second; y++) for (int x = 0; x < size.first; x++) {
      auto p = nvidiaSamplePosition(x, y, 0, 0, size.first, size.second, 6, 4, rotation);
      int expectedX = x, expectedY = y;
      if (rotation == 1) { expectedX = 5 - y; expectedY = x; }
      if (rotation == 2) { expectedX = 5 - x; expectedY = 3 - y; }
      if (rotation == 3) { expectedX = y; expectedY = 3 - x; }
      assert(std::abs(p.x - expectedX) < 0.0001f);
      assert(std::abs(p.y - expectedY) < 0.0001f);
    }
  }
  // Native-size fold panels keep their own dimensions, centered on one fixed canvas.
  for (auto panel : {std::make_pair(2076, 2152), std::make_pair(1080, 2424)}) {
    Rect rect = placeOnCanvas(panel.first, panel.second, 2076, 2424);
    auto first = nvidiaSamplePosition(rect.x, rect.y, rect.x, rect.y, rect.width, rect.height,
                                      panel.first, panel.second, 0);
    auto last = nvidiaSamplePosition(rect.x + rect.width - 1, rect.y + rect.height - 1,
                                     rect.x, rect.y, rect.width, rect.height,
                                     panel.first, panel.second, 0);
    assert(std::abs(first.x) < 0.0001f && std::abs(first.y) < 0.0001f);
    assert(std::abs(last.x - (panel.first - 1)) < 0.001f);
    assert(std::abs(last.y - (panel.second - 1)) < 0.001f);
  }
  // Bilinear center mapping at half size: each output pixel sits between four inputs.
  auto p = nvidiaSamplePosition(0, 0, 0, 0, 3, 2, 6, 4, 0);
  assert(p.x == 0.5f && p.y == 0.5f);

  // Non-contiguous pitches, four channel-distinct corners, and a centered rectangle.
  // Repaint on a previously filled canvas: borders must overwrite old panel pixels.
  std::vector<unsigned char> source(3 * 12, 231), output(5 * 24, 99);
  const unsigned char colors[4][3] = {{0, 0, 0}, {80, 40, 20}, {40, 80, 120}, {120, 120, 140}};
  for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++)
    for (int c = 0; c < 3; c++) source[y * 12 + x * 4 + c] = colors[y * 2 + x][c];
  for (unsigned y = 0; y < 4; y++) for (unsigned x = 0; x < 4; x++) {
    threadIdx = {x, y};
    transformRgba(source.data(), 12, 2, 2, output.data(), 24, 4, 4, 1, 1, 2, 2, 0);
  }
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
    auto* pixel = output.data() + y * 24 + x * 4;
    bool inside = x >= 1 && x < 3 && y >= 1 && y < 3;
    for (int c = 0; c < 3; c++)
      assert(pixel[c] == (inside ? colors[(y - 1) * 2 + x - 1][c] : 0));
    assert(pixel[3] == 255);
  }
  // Padding is not image data and must stay untouched.
  for (int y = 0; y < 4; y++) for (int x = 16; x < 24; x++) assert(output[y * 24 + x] == 99);
  threadIdx = {0, 0};
  transformRgba(source.data(), 12, 2, 2, output.data(), 24, 1, 1, 0, 0, 1, 1, 0);
  assert(output[0] == 60 && output[1] == 60 && output[2] == 70);
  std::cout << "NVIDIA transform coordinate checks passed (no GPU execution)\n";
}
