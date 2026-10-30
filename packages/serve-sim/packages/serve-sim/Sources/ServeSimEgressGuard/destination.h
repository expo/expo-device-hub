#pragma once
// Destination semantics from build-tools resources/egress-guard/policy.c.
#include <arpa/inet.h>
#include <netinet/in.h>
#include <string.h>
#include <sys/socket.h>

static int eg_v4_local(uint32_t address) {
#ifdef SERVE_SIM_EGRESS_TEST_REMOTE_LOOPBACK
  if (address == UINT32_C(0x7f000001)) return 0; // deny only the host test peer
#endif
  return (address >> 24) == 127 || address == 0;
}

static int eg_remote(const struct sockaddr *sa, socklen_t size) {
  if (!sa || size < 2) return 0;
  sa_family_t family = sa->sa_family;
  if (family == AF_UNSPEC) {
    if (size == sizeof(struct sockaddr_in)) family = AF_INET;
    if (size == sizeof(struct sockaddr_in6)) family = AF_INET6;
  }
  if (family == AF_INET && size >= sizeof(struct sockaddr_in))
    return !eg_v4_local(ntohl(((const struct sockaddr_in *)sa)->sin_addr.s_addr));
  if (family == AF_INET6) {
    // @ref LLP 0007.000#native-argument-handling — mapped TCP input can omit scope-id bytes and XNU zero-fills them
    struct sockaddr_in6 copied = {0};
    memcpy(&copied, sa, size < sizeof copied ? size : sizeof copied);
    const struct in6_addr *a = &copied.sin6_addr;
    if (size < sizeof copied && !IN6_IS_ADDR_V4MAPPED(a)) return 0;
    if (IN6_IS_ADDR_LOOPBACK(a) || IN6_IS_ADDR_UNSPECIFIED(a)) return 0;
    if (IN6_IS_ADDR_V4MAPPED(a)) { uint32_t v4; memcpy(&v4, &a->s6_addr[12], sizeof v4); return !eg_v4_local(ntohl(v4)); }
    return 1;
  }
  return 0;
}
