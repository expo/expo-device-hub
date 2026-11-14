# LLP 0024: Hub emulator GPU mode on Apple silicon

**Type:** Decision
**Status:** Draft
**Systems:** Hub, HubComponents, AndroidUtils
**Author:** Claude Code (Claude Opus 5.5), directed by Krystof Woldrich
**Date:** 2026-11-13
**Revised:** 2026-11-13 (the warning moved to the status pill; the Rendering row moved to Stream options; a chevron replaced the info icon); 2026-11-14 (discard partial sysctl output on timeout, signal, spawn or buffer failure), by Codex (gpt-6.1-sol), directed by Krystof Woldrich
**Related:** LLP 0000

## Summary

The Hub boots Android emulators with `-gpu host` on an Apple silicon Mac that is not a virtual machine, and with `-gpu auto` everywhere else. On that same host, the stream's status pill warns when the selected emulator renders on the CPU. On every host, Stream options shows whether an Android device renders on the CPU or the GPU.

> **Provenance.** Claude Code wrote this draft while it implemented the change. `[observed]` claims give their source. `[confirmed]` claims name a human and a date. `[inferred]` claims are guesses that a maintainer must confirm or delete, so this document stays `Draft`. File paths are relative to `packages/`.

## Direction

- The Hub warns when an emulator does not render on the GPU although GPU rendering should be available. For now, the warning is only for a Mac with Apple silicon that is not a virtual machine, and it recommends a restart with GPU rendering [confirmed] (Krystof Woldrich, 2026-11-13).
- The warning is on the stream's status pill, not in Device options. The Live status takes the warning colors and a chevron, and opens a non-modal popover with fixed text that does not name the renderer. Krystof Woldrich based this on the Carbon status indicator pattern, WCAG 2.2 SC 1.4.1 (Use of Color), and the NN/g heuristic "visibility of system status" [confirmed] (Krystof Woldrich, 2026-11-13). A first version put a warning box with the renderer's name in Device options.
- Stream options always has a neutral `Rendering` row for an Android device, emulator or physical, on every host, so the rows do not move. It starts as `Unknown` and then shows `CPU` or `GPU`. iOS has no such row [confirmed] (Krystof Woldrich, 2026-11-13). An earlier version showed the row in Device options, and only where the warning could apply.
- On the same hosts, the Hub boots emulators with `-gpu host`, because it most likely works there [confirmed] (Krystof Woldrich, 2026-11-13).
- The emulator's output gives no good way to tell whether `-gpu host` will work. That is why the decision uses host detection, not the emulator's output [confirmed] (Krystof Woldrich, 2026-11-13).

## Background

