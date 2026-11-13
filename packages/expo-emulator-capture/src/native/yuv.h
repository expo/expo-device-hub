// SPDX-License-Identifier: MIT
// RGBA to I420 conversion with bilinear scaling, and turns of the I420 planes, for the
// software encoder.
// Portable C++; the Linux agent uses it and the native tests run it on any host.
#pragma once
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

namespace expo_capture {

// Destination planes. Width and height are even; chroma is half size each way.
struct I420Planes {
  uint8_t* y = nullptr;
  uint8_t* u = nullptr;
  uint8_t* v = nullptr;
  int yStride = 0;
  int uvStride = 0;
  int width = 0;
  int height = 0;
};

// BT.709 limited range (Y 16-235, Cb and Cr 16-240) from 8-bit sRGB values, as
// x256 fixed-point coefficients from Kr = 0.2126 and Kb = 0.0722. The pixels are
// not linearized, as is usual for video. The offsets keep each sum non-negative.
inline uint8_t lumaBt709(int r, int g, int b) {
  return uint8_t(((47 * r + 157 * g + 16 * b + 128) >> 8) + 16);
}
// Chroma from the sums of four pixels' components.
inline uint8_t cbBt709(int r4, int g4, int b4) {
  return uint8_t((-26 * r4 - 86 * g4 + 112 * b4 + (128 << 10) + 512) >> 10);
}
inline uint8_t crBt709(int r4, int g4, int b4) {
  return uint8_t((112 * r4 - 102 * g4 - 10 * b4 + (128 << 10) + 512) >> 10);
}

// Converts two RGBA rows of `width` (even) pixels into two luma rows and one row
// of each chroma plane.
inline void convertRowPair(const uint8_t* top, const uint8_t* bottom, int width, uint8_t* y0,
                           uint8_t* y1, uint8_t* u, uint8_t* v) {
  for (int x = 0; x < width; x += 2) {
    const uint8_t* a = top + x * 4;
    const uint8_t* b = a + 4;
    const uint8_t* c = bottom + x * 4;
    const uint8_t* d = c + 4;
    y0[x] = lumaBt709(a[0], a[1], a[2]);
    y0[x + 1] = lumaBt709(b[0], b[1], b[2]);
    y1[x] = lumaBt709(c[0], c[1], c[2]);
    y1[x + 1] = lumaBt709(d[0], d[1], d[2]);
    int r4 = a[0] + b[0] + c[0] + d[0];
    int g4 = a[1] + b[1] + c[1] + d[1];
    int b4 = a[2] + b[2] + c[2] + d[2];
    u[x / 2] = cbBt709(r4, g4, b4);
    v[x / 2] = crBt709(r4, g4, b4);
  }
}

// One output pixel of a turn: the source pixel that lands at (x, y). Rotation N turns the
// picture N quarter turns counter-clockwise, so rotations 1 and 3 swap the edges.
template <int Rotation>
inline void rotatePlaneTile(const uint8_t* source, int width, int height, size_t sourceStride,
                            uint8_t* destination, size_t destinationStride, int x0, int y0,
                            int x1, int y1) {
  for (int y = y0; y < y1; y++) {
    uint8_t* row = destination + size_t(y) * destinationStride;
    for (int x = x0; x < x1; x++) {
      int sx = Rotation == 1 ? width - 1 - y : Rotation == 2 ? width - 1 - x : y;
      int sy = Rotation == 1 ? x : Rotation == 2 ? height - 1 - y : height - 1 - x;
      row[x] = source[size_t(sy) * sourceStride + size_t(sx)];
    }
  }
}

// Turns one 8-bit plane of width x height for Android's display rotation (0 to 3). In square
// tiles, so that the column reads of a quarter turn stay in the cache.
inline void rotatePlane(const uint8_t* source, int width, int height, size_t sourceStride,
                        int rotation, uint8_t* destination, size_t destinationStride) {
  int outWidth = rotation % 2 ? height : width;
  int outHeight = rotation % 2 ? width : height;
  if (rotation == 0) {
    for (int y = 0; y < height; y++)
      std::memcpy(destination + size_t(y) * destinationStride, source + size_t(y) * sourceStride,
                  size_t(width));
    return;
  }
  constexpr int kTile = 32;
  for (int y0 = 0; y0 < outHeight; y0 += kTile) {
    int y1 = std::min(y0 + kTile, outHeight);
    for (int x0 = 0; x0 < outWidth; x0 += kTile) {
      int x1 = std::min(x0 + kTile, outWidth);
      if (rotation == 1)
        rotatePlaneTile<1>(source, width, height, sourceStride, destination, destinationStride,
                           x0, y0, x1, y1);
      else if (rotation == 2)
        rotatePlaneTile<2>(source, width, height, sourceStride, destination, destinationStride,
                           x0, y0, x1, y1);
      else
        rotatePlaneTile<3>(source, width, height, sourceStride, destination, destinationStride,
                           x0, y0, x1, y1);
    }
  }
}

// @ref LLP 0021#rotation — turned after scaling, on the smaller I420 planes
// Turns I420 planes upright for Android's display rotation N: N quarter turns
// counter-clockwise, because at rotation N the panel holds the picture N quarter turns
// clockwise. `out` is in.height x in.width for rotations 1 and 3.
inline void rotateI420(const I420Planes& in, int rotation, const I420Planes& out) {
  rotatePlane(in.y, in.width, in.height, size_t(in.yStride), rotation, out.y,
              size_t(out.yStride));
  rotatePlane(in.u, in.width / 2, in.height / 2, size_t(in.uvStride), rotation, out.u,
              size_t(out.uvStride));
  rotatePlane(in.v, in.width / 2, in.height / 2, size_t(in.uvStride), rotation, out.v,
              size_t(out.uvStride));
}

// Scales RGBA to the planes' size with bilinear sampling and converts it. Equal
// sizes skip the scaling. `scratch` holds two scaled rows between calls.
class RgbaToI420 {
 public:
  void convert(const uint8_t* rgba, int sourceWidth, int sourceHeight, size_t sourceStride,
               const I420Planes& out) {
    if (sourceWidth == out.width && sourceHeight == out.height) {
      for (int row = 0; row < out.height; row += 2) {
        const uint8_t* top = rgba + size_t(row) * sourceStride;
        convertRowPair(top, top + sourceStride, out.width, out.y + size_t(row) * out.yStride,
                       out.y + size_t(row + 1) * out.yStride,
                       out.u + size_t(row / 2) * out.uvStride,
                       out.v + size_t(row / 2) * out.uvStride);
      }
      return;
    }
    prepare(sourceWidth, out.width);
    rows_.resize(size_t(out.width) * 8);
    uint8_t* scaledTop = rows_.data();
    uint8_t* scaledBottom = scaledTop + size_t(out.width) * 4;
    for (int row = 0; row < out.height; row += 2) {
      scaleRow(rgba, sourceHeight, sourceStride, row, out.height, scaledTop);
      scaleRow(rgba, sourceHeight, sourceStride, row + 1, out.height, scaledBottom);
      convertRowPair(scaledTop, scaledBottom, out.width, out.y + size_t(row) * out.yStride,
                     out.y + size_t(row + 1) * out.yStride,
                     out.u + size_t(row / 2) * out.uvStride,
                     out.v + size_t(row / 2) * out.uvStride);
    }
  }

