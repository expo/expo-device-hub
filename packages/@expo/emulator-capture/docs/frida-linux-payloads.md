# Linux Frida payload source audit

The Linux x86_64 offline build regenerates the Frida agent, helper executable,
and QuickJS runtime. It still embeds **five upstream checked-in helper payloads**
without rebuilding them. The current source archive includes their Frida source
code and build recipes, but is missing additional inputs needed to regenerate
them. A successful main build therefore does not establish complete regeneration
of all embedded code. This report does not provide legal clearance or change any
release gate.

This audit covers the pinned Frida 17.18.0 profile in
[`frida-source.py`](../scripts/frida-source.py): Linux x86_64, embedded assets,
compatibility builds disabled, and compiler, mobile, barebone, and V8 backends
disabled. Frida Core is pinned to commit
`0602e5dca4c9d7be6098fc319edf978724dabeab`; Gum is pinned to
`22e077120358a49b26e32110a6e2b8e80f1ed7f1`. All pins are recorded in
[`frida-lock.json`](../sources/frida-lock.json).

## What the build actually regenerates

The development log `artifacts/linux-source-rebuild/rebuild-2.log` records these
targets. The log is local validation evidence, not a required source input.

| Component | Evidence from the build | Pinned upstream recipe |
| --- | --- | --- |
| Agent shared library | Steps 2896 and 2899 compile C and Vala-generated C; 2909 links `libfrida-agent-raw.so`; 2911–2913 modulate, postprocess, and embed the resulting agent. | `subprojects/frida-core/lib/agent/meson.build:57` and `subprojects/frida-core/src/meson.build:506` |
| Linux helper executable and backend | Steps 2870 and 2906 compile Vala; 2908 links the helper backend; 2914–2915 link and postprocess `frida-helper`. | `subprojects/frida-core/src/meson.build:352` and `:440` |
| QuickJS runtime | Steps 2338 and 2440 compile/link `quickcompile`; step 2443 generates `gumjs-runtime` from checked-in JavaScript. | `subprojects/frida-gum/bindings/gumjs/meson.build:69` and `:175` |
| Compatibility bundle | Step 2824 generates `arch-support`; with compat disabled, the upstream script writes an empty bundle. It does not fetch a compatibility agent. | `subprojects/frida-core/compat/build.py:150` and `:502` |

For Linux, Core deliberately omits the same-architecture helper executable from
its embedded helper-process resources, because its in-process backend provides
the same capabilities. With compatibility builds disabled, absent helper/agent
architecture slots are empty resources. This does **not** remove the separate
helper-backend payloads below. See Core `src/meson.build:467`, `src/embed-helper.py`,
and `src/embed-agent.py`.

[`build.mjs`](../scripts/build.mjs) links the Gum devkit into the injected capture
library and the Core devkit into the driver. The five helper payloads below are
inputs to the Core side of this build. The subsequent 2026-09-18
[final-binary audit](native-binary-dependencies.md) matched all five byte sequences
inside loadable segments of the current injector and found none in the capture
library. That confirms inclusion; the regeneration-input and incorporated-license
gaps below remain unresolved.

## The five payloads still supplied as checked-in binaries

Paths in this section are relative to
`sources/frida/subprojects/frida-core/src/linux/helpers/` unless stated otherwise.
Core `src/meson.build:381–413` feeds these exact source-tree artifacts to the
resource compiler. Log step 2857 generates `frida-data-helper-backend`; steps
2888–2889 compile its generated resource representation. Those steps package the
existing payloads; they do not compile the payload sources.

| Embedded artifact | Preferred Frida source already included |
| --- | --- |
| `artifacts/native/x86_64/bootstrapper.bin` | `bootstrapper.c`, `elf-parser.c`, their headers, `inject-context.h`, `helper.lds` |
| `artifacts/native/x86_64/loader.bin` | `loader.c`, `syscall.c`, `syscall.h`, `inject-context.h`, `helper.lds` |
| `artifacts/bpf/noarch-little/activity-sampler.elf` | `activity-sampler.bpf.c` |
| `artifacts/bpf/x86_64/spawn-gater.elf` | `spawn-gater.bpf.c`; Core `lib/base/linux-syscalls/x86_64.vala` |
| `artifacts/bpf/x86_64/syscall-tracer.elf` | `syscall-tracer.bpf.c`; Core `lib/base/linux-syscalls/x86_64.vala` |

The helper `meson.build`, `Makefile`, `rebuild.sh`, and
`patches/linux-headers-install-portability.patch` and
`patches/linux-nolibc-tweaks.patch` are also included.

### Missing or unmatched inputs

1. **Linux v6.2 source.** The upstream Makefile fetches the `v6.2` tag of
   `https://github.com/torvalds/linux.git`, applies both included patches, and uses
   `tools/include/nolibc/nolibc.h` for the native bootstrapper. It also runs
   `make ARCH=x86 headers_install` for the BPF UAPI headers. The fetched Frida
   tree has no `helpers/ext/linux` directory. This Linux source is not in the
   current source closure. The tag still needs an immutable commit/archive hash
   in our lock before adding a reproducible fetch step.
