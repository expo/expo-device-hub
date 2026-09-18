# Third-party licenses

Original Expo code is [MIT](LICENSE). These tables cover the current Linux x86-64 binaries. `+` means “or later.”

`hooks` refers to `libgpu_capture.so`, the library injected into the target process to hook gfxstream rendering functions and capture and encode frames. `inject` is the separate executable that loads this library into the target process.

## Direct dependencies

Libraries called by Expo code and adapted interface material:

| Binary | Dependency / repository | License and notices |
| --- | --- | --- |
| `inject` | [Frida Core 17.18.0](https://github.com/frida/frida-core) | [wxWindows 3.1](LICENSES/frida-core/COPYING): [LGPL-2.0+](LICENSES/libsoup/COPYING) with binary linking exception |
| `hooks` | [Frida Gum 17.18.0](https://github.com/frida/frida-gum) | [wxWindows 3.1](LICENSES/frida-gum/COPYING): [LGPL-2.0+](LICENSES/libsoup/COPYING) with binary linking exception |
| Both | [GLib / GObject](https://github.com/frida/glib), supplied by Frida devkits | [LGPL-2.1+ and per-file notices](LICENSES/glib) |
| `hooks` | [FFmpeg 8.0.1](https://github.com/FFmpeg/FFmpeg): libavcodec/libavutil | [LGPL-2.1+](LICENSES/ffmpeg/COPYING.LGPLv2.1) for this build; [adapted CUDA-context notice](LICENSES/ffmpeg/hwcontext_cuda.h.NOTICE) |
| `hooks` | [nv-codec-headers 13.0.19.0](https://github.com/FFmpeg/nv-codec-headers): CUDA/NVENC interfaces | [MIT notices](LICENSES/nv-codec-headers) |
| `hooks` | [gfxstream](https://github.com/google/gfxstream): adapted declarations, not a bundled backend | [Apache-2.0](LICENSES/gfxstream/LICENSE), [copyright notices](LICENSES/gfxstream) |

## Indirect dependencies

Retained code bundled through Frida:

| Binary | Dependency / repository | License and notices |
| --- | --- | --- |
| `inject` | [Frida Gum](https://github.com/frida/frida-gum) | [wxWindows 3.1](LICENSES/frida-gum/COPYING): [LGPL-2.0+](LICENSES/libsoup/COPYING) with binary linking exception |
| `inject` | [GIO](https://github.com/frida/glib/tree/129e8d998936cdd47be41d25d3ffd1294c26a920/gio) | [LGPL-2.1+ and per-file notices](LICENSES/glib) |
| Both | [Capstone](https://github.com/frida/capstone) | [BSD-3-Clause and LLVM/NCSA](LICENSES/capstone) |
| Both | [libffi](https://github.com/frida/libffi) | [MIT-style](LICENSES/libffi/LICENSE) |
| Both | [XZ / liblzma](https://github.com/frida/xz) | [Public-domain library source at the pinned revision](LICENSES/xz/COPYING) |
| `inject` | [libgee](https://github.com/frida/libgee) | [LGPL-2.1+](LICENSES/ffmpeg/COPYING.LGPLv2.1), [copyright notice](LICENSES/libgee/hashmap.vala.NOTICE) |
| `inject` | [PCRE2](https://github.com/frida/pcre2) | [BSD-3-Clause-style with downstream binary-package exemption](LICENSES/pcre2/LICENCE) |
| `inject` | [glib-networking](https://github.com/frida/glib-networking) | [LGPL-2.1+](LICENSES/ffmpeg/COPYING.LGPLv2.1), [OpenSSL linking exception](LICENSES/glib-networking/LICENSE_EXCEPTION) |
| `inject` | [OpenSSL](https://github.com/frida/openssl) | [Apache-2.0](LICENSES/openssl/LICENSE.txt) |
| `inject` | [libbpf](https://github.com/frida/libbpf) | [BSD-2-Clause](LICENSES/libbpf/LICENSE.BSD-2-Clause), selected where offered under the [dual license](LICENSES/libbpf/LICENSE) |
| `inject` | [elfutils / libelf](https://github.com/frida/elfutils) | [LGPL-3.0+](LICENSES/elfutils/COPYING-LGPLV3), selected instead of GPL-2.0+; [accompanying GPLv3 text](LICENSES/elfutils/COPYING) |
| `inject` | [zlib](https://github.com/frida/zlib) | [Zlib](LICENSES/zlib/LICENSE) |
| `inject` | [Frida native bootstrapper / loader](https://github.com/frida/frida-core/tree/0602e5dca4c9d7be6098fc319edf978724dabeab/src/linux/helpers) | [Frida Core terms](LICENSES/frida-core/COPYING); incorporated Linux/header material remains [under review](docs/frida-linux-payloads.md) |
| `inject` | [Frida BPF helpers](https://github.com/frida/frida-core/tree/0602e5dca4c9d7be6098fc319edf978724dabeab/src/linux/helpers): activity sampler, spawn gater, syscall tracer | `Dual BSD/GPL`; exact variants and incorporated notices remain [under review](docs/frida-linux-payloads.md) |

[Source and rebuild materials](SOURCES.md) · [Detailed inventory and external runtimes](docs/native-binary-dependencies.md) · [Pinned license sources](LICENSES/README.md) · [Pending release reviews](sources/compliance.json).
