#!/usr/bin/env python3
"""Fetch or verify the reviewed emulator source scope, never the emulator SDK binary.

The reviewed tar must contain one directory with source-manifest.json. Its files
inventory uses {path: {sha256, executable}} for regular files and
{path: {symlink}} for symbolic links, excluding source-manifest.json itself.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
HEX256 = re.compile(r"[a-f0-9]{64}")
NATIVE_NAME = re.compile(r"(?:\.(?:o|a|dylib|dll|exe|lib)|\.so(?:\.[0-9]+)*)$")
NATIVE_MAGICS = (b"\x7fELF", b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe",
                 b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe",
                 b"\xbe\xba\xfe\xca", b"!<arch>\n", b"!<thin>\n")


def fail(message):
    raise ValueError(message)


def sha(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def source_url(value):
    if not isinstance(value, str) or any(c.isspace() for c in value):
        return False
    parsed = urlparse(value)
    return parsed.scheme == "https" and bool(parsed.hostname) and not parsed.username and not parsed.password and not parsed.fragment


def reject_binary(path):
    if NATIVE_NAME.search(path.name):
        fail(f"Native binary/build product in host source: {path.name}")
    with path.open("rb") as stream:
        header = stream.read(64)
        if any(header.startswith(magic) for magic in NATIVE_MAGICS):
            fail(f"Native binary content in host source: {path.name}")
        if header.startswith(b"MZ") and len(header) >= 64:
            stream.seek(int.from_bytes(header[60:64], "little"))
            if stream.read(4) == b"PE\0\0":
                fail(f"Windows executable in host source: {path.name}")


def verify_source(directory, expected_manifest):
    directory = Path(directory).resolve()
    manifest_path = directory / "source-manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        fail("Host source must include a regular source-manifest.json")
    if not HEX256.fullmatch(str(expected_manifest)) or sha(manifest_path) != expected_manifest:
        fail("Host source-manifest.json does not match the reviewed manifest hash")
    manifest = json.loads(manifest_path.read_text())
    expected = manifest.get("files")
    if not isinstance(expected, dict) or not expected:
        fail("Host source-manifest.json needs a nonempty files inventory")
    actual = {}
    for current, directories, files in os.walk(directory, followlinks=False):
        for name in sorted(directories + files):
            path = Path(current) / name
            relative = path.relative_to(directory).as_posix()
            if path.is_symlink():
                target = os.readlink(path)
                if os.path.isabs(target) or not path.resolve().is_relative_to(directory):
                    fail(f"Host source symlink leaves its tree: {relative}")
                actual[relative] = {"symlink": target}
            elif path.is_file():
                if relative == "source-manifest.json":
                    continue
                reject_binary(path)
                actual[relative] = {"sha256": sha(path), "executable": bool(path.stat().st_mode & 0o111)}
            elif not path.is_dir():
                fail(f"Unsupported host source entry: {relative}")
    if actual != expected:
        fail("Host source contents do not match the reviewed file inventory")
    return len(actual)


def extract_source(archive_path, destination):
    """Manually extract a source tar without tarfile's path/link side effects."""
    destination = Path(destination).resolve()
    with tarfile.open(archive_path, "r:*") as archive:
        members = archive.getmembers()
        names = {}
        roots = set()
        for member in members:
            name = member.name.rstrip("/")
            path = PurePosixPath(name)
            if not name or not path.parts or path.is_absolute() or ".." in path.parts or "\\" in name or name != path.as_posix():
                fail(f"Unsafe host archive path: {member.name}")
            if name in names:
                fail(f"Duplicate host archive entry: {name}")
            if not (member.isdir() or member.isfile() or member.issym()):
                fail(f"Unsupported host archive entry: {name}")
            names[name] = member
            roots.add(path.parts[0])
        if len(roots) != 1:
            fail("Host source archive must contain exactly one root directory")
        root = next(iter(roots))
        if root in names and not names[root].isdir():
            fail("Host source archive root must be a directory")
        prefix = root + "/"
        for name, member in names.items():
            for ancestor in PurePosixPath(name).parents:
                parent = names.get(ancestor.as_posix())
                if parent is not None and not parent.isdir():
                    fail(f"Host archive entry has a non-directory parent: {name}")
            if member.issym():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
                if member.linkname.startswith("/") or "\\" in member.linkname or not (target == root or target.startswith(prefix)):
                    fail(f"Unsafe host source symlink: {name}")
        # All normal entries are written before links; no output path can follow
        # an archive-controlled symlink or hard link.
        for name, member in names.items():
            output = destination / name
            if member.isdir():
                output.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                output.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, output.open("xb") as target:
                    shutil.copyfileobj(source, target)
                output.chmod(0o755 if member.mode & 0o111 else 0o644)
                reject_binary(output)
        for name, member in names.items():
            if member.issym():
                output = destination / name
                output.parent.mkdir(parents=True, exist_ok=True)
                output.symlink_to(member.linkname)
        result = destination / root
        # Resolve chains after links exist; lexical checks alone do not detect
        # a symlink followed by '..' that traverses outside the source root.
        for name, member in names.items():
            if member.issym() and not (destination / name).resolve().is_relative_to(result):
                fail(f"Host source symlink chain leaves its tree: {name}")
        return result


