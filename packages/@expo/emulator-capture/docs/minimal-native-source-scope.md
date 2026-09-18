# Minimal source scope for the two Linux native outputs

For the current Linux x86_64 profile, **no npm package is needed to build
`libgpu_capture.so` or `inject`**. The Frida npm cache is an unnecessary result of
our broad source-fetch workflow. Vala is needed: Frida Core is written partly in
Vala, which the Vala compiler translates into C before the C compiler builds it.

This is a technical dependency audit of the pinned profile, not a conclusion
about the applicable GPL source-delivery obligations. It proposes changes to
the next source archive; it does not change the running build, source receipts,
or release gates.

## Vala source versus the Vala compiler

Keep Frida's `.vala` files: they are the editable input for its Core, agent,
helper, and resource compiler. Generated C alone would discard that input.
`valac` is a build tool; it is not a Vala virtual machine shipped with either
native output. The resulting native code uses linked libraries such as GLib,
GObject, and GIO, whose source must remain in the technical build closure.
The distinction is described by the pinned [Vala README](https://github.com/frida/vala/blob/172348fa9123ff4a95d541c5f9e56837434c4b6e/README.md).

The pinned [Core build](https://github.com/frida/frida-core/blob/0602e5dca4c9d7be6098fc319edf978724dabeab/meson.build#L11)
requires a Vala version ending in `-frida`. Our current recipe builds that fork
from `dependency-sources/vala`, using the distro Vala compiler and distro GLib as
bootstrap tools. Keeping this compiler source makes the rebuild self-sufficient
with respect to the special Frida compiler; whether its source must be included
in a particular legally sufficient delivery is a separate question. It is not
the same thing as shipping `libvala` in the two outputs.

## Why npm is currently downloaded, and why this profile does not need it

[`frida-source.py`](../scripts/frida-source.py) walks every fetched dependency's
nested package locks, runs `npm ci` during fetch, and repeats it offline before
the native build. That walk is broader than the enabled Meson build graph.

There are 16 selected manifests in the current fetched tree:

| Source prefix | Package-lock paths under that prefix | Count |
| --- | --- | --- |
| `subprojects/frida-core/` | `src/barebone/package-lock.json`; `src/compiler/package-lock.json`; `src/darwin/agent/osanalytics/package-lock.json`; `src/darwin/agent/reportcrash/package-lock.json` | 4 |
| `dependency-sources/v8/` | `tools/package-lock.json`; `tools/clusterfuzz/js_fuzzer/package-lock.json`; `tools/tracing/proto-converter/package-lock.json`; `tools/turbolizer/package-lock.json` | 4 |
| `subprojects/frida-gum/subprojects/v8/` | The same four V8 paths above | 4 |
| `subprojects/frida-core/subprojects/frida-gum/subprojects/v8/` | The same four V8 paths above | 4 |

All 16 are inactive here:

- [Core's Node/npm check](https://github.com/frida/frida-core/blob/0602e5dca4c9d7be6098fc319edf978724dabeab/meson.build#L642)
  runs for Darwin, Android, or enabled barebone/compiler backends. This build is
  Linux, with both backends disabled. The compiler and barebone Meson recipes
  place their npm-consuming custom targets inside those feature conditions.
- V8 is disabled. Its fuzzing, tracing, and visualization packages do not build
  the enabled QuickJS engine.
- [Gum's runtime recipe](https://github.com/frida/frida-gum/blob/22e077120358a49b26e32110a6e2b8e80f1ed7f1/bindings/gumjs/meson.build#L175)
  consumes checked-in JavaScript. Its
  [Python generator](https://github.com/frida/frida-gum/blob/22e077120358a49b26e32110a6e2b8e80f1ed7f1/bindings/gumjs/generate-runtime.py)
  invokes the newly compiled `quickcompile` program to produce QuickJS bytecode;
  it does not install npm packages.
- Expo's [package manifest](../package.json) has no npm dependencies. Its native
  build scripts use Bun's built-in APIs and Node-compatible built-ins.
  [`compile-scale.mjs`](../scripts/compile-scale.mjs) uses Bun FFI to call NVRTC.
  Bun and NVRTC remain build tools; an npm cache is not required to run them.
  The separate `src/cli.mjs` Node CLI is outside the user's two-binary scope.

Therefore the next profile-specific recipe can omit Frida's entire `npm-cache`,
all 16 npm install operations, and Node/npm from its compiler image. This must
be validated by a fresh offline build with those tools/cache absent; the current
[successful rebuild](linux-source-rebuild-validation.md) still used the broader
environment.

## Source that the current native graph still needs

[`build.mjs`](../scripts/build.mjs) links Expo's capture/hook C++, generated CUDA
PTX from `src/scale.cu`, the Gum devkit, and FFmpeg's `libavcodec`/`libavutil` into
`libgpu_capture.so`. It links `src/inject.cpp` and the Core devkit into `inject`.
Keep the corresponding source, codec headers, required interfaces, build scripts,
configuration, license texts, patches, and version pins. Keep the checked-in
JavaScript used by the QuickJS runtime even though npm is unnecessary.

The real configure's `intro-targets.json` identifies Core/Gum plus these 24
target-owning dependency projects:

`brotli`, `capstone`, `elfutils`, `glib`, `glib-networking`, `json-glib`, `libbpf`,
`libdwarf`, `libffi`, `libgee`, `libnice`, `libpsl`, `libsoup`, `libunwind`, `lzfse`,
`nghttp2`, `openssl`, `pcre2`, `quickjs`, `sqlite`, `tinycc`, `usrsctp`, `xz`, `zlib`.

This list is a starting point, not a complete file manifest: for example, **GVDB
is also required**, although it has no independent library target. Build-system
files, included headers, generators, and resources can be needed without owning
a target. Use actual configured source locations; the current fetch also carries
duplicate copies of these repositories in unused directories.

Keep the Linux helper payload sources and resolve their missing dependencies
described in [the payload audit](frida-linux-payloads.md). Removing unrelated
sources does not repair the missing Linux v6.2/nolibc/UAPI and matching libbpf
header inputs used to regenerate the five helper payloads.

## Recommended exclusions and their limits

These are candidates for the next profile-specific fetch/verification/archive
recipe, not instructions to delete files from the current receipted tree.

| Candidate | Basis and required care |
| --- | --- |
| All Frida npm caches and npm installs | All 16 selected manifests are inactive, as shown above. |
| V8 sources, including its duplicated copies | `frida-gum:v8=disabled`; QuickJS remains included. |
| `frida-node`, `frida-python`, `frida-clr`, `frida-swift`, `frida-qml`, `frida-tools` binding/tool repositories | Their root Meson options are explicitly disabled. Keep Frida's own `releng` and required Core/Gum build tools. |
| Duplicate `dependency-sources/*` repositories other than `vala` | The current native graph builds dependencies from the resolved Meson subproject trees; only the Vala bootstrap uses this separate directory directly. Retain each active subproject's actual source and pin. |
| Inactive dependency repositories: `picolibc`, `compiler-rt`, `libiconv`, `selinux`, `minizip-ng`, `libusb`, `lwip`, `libxml2`, `ngtcp2`, `v8`, `libcxx` | They own no targets in the inspected Linux graph. Removing their downloaded trees requires profile-aware source verification and another configure/build. System libc++ used by Expo is a separate build/link input from Frida's inactive `libcxx` repository. |
| Separately fetched Ninja and pkg-config source repositories | The recipe invokes the image's installed build tools instead; it does not compile these fetched copies. Preserve declared tool versions and installation instructions. |
| Core/Gum test-only source trees and disabled-platform runtime payloads | Core/Gum tests are disabled. Trim only after confirming no active generator/resource refers to the files. Do not infer that a filename mentioning another platform is unused. |
| Optional tools/tests within active dependencies | Use their build options or narrow target selection first. The current default build still configures PCRE2 tools/tests, GLib tools, libdwarf tests/tools, OpenSSL CLI, and libnice utilities. |

Further reductions need recipe changes. For example, root `graft_tool=auto`
currently enables `gum-graft`, which neither output needs; explicitly disabling
it avoids that target. In contrast, keep Core's `frida-resource-compiler` and
Gum's `quickcompile`, which generate embedded resources. Do not delete all of
Core's `src/compiler`: its `compiler.vala` and `backend-glue.c` are still listed
in the Core source graph even with the optional compiler backend disabled.
Likewise, Vala's Meson build unconditionally enters `doc` and `tests`; deleting
those directories without adapting its build would break configuration.

## Validation required before claiming a smaller archive works

1. Declare the exact two-output Linux profile and make fetch/verification follow
   that graph, including header-only dependencies and the five Linux payloads.
2. Remove npm operations and cache, inactive projects, and duplicate source trees
   from a fresh staged archive. Preserve original pins, patches, license files,
   and the recorded private-build adaptations.
3. Build from the extracted archive in a fresh Docker environment with networking
   disabled and Node/npm absent. Retain Bun/NVRTC or replace their recipes with
   an independently validated equivalent.
4. Require source-dependency checks and standalone devkit-header compilation,
   build both outputs, and repeat the modified-dependency rebuild test. Record
   the source manifest and build evidence for that exact distribution.

This approach removes demonstrably inactive material first. It does not rely on
the mistaken assumption that every fetched Frida repository or npm package is
part of these two binaries, nor that target enumeration alone is a complete
source audit.
