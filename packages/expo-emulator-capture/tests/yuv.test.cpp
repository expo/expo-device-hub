#include "../src/native/yuv.h"
#include <cassert>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <iostream>

using namespace expo_capture;

struct Image {
  std::vector<uint8_t> rgba;
  int width, height;
  Image(int w, int h) : rgba(size_t(w) * h * 4), width(w), height(h) {}
  uint8_t* at(int x, int y) { return rgba.data() + (size_t(y) * width + x) * 4; }
  void fill(uint8_t r, uint8_t g, uint8_t b) {
    for (int y = 0; y < height; y++)
      for (int x = 0; x < width; x++) {
        uint8_t* p = at(x, y);
        p[0] = r, p[1] = g, p[2] = b, p[3] = 255;
      }
  }
};

struct Yuv {
  std::vector<uint8_t> data;
  I420Planes planes;
  Yuv(int w, int h) : data(size_t(w) * h * 3 / 2) {
    planes.y = data.data();
    planes.u = planes.y + size_t(w) * h;
    planes.v = planes.u + size_t(w / 2) * (h / 2);
    planes.yStride = w;
    planes.uvStride = w / 2;
    planes.width = w;
    planes.height = h;
  }
  bool uniform(int y, int u, int v) const {
    for (int row = 0; row < planes.height; row++)
      for (int col = 0; col < planes.width; col++)
        if (planes.y[row * planes.yStride + col] != y) return false;
    for (int row = 0; row < planes.height / 2; row++)
      for (int col = 0; col < planes.width / 2; col++)
        if (planes.u[row * planes.uvStride + col] != u ||
            planes.v[row * planes.uvStride + col] != v)
          return false;
    return true;
  }
};

// BT.709 limited range from the defining equations, in doubles.
static void reference(int r, int g, int b, double& y, double& u, double& v) {
  double rf = r / 255.0, gf = g / 255.0, bf = b / 255.0;
  double luma = 0.2126 * rf + 0.7152 * gf + 0.0722 * bf;
  y = 16 + 219 * luma;
  u = 128 + 224 * (bf - luma) / 1.8556;
  v = 128 + 224 * (rf - luma) / 1.5748;
}

static void colors() {
  // Each converted value is within one code value of the reference.
  RgbaToI420 converter;
  for (int r : {0, 64, 128, 200, 255})
    for (int g : {0, 64, 128, 200, 255})
      for (int b : {0, 64, 128, 200, 255}) {
        Image image(4, 4);
        image.fill(uint8_t(r), uint8_t(g), uint8_t(b));
        Yuv yuv(4, 4);
        converter.convert(image.rgba.data(), 4, 4, 16, yuv.planes);
        double y, u, v;
        reference(r, g, b, y, u, v);
        int gotY = yuv.planes.y[0], gotU = yuv.planes.u[0], gotV = yuv.planes.v[0];
        if (std::abs(gotY - y) > 1 || std::abs(gotU - u) > 1 || std::abs(gotV - v) > 1 ||
            !yuv.uniform(gotY, gotU, gotV)) {
          std::cerr << "RGB " << r << "," << g << "," << b << " gave " << gotY << "," << gotU
                    << "," << gotV << "; reference " << y << "," << u << "," << v << "\n";
          std::exit(1);
        }
      }
  // The neutral extremes are exact.
  Image black(2, 2), white(2, 2);
  black.fill(0, 0, 0);
  white.fill(255, 255, 255);
  Yuv yuv(2, 2);
  converter.convert(black.rgba.data(), 2, 2, 8, yuv.planes);
  assert(yuv.uniform(16, 128, 128));
  converter.convert(white.rgba.data(), 2, 2, 8, yuv.planes);
  assert(yuv.uniform(235, 128, 128));
}

