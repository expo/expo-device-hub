---
"expo-device-hub": minor
"@expo/hub-client": minor
---

With `--experimental-emulator-capture`, the Hub attaches the capture agent to an emulator that started without it, such as one from Android Studio, when you open that emulator: with lldb on macOS, where macOS can ask for your password, and with gdb on Linux, where `kernel.yama.ptrace_scope` must allow it. The stream source select offers the capture for such emulators, with a note, and says why an attach failed; selecting the capture tries again. `@expo/hub-client` reads the new `modeNotes` field of the stream source status.
