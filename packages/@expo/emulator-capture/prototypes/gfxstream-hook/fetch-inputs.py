#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Fetch pinned inputs for the standalone experiment, never a release build.

Explicit directory overrides are used without modifying them. Default caches are
checked against the checksum-verified upstream archive on every invocation.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import posixpath
import shutil
import sys
import tarfile
import tempfile
import urllib.request


PACKAGE = Path(__file__).resolve().parents[2]
GFXSTREAM_COMMIT = "8764af0869eb5d3cce3a3e0b9a03545c9301bfc2"
GFXSTREAM_SHA256 = "d4b87525f6098d652e31fc9a952f9425095a21c71caff2c3277b7230ed8be60d"
FRIDA_VERSION = "17.18.0"
# Official release asset digests:
# https://github.com/frida/frida/releases/expanded_assets/17.18.0
FRIDA_SHA256 = {
    "arm64": {
        "core": "365f102868981247393e83d059e9de114a888d3c909ee21afbc9d997c424c4a2",
        "gum": "a294af484ea531e10ef22de22d9c8de2e312d2457a7e99b1bbe131e74bb79f6d",
    },
    "x86_64": {
        "core": "3557c4d55718d94b421394f137db96a997901472388bede4cc97fcd2a59b8037",
        "gum": "76970e3b058c6d718c209bb5bf474075b86a987052bd46aa2ee200c2ffc64861",
    },
}


def sha256_file(path):
    with path.open("rb") as stream:
        return sha256_stream(stream)


