# Source archives and modified-dependency rebuilds

Original Expo code remains MIT; incorporated dependencies retain their own
licenses, notices and applicable source/relink requirements. The earlier blanket
combined-GPL assumption is superseded by the [gfxstream boundary findings](gfxstream-hook-source-boundary.md).
The current [compliance record](../sources/compliance.json) still contains
unresolved dependency, host-scope and source decisions. A development archive is
useful for rebuilding, but is not a declaration of completed release compliance.
`create --release` refuses unresolved records.

## Linux or Docker

Run commands from `packages/@expo/emulator-capture`, or from the root of an
extracted source archive. Native builds and the complete Frida fetch require
**Linux x86-64**; Frida's npm cache must match the target platform. Archiving and
integrity checks can also run on macOS. Use Python 3.11+, Bun
1.3.14 and the compiler/build tools listed in [Dockerfile.source](../Dockerfile.source).
A GPU, driver and emulator are unnecessary for building and native unit tests.
End-to-end capture still requires a supported NVIDIA/Android Emulator setup.

The Docker wrapper builds that tool image and mounts the current package:

```sh
bash scripts/source-container.sh fetch
bash scripts/source-container.sh create --version my-build
```

These are equivalent to local commands:

```sh
python3 scripts/source-archive.py fetch
python3 scripts/source-archive.py create --version my-build
python3 scripts/source-archive.py verify artifacts/sources/emulator-capture-source-my-build.tar.gz
```

`fetch` is the explicit network phase. It preserves existing source directories
and does not reset local changes. The archive includes source edits, build
scripts, dependency sources, notices and a file-hash manifest. It omits Git
metadata, source-tree credentials, downloaded binary devkits, NVRTC and emulator binaries.
Use fresh, unbuilt source trees: generated `.o`, `.a` and `.so` files in source
directories cause packaging to fail instead of silently shipping incomplete
or opaque dependency inputs. Frida's source workflow validates its own source
inventory before the archive is created. Verified upstream Frida test fixtures
and pre-generated payloads are preserved rather than silently removed; their
preferred sources and regeneration remain part of the release payload audit.
An inventory check alone does not establish complete corresponding source.

Archives are never overwritten. Use a new version/output name after edits.
The `.sha256` companion authenticates the archive against a separately trusted
published checksum; the internal manifest detects accidental changes, not a
malicious replacement of both archive and manifest.

## Rebuild an extracted archive

Verify before extraction. All sources are beneath one archive directory:

```sh
python3 scripts/source-archive.py verify emulator-capture-source-my-build.tar.gz
tar -xzf emulator-capture-source-my-build.tar.gz
cd emulator-capture-source-my-build
```

Prepare the build-only NVRTC compiler once, or point to your installed compiler:

```sh
bun scripts/prepare-source-tools.mjs
# Alternatively:
export POC_NVRTC_LIBRARY=/opt/cuda/lib64/libnvrtc.so.12
```

Then rebuild using the included editable dependency sources:

```sh
bash scripts/rebuild-from-source.sh
```

In Docker, use:

```sh
bash scripts/source-container.sh run bun scripts/prepare-source-tools.mjs
POC_CONTAINER_OFFLINE=1 bash scripts/source-container.sh rebuild
```

The source rebuild selects locally rebuilt Frida devkits explicitly and runs
FFmpeg configuration/build, PTX generation, both native links, native tests and
`inject --help`. It must not fall back to upstream prebuilt Frida SDK/devkits.
Tool/bootstrap preparation is a separate concern from dependency source: keep
the prepared compiler/tools available for offline builds. NVRTC is governed by
NVIDIA's terms and is not part of the editable source archive.

The source-built Frida profile targets Linux x86-64. It disables compatibility
architectures, remote mobile/barebone backends, compiler backend and V8. It
therefore differs from the previously used official prebuilt devkits. A new
source-built release needs its own binary/payload inventory. The Linux x86-64
offline rebuild, native checks, and modified-FFmpeg relinking test passed in
Docker; see [the validation record](linux-source-rebuild-validation.md).
GPU capture remains untested, and five checked-in Frida helper payloads still
need their own regeneration inputs and verification. The current source fetch
is broader than these two outputs require; [the scope audit](minimal-native-source-scope.md)
identifies inactive npm packages and source trees for a subsequent smaller
archive. Fetching all pinned dependencies can use substantial disk space, and
the modification test keeps separate build/source copies.

## Replace one dependency

Relative environment paths are relative to the package/archive root, not the
shell's working directory. Absolute paths are also supported. Supplied source
directories must exist and are never replaced by setup downloads.

