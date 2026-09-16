# Third-party licenses

**Preliminary inventory, 2026-09-16.** This documents the pinned dependencies and source interfaces currently used by this experiment. It is not a completed audit of the final npm archive. Static-link garbage collection can remove unused devkit components, and embedded helper binaries can contain additional components. The final per-binary inventory, copyright notices, and matching source/rebuild distribution still need verification.

## Original Expo source

Our original source is licensed under [MIT](LICENSE), including:

| Source | Role | Original source license |
| --- | --- | --- |
| `src/*.mjs` and JavaScript declarations | CLI and capture control | MIT |
| `src/inject.cpp` | Native injector/controller using Frida Core | MIT |
| `src/gum-agent.cpp` | Injected renderer hooks using Frida Gum | MIT |
| `src/capture.cpp`, `src/scale.cu`, and original capture/protocol headers | GPU capture, conversion, and FFmpeg encoding | MIT |
| `scripts/`, tests, and documentation | Build, development, and usage | MIT |

This choice applies to our original code, not third-party components. Frida's own [wxWindows exception](LICENSES/frida-core/COPYING) allows binary combinations under other terms. FFmpeg's [LGPL2.1 section 6](LICENSES/ffmpeg/COPYING.LGPLv2.1) also permits combined works under other terms when its requirements are met. We therefore retain MIT on the original injector and capture sources. Copied or adapted upstream material retains its original notices. The separate emulator integration question below is not resolved by this source license choice.

## Native dependencies

`dist/linux-x64/libgpu_capture.so` statically links FFmpeg's `libavcodec`/`libavutil` and the Frida Gum devkit. `dist/linux-x64/inject` statically links the Frida Core devkit. These binaries are not exclusively MIT-licensed.

| Component | Pinned version | Terms relevant to this build | Local license copies |
| --- | --- | --- | --- |
| FFmpeg | 8.0.1 (`n8.0.1`) | LGPL-2.1-or-later for the configured libraries | [License inventory](LICENSES/ffmpeg/LICENSE.md), [LGPL2.1](LICENSES/ffmpeg/COPYING.LGPLv2.1) |
| Frida Core | 17.18.0 | wxWindows Library Licence 3.1: LGPL-2.0-or-later with its binary linking exception; dependencies have separate terms | [COPYING](LICENSES/frida-core/COPYING) |
| Frida Gum | 17.18.0 | Same wxWindows terms, with additional notices in its COPYING | [COPYING](LICENSES/frida-gum/COPYING) |
| nv-codec-headers | 13.0.19.0 (`n13.0.19.0`) | MIT notices in NVIDIA/FFmpeg interface headers | [Header notices](LICENSES/nv-codec-headers) |

Our FFmpeg configuration enables CUDA and `h264_nvenc`, and does not enable `--enable-gpl`, `--enable-version3`, or `--enable-nonfree`. FFmpeg's source tree contains optional differently licensed components, so this statement concerns the configured libraries rather than every source file. Changing the configuration or sources requires reviewing this inventory again.

The GNU Library GPL v2 text referenced by Frida's wxWindows license is included in [libsoup/COPYING](LICENSES/libsoup/COPYING). The LGPL3 and accompanying GPL3 texts for the libelf option are included in [elfutils](LICENSES/elfutils).

Every copied license and header notice has a commit-pinned original link in [LICENSES/README.md](LICENSES/README.md). FFmpeg's original source is pinned to [894da5ca](https://github.com/FFmpeg/FFmpeg/tree/894da5ca7d742e4429ffb2af534fcda0103ef593), nv-codec-headers to [e844e5b2](https://github.com/FFmpeg/nv-codec-headers/tree/e844e5b26f46bb77479f063029595293aa8f812d), and the Frida dependency revisions follow the 17.18.0 Core/Gum wraps and [pinned dependency manifest](https://github.com/frida/releng/blob/963fe3826f861a7d844d235957f2f13738e3a73b/deps.toml).

## Components in Frida's devkits and build dependency set

Frida's exception does not apply automatically to independently licensed dependencies. The following entries come from inspected pinned sources and devkit archives; they are not assertions that every component survives the final link. References to other programs in a copied upstream license inventory do not imply those programs are included.

