#!/usr/bin/env python3
"""Build clean outputs, then prove a modified FFmpeg is relinked into capture.

The probe alters only an owned temporary source copy; it needs no NVIDIA GPU.
It checks the actual injected ELF for the marker, not just a dependency archive.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def save(path, data):
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", default="build/source-verification")
    parser.add_argument("--evidence-dir", default="artifacts/source-verification")
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine() not in {"x86_64", "amd64"}:
        raise ValueError("Source rebuild validation requires Linux x64; use source-container.sh run python3 scripts/verify-source-rebuild.py")
    work = (ROOT / args.work_dir).resolve()
    evidence = (ROOT / args.evidence_dir).resolve()
    if work.exists() or evidence.exists():
        raise ValueError("Choose fresh work/evidence directories; previous validation evidence is never overwritten")
    work.mkdir(parents=True)
    evidence.mkdir(parents=True)
    environment = dict(os.environ)
    source = (ROOT / environment.get("POC_FFMPEG_SOURCE_DIR", "sources/ffmpeg")).resolve()
    environment.update(POC_BUILD_DIR=str(work / "baseline"), POC_DIST_DIR=str(work / "baseline-dist"),
                       POC_FRIDA_BUILD_DIR=str(work / "frida-build"),
                       POC_FRIDA_DEVKIT_OUTPUT_DIR=str(work / "frida-devkits"))
    # The baseline must rebuild Frida too. The modified-FFmpeg run below reuses
    # only these newly built devkits, never a caller's earlier Frida outputs.
    # A caller's in-tree FFmpeg build path must not undermine the clean test.
    environment["POC_FFMPEG_BUILD_DIR"] = str(work / "baseline/ffmpeg")
    subprocess.run(["bash", "scripts/rebuild-from-source.sh"], cwd=ROOT, env=environment, check=True)
    native = work / "baseline/native-build.json"
    shutil.copy2(native, evidence / "binary-inventory.json")
    inventory = json.loads(native.read_text())
    inventory_hash = digest(native)
    devkits = (ROOT / environment.get("POC_FRIDA_DEVKIT_OUTPUT_DIR", "build/frida-devkits")).resolve()
    shutil.copy2(devkits / "build-provenance.json", evidence / "frida-build.json")
    original = work / "baseline-dist/libgpu_capture.so"
    original_hash = digest(original)

    spec = importlib.util.spec_from_file_location("source_archive", ROOT / "scripts/source-archive.py")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    replacement = work / "modified-ffmpeg"
    helper.copy_sources(source, replacement)
    codec_file = replacement / "libavcodec/allcodecs.c"
    text = codec_file.read_text()
    signature = "const AVCodec *avcodec_find_encoder_by_name(const char *name)\n{"
    if text.count(signature) != 1:
        raise ValueError("FFmpeg API changed; adapt the explicit relink probe for this version before validation")
    marker = "expo-emulator-capture-modified-ffmpeg-proof"
    if marker.encode() in original.read_bytes():
        raise ValueError("Baseline already contains modification probe")
    codec_file.write_text(text.replace(signature, signature +
        '\n    static const volatile char expo_relink_probe[] = "' + marker + '";\n    (void)expo_relink_probe[0];', 1))
    environment.update(POC_FFMPEG_SOURCE_DIR=str(replacement), POC_BUILD_DIR=str(work / "modified"),
                       POC_FFMPEG_BUILD_DIR=str(work / "modified/ffmpeg"), POC_DIST_DIR=str(work / "modified-dist"))
    subprocess.run(["bash", "scripts/rebuild-from-source.sh"], cwd=ROOT, env=environment, check=True)
    modified = work / "modified-dist/libgpu_capture.so"
    modified_hash = digest(modified)
    if marker.encode() not in modified.read_bytes() or original_hash == modified_hash:
        raise ValueError("Modified dependency was not demonstrably relinked into libgpu_capture.so")
    modified_inventory = json.loads((work / "modified/native-build.json").read_text())
    save(evidence / "rebuild-verification.json", {
        "schemaVersion": 1, "passed": True, "binaryInventorySha256": inventory_hash,
        "checks": ["clean-source-build", "native-format-and-pacing", "inject-help"],
        "outputs": inventory["outputs"], "gpuRuntimeTested": False,
    })
    save(evidence / "modified-dependency-rebuild.json", {
        "schemaVersion": 1, "passed": True, "binaryInventorySha256": inventory_hash,
        "dependency": "ffmpeg", "originalSourceSha256": inventory["sources"]["ffmpeg"]["sha256"],
        "modifiedSourceSha256": modified_inventory["sources"]["ffmpeg"]["sha256"],
        "originalLibrarySha256": original_hash, "modifiedLibrarySha256": modified_hash,
        "marker": marker, "markerFoundInCapture": True, "gpuRuntimeTested": False,
    })
    print(f"Validated source substitution. Baseline release binaries: {work / 'baseline-dist'}")
    print(f"Evidence: {evidence}; test-modified outputs are not release artifacts.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(f"verify-source-rebuild: {error}")
