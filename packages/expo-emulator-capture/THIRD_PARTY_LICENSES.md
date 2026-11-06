# Third-party licenses

Original Expo code is [MIT-licensed](LICENSE). The agent libraries
`libexpo_emulator_capture.dylib` (macOS) and `libexpo_emulator_capture.so` (Linux)
also contain third-party components from the Frida Gum devkits under the terms
below. `+` means "or later."

Common license texts are included once in `LICENSES/`. The shared wxWindows file
includes Frida Gum's additional third-party notices; those notices apply to Gum.

## Native dependencies

Each agent links `libfrida-gum.a` from the Frida 17.18.0 devkit for its platform
(macOS arm64 or Linux x86-64), the same Frida release as the Linux experiment in
PR #107. The linkers remove unused code (`-dead_strip`, `--gc-sections`), but this
list follows the archives' contents. Rows marked (Linux) are only in the Linux
devkit.

| Component and pinned source                                                                                     | License text                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Frida Gum 17.18.0](https://github.com/frida/frida-gum/tree/22e077120358a49b26e32110a6e2b8e80f1ed7f1)           | [wxWindows 3.1](LICENSES/wxWindows-3.1.txt), [LGPL-2.0+](LICENSES/LGPL-2.0.txt) with binary linking exception                                                                                                 |
| [GLib / GObject](https://github.com/frida/glib/tree/129e8d998936cdd47be41d25d3ffd1294c26a920)                   | [LGPL-2.1+](LICENSES/LGPL-2.1.txt); per-file [MIT](LICENSES/MIT.txt), [Apache-2.0](LICENSES/Apache-2.0.txt), [LLVM exception](LICENSES/LLVM-exception.txt) and [CC0](LICENSES/CC0-1.0.txt) notices also apply |
| [JSON-GLib](https://github.com/frida/json-glib/tree/1a39cbe151b02c4192987c8fcc98997a59db2154)                   | [LGPL-2.1+](LICENSES/LGPL-2.1.txt)                                                                                                                                                                            |
| [Capstone](https://github.com/frida/capstone/tree/d536b1577fd033a31d75f48fd183aa425256cc18)                     | [BSD-3-Clause](LICENSES/BSD-3-Clause-Capstone.txt), [LLVM/NCSA](LICENSES/NCSA.txt)                                                                                                                            |
| [libffi](https://github.com/frida/libffi/tree/2b42587b9b5c8f4ab4144b615014e20d9e4d396f)                         | [MIT](LICENSES/MIT.txt)                                                                                                                                                                                       |
| [XZ / liblzma](https://github.com/frida/xz/tree/e70f5800ab5001c9509d374dbf3e7e6b866c43fe)                       | Public-domain library source at this revision; upstream grant below                                                                                                                                           |
| [PCRE2](https://github.com/frida/pcre2/tree/b47486922fdc3486499b310dc9cf903449700474)                           | [BSD-3-Clause-style terms and binary-package exemption](LICENSES/BSD-3-Clause-PCRE2.txt)                                                                                                                      |
| [zlib](https://github.com/frida/zlib/tree/171a3eacaea8b731ef1fc586e7777b77742e2a1d)                             | [Zlib](LICENSES/Zlib.txt)                                                                                                                                                                                     |
| [TinyCC](https://github.com/frida/tinycc/tree/3da7432bebd348bf16cdc7a22c3717b4f22946af) (Gum's CModule support) | [LGPL-2.1+](LICENSES/LGPL-2.1.txt)                                                                                                                                                                            |
| [libdwarf](https://github.com/frida/libdwarf/tree/61ff154ae803d2b0202dbc1bf385cda1ac3ece54) (Linux)             | [LGPL-2.1](LICENSES/LGPL-2.1.txt); some files [BSD-2-Clause](LICENSES/BSD-2-Clause-libdwarf.txt)                                                                                                              |
| [libunwind](https://github.com/frida/libunwind/tree/4d0abea0effd3c80916e70abe38c2a6156596f05) (Linux)           | [MIT](LICENSES/MIT.txt); notice below                                                                                                                                                                         |

Frida's wxWindows exception does not replace its dependencies' separate terms.

The Linux agent also links the GCC C++ library (libstdc++) and its support library
(libgcc) statically. They are licensed under GPL-3.0 with the GCC Runtime Library
Exception, which permits this for code that GCC compiles.

## Incorporated interfaces and notices

| Material in the agent               | Source and license                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapted borrowed-image declarations | [gfxstream BorrowedImage.h](https://android.googlesource.com/platform/hardware/google/gfxstream/+/35d53baaa71ec845d4e616dc7a31cc7d8d5f640b/host/BorrowedImage.h) and [BorrowedImageGl.h](https://android.googlesource.com/platform/hardware/google/gfxstream/+/35d53baaa71ec845d4e616dc7a31cc7d8d5f640b/host/gl/BorrowedImageGl.h), [Apache-2.0](LICENSES/Apache-2.0.txt) |

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
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
```

### libunwind (Linux)

```text
Copyright (c) 2002 Hewlett-Packard Co.
```

The MIT license text in `LICENSES/MIT.txt` applies with this copyright notice.

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

## System frameworks and external runtimes

VideoToolbox, CoreVideo, CoreMedia, IOSurface, OpenGL and Accelerate are macOS
system frameworks; the agent links them dynamically and does not bundle them.
The Linux agent links the C library and the math library dynamically, and loads x264
build 165 (`libx264.so.165`, GPL-2.0-or-later) from the host system at run time; the
package does not contain x264. The Android Emulator and its system images are not
bundled.

## Source code

The npm package contains the agent's own source code (`src/native`) and its build
scripts (`scripts`). `bun run build` (macOS with Apple silicon and the Xcode command
line tools) and `bun run build:linux-x64` (Linux x86-64 with g++ and the x264 build 165
header, `libx264-dev` on Ubuntu 26.04) download the pinned Frida Gum devkit, check its
SHA-256 digest, and link the agent, so the agent can be rebuilt and relinked with a
modified copy of a statically linked component. The source code of each
statically linked third-party component is at the revision that the table above
links. The revisions are the ones that Frida 17.18.0 pins in its dependency list
(`releng/deps.toml` at `frida/releng` commit
`963fe3826f861a7d844d235957f2f13738e3a73b`).