| Component | Pinned-source terms / intended choice where alternatives are offered | Local copies |
| --- | --- | --- |
| GLib, GObject, GIO, GModule | LGPL-2.1-or-later, plus per-file permissive notices | [GLib](LICENSES/glib) |
| libgee | LGPL-2.1-or-later | [libgee](LICENSES/libgee) |
| elfutils libelf | LGPL-3.0-or-later OR GPL-2.0-or-later; use the LGPL option | [elfutils](LICENSES/elfutils) |
| libdwarf | Primarily LGPL-2.1-only, with some BSD-2-Clause files; not the GPL dwarfdump program | [libdwarf](LICENSES/libdwarf) |
| JSON-GLib | LGPL-2.1-or-later, plus MIT/CC0 material | [JSON-GLib](LICENSES/json-glib) |
| TinyCC/libtcc | LGPL2.1 text; preserve individual file notices | [TinyCC](LICENSES/tinycc/COPYING) |
| libbpf | LGPL-2.1 OR BSD-2-Clause for the dual-licensed library files; use the BSD option where offered | [libbpf](LICENSES/libbpf) |
| glib-networking | LGPL-2.1-or-later with a specific OpenSSL exception | [COPYING and exception](LICENSES/glib-networking) |
| libsoup | GNU Library GPL v2 text in the pinned COPYING; per-file terms also apply | [libsoup](LICENSES/libsoup/COPYING) |
| libnice | MPL-1.1 OR LGPL-2.1; use the LGPL option | [libnice](LICENSES/libnice) |
| libusb | LGPL-2.1-or-later | [libusb](LICENSES/libusb/COPYING) |
| Capstone | BSD-3-Clause and LLVM/NCSA notices | [Capstone](LICENSES/capstone) |
| libffi | MIT-style license | [libffi](LICENSES/libffi/LICENSE) |
| PCRE2 | BSD-style terms with its binary-library exemption | [PCRE2](LICENSES/pcre2/LICENCE) |
| zlib | Zlib | [zlib](LICENSES/zlib/LICENSE) |
| libunwind | MIT | [libunwind](LICENSES/libunwind/COPYING) |
| XZ liblzma | Public domain for liblzma in this pin; the copied inventory also describes separately licensed tools | [XZ](LICENSES/xz) |
| OpenSSL | Apache-2.0 at this pin | [OpenSSL](LICENSES/openssl/LICENSE.txt) |
| usrsctp, lwIP, LZFSE | BSD-3-Clause | [usrsctp](LICENSES/usrsctp/LICENSE.md), [lwIP](LICENSES/lwip/COPYING), [LZFSE](LICENSES/lzfse/LICENSE) |
| Brotli, nghttp2, ngtcp2, libpsl | MIT, with additional file notices where applicable | [Brotli](LICENSES/brotli/LICENSE), [nghttp2](LICENSES/nghttp2), [ngtcp2](LICENSES/ngtcp2), [libpsl](LICENSES/libpsl) |
| minizip-ng | Zlib | [minizip-ng](LICENSES/minizip-ng/LICENSE) |

The Core archive also contains optional script-agent/compiler assets. Their complete embedded dependency inventory remains to be checked if those bytes are distributed, including in a future relink kit. Supplying a whole prebuilt devkit can distribute more components than our final injector uses.

## Emulator interfaces and external NVIDIA software

The injected library hooks `libgfxstream_backend.so` in an independently installed Android Emulator. The inspected FrameBuffer and borrowed-image interface source files carry Apache-2.0 notices. See the [gfxstream license and copyright notice](LICENSES/gfxstream), [FrameBuffer implementation](https://github.com/google/gfxstream/blob/8764af0869eb5d3cce3a3e0b9a03545c9301bfc2/host/frame_buffer.cpp), and [BorrowedImage declarations](https://android.googlesource.com/platform/hardware/google/gfxstream/+/35d53baaa71ec845d4e616dc7a31cc7d8d5f640b/host/BorrowedImage.h). These inspected revisions are source references, not a verified complete source manifest for the tested SDK binary. Our use of upstream interface layouts is not a claim of authorship over those interfaces.

Android Emulator 36.6.11 / build 15507667's [Linux SDK archive](https://dl.google.com/android/repository/emulator-linux_x64-15507667.zip) identifies GPL-2.0-or-later FFmpeg in the renderer and GPL-2.0-only QEMU in the host. The renderer's Apache source headers do not make the complete host binary Apache-only. The injected library's interaction with those components still requires a combined-work assessment before release. This package does not redistribute the emulator or its system images.

NVRTC 12.9.86 is a build-time compiler downloaded from CUDA 12.9.1, governed by the [versioned NVIDIA SDK terms](https://docs.nvidia.com/cuda/archive/12.9.1/eula/index.html). The NVIDIA driver is an independently installed runtime prerequisite. Neither the NVRTC compiler binaries nor the driver are included in the current native outputs; the MIT notices for nv-codec-headers do not relicense either product.

## Source and redistribution status

Static LGPL components require applicable notices, matching library source, and materials that let recipients rebuild/relink the combination with modified libraries. Our original MIT source license does not waive those requirements. Frida [combines archives and renames dependency symbols](https://github.com/frida/releng/blob/963fe3826f861a7d844d235957f2f13738e3a73b/devkit.py), so an FFmpeg-only relink kit or opaque Frida archives would not cover all bundled LGPL components.

The links and license copies here are preliminary provenance, not a completed corresponding-source distribution or written source offer. The intended release arrangement is a maintained, version-specific source/rebuild download linked from the npm package. It must cover the applicable dependencies, patches, and build machinery for both native binaries, including canary releases. Final source-delivery terms and availability must be verified along with the artifacts.

Before release:

- [ ] Verify the final linked binaries and embedded helpers, and complete their copyright and license notices.
- [ ] Publish and validate the matching source/rebuild materials for FFmpeg and the applicable Frida dependencies.
- [ ] Verify every npm archive includes the license copies and points to the correct maintained source materials.
- [ ] Resolve the emulator/injected-agent combined-work question.
