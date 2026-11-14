#include "../src/native/callback.h"
#include "../src/native/socket-input.h"
#include <cassert>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <new>
#include <string>
#include <unistd.h>

static std::string logged;
namespace expo_capture {
void logLine(const char* format, ...) noexcept {
  char message[512];
  va_list args;
  va_start(args, format);
  vsnprintf(message, sizeof(message), format, args);
  va_end(args);
  logged = message;
}
}  // namespace expo_capture

int main() {
  using namespace expo_capture;
  bool called = false;
  guardCallback("success", [&] { called = true; });
  assert(called && logged.empty());
  guardCallback("allocation", [] { throw std::bad_alloc(); });
  assert(logged.find("allocation:") == 0);
  guardCallback("foreign", [] { throw 42; });
  assert(logged == "foreign: unknown exception");

  int sockets[2];
  assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
  assert(fcntl(sockets[1], F_SETFL, O_NONBLOCK) == 0);
  std::vector<uint8_t> pending;
  // A peer leaves far more data readable than one poll is allowed to consume.
  uint8_t flood[4096];
  memset(flood, 'K', sizeof(flood));
  assert(write(sockets[0], flood, sizeof(flood)) == ssize_t(sizeof(flood)));
  assert(readCommandBatch(sockets[1], pending) == 256);
  assert(pending.size() == 256);
  // Forgetting to parse a batch cannot grow the receive buffer without a bound.
  bool rejected = false;
  try { readCommandBatch(sockets[1], pending); } catch (...) { rejected = true; }
  assert(rejected && pending.size() == 256);
  pending.clear();
  while (readCommandBatch(sockets[1], pending) > 0) pending.clear();
  // A partial command is preserved when the rest arrives in another batch.
  pending = {'S', 0, 0};
  assert(write(sockets[0], "\0\0", 2) == 2);
  assert(readCommandBatch(sockets[1], pending) == 2);
  assert(pending.size() == 5 && pending[0] == 'S');
  close(sockets[0]);
  pending.clear();
  assert(readCommandBatch(sockets[1], pending) == 0);
  close(sockets[1]);
  puts("native callback and bounded socket input checks passed");
}
