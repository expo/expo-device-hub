// SPDX-License-Identifier: MIT
#include "../src/native/pbo-borrow.cpp"
#include <cassert>
#include <cstdio>
using namespace expo_capture;
static int colorBuffer, hiddenResult;
static bool glAvailable = true;
static bool hasGl(void*) { return glAvailable; }
static std::unique_ptr<BorrowedImageInfo> descriptor(void*) { return nullptr; }
static std::unique_ptr<BorrowedImageInfo> borrow(void* cb, int api) {
  assert(cb == &colorBuffer && api == 0);
#if defined(__x86_64__)
  GumInvocationContext invocation{{&hiddenResult, cb}};
#else
  GumInvocationContext invocation{{cb, &hiddenResult}};
#endif
  listener.enter(&invocation, nullptr);
  return std::make_unique<BorrowedImageInfoGl>();
}
int main() {
  Gfxstream g;
  g.canUseGlOps = hasGl;
  g.borrowedImageInfo = descriptor;
  g.borrowForDisplay = borrow;
  std::string error;
  assert(preparePboBorrow(g, error));
  void* gl = nullptr;
  auto image = borrowPboGlImage(g, &colorBuffer, gl);
  assert(image && gl == &colorBuffer && gl != &hiddenResult);
  // An unrelated renderer call must not retain the stack destination of our previous borrow.
  gl = nullptr;
  GumInvocationContext unrelated{{nullptr, nullptr}};
  listener.enter(&unrelated, nullptr);
  assert(gl == nullptr);
  glAvailable = false;
  assert(!borrowPboGlImage(g, &colorBuffer, gl));
  assert(!gl);
  puts("PBO borrow observes this rather than the hidden class-result argument and restores thread state");
}
