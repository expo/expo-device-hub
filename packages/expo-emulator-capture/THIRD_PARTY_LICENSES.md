# Third-party licenses

Original Expo code is [MIT-licensed](LICENSE). The agent library
`libexpo_emulator_capture.dylib` also contains third-party components from the
Frida Gum devkit under the terms below. `+` means "or later."

Common license texts are included once in `LICENSES/`. The shared wxWindows file
includes Frida Gum's additional third-party notices; those notices apply to Gum.

## Native dependencies

The agent links `libfrida-gum.a` from the Frida 17.18.0 macOS arm64 devkit, the
same Frida release as the Linux experiment in PR #107. The linker removes unused
code (`-dead_strip`), but this list follows the archive's contents.

| Component and pinned source                                                                               | License text                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Frida Gum 17.18.0](https://github.com/frida/frida-gum/tree/22e077120358a49b26e32110a6e2b8e80f1ed7f1)     | [wxWindows 3.1](LICENSES/wxWindows-3.1.txt), [LGPL-2.0+](LICENSES/LGPL-2.0.txt) with binary linking exception                                                                                                 |
| [GLib / GObject](https://github.com/frida/glib/tree/129e8d998936cdd47be41d25d3ffd1294c26a920)             | [LGPL-2.1+](LICENSES/LGPL-2.1.txt); per-file [MIT](LICENSES/MIT.txt), [Apache-2.0](LICENSES/Apache-2.0.txt), [LLVM exception](LICENSES/LLVM-exception.txt) and [CC0](LICENSES/CC0-1.0.txt) notices also apply |
| [Capstone](https://github.com/frida/capstone/tree/d536b1577fd033a31d75f48fd183aa425256cc18)               | [BSD-3-Clause](LICENSES/BSD-3-Clause-Capstone.txt), [LLVM/NCSA](LICENSES/NCSA.txt)                                                                                                                            |
| [libffi](https://github.com/frida/libffi/tree/2b42587b9b5c8f4ab4144b615014e20d9e4d396f)                   | [MIT](LICENSES/MIT.txt)                                                                                                                                                                                       |
| [XZ / liblzma](https://github.com/frida/xz/tree/e70f5800ab5001c9509d374dbf3e7e6b866c43fe)                 | Public-domain library source at this revision; upstream grant below                                                                                                                                           |
| [PCRE2](https://github.com/frida/pcre2/tree/b47486922fdc3486499b310dc9cf903449700474)                     | [BSD-3-Clause-style terms and binary-package exemption](LICENSES/BSD-3-Clause-PCRE2.txt)                                                                                                                      |
| [zlib](https://github.com/frida/zlib/tree/171a3eacaea8b731ef1fc586e7777b77742e2a1d)                       | [Zlib](LICENSES/Zlib.txt)                                                                                                                                                                                     |
| [TinyCC](https://github.com/frida/tinycc) (Gum's CModule support; revision not yet pinned in this notice) | [LGPL-2.1+](LICENSES/LGPL-2.1.txt)                                                                                                                                                                            |

Frida's wxWindows exception does not replace its dependencies' separate terms.

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
The Android Emulator and its system images are not bundled.

## Distribution status

The package is private. These notices do not constitute a matching source
distribution or written source offer. Static LGPL dependencies require applicable
source and rebuild/relink materials, and the TinyCC revision is not yet pinned
here. This notice does not establish release clearance.