static void scaling() {
  // A uniform image stays uniform at any size, including odd source sizes.
  RgbaToI420 converter;
  for (auto size : {std::pair{1080, 2424}, std::pair{2076, 2152}, std::pair{1081, 2423}}) {
    Image image(size.first, size.second);
    image.fill(200, 100, 50);
    Yuv expected(2, 2);
    Image tile(2, 2);
    tile.fill(200, 100, 50);
    converter.convert(tile.rgba.data(), 2, 2, 8, expected.planes);
    for (auto target : {std::pair{570, 1280}, std::pair{1234, 1280}, std::pair{1080, 2424}}) {
      Yuv yuv(target.first, target.second);
      converter.convert(image.rgba.data(), image.width, image.height, size_t(image.width) * 4,
                        yuv.planes);
      assert(yuv.uniform(expected.planes.y[0], expected.planes.u[0], expected.planes.v[0]));
    }
  }
  // Rows keep their order: a top half of white and a bottom half of black.
  Image image(64, 128);
  image.fill(0, 0, 0);
  for (int y = 0; y < 64; y++)
    for (int x = 0; x < 64; x++) {
      uint8_t* p = image.at(x, y);
      p[0] = p[1] = p[2] = 255;
    }
  Yuv yuv(32, 64);
  converter.convert(image.rgba.data(), 64, 128, 64 * 4, yuv.planes);
  assert(yuv.planes.y[0] == 235);
  assert(yuv.planes.y[63 * 32 + 31] == 16);
  // A horizontal ramp stays monotonic after scaling.
  Image ramp(256, 4);
  for (int y = 0; y < 4; y++)
    for (int x = 0; x < 256; x++) {
      uint8_t* p = ramp.at(x, y);
      p[0] = p[1] = p[2] = uint8_t(x), p[3] = 255;
    }
  Yuv scaled(100, 2);
  converter.convert(ramp.rgba.data(), 256, 4, 256 * 4, scaled.planes);
  for (int x = 1; x < 100; x++) assert(scaled.planes.y[x] >= scaled.planes.y[x - 1]);
  assert(scaled.planes.y[0] <= 18 && scaled.planes.y[99] >= 233);
}

// A plane as Android's panel holds it at display rotation N: the upright picture turned N
// quarter turns clockwise. Pixel by pixel, without tiles.
static std::vector<uint8_t> turnClockwise(const std::vector<uint8_t>& upright, int width,
                                          int height, int quarterTurns, int& outWidth,
                                          int& outHeight) {
  std::vector<uint8_t> plane = upright;
  outWidth = width;
  outHeight = height;
  for (int turn = 0; turn < quarterTurns; turn++) {
    std::vector<uint8_t> next(plane.size());
    // Clockwise: (x, y) moves to (h - 1 - y, x) in a plane of h x w.
    for (int y = 0; y < outHeight; y++)
      for (int x = 0; x < outWidth; x++)
        next[size_t(x) * outHeight + (outHeight - 1 - y)] = plane[size_t(y) * outWidth + x];
    plane.swap(next);
    std::swap(outWidth, outHeight);
  }
  return plane;
}