 private:
  // Source position of a destination sample, in 1/256 pixels, with pixel centers
  // aligned and the edges clamped.
  static void position(int index, int sourceSize, int size, int& first, int& weight) {
    int64_t fixed = (int64_t(2 * index + 1) * sourceSize * 256) / (2 * int64_t(size)) - 128;
    fixed = std::max<int64_t>(0, std::min<int64_t>(fixed, int64_t(sourceSize - 1) * 256));
    first = int(fixed >> 8);
    weight = int(fixed & 255);
    if (first >= sourceSize - 1) {
      first = sourceSize - 1;
      weight = 0;
    }
  }

  void prepare(int sourceWidth, int width) {
    if (sourceWidth == preparedSourceWidth_ && width == preparedWidth_) return;
    columns_.resize(size_t(width));
    weights_.resize(size_t(width));
    for (int x = 0; x < width; x++) position(x, sourceWidth, width, columns_[x], weights_[x]);
    preparedSourceWidth_ = sourceWidth;
    preparedWidth_ = width;
  }

  void scaleRow(const uint8_t* rgba, int sourceHeight, size_t stride, int row, int height,
                uint8_t* out) {
    int first, fy;
    position(row, sourceHeight, height, first, fy);
    const uint8_t* top = rgba + size_t(first) * stride;
    const uint8_t* bottom = fy ? top + stride : top;
    for (size_t x = 0; x < columns_.size(); x++) {
      int fx = weights_[x];
      const uint8_t* a = top + size_t(columns_[x]) * 4;
      const uint8_t* c = bottom + size_t(columns_[x]) * 4;
      const uint8_t* b = fx ? a + 4 : a;
      const uint8_t* d = fx ? c + 4 : c;
      for (int channel = 0; channel < 4; channel++) {
        int upper = a[channel] * (256 - fx) + b[channel] * fx;
        int lower = c[channel] * (256 - fx) + d[channel] * fx;
        out[x * 4 + channel] = uint8_t((upper * (256 - fy) + lower * fy + 32768) >> 16);
      }
    }
  }

  std::vector<int> columns_, weights_;
  std::vector<uint8_t> rows_;
  int preparedSourceWidth_ = 0, preparedWidth_ = 0;
};

}  // namespace expo_capture
