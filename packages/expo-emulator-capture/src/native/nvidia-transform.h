// SPDX-License-Identifier: MIT
#pragma once

#ifdef __CUDACC__
#define EXPO_CAPTURE_HD __host__ __device__
#else
#define EXPO_CAPTURE_HD
#endif

namespace expo_capture {
struct SamplePosition {
  float x, y;
};

// @ref LLP 0021#nvidia-transform — inverse mapping undoes Android's clockwise panel rotation
// Pixel centers in a destination rectangle map to the native panel, before bilinear sampling.
EXPO_CAPTURE_HD inline SamplePosition nvidiaSamplePosition(int x, int y, int left, int top,
                                                          int width, int height, int nativeWidth,
                                                          int nativeHeight, int rotation) {
  float u = (float(x - left) + 0.5f) / float(width);
  float v = (float(y - top) + 0.5f) / float(height);
  float a = u, b = v;
  switch (rotation) {
    case 1: a = 1.0f - v; b = u; break;
    case 2: a = 1.0f - u; b = 1.0f - v; break;
    case 3: a = v; b = 1.0f - u; break;
  }
  return {a * float(nativeWidth) - 0.5f, b * float(nativeHeight) - 0.5f};
}
}  // namespace expo_capture
#undef EXPO_CAPTURE_HD
