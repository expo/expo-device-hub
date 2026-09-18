# Dependencies in the current Linux x86-64 binaries

Reviewed 2026-09-18. This is a library-level inventory of the current source-built
outputs, including code retained from the merged Frida devkits. Original Expo
code is MIT; incorporated dependencies retain their own terms. This inventory
does not close the embedded-helper license/source audit or the separate host
integration review.

| Binary | SHA-256 |
| --- | --- |
| `dist/linux-x64/libgpu_capture.so` | `2cef3fe3c01d084f8ba7fd5971e17c842280e4a0892d2d2643c0f16eb1bc0e1a` |
| `dist/linux-x64/inject` | `c961dd9f1b721e2ec319ab7a873feeb40776af94efb467c9b9da0a54fcb91cb4` |

## Retained library code

“Included” means objects from the component contribute to allocated ELF sections
in that binary. It does not mean every feature of the library is used at runtime.
Repository links identify the upstream project or Frida fork used by this build;
license links identify the inspected pinned source.

| Component | Capture library | Injector | License for the inspected component | Repository |
| --- | --- | --- | --- | --- |
| Frida Gum 17.18.0 | Included | Included through Core | [wxWindows Library Licence 3.1](https://github.com/frida/frida-gum/blob/22e077120358a49b26e32110a6e2b8e80f1ed7f1/COPYING): LGPL-2.0-or-later with its binary linking exception; additional notices for bundled portions | [frida/frida-gum](https://github.com/frida/frida-gum) |
| Frida Core 17.18.0 | — | Included | [wxWindows Library Licence 3.1](https://github.com/frida/frida-core/blob/0602e5dca4c9d7be6098fc319edf978724dabeab/COPYING) | [frida/frida-core](https://github.com/frida/frida-core) |
| FFmpeg 8.0.1: libavcodec and libavutil | Included | — | [LGPL-2.1-or-later for this configured build](https://github.com/FFmpeg/FFmpeg/blob/894da5ca7d742e4429ffb2af534fcda0103ef593/LICENSE.md) | [FFmpeg/FFmpeg](https://github.com/FFmpeg/FFmpeg) |
| GLib family | GLib and GObject | GLib, GObject and GIO | [LGPL-2.1-or-later](https://github.com/frida/glib/blob/129e8d998936cdd47be41d25d3ffd1294c26a920/COPYING), plus per-file notices | [frida/glib](https://github.com/frida/glib) |
| Capstone | Included | Included | [BSD-3-Clause](https://github.com/frida/capstone/blob/d536b1577fd033a31d75f48fd183aa425256cc18/LICENSE.TXT) and [LLVM/NCSA notices](https://github.com/frida/capstone/blob/d536b1577fd033a31d75f48fd183aa425256cc18/LICENSE_LLVM.TXT) | [frida/capstone](https://github.com/frida/capstone) |
| libffi | Included | Included | [MIT-style](https://github.com/frida/libffi/blob/2b42587b9b5c8f4ab4144b615014e20d9e4d396f/LICENSE) | [frida/libffi](https://github.com/frida/libffi) |
| XZ/liblzma | Included | Included | [Public domain for the library source at this pin](https://github.com/frida/xz/blob/e70f5800ab5001c9509d374dbf3e7e6b866c43fe/COPYING) | [frida/xz](https://github.com/frida/xz) |
| libgee | — | Included | [LGPL-2.1-or-later](https://github.com/frida/libgee/blob/ad17ed847039469fcc2dc711ecfee2bbf7d2bf87/gee/hashmap.vala) | [frida/libgee](https://github.com/frida/libgee) |
| PCRE2 | — | Included | [BSD-3-Clause-style terms with a downstream binary-package exemption](https://github.com/frida/pcre2/blob/b47486922fdc3486499b310dc9cf903449700474/LICENCE) | [frida/pcre2](https://github.com/frida/pcre2) |
| glib-networking OpenSSL backend | — | Included | [LGPL-2.1-or-later](https://github.com/frida/glib-networking/blob/ef47b1a09cf8c1875f181bcf901643689a56d12f/COPYING), with an [OpenSSL linking exception](https://github.com/frida/glib-networking/blob/ef47b1a09cf8c1875f181bcf901643689a56d12f/LICENSE_EXCEPTION) | [frida/glib-networking](https://github.com/frida/glib-networking) |
| OpenSSL | — | Included | [Apache-2.0](https://github.com/frida/openssl/blob/fa60a1c8c704e4ca0cc0dcb289c3be1fea1b50ff/LICENSE.txt) | [frida/openssl](https://github.com/frida/openssl) |
| libbpf | — | Included | [LGPL-2.1 OR BSD-2-Clause](https://github.com/frida/libbpf/blob/6c8d0d00a122fe126b7a3094f0785340128506f5/LICENSE); BSD option selected where offered | [frida/libbpf](https://github.com/frida/libbpf) |
| elfutils/libelf | — | Included | [LGPL-3.0-or-later OR GPL-2.0-or-later](https://github.com/frida/elfutils/blob/1284bbc128473aea220337685985d465607fbac8/libelf/elf_begin.c); LGPL option selected | [frida/elfutils](https://github.com/frida/elfutils) |
| zlib | — | Included | [Zlib](https://github.com/frida/zlib/blob/171a3eacaea8b731ef1fc586e7777b77742e2a1d/LICENSE) | [frida/zlib](https://github.com/frida/zlib) |

FFmpeg has GPL, version3 and nonfree disabled. The configured encoder is
`h264_nvenc`; our binary does not incorporate the SDK emulator's separate
GPL-enabled FFmpeg/x264 build. XZ's separately licensed command-line tools and
build scripts do not make its retained liblzma source GPL-covered. Frida's
wxWindows exception does not replace its independently licensed dependencies'
terms.

## Adapted headers and generated material in capture

| Material | Treatment | Repository/source |
| --- | --- | --- |
| gfxstream borrowed-image declarations | Adapted Apache-2.0 declarations, with retained notices; a gfxstream backend implementation is not linked into our library | [gfxstream BorrowedImage.h](https://android.googlesource.com/platform/hardware/google/gfxstream/+/35d53baaa71ec845d4e616dc7a31cc7d8d5f640b/host/BorrowedImage.h) |
| CUDA/NVENC interface material from nv-codec-headers 13.0.19.0 | MIT header notices | [nv-codec-headers](https://github.com/FFmpeg/nv-codec-headers/blob/e844e5b26f46bb77479f063029595293aa8f812d/include/ffnvcodec/nvEncodeAPI.h) |
| Leading fields adapted from FFmpeg's AVCUDADeviceContext | LGPL-2.1-or-later attribution, covered by the FFmpeg notices above | [FFmpeg hwcontext_cuda.h](https://github.com/FFmpeg/FFmpeg/blob/894da5ca7d742e4429ffb2af534fcda0103ef593/libavutil/hwcontext_cuda.h) |
| PTX generated from Expo's scale.cu | Original Expo source is MIT; generated NVIDIA material remains subject to the recorded review | [local scale.cu](../src/scale.cu), [NVIDIA CUDA 12.9.1 terms](https://docs.nvidia.com/cuda/archive/12.9.1/eula/index.html) |

NVRTC is an external build compiler. The CUDA/NVENC drivers are independently
installed runtime prerequisites, loaded dynamically. Their binaries are not
incorporated into these outputs, and the MIT header licenses do not relicense
the compiler or drivers.

## Embedded Frida payloads in inject

The exact byte sequences of all five checked-in Linux x86-64 helper payloads
were found in loadable segments of the final injector. None of those five was
found in the capture library.

| Payload | License/source status |
| --- | --- |
| Native bootstrapper and loader | Frida Core package terms, subject to any incorporated Linux nolibc/header material; that additional material's audit remains incomplete |
| BPF activity sampler, spawn gater and syscall tracer | Source declares `Dual BSD/GPL`; that declaration does not identify the exact BSD variant or GPL version |

Sources and build recipes are in [Frida Core's Linux helpers](https://github.com/frida/frida-core/tree/0602e5dca4c9d7be6098fc319edf978724dabeab/src/linux/helpers).
The [helper-source audit](frida-linux-payloads.md) records the missing matching
Linux/nolibc and libbpf-header regeneration inputs. Do not apply the ordinary
libbpf library's BSD-2-Clause choice automatically to these separate BPF programs.

## External system runtimes

The current outputs require the following shared libraries. These runtime DSOs
are supplied by the system, not shipped inside our two files. Header/template
and compiler-support code may still contribute to compiled outputs.

| Runtime | Capture library | Injector | License reference / repository |
| --- | --- | --- | --- |
| glibc 2.36: libc, libm, libresolv and ELF loader | Required | Required | LGPL-2.1-or-later plus per-file terms; [glibc](https://sourceware.org/glibc/) |
| GCC 12.2: libgcc_s | Required | Required | GPL-3.0-or-later with GCC Runtime Library Exception; [GCC license guidance](https://gcc.gnu.org/onlinedocs/libstdc++/manual/license.html), [GCC sources](https://gcc.gnu.org/git.html) |
| GCC 12.2: libstdc++ | — | Required | Same GCC runtime terms |
| LLVM 14.0.6: libc++, libc++abi and libunwind | Required | — | Apache-2.0 with LLVM exceptions and retained legacy notices; [LLVM runtime license](https://github.com/llvm/llvm-project/blob/llvmorg-14.0.6/libcxx/LICENSE.TXT) |

This external LLVM libunwind is distinct from the nongnu libunwind sources in
Frida's wider dependency collection.

## Evidence and limits

The audit replayed the recorded native link commands with verified original
inputs, directing outputs to a separate audit directory and generating linker
maps. After stripping, each diagnostic relink differs from the current final
binary only in its 20-byte GNU build-id digest. All remaining bytes, including
code/data and ELF section metadata, match. The distributed outputs were not
overwritten.

Maps were filtered against allocated ELF sections, excluding discarded and
debug-only material. The capture output retains 22 libavcodec objects, 35
libavutil objects and 159 merged Gum-devkit objects. The injector retains 1,299
Core-devkit objects plus one libc_nonshared object. Original Meson archive
membership identifies the libraries behind the merged devkits.

All retained Frida-devkit member names were mapped to component archives.
Duplicate `utils.c.o` and `promise.c.o` basenames were resolved from retained
section symbols as Capstone and Frida Core respectively. No GModule-owned
member was retained. GLib's aggregate archives also contain gnulib,
proxy-libintl and libcharset objects; GIO contains inotify and xdgmime code.
Their component/file notices remain applicable within the GLib attribution.
Some nested files originally offer LGPL-2.0-or-later, including the
[proxy-libintl stub](https://github.com/frida/glib/blob/129e8d998936cdd47be41d25d3ffd1294c26a920/proxy-libintl-static/libintl.c)
and [libcharset](https://github.com/frida/glib/blob/129e8d998936cdd47be41d25d3ffd1294c26a920/glib/libcharset/localcharset.c);
[xdgmime](https://github.com/frida/glib/blob/129e8d998936cdd47be41d25d3ffd1294c26a920/gio/xdgmime/xdgmime.c)
offers AFL-2.0 OR LGPL-2.1-or-later. We use the LGPL-2.1-or-later-compatible options.

No top-level retained member was identified from JSON-GLib, libsoup, libnice,
usrsctp, lwIP, Brotli, nghttp2, ngtcp2, libpsl, minizip-ng, LZFSE, nongnu libunwind
or libdwarf. Their presence in Frida's wider build inputs does not by itself
make them components of these final files. This observation is not a recursive
clearance of embedded blobs or a reason to discard source-tree notices.

Local records are in `artifacts/final-dependency-audit/`: `relink-verification.json`,
`elf-link-inventory.json`, linker maps, retained-member lists and dynamic-library
reports. Build/source provenance is in `artifacts/source-verification-4/`.
This replaces the earlier reliance on the prebuilt-devkit build for the
top-level component inventory. It does not prove complete attribution for every
embedded payload or settle the [host integration scope](emulator-injection-licensing.md).