static void rotation() {
  // A 3 x 2 plane, turned upright from each panel rotation:
  //   1 2 3
  //   4 5 6
  const std::vector<uint8_t> upright = {1, 2, 3, 4, 5, 6};
  for (int rotation = 0; rotation < 4; rotation++) {
    int panelWidth, panelHeight;
    std::vector<uint8_t> panel = turnClockwise(upright, 3, 2, rotation, panelWidth, panelHeight);
    std::vector<uint8_t> out(6, 0);
    rotatePlane(panel.data(), panelWidth, panelHeight, size_t(panelWidth), rotation, out.data(),
                3);
    assert(out == upright);
  }
  // At rotation 1 the panel holds the picture one quarter turn clockwise:
  //   4 1
  //   5 2
  //   6 3
  {
    int panelWidth, panelHeight;
    std::vector<uint8_t> panel = turnClockwise(upright, 3, 2, 1, panelWidth, panelHeight);
    assert(panelWidth == 2 && panelHeight == 3);
    assert((panel == std::vector<uint8_t>{4, 1, 5, 2, 6, 3}));
  }
  // Sizes that are not a multiple of the tile, with row padding on both sides.
  for (auto size : {std::pair{70, 45}, std::pair{33, 97}, std::pair{1, 64}}) {
    int width = size.first, height = size.second;
    std::vector<uint8_t> picture(size_t(width) * height);
    for (size_t index = 0; index < picture.size(); index++) picture[index] = uint8_t(index * 7 + 3);
    for (int rotation = 0; rotation < 4; rotation++) {
      int panelWidth, panelHeight;
      std::vector<uint8_t> panel =
          turnClockwise(picture, width, height, rotation, panelWidth, panelHeight);
      const size_t sourceStride = size_t(panelWidth) + 5, outStride = size_t(width) + 3;
      std::vector<uint8_t> padded(sourceStride * panelHeight, 0xEE);
      for (int y = 0; y < panelHeight; y++)
        std::memcpy(padded.data() + size_t(y) * sourceStride,
                    panel.data() + size_t(y) * panelWidth, size_t(panelWidth));
      std::vector<uint8_t> out(outStride * height, 0xAA);
      rotatePlane(padded.data(), panelWidth, panelHeight, sourceStride, rotation, out.data(),
                  outStride);
      for (int y = 0; y < height; y++) {
        assert(std::memcmp(out.data() + size_t(y) * outStride,
                           picture.data() + size_t(y) * width, size_t(width)) == 0);
        // The padding of each output row is untouched.
        for (size_t x = size_t(width); x < outStride; x++)
          assert(out[size_t(y) * outStride + x] == 0xAA);
      }
    }
  }
  // I420: an upright 64 x 32 picture with a white 16 x 16 block at the top left. The panel
  // holds it turned for each rotation; scaling and turning bring it back upright.
  Image picture(64, 32);
  picture.fill(0, 0, 0);
  for (int y = 0; y < 16; y++)
    for (int x = 0; x < 16; x++) {
      uint8_t* p = picture.at(x, y);
      p[0] = p[1] = p[2] = 255;
    }
  RgbaToI420 converter;
  for (int rotation = 0; rotation < 4; rotation++) {
    // The panel's RGBA, turned clockwise as Android draws it.
    Image panel(rotation % 2 ? 32 : 64, rotation % 2 ? 64 : 32);
    for (int y = 0; y < 32; y++)
      for (int x = 0; x < 64; x++) {
        int px = x, py = y, w = 64, h = 32;
        for (int turn = 0; turn < rotation; turn++) {
          int nx = h - 1 - py, ny = px;
          px = nx, py = ny;
          std::swap(w, h);
        }
        std::memcpy(panel.at(px, py), picture.at(x, y), 4);
      }
    // Scale to half size in the panel's orientation, then turn: the encoder's order.
    Yuv scaled(panel.width / 2, panel.height / 2);
    converter.convert(panel.rgba.data(), panel.width, panel.height, size_t(panel.width) * 4,
                      scaled.planes);
    Yuv upright(32, 16);
    rotateI420(scaled.planes, rotation, upright.planes);
    // The white block covers the top-left 8 x 8 luma samples and 4 x 4 chroma samples.
    for (int y = 0; y < 16; y++)
      for (int x = 0; x < 32; x++) {
        bool white = x < 8 && y < 8;
        int luma = upright.planes.y[y * upright.planes.yStride + x];
        if (white ? luma != 235 : luma != 16) {
          std::cerr << "rotation " << rotation << ": luma " << luma << " at " << x << "," << y
                    << "\n";
          std::exit(1);
        }
      }
    for (int y = 0; y < 8; y++)
      for (int x = 0; x < 16; x++) {
        assert(upright.planes.u[y * upright.planes.uvStride + x] == 128);
        assert(upright.planes.v[y * upright.planes.uvStride + x] == 128);
      }
  }
}

// The recording places each frame on a fixed canvas: black borders, the picture inside.
static void letterbox() {
  Yuv canvas(8, 8);
  fillI420(canvas.planes, 16, 128);
  assert(canvas.uniform(16, 128, 128));
  struct {
    int x, y, width, height;
  } rect{2, 4, 4, 2};
  Image white(4, 2);
  white.fill(255, 255, 255);
  RgbaToI420 converter;
  converter.convert(white.rgba.data(), 4, 2, 16, subPlanes(canvas.planes, rect));
  for (int y = 0; y < 8; y++)
    for (int x = 0; x < 8; x++) {
      bool inside = x >= 2 && x < 6 && y >= 4 && y < 6;
      assert(canvas.planes.y[y * canvas.planes.yStride + x] == (inside ? 235 : 16));
    }
  for (int y = 0; y < 4; y++)
    for (int x = 0; x < 4; x++) {
      assert(canvas.planes.u[y * canvas.planes.uvStride + x] == 128);
      assert(canvas.planes.v[y * canvas.planes.uvStride + x] == 128);
    }
}

int main() {
  colors();
  scaling();
  rotation();
  letterbox();
  std::cout << "RGBA to I420 conversion, scaling and rotation checks passed\n";
}