| Variable | Meaning |
| --- | --- |
| `POC_FFMPEG_SOURCE_DIR` | FFmpeg source; source rebuild defaults to `sources/ffmpeg` |
| `POC_NV_CODEC_HEADERS_SOURCE_DIR` | NVIDIA codec API header source; defaults to `sources/nv-codec-headers` |
| `POC_FRIDA_SOURCE_DIR` | Complete Frida source bundle; defaults to `sources/frida` |
| `POC_FRIDA_SOURCE_OVERRIDES` | JSON map from a Frida source subtree or `dependency:NAME` alias to an edited directory |
| `POC_FRIDA_BUILD_DIR` | Frida's private build copy; defaults to `build/frida-source-build` |
| `POC_FRIDA_DEVKIT_OUTPUT_DIR` | Source-built devkits and provenance; defaults to `build/frida-devkits` |
| `POC_FRIDA_GUM_DEVKIT_DIR` | Explicit rebuilt Gum devkit used by the native link |
| `POC_FRIDA_CORE_DEVKIT_DIR` | Explicit rebuilt Core devkit used by the native link |
| `POC_NVRTC_LIBRARY` | Installed build-only `libnvrtc.so.12` |
| `POC_BUILD_DIR` | Generated outputs; defaults to `build` |
| `POC_FFMPEG_BUILD_DIR` | FFmpeg object/configuration directory; defaults to `$POC_BUILD_DIR/ffmpeg` |
| `POC_DIST_DIR` | Final native output directory; defaults to `dist/linux-x64` |
| `POC_EMULATOR_SOURCE_DIR` | Reviewed corresponding host-source bundle, including its `source-manifest.json` |
| `POC_BUILD_JOBS` | Build parallelism; defaults to four for FFmpeg |
| `POC_OFFLINE=1` | Setup must fail rather than download missing dependency inputs |
| `POC_CONTAINER_OFFLINE=1` | Disable the Docker container's network during rebuilding |

For example, copy FFmpeg from the complete archive, edit that copy, and change
only its source path:

```sh
cp -a sources/ffmpeg sources/ffmpeg-local
# Edit sources/ffmpeg-local/libavcodec/...
POC_FFMPEG_SOURCE_DIR=sources/ffmpeg-local bash scripts/rebuild-from-source.sh
```

Or select a separately downloaded version:

```sh
POC_FFMPEG_SOURCE_DIR=/home/me/FFmpeg \
POC_NV_CODEC_HEADERS_SOURCE_DIR=/home/me/nv-codec-headers \
bash scripts/rebuild-from-source.sh
```

Use those same variables with `source-container.sh rebuild`. Absolute external
directories are mounted at the same paths; create external output directories
before starting Docker. The wrapper deduplicates identical bind mounts and
translates external directories in the Frida override map as well.

To modify GLib or another Frida dependency, copy its fetched source tree and
supply the edited directory. The `dependency:NAME` alias replaces every fetched
Meson wrap copy of that dependency, including its inventory copy:

```sh
export POC_FRIDA_SOURCE_OVERRIDES='{"dependency:glib":"/home/me/edited-glib"}'
export POC_FRIDA_BUILD_DIR=build/frida-edited
export POC_FRIDA_DEVKIT_OUTPUT_DIR=build/frida-edited-devkits
bash scripts/rebuild-from-source.sh
python3 scripts/source-archive.py create --version edited-glib
```

For a dependency without a named Meson wrap, use its exact relative directory
from `sources/frida/source-state.json` as the key instead. Overrides are applied
to a private build copy and are also baked into generated source archives, so
recipients do not need your absolute paths. The original fetched Frida receipt
is immutable; use overrides for edits, or fetch a fresh tree for a new lock.
Matching existing devkits can be reused; changed Frida inputs require fresh
build/output directories. Switching FFmpeg alone reuses the unchanged Frida
devkits. Changes of Frida version also require updating `sources/frida-lock.json`
and checking its root/submodule pins and build options.

Changing a source directory triggers FFmpeg object cleanup after configuration
to avoid reusing objects from a previous checkout. Editing files in the same
tree uses normal make dependency tracking. FFmpeg sources must be unconfigured
for an out-of-tree build. For an existing in-tree build, choose a fresh source
copy, run `make distclean` yourself, or deliberately set
`POC_FFMPEG_BUILD_DIR` equal to that source path.
Keep FFmpeg source and build paths free of whitespace; FFmpeg's build system
does not support these paths even though the wrapper preserves shell quoting.

Other versions are rebuild inputs, not promises of ABI/API compatibility.
The private gfxstream ABI, FFmpeg API, codec headers and Frida version may need
code changes. Review licenses and notices again when changing versions.
Restart the emulator before injecting a replacement library.

