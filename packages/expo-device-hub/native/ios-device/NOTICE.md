# Physical iOS capture dependency

The optional build fetches Callstack's MIT-licensed `codex-mobile-dev-plugin` at commit
`7ea9a42c713117464a36c2f4ebde424b13059bb7`, directory `packages/native/ios-mirror`.
The archive is SHA-256 verified before extraction. See CALLSTACK-LICENSE.txt.
The small `scripts/ios-device.patch` removes telemetry, renames the crate, and
maps display touches to portrait digitizer coordinates using SpringBoard's
interface orientation. The display transport, bounded frame queue, generation
checks, touch release, and per-stream teardown are retained.

The media parser and negotiation source derive from `jkcoxson/idevice` at
`a64b8867815b3da17b5c927531bdba877e8456ef` and `JaviSoto/device-hub-ios` at
`1fcdfb0a6799b62f05625d0cbb359bec57256b94`. See IDEVICE-LICENSE.txt and
DEVICE-HUB-LICENSE.txt. The upstream Cargo.lock pins native dependencies.

Build explicitly with `bun run --filter expo-device-hub build:ios-device` after
installing Rust; the first build needs network access. Downloaded source and build
output are ignored by Git. Regular simulator/Android builds do not require Rust. Include the
resulting addon and license files when packaging a physical-iOS-enabled Hub.
This experimental backend uses private CoreDevice display and UniversalHID services;
it requires Xcode 27, Developer Mode, a trusted USB/Wi-Fi pairing, and HEVC WebCodecs.