def sha256_stream(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def resolve_path(value):
    path = Path(value).expanduser()
    return (path if path.is_absolute() else PACKAGE / path).resolve()


def download(url, archive, expected_sha256):
    if not archive.exists():
        print(f"Downloading {url}", file=sys.stderr)
        with tempfile.TemporaryDirectory(prefix=".download-", dir=archive.parent) as temp:
            pending = Path(temp) / "archive"
            request = urllib.request.Request(url, headers={"User-Agent": "gfxstream-hook-prototype"})
            with urllib.request.urlopen(request, timeout=120) as response:
                if not response.url.startswith("https://"):
                    raise ValueError("Refusing a non-HTTPS download redirect")
                with pending.open("wb") as output:
                    shutil.copyfileobj(response, output)
            if sha256_file(pending) != expected_sha256:
                raise ValueError(f"Checksum mismatch for downloaded {archive.name}")
            if archive.exists():
                raise ValueError(f"Archive appeared during download: {archive}")
            pending.rename(archive)
    if not archive.is_file() or sha256_file(archive) != expected_sha256:
        raise ValueError(f"Checksum mismatch for cached archive: {archive}")


def archive_entries(tar, strip_root=None):
    """Validate before extraction, including links and writes below link paths."""
    entries = {}
    for member in tar.getmembers():
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError(f"Unsafe archive path: {member.name}")
        if strip_root:
            if not path.parts or path.parts[0] != strip_root:
                raise ValueError(f"Unexpected archive root: {member.name}")
            path = PurePosixPath(*path.parts[1:])
        if str(path) == ".":
            if not member.isdir():
                raise ValueError("Archive root must be a directory")
            continue
        if not (member.isdir() or member.isfile() or member.issym()):
            raise ValueError(f"Unsupported archive entry: {member.name}")
        if path in entries:
            raise ValueError(f"Duplicate archive path: {path}")
        if member.issym():
            target = PurePosixPath(member.linkname)
            normalized = posixpath.normpath(str(path.parent / target))
            if target.is_absolute() or normalized == ".." or normalized.startswith("../"):
                raise ValueError(f"Unsafe archive symlink: {member.name}")
        entries[path] = member
    for path in entries:
        for parent in path.parents:
            if parent in entries and not entries[parent].isdir():
                raise ValueError(f"Archive path traverses a non-directory: {path}")
    return entries


def verify_tree(tar, entries, directory):
    """Check archived files, allowing additional local build outputs."""
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError(f"Cache must be an ordinary directory: {directory}")
    for path, member in entries.items():
        output = directory / str(path)
        for parent in path.parents:
            if (directory / str(parent)).is_symlink():
                raise ValueError(f"Cached input traverses a symlink: {output}")
        if member.issym():
            matches = output.is_symlink() and os.readlink(output) == member.linkname
            try:
                output.resolve().relative_to(directory.resolve())
            except (ValueError, RuntimeError):
                matches = False
        elif member.isdir():
            matches = output.is_dir() and not output.is_symlink()
        else:
            matches = output.is_file() and not output.is_symlink()
            if matches:
                with tar.extractfile(member) as source:
                    matches = sha256_file(output) == sha256_stream(source)
        if not matches:
            raise ValueError(
                f"Cached input differs from its pinned archive: {output}. "
                "Use an explicit directory override for modified inputs."
            )


def unpack(archive, destination, strip_root=None):
    with tarfile.open(archive, "r:*") as tar:
        entries = archive_entries(tar, strip_root)
        if destination.exists() or destination.is_symlink():
            verify_tree(tar, entries, destination)
            return
        with tempfile.TemporaryDirectory(prefix=".extract-", dir=destination.parent) as temp:
            root = Path(temp) / "content"
            root.mkdir()
            # Links are installed last, so extraction never follows them.
            for path, member in entries.items():
                output = root / str(path)
                if member.isdir():
                    output.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    output.parent.mkdir(parents=True, exist_ok=True)
                    with tar.extractfile(member) as source, output.open("xb") as target:
                        shutil.copyfileobj(source, target)
                    output.chmod(0o755 if member.mode & 0o111 else 0o644)
            for path, member in entries.items():
                if member.issym():
                    output = root / str(path)
                    output.parent.mkdir(parents=True, exist_ok=True)
                    output.symlink_to(member.linkname)
            verify_tree(tar, entries, root)
            if destination.exists() or destination.is_symlink():
                raise ValueError(f"Destination appeared during extraction: {destination}")
            root.rename(destination)


def input_directory(work, env_name, cache_name, url, digest, markers, strip_root=None):
    override = os.environ.get(env_name)
    if override:
        directory = resolve_path(override)
        provenance = {"kind": "directory-override", "environmentVariable": env_name,
                      "archiveSha256Verified": False}
    else:
        directory = work / cache_name
        archive = work / url.rsplit("/", 1)[1]
        if strip_root:
            archive = work / f"gfxstream-{GFXSTREAM_COMMIT}.tar.gz"
        download(url, archive, digest)
        unpack(archive, directory, strip_root)
        provenance = {"kind": "pinned-archive", "url": url, "archiveSha256": digest,
                      "archiveSha256Verified": True, "archivedFilesVerified": True}
    if not directory.is_dir() or any(not (directory / name).is_file() for name in markers):
        raise ValueError(f"Invalid {env_name} input directory: {directory}")
    return str(directory), {"path": str(directory), **provenance}


def main():
    machine = {"aarch64": "arm64", "amd64": "x86_64"}.get(platform.machine(), platform.machine())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arch", choices=tuple(FRIDA_SHA256), default=machine,
                        help="Linux devkit architecture (default: host architecture)")
    args = parser.parse_args()
    if args.arch not in FRIDA_SHA256:
        parser.error("Host architecture is unsupported; specify --arch arm64 or --arch x86_64")
    work = resolve_path(os.environ.get("DEMO_WORK_DIR", "artifacts/gfxstream-hook"))
    work.mkdir(parents=True, exist_ok=True)
    result = {"arch": args.arch, "workDir": str(work), "provenance": {}}
    source, provenance = input_directory(
        work, "GFXSTREAM_SOURCE_DIR", "gfxstream",
        f"https://codeload.github.com/google/gfxstream/tar.gz/{GFXSTREAM_COMMIT}",
        GFXSTREAM_SHA256, ["CMakeLists.txt", "host/frame_buffer.cpp", "LICENSE"],
        strip_root=f"gfxstream-{GFXSTREAM_COMMIT}",
    )
    result["gfxstreamSourceDir"] = source
    result["provenance"]["gfxstream"] = provenance
    for kind in ("core", "gum"):
        name = f"frida-{kind}-devkit-{FRIDA_VERSION}-linux-{args.arch}.tar.xz"
        directory, provenance = input_directory(
            work, f"FRIDA_{kind.upper()}_DEVKIT_DIR", f"frida-{kind}-{args.arch}",
            f"https://github.com/frida/frida/releases/download/{FRIDA_VERSION}/{name}",
            FRIDA_SHA256[args.arch][kind], [f"frida-{kind}.h", f"libfrida-{kind}.a"],
        )
        result[f"frida{kind.title()}DevkitDir"] = directory
        result["provenance"][f"frida-{kind}"] = provenance
    serialized = json.dumps(result, indent=2) + "\n"
    (work / "inputs.json").write_text(serialized)
    print(serialized, end="")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, tarfile.TarError) as error:
        sys.exit(f"fetch-inputs: {error}")
