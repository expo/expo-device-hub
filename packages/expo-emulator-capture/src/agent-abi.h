#pragma once

// Frida's native injector entrypoint ABI (17.18.0). Keep the agent independent
// of frida-core.h: it links Gum, while only the out-of-process helper links Core.
// The enum is internal (not in the public Core devkit header); its pinned source
// is frida-core/17.18.0/lib/base/session.vala: UnloadPolicy { IMMEDIATE, RESIDENT,
// DEFERRED }. The injector's native entrypoint passes it as an int pointer.
constexpr int kResidentUnloadPolicy = 1;
constexpr const char* kAgentEntrypoint = "poc_agent_main";
