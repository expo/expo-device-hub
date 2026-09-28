import sys
p = sys.argv[1]; s = open(p).read()
anchor = "  rtc::SetSctpSettings(settings);"
add = """  // Exposed for the simstream spike: SCTP retransmission timers and burst limits.
  if (config.Get("maxBurst").IsNumber())
    settings.maxBurst = config.Get("maxBurst").As<Napi::Number>().Uint32Value();
  if (config.Get("minRetransmitTimeout").IsNumber())
    settings.minRetransmitTimeout =
        std::chrono::milliseconds(config.Get("minRetransmitTimeout").As<Napi::Number>().Uint32Value());
  if (config.Get("maxRetransmitTimeout").IsNumber())
    settings.maxRetransmitTimeout =
        std::chrono::milliseconds(config.Get("maxRetransmitTimeout").As<Napi::Number>().Uint32Value());
  if (config.Get("initialRetransmitTimeout").IsNumber())
    settings.initialRetransmitTimeout =
        std::chrono::milliseconds(config.Get("initialRetransmitTimeout").As<Napi::Number>().Uint32Value());
  if (config.Get("maxRetransmitAttempts").IsNumber())
    settings.maxRetransmitAttempts = config.Get("maxRetransmitAttempts").As<Napi::Number>().Uint32Value();
  if (config.Get("heartbeatInterval").IsNumber())
    settings.heartbeatInterval =
        std::chrono::milliseconds(config.Get("heartbeatInterval").As<Napi::Number>().Uint32Value());

"""
if "minRetransmitTimeout" not in s:
    s = s.replace(anchor, add + anchor)
open(p, 'w').write(s)
print("patched")
