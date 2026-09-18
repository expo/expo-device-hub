# Source and license boundary of the hooked gfxstream implementation

Reviewed 2026-09-17. This identifies the public source implementation and its
documented component boundaries. It does not establish the complete corresponding
source or distribution license of Android Emulator build 15507667.

## Hook and source file

Our [agent](../src/gum-agent.cpp) locates `libgfxstream_backend.so`, enumerates
exports whose names start with
`_ZN9gfxstream4host11FrameBuffer4Impl8postImplE`, and attaches a callback to them.
The matching public implementation is
`gfxstream::host::FrameBuffer::Impl::postImpl` in
[`host/frame_buffer.cpp`, line 2599](https://github.com/google/gfxstream/blob/8764af0869eb5d3cce3a3e0b9a03545c9301bfc2/host/frame_buffer.cpp#L2599).
The function looks up a color buffer, optionally acquires renderer/context locks,
and schedules its presentation. Our hook observes entry and lets the original
function run; it does not replace that implementation. This exported internal
C++ method is not a guaranteed stable public API.

The nearest license statement is **inside that source file itself**:
[`frame_buffer.cpp`, lines 1–15](https://github.com/google/gfxstream/blob/8764af0869eb5d3cce3a3e0b9a03545c9301bfc2/host/frame_buffer.cpp#L1)
identifies copyright 2011–2015 The Android Open Source Project and explicitly
licenses the file under **Apache-2.0**. No inference from a distant repository
license is necessary for this file.

## Enclosing component and build boundary

| Level | Primary evidence | Meaning |
| --- | --- | --- |
| Source file | [File notice](https://github.com/google/gfxstream/blob/8764af0869eb5d3cce3a3e0b9a03545c9301bfc2/host/frame_buffer.cpp#L1) | This implementation is Apache-2.0 source. |
| Nearest build package, `host/` | [`host/Android.bp`, lines 15–18](https://github.com/google/gfxstream/blob/8764af0869eb5d3cce3a3e0b9a03545c9301bfc2/host/Android.bp#L15) | Sets `default_applicable_licenses` to `hardware_google_gfxstream_license`. |
| Named license definition | [Root `Android.bp`, lines 19–32](https://github.com/google/gfxstream/blob/8764af0869eb5d3cce3a3e0b9a03545c9301bfc2/Android.bp#L19) | Lists Apache-2.0, BSD, ISC, MIT, and `legacy_unencumbered` across the component; this is aggregate metadata, not a choice of licenses for every file. |
| Project | [Root `LICENSE`](https://github.com/google/gfxstream/blob/8764af0869eb5d3cce3a3e0b9a03545c9301bfc2/LICENSE), [README](https://github.com/google/gfxstream/blob/8764af0869eb5d3cce3a3e0b9a03545c9301bfc2/README.md) | Gfxstream, the Graphics Streaming Kit, is a rendering API streaming project with an Apache-2.0 root license and its own build instructions. |
| Native target | [`host/CMakeLists.txt`](https://github.com/google/gfxstream/blob/8764af0869eb5d3cce3a3e0b9a03545c9301bfc2/host/CMakeLists.txt#L77) | `frame_buffer.cpp` is in `stream-server-core-sources`, compiled into `gfxstream_backend_static`, then linked into shared target `gfxstream_backend`. |

The Soong build independently puts `frame_buffer.cpp` into
`libgfxstream_backend_defaults` and uses those defaults for `libgfxstream_backend`:
[`host/Android.bp`, lines 83–175](https://github.com/google/gfxstream/blob/8764af0869eb5d3cce3a3e0b9a03545c9301bfc2/host/Android.bp#L83).
These are source/build component boundaries, not a determination that a shared
library boundary is necessarily the complete legal boundary of a combined work.

Related private implementations used by [capture.cpp](../src/capture.cpp) also
carry Apache-2.0 notices: [`host/color_buffer.cpp`](https://github.com/google/gfxstream/blob/8764af0869eb5d3cce3a3e0b9a03545c9301bfc2/host/color_buffer.cpp#L1)
and [`host/gl/color_buffer_gl.cpp`](https://github.com/google/gfxstream/blob/8764af0869eb5d3cce3a3e0b9a03545c9301bfc2/host/gl/color_buffer_gl.cpp#L1).

## SDK artifact corroboration and limits

The `NOTICE.csv` extracted from the
[Linux SDK build 15507667](https://dl.google.com/android/repository/emulator-linux_x64-15507667.zip)
has a `gfxstream` row labeled Apache-2.0, attributes it to `gfxstream_backend.so`,
and identifies the AOSP `platform/hardware/google/gfxstream` repository as its
source. Its `qemu` GPL-2.0-only row does not attribute QEMU to that shared library.
Its `ffmpeg` GPL-2.0-or-later row does attribute FFmpeg to the same library.
The extracted evidence is preserved in
[`sdk-NOTICE.csv`](../artifacts/legal-review/sdk-NOTICE.csv); exact renderer
inspection also found GPL-enabled FFmpeg strings, as recorded in
[the earlier review](emulator-injection-licensing.md#exact-emulator-artifact).

Thus the directly hooked implementation is Apache-2.0 code in **gfxstream's host
graphics backend**. The complete SDK renderer contains additional dependencies
with their own terms; the source file notice alone cannot classify that entire
binary or settle whether the injected library forms a combined work with its
GPL-covered components. The earlier blanket combined-GPL classification was a
conservative assumption, now superseded; no requirement to distribute all QEMU
source has been established.

All GitHub source links above are pinned to commit
[`8764af0869eb5d3cce3a3e0b9a03545c9301bfc2`](https://github.com/google/gfxstream/commit/8764af0869eb5d3cce3a3e0b9a03545c9301bfc2),
dated 2026-09-08. The symbol and component mapping is supported by the inspected
source and SDK notices, but this commit has **not** been proven to be the exact
source revision used for SDK build 15507667. Release compliance remains blocked
by the unresolved source, dependency and host-scope questions.

## Independent integration demonstrated

The [standalone injection prototype](../prototypes/gfxstream-hook/README.md)
subsequently built this pinned gfxstream source, without source edits, in native
Linux ARM64 Docker with `BUILD_STANDALONE=ON` and `CONFIG_AEMU=OFF`. A small host
created a real 64×64 color buffer, verified its pixel upload/readback, and posted
frames. The existing Expo injector loaded a minimal Gum agent into that process;
each of two runs counted 58 calls to the real `FrameBuffer::Impl::postImpl`.
The host and injector exited successfully. Runtime mappings, ELF dependency
information, input provenance, and hashes are retained in the prototype's
[local evidence](../artifacts/gfxstream-hook/evidence/result.json).

This demonstrates an independent integration of the entry hook with gfxstream,
without QEMU or an Android Emulator executable. It does not demonstrate full GPU
capture portability: [capture.cpp](../src/capture.cpp) additionally depends on
private object layouts, C++ runtime compatibility, EGL dispatch entries and
GL-backed textures. These are gfxstream build/ABI assumptions, not direct QEMU
API calls. A different host must expose the compatible symbols and use the
hooked rendering path.

Apache-2.0 excludes merely linking or binding by name to interfaces from its own
derivative-work definition. This supports preserving MIT for original Expo code;
the adapted Apache-covered declarations retain their license and notices.
Private-interface usage does not itself make all QEMU source required. Neither
this definition nor the standalone demonstration grants an exception for other
copyright holders' GPL-covered code in the SDK renderer. The justified scope of
that particular integration remains a separate unresolved question.
[Apache-2.0 §§1, 4](https://www.apache.org/licenses/LICENSE-2.0),
[distribution review](emulator-injection-licensing.md).