- The Hub first booted with `-gpu host` (`4b62857a`, 2026-07-09), with the note that `auto` gave low frame rates with `-no-window`. On 2026-08-27, `c05ba1ff` changed the boot to `-gpu auto`, "Let the emulator choose the GPU backend that best matches the host" [observed: git history of `@expo/hub-android-utils/src/emulator.ts`]. The commit does not say why.
- The likely reason is that `-gpu host` stops the emulator on a host without a usable GPU, such as a headless worker or a virtual machine. https://github.com/expo/expo-device-hub/pull/12 (a draft from 2026-08-12) says that headless workers without a usable hardware GPU fail with `-gpu host`, and `c05ba1ff` also added `expo-device-hub/.env.eas-simulator` for EAS simulator sessions [inferred].
- Without a window, `-gpu auto` picks a software renderer on Apple silicon. The emulator log of a Mac mini M2 (emulator 37.2.7) shows `gles_mode_selected:swangle` with `vulkan_mode_selected:lavapipe`, and the adapter "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device …))". With `-gpu host`, the adapter is "Android Emulator OpenGL ES Translator (Apple M2)" [observed: emulator logs of an agent test, 2026-11-04; LLP 0020 in https://github.com/expo/expo-device-hub/pull/570 reports the same modes]. https://github.com/expo/expo-device-hub/pull/174 reports the same on an Apple M4: SwiftShader without flags, and Apple M4 with `-gpu host` [observed: the PR's evidence table].
- `EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS` (https://github.com/expo/expo-device-hub/pull/174) is appended after all built-in flags, and the emulator uses the last `-gpu` [observed: `@expo/hub-android-utils/README.md`].

## Detection

`isBareMetalAppleSilicon` in `@expo/hub-android-utils/src/host-gpu.ts` decides from one `sysctl hw.optional.arm64 sysctl.proc_translated kern.hv_vmm_present` call. The Hub reads it once per process.

- **macOS only.** Any other platform is `false` without a `sysctl` call.
- **Apple silicon:** `hw.optional.arm64` is `1`, or `sysctl.proc_translated` is `1`. On this Mac mini M2, the first is `1` and the second is `0` [observed: `sysctl`, 2026-11-13]. `sysctl.proc_translated` is `1` only for a process that runs under Rosetta, which exists only on Apple silicon, so a Node.js for x86_64 on Apple silicon still counts. Rosetta is not installed on this Mac, so that case is not tested [inferred].
- **Not a virtual machine:** `kern.hv_vmm_present` is exactly `0`. It is `0` on this Mac mini M2 [observed: `sysctl`, 2026-11-13] and `1` on an EAS macOS VM (`macos-large`, "Apple M4 Pro (Virtual)") [observed: EAS workflow runs, 2026-11-04]. A missing or empty value counts as a virtual machine, so an unknown host keeps `-gpu auto`.
- **Failure means no.** A `sysctl` that fails, times out after 2 s, or prints nothing gives `false`. `sysctl` exits non-zero when it does not know a name, such as on an Intel Mac, but still prints the names it knows, so output on exit 1 is still read. A timed-out, signaled or failed subprocess discards even a complete-looking partial answer [observed: `readHostSysctl` and executor failure tests in `src/__tests__/host-gpu.test.ts`; `sysctl hw.optional.nonexistent kern.hv_vmm_present` on this Mac prints the second value and exits 1].

## Boot default

`bootDevice` uses `options.gpu`, or `defaultEmulatorGpu()`: `host` when the detection is `true`, `auto` otherwise. `buildEmulatorArgs` puts that mode in the built-in `-gpu`, before `extraArgs` and `EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS`, so a user's `-gpu` still wins.

- Every host that is not bare-metal Apple silicon (Linux, Windows, Intel Macs, macOS virtual machines) keeps `-gpu auto`, so the change does not bring back the failure that `c05ba1ff` probably fixed.
- A bare-metal Apple silicon Mac always has a GPU that the emulator can use, so `-gpu host` is expected to work there, also without a display [inferred]. If it does not, the boot fails with the emulator command in the error, and `EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS='-gpu auto'` restores the previous behavior.
- The Hub does not retry with another mode when an emulator exits early, as https://github.com/expo/expo-device-hub/pull/12 did. An early exit has many causes, and the output does not say which (see [Direction](#direction)).
- The experimental emulator capture (https://github.com/expo/expo-device-hub/pull/570, not merged) adds `-gpu host` through `extraArgs` on macOS while it is on. That flag comes after the built-in one, so it wins either way.

## Warning

The Hub server answers `GET /api/devices/gpu?serial=<adb serial>` with `{ gpuAvailable, renderer }` (`expo-device-hub/src/server/android-gpu.ts`).

- `gpuAvailable` is the [detection](#detection). The server reads the renderer on every host, so the `Rendering` row is real everywhere; only the warning needs `gpuAvailable`.
- `renderer` comes from the `GLES:` line of `adb shell dumpsys SurfaceFlinger`, bounded to 3 s, which https://github.com/expo/expo-device-hub/pull/117 introduced to show the GPU backend. A renderer that names SwiftShader, lavapipe, or llvmpipe is software. The read tells what the guest actually renders with, also for an emulator that the Hub did not start, such as one from Android Studio. It also works for a physical device. A failed or timed-out read is `null`, which shows `Unknown` and no warning.
- The route reads only a running Android device that the Hub lists, after its platform and single-device filters (`listDevices` in `index.ts`). In a single-device session it reads only the session's device, and under a session token it is gated like every other Hub route.
- The dashboard reads the route each time the selected Android device's stream starts, so a restarted emulator is read again (`expo-device-hub/src/dashboard/useAndroidRendering.ts`). A software renderer is `cpu`, any other renderer is `gpu`, and no renderer, a failed request, or no answer within 5 s is `unknown`.
- **Status pill** (`hub-components/src/dashboard/DeviceTitle.tsx`). While the stream is Live, and an emulator (not a physical device) renders on the CPU on a host where `gpuAvailable` is true (`showsCpuRenderingWarning`):
  - The label stays "Live", but the dot, its ring, and the label take the warning tokens (`icon.warning`, `border.warning`, `text.warning`). A down chevron in `icon.warning` follows the label. The label and the chevron are the cues besides the color. The dot does not pulse. Amber also means Loading and Reconnecting, and the label keeps the states apart.
  - The chevron marks the status as something that opens details, and it points up while the popover is open, with a short turn, or none when the user prefers reduced motion. It is drawn on a 12-unit grid at 12 px (`SmallChevronDownIcon`, 1.5 px lines), so it stays sharp. A first version used Lucide's 24-unit `info` icon at 14 px, whose 1.17 px lines rendered blurry; Krystof Woldrich chose the chevron in its place [confirmed] (Krystof Woldrich, 2026-11-13).
  - The pill is two buttons, never nested. The name keeps the toggle between the name and the ID. The status opens a non-modal Radix dialog, whose trigger has `aria-haspopup="dialog"`, `aria-expanded`, and `aria-controls`, and the accessible name "Live, rendering on the CPU. Show details". Enter and Space open it, because it is a native button. Escape closes it and returns the focus to the status button, and a click outside closes it.
  - The popover's title is "Rendering on the CPU". Its text is "This emulator renders on the CPU, so the stream is usually slow: 15 to 30 FPS. Reboot the emulator with GPU rendering (automatic when booting through the Hub) for 60 FPS." [confirmed] (Krystof Woldrich, 2026-11-13).
  - In every other state, the pill is the same single button as before.
  - The popover content mounts only while it is open, because it has no exit animation. Radix's `Presence` would mount it from a layout effect, and `@radix-ui/react-use-layout-effect` replaces that effect with a no-op when `document` is missing at import time, as in the unit tests [observed: its `dist/index.mjs`, 2026-11-13].
  - The title's wrapper in `StreamPanel` has `zIndex: 3`, so the popover opens over the frame's own layers, such as the agent overlay at `zIndex: 2` [observed: `PhoneFrame.tsx`].
- **Stream options** (`hub-components/src/dashboard/StreamOptionsSection.tsx`). The first row is a read-only `Rendering` row with `Unknown`, `CPU`, or `GPU`, for every Android device, and never for iOS. As the first row, a new value does not move the rows below it. Stream options starts collapsed, as before, and the read does not wait for it to open. On the mobile layout, which hides the status pill, the row is the only signal [observed: `StreamPanel.tsx`].
- The warning is a recommendation only. The Hub does not restart the emulator itself.

## iOS

A simulator has no GPU mode to choose: the Hub boots it with `simctl boot` and no rendering option [observed: `@expo/hub-apple-utils`]. So this decision has no iOS part, and [constraint 10 of LLP 0000](0000-expo-device-hub.explainer.md#same-behavior) does not apply to it [inferred].

## Open questions

- Is the [Background](#background) reason for `-gpu auto` correct?
- Should the popover have a button that boots the emulator again with GPU rendering?
- Should the warning stay when the user asked for a software renderer with `EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS`?
- Should Linux hosts with a usable GPU get the same default? https://github.com/expo/expo-device-hub/pull/174 measured `-gpu host` on an NVIDIA GPU with a headless X server, but the Hub cannot yet tell such a host from a Linux VM without a GPU.
