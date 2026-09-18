# Third-party licenses

Original Expo code is [MIT-licensed](LICENSE). The native binaries also contain
third-party components under the terms below. `hooks` means `libgpu_capture.so`;
`inject` is the separate executable that loads it. `+` means “or later.”

Common license texts are included once in `LICENSES/`. Component-specific
copyright notices, exceptions and distinct BSD variants are retained. The shared
wxWindows file includes Frida Gum's additional third-party notices; those notices
apply to Gum, not automatically to every Frida Core file.

## Native dependencies

| Binary | Component and pinned source | License text |
| --- | --- | --- |
| `inject` | [Frida Core 17.18.0](https://github.com/frida/frida-core/tree/0602e5dca4c9d7be6098fc319edf978724dabeab) | [wxWindows 3.1](LICENSES/wxWindows-3.1.txt), [LGPL-2.0+](LICENSES/LGPL-2.0.txt) with binary linking exception |
| Both | [Frida Gum 17.18.0](https://github.com/frida/frida-gum/tree/22e077120358a49b26e32110a6e2b8e80f1ed7f1) | [wxWindows 3.1](LICENSES/wxWindows-3.1.txt), [LGPL-2.0+](LICENSES/LGPL-2.0.txt) with binary linking exception |
| Both | [GLib / GObject; GIO in `inject`](https://github.com/frida/glib/tree/129e8d998936cdd47be41d25d3ffd1294c26a920) | [LGPL-2.1+](LICENSES/LGPL-2.1.txt); per-file [MIT](LICENSES/MIT.txt), [Apache-2.0](LICENSES/Apache-2.0.txt), [LLVM exception](LICENSES/LLVM-exception.txt) and [CC0](LICENSES/CC0-1.0.txt) notices also apply |
| `hooks` | [FFmpeg 8.0.1: libavcodec/libavutil](https://github.com/FFmpeg/FFmpeg/tree/894da5ca7d742e4429ffb2af534fcda0103ef593) | [LGPL-2.1+](LICENSES/LGPL-2.1.txt); GPL, version3 and nonfree features are disabled in this build |
| Both | [Capstone](https://github.com/frida/capstone/tree/d536b1577fd033a31d75f48fd183aa425256cc18) | [BSD-3-Clause](LICENSES/BSD-3-Clause-Capstone.txt), [LLVM/NCSA](LICENSES/NCSA.txt) |
| Both | [libffi](https://github.com/frida/libffi/tree/2b42587b9b5c8f4ab4144b615014e20d9e4d396f) | [MIT](LICENSES/MIT.txt) |
| Both | [XZ / liblzma](https://github.com/frida/xz/tree/e70f5800ab5001c9509d374dbf3e7e6b866c43fe) | Public-domain library source at this revision; upstream grant below |
| `inject` | [libgee](https://github.com/frida/libgee/tree/ad17ed847039469fcc2dc711ecfee2bbf7d2bf87) | [LGPL-2.1+](LICENSES/LGPL-2.1.txt) |
| `inject` | [PCRE2](https://github.com/frida/pcre2/tree/b47486922fdc3486499b310dc9cf903449700474) | [BSD-3-Clause-style terms and binary-package exemption](LICENSES/BSD-3-Clause-PCRE2.txt) |
| `inject` | [glib-networking](https://github.com/frida/glib-networking/tree/ef47b1a09cf8c1875f181bcf901643689a56d12f) | [LGPL-2.1+](LICENSES/LGPL-2.1.txt), [OpenSSL linking exception](LICENSES/glib-networking-OpenSSL-exception.txt) |
| `inject` | [OpenSSL](https://github.com/frida/openssl/tree/fa60a1c8c704e4ca0cc0dcb289c3be1fea1b50ff) | [Apache-2.0](LICENSES/Apache-2.0.txt) |
| `inject` | [libbpf](https://github.com/frida/libbpf/tree/6c8d0d00a122fe126b7a3094f0785340128506f5) | [BSD-2-Clause](LICENSES/BSD-2-Clause.txt), selected where offered under LGPL-2.1 OR BSD-2-Clause |
| `inject` | [elfutils / libelf](https://github.com/frida/elfutils/tree/1284bbc128473aea220337685985d465607fbac8) | [LGPL-3.0+](LICENSES/LGPL-3.0.txt), selected instead of GPL-2.0+; [accompanying GPLv3 text](LICENSES/GPL-3.0.txt) |
| `inject` | [zlib](https://github.com/frida/zlib/tree/171a3eacaea8b731ef1fc586e7777b77742e2a1d) | [Zlib](LICENSES/Zlib.txt) |

Frida's wxWindows exception does not replace its dependencies' separate terms.
GLib includes nested gnulib, proxy-libintl, libcharset, inotify and xdgmime
material; the LGPL-compatible options are selected where alternatives are offered.

## Incorporated interfaces and notices

| Material in `hooks` | Source and license |
| --- | --- |
| CUDA/NVENC interfaces | [nv-codec-headers 13.0.19.0](https://github.com/FFmpeg/nv-codec-headers/tree/e844e5b26f46bb77479f063029595293aa8f812d), [MIT](LICENSES/MIT.txt); copyright notices included with the license |
| Adapted borrowed-image declarations | [gfxstream BorrowedImage.h](https://android.googlesource.com/platform/hardware/google/gfxstream/+/35d53baaa71ec845d4e616dc7a31cc7d8d5f640b/host/BorrowedImage.h) and [BorrowedImageGl.h](https://android.googlesource.com/platform/hardware/google/gfxstream/+/35d53baaa71ec845d4e616dc7a31cc7d8d5f640b/host/gl/BorrowedImageGl.h), [Apache-2.0](LICENSES/Apache-2.0.txt) |
| Adapted CUDA-context declaration | [FFmpeg hwcontext_cuda.h](https://github.com/FFmpeg/FFmpeg/blob/894da5ca7d742e4429ffb2af534fcda0103ef593/libavutil/hwcontext_cuda.h), [LGPL-2.1+](LICENSES/LGPL-2.1.txt) |

The following upstream header notices are retained for the adapted declarations
and the GLib/libgee source inventory. They do not replace the full license texts.

### gfxstream borrowed-image declarations

```text
// Copyright 2022 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either expresso or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
```

### FFmpeg CUDA-context declaration

```text
/*
 * This file is part of FFmpeg.
 *
 * FFmpeg is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * FFmpeg is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with FFmpeg; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 */
```

### GLib main loop

```text
/* GLIB - Library of useful routines for C programming
 * Copyright (C) 1995-1997  Peter Mattis, Spencer Kimball and Josh MacDonald
 *
 * gmain.c: Main loop abstraction, timeouts, and idle functions
 * Copyright 1998 Owen Taylor
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.	 See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, see <http://www.gnu.org/licenses/>.
 */
```

### libgee hashmap

```text
/* hashmap.vala
 *
 * Copyright (C) 1995-1997  Peter Mattis, Spencer Kimball and Josh MacDonald
 * Copyright (C) 1997-2000  GLib Team and others
 * Copyright (C) 2007-2009  Jürg Billeter
 * Copyright (C) 2009-2014  Maciej Piechotka
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.

 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.

 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301  USA
 *
 * Author:
 * 	Jürg Billeter <j@bitron.ch>
 */
```

### XZ / liblzma

This software includes code from XZ Utils. At the pinned revision, upstream
places the liblzma library source in the public domain and additionally states:

```text
You can do whatever you want with the files that have been put into
    the public domain. If you find public domain legally problematic,
    take the previous sentence as a license grant. If you still find
    the lack of copyright legally problematic, you have too many
    lawyers.

    As usual, this software is provided "as is", without any warranty.
```

## Embedded helpers and external runtimes

`inject` contains Frida's native bootstrapper/loader and BPF activity-sampler,
spawn-gater and syscall-tracer payloads. Their sources are in
[Frida Core's Linux helpers](https://github.com/frida/frida-core/tree/0602e5dca4c9d7be6098fc319edf978724dabeab/src/linux/helpers).
The native helpers use Frida Core terms, subject to incorporated Linux/header
material. The BPF programs declare `Dual BSD/GPL`; their exact variants and
incorporated notices remain unresolved. The ordinary libbpf BSD choice above
does not resolve these separate programs' terms.

The NVIDIA driver and NVRTC compiler are external prerequisites, not bundled
binaries. NVIDIA's terms remain applicable; MIT interface headers do not
relicense them. The Android Emulator and its system images are not bundled.
System C/C++ runtimes are supplied by the host.

## Distribution status

These notices do not constitute a matching source distribution or written source
offer. Static LGPL dependencies require applicable source and rebuild/relink
materials. Matching source delivery, the embedded-helper audit, generated NVIDIA
material and the emulator-integration scope remain unresolved; this notice does
not establish release clearance or assign a package-wide GPL license.