def pending(message, required):
    if required:
        fail(message)
    print(f"Host corresponding source pending: {message}; no download attempted.")


def fetch(args):
    record = json.loads(Path(args.compliance).read_text())
    reviewed = record.get("host", {}).get("correspondingSource", {})
    manifest_hash = reviewed.get("manifestSha256")
    if reviewed.get("status") != "resolved" or not HEX256.fullmatch(str(manifest_hash)):
        return pending("record a resolved host source scope and matching manifest SHA-256", args.required)
    if not reviewed.get("scope") or not reviewed.get("evidence"):
        return pending("the resolved host source scope is missing its supporting evidence", args.required)
    explicit = os.environ.get("POC_EMULATOR_SOURCE_DIR")
    destination = (ROOT / (explicit or "sources/emulator")).resolve()
    if destination.exists():
        count = verify_source(destination, manifest_hash)
        print(f"Preserved and verified existing host source: {destination} ({count} files/links)")
        return
    if explicit:
        fail(f"Explicit POC_EMULATOR_SOURCE_DIR does not exist: {destination}; supplied source paths are never populated or replaced")
    url, archive_hash = reviewed.get("archiveUrl"), reviewed.get("archiveSha256")
    if not url or not archive_hash:
        return pending("no reviewed correspondingSource archiveUrl/archiveSha256; the SDK archive is not a source substitute", args.required)
    if not source_url(url) or not HEX256.fullmatch(str(archive_hash)):
        fail("Reviewed host source needs an HTTPS archive URL and SHA-256")
    if os.environ.get("POC_OFFLINE") == "1":
        fail("Host source is unavailable offline; fetch it first or set POC_EMULATOR_SOURCE_DIR to the reviewed source tree")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="host-source-", dir=destination.parent) as temporary:
        temporary = Path(temporary)
        archive_path = temporary / "sources.tar"
        subprocess.run(["curl", "--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
                        "--retry", "3", "--output", str(archive_path), url], check=True)
        if sha(archive_path) != archive_hash:
            fail("Downloaded host source archive SHA-256 does not match the reviewed record")
        source = extract_source(archive_path, temporary / "extracted")
        count = verify_source(source, manifest_hash)
        if destination.exists():
            fail(f"Host source destination appeared during fetch; refusing replacement: {destination}")
        source.rename(destination)
    print(f"Fetched and verified reviewed host source: {destination} ({count} files/links)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compliance", default=str(ROOT / "sources/compliance.json"))
    parser.add_argument("--required", action="store_true", help="Fail instead of reporting unresolved source availability")
    fetch(parser.parse_args())


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError, subprocess.CalledProcessError, tarfile.TarError) as error:
        sys.exit(f"fetch-host-source: {error}")