2. **The BPF header version used by the upstream recipe.** The helper Makefile
   downloads `libbpf-devel-1.6.3-1.fc44.x86_64.rpm` from Fedora and extracts its
   headers. The current archive instead includes Frida's separately pinned
   libbpf **1.7.0** source at commit
   `6c8d0d00a122fe126b7a3094f0785340128506f5`. That is not evidence of the exact
   1.6.3 header inputs. Add pinned libbpf 1.6.3 source and verify the installed
   header contents against the specified Fedora package, including any Fedora
   patches; alternatively document and validate an intentional change to the
   available 1.7.0 headers. Do not silently equate these versions.

These omissions are not hidden network downloads in the tested main build:
the main Meson graph consumes the checked-in artifacts directly. They become
necessary when independently rebuilding those artifacts.

## Upstream regeneration entry points

The upstream `helpers/rebuild.sh x86_64` is intended to run inside its own helper
container with `XTOOLS_HOST` set. It configures Core and invokes the helper
Makefile. Running it unchanged is not our offline recipe: it can fetch prebuilds,
the Makefile can download Linux/RPM inputs, and its Linux refresh recipe uses
`git reset --hard`. Never run that refresh against a user-maintained source tree.

The underlying targets are suitable for a controlled build on a private copy.
After supplying the patched Linux tree and matching libbpf headers, the upstream
Makefile offers the following entry points. This is a recipe outline, **not a
validated command to run against the current incomplete archive**:

```sh
# Set these to the private copy and its generated native machine file.
HELPERS=/path/to/private/frida-core/src/linux/helpers
MESON_SCRIPT=/path/to/frida/releng/meson/meson.py
CROSS_FILE=/path/to/native/frida-linux-x86_64.txt
VALAC=/path/to/rebuilt/toolchain/bin/valac

make -C "$HELPERS" build-native \
  FRIDA_HOST=linux-x86_64 "crossfile=$CROSS_FILE" \
  "MESON=python3 $MESON_SCRIPT"

# -W forces regeneration of the checked-in payload targets without forcing
# the Linux download/patch prerequisite. Build sequentially: these rules share
# and recreate a temporary build directory.
make -j1 -C "$HELPERS" \
  -W activity-sampler.bpf.c -W spawn-gater.bpf.c -W syscall-tracer.bpf.c \
  artifacts/bpf/noarch-little/activity-sampler.elf \
  artifacts/bpf/x86_64/spawn-gater.elf \
  artifacts/bpf/x86_64/syscall-tracer.elf \
  FRIDA_HOST=linux-x86_64 "crossfile=$CROSS_FILE" \
  "valac=$VALAC" BPF_CLANG=clang KERNEL_AWK=gawk
```

The native recipe requires GCC or a compatible compiler, linker, objcopy,
Meson/Ninja, and the patched nolibc headers. The BPF recipe requires a Clang with
the BPF target, Linux UAPI header-install tools, GNU awk, and the rebuilt Frida
Vala compiler for the architecture syscall header. Debian's default `awk` must
not be assumed sufficient: the upstream recipe uses GNU awk's array form of
`match`. The existing Docker image has GCC, Clang 14, binutils, Meson, and Ninja;
this audit has not validated Clang 14 against the three BPF programs or checked
every Linux header-install prerequisite.

## Follow-up implementation scope

The bounded follow-up is a separate source-fetch addition and a pre-Meson helper
regeneration step, followed by another offline Core/devkit and native build:

1. Pin and fetch Linux v6.2 plus the selected libbpf header source during the
   explicit network phase. Include hashes and provenance in the source receipt.
2. Copy them into the private build tree, apply the two pinned patches there,
   and produce x86 UAPI headers. Avoid the upstream network/reset recipes.
3. Regenerate only the two native and three BPF artifacts for this profile,
   record input/output hashes, then run the existing Core build against them.
4. Validate under `--network none` and verify that edits to a helper source
   regenerate its payload and the resulting devkit. Record the compiler versions;
   differing output hashes from upstream do not by themselves imply failure.

Prefer the complete pinned Linux release source for the first implementation.
A header-only subset must also contain nolibc's transitive includes, the UAPI
header generation sources/scripts, both patch targets, and license files. An
unvalidated subset risks repeating the missing-source error. Shipping only
already-generated `headers_install` output would also omit the preferred inputs
needed to regenerate those headers. A later audited subset is possible, but
requires its own dependency-closure validation.

This is a moderate follow-up rather than a flag change: the source and upstream
recipes are available, but the missing inputs, header-version decision, build
prerequisites, and BPF compiler compatibility still need to be resolved and
tested. No full Linux source download or payload rebuild was performed as part
of this bounded audit.