## Prove that a modified library is used

After preparing sources and tools, run on Linux:

```sh
python3 scripts/verify-source-rebuild.py
# Or:
POC_CONTAINER_OFFLINE=1 bash scripts/source-container.sh run python3 scripts/verify-source-rebuild.py
```

This uses fresh output directories, builds a baseline, copies FFmpeg to a
temporary source tree, inserts a harmless retained marker into an encoder
lookup function, and rebuilds with only the FFmpeg source path changed. It
checks that the marker reaches the final `libgpu_capture.so`, that its hash
changes, and that native tests and the injector help command pass. It never
patches your original source tree. If a different FFmpeg version changes that
function, the probe fails with an instruction to adapt it.

The script writes `binary-inventory.json`, `rebuild-verification.json` and
`modified-dependency-rebuild.json` under `artifacts/source-verification`.
Release **baseline** outputs from `build/source-verification/baseline-dist`;
the test-modified library is not a release artifact. Repeated runs require
fresh `--work-dir` and `--evidence-dir` names. This does not test GPU capture.

## Archive a validated development build

The basic `create --version my-build` command makes a source-only development
archive. To bind an archive to a successful rebuild while compatibility
questions remain unresolved, use fresh custom work and evidence directories:

```sh
python3 scripts/verify-source-rebuild.py \
  --work-dir build/source-verification-2 \
  --evidence-dir artifacts/source-verification-2

# Continue only after the rebuild and modified-dependency check succeed.
python3 scripts/source-archive.py create --version verified-2 \
  --with-build-evidence \
  --evidence-dir artifacts/source-verification-2 \
  --binary-dir build/source-verification-2/baseline-dist

python3 scripts/source-archive.py verify --with-build-evidence \
  --binary-dir build/source-verification-2/baseline-dist \
  artifacts/sources/emulator-capture-source-verified-2.tar.gz
```

Run these from the same package or extracted source tree, retaining the source
overrides used for the baseline. Use `source-container.sh run` for the rebuild
command and `source-container.sh create` / `verify` for the archive commands
when using Docker. Increment the directory and archive names for another run.
Select `baseline-dist`, not older default outputs or the test-modified library.

The manifest records `buildEvidenceVerified: true` and `releaseReady: false`:
source/binary matching and rebuild evidence are checked, while the unresolved
release limitations remain. Providing either `--evidence-dir` or `--binary-dir`
to `create` requires both and activates these checks. Ordinary `verify` checks
recorded build evidence too; the explicit command above also compares the
actual binaries. These commands do not resolve license permissions, publish a
source offer, or establish GPU capture behavior.

## Prepare a release source companion

First resolve and record the decisions in `sources/compliance.json`, including
whether the host integration forms a GPL-covered combined work and any resulting
host-source scope. Changing status flags without supporting evidence does not
provide permission.

The existing release archive path implements the earlier combined-program
case: it requires the reviewed host-source scope through
`POC_EMULATOR_SOURCE_DIR` and a matching `source-manifest.json` hash. This is not
a determination that host source is legally required, or that the entire SDK
belongs in the archive. An unresolved relationship blocks release. If the review
supports a different scope, adapt and verify the release archive checks for
that recorded outcome before using the commands below; unsupported outcomes
also remain blocked.

After the validation above, choose a permanent source URL and record the build
evidence without changing legal decisions:

```sh
python3 scripts/source-archive.py record-release \
  --evidence-dir artifacts/source-verification \
  --source-url https://example.org/releases/BUILD/emulator-capture-source-BUILD.tar.gz \
  --output build/compliance-release.json

python3 scripts/source-archive.py create --release --version BUILD \
  --compliance build/compliance-release.json \
  --evidence-dir artifacts/source-verification \
  --binary-dir build/source-verification/baseline-dist \
  --source-url https://example.org/releases/BUILD/emulator-capture-source-BUILD.tar.gz

python3 scripts/source-archive.py verify --release \
  --binary-dir build/source-verification/baseline-dist \
  artifacts/sources/emulator-capture-source-BUILD.tar.gz
```

Replace the example URL with the actual maintained download location.
The release archive checks source fingerprints against the native build,
binary hashes against the supplied outputs, and rebuild/relink evidence against
that same build. Creation generates `SOURCES.md` with the matching URL and
archive checksum. Publish the archive and checksum **before** distributing the
native binaries. Keep both available for every release, including canaries;
short-lived CI artifacts are insufficient as the public source location.

Preserve `LICENSE`, `LICENSES/`, `THIRD_PARTY_LICENSES.md` and `SOURCES.md`
with the binaries. The separate injector retains its component terms; its
complete dependency list is not automatically assigned to the injected agent.
