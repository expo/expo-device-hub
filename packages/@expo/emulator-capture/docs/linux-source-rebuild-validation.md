# Linux native rebuild validation

Validated on 2026-09-17 for PR #107, using a Linux x86-64 Docker container with
networking disabled. Both `libgpu_capture.so` and `inject` built successfully
from the exported source snapshot plus the recorded source/recipe repairs.
This is a development validation, not release clearance or a claim that every
embedded payload was regenerated.

## Checks that passed

- Verified 332,013 Frida source inputs after repairing eight empty GVDB
  placeholders. The repair added 95 files without changing previously recorded
  source content.
- Bootstrapped Vala 0.58.0-frida, built the Frida Gum and Core devkits, and compiled
  both generated headers standalone. Generated headers remain inside Frida's
  private source tree so its devkit generator includes them.
- Normalized malformed wrap provider lists in the private build copy, with
  before/after hashes. Meson selected bundled PCRE2 10.41 rather than distro
  PCRE2; the pre-compilation dependency check passed.
- Built FFmpeg, generated the CUDA PTX through the external NVRTC compiler, and
  linked the two native outputs. Native format/pacing tests and `inject --help`
  passed.
- Copied FFmpeg, added a retained marker in its encoder lookup function, selected
  that copy through `POC_FFMPEG_SOURCE_DIR`, and rebuilt. The marker appeared only
  in the modified `libgpu_capture.so`, its hash changed, and native checks passed.
- Passed 82 source/archive workflow tests, 21 Frida source tests, and the
  configure-only regression using Frida's pinned Meson in Docker (104 total).

The container image was `expo-emulator-capture-source:local`, ID
`sha256:6a0fe032bf5ff7570e1554a7dc9940086c5560546a90cdd3b38aef504f857a04`.
It used Debian bookworm, GCC 12.2.0, Clang 14.0.6, Python 3.11.2, Bun 1.3.14,
and distro Vala 0.56.3 to bootstrap the pinned Frida Vala fork. NVRTC 12.9.86
was a separately supplied build tool. The container ran with `--network none`.

## Outputs and evidence

| Artifact | SHA-256 |
| --- | --- |
| Baseline `libgpu_capture.so` | `2cef3fe3c01d084f8ba7fd5971e17c842280e4a0892d2d2643c0f16eb1bc0e1a` |
| Baseline `inject` | `c961dd9f1b721e2ec319ab7a873feeb40776af94efb467c9b9da0a54fcb91cb4` |
| Test-modified `libgpu_capture.so` | `dc7b3b398737531c8421874acdf8cecb578fefb97ba5e064d617b9dfe4fd2480` |
| Baseline binary inventory | `d1698bc5f88e38d2d6e085087abeb68c207fbbae1cc3c0633e45de09652946eb` |

Local baseline binaries are saved under
`artifacts/linux-source-rebuild/baseline-dist/`. The test-modified binary is not
a distribution artifact. Machine-readable validation is under
`artifacts/source-verification-4/`:

- `binary-inventory.json`: actual source, recipe, dependency, and output hashes.
- `frida-build.json`: source inputs, compiler version, devkit hashes, wrap
  adaptations, and source-dependency checks.
- `rebuild-verification.json`: successful baseline checks bound to that inventory.
- `modified-dependency-rebuild.json`: modified source/output hashes and marker proof.

The evidence and binary hashes were checked again after the container completed.
The captured `rebuild-4.log` ends during the second FFmpeg compilation after a
conversation interruption; the completed evidence and outputs were recovered
from the Docker volume. Do not interpret that partial log as a complete transcript.

## Limits and archive status

GPU capture and injection into a running emulator were not exercised. Five
upstream helper payloads remain checked-in inputs; their Frida sources are
present, but additional Linux/libbpf regeneration inputs are missing. See
[the payload audit](frida-linux-payloads.md).

The existing 910 MiB development archive predates the GVDB and recipe repairs.
Its file integrity passed, but it is not the final verified source companion for
these binaries. The working source tree and scripts contain the repairs; a new
archive must be created and matched to the evidence before distribution.
The [minimal two-binary scope audit](minimal-native-source-scope.md) identifies
unused npm inputs, inactive projects, and duplicate sources to remove through
a separately validated profile. No smaller archive has yet been validated.

The unresolved records in `sources/compliance.json` remain unchanged. Building
successfully does not resolve GPL version compatibility, the assumed emulator
combination's source scope, NVIDIA permissions, or payload-source completeness.
