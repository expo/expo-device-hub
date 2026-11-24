// SPDX-License-Identifier: MIT
// Adapted from PR #107's scale.cu: a GPU-only transform of owned CUDA RGB frames.
#include "nvidia-transform.h"

extern "C" __global__ void transformRgba(const unsigned char* src, unsigned long long srcPitch,
                                        int sw, int sh, unsigned char* dst,
                                        unsigned long long dstPitch, int dw, int dh,
                                        int left, int top, int width, int height, int rotation) {
  int x = int(blockIdx.x * blockDim.x + threadIdx.x);
  int y = int(blockIdx.y * blockDim.y + threadIdx.y);
  if (x >= dw || y >= dh) return;
  unsigned char* out = dst + y * dstPitch + x * 4;
  out[3] = 255;
  if (x < left || y < top || x >= left + width || y >= top + height) {
    out[0] = out[1] = out[2] = 0;
    return;
  }
  auto p = expo_capture::nvidiaSamplePosition(x, y, left, top, width, height, sw, sh, rotation);
  float sx = fminf(fmaxf(p.x, 0.0f), float(sw - 1));
  float sy = fminf(fmaxf(p.y, 0.0f), float(sh - 1));
  int x0 = int(sx), y0 = int(sy);
  int x1 = min(x0 + 1, sw - 1), y1 = min(y0 + 1, sh - 1);
  float fx = sx - x0, fy = sy - y0;
  for (int c = 0; c < 3; c++) {
    float a = src[y0 * srcPitch + x0 * 4 + c];
    float b = src[y0 * srcPitch + x1 * 4 + c];
    float d = src[y1 * srcPitch + x0 * 4 + c];
    float e = src[y1 * srcPitch + x1 * 4 + c];
    out[c] = (unsigned char)((a + (b - a) * fx) * (1.0f - fy) +
                             (d + (e - d) * fx) * fy + 0.5f);
  }
}
