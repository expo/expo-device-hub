#!/usr/bin/env python3
"""Fetch, package and verify the editable sources for emulator-capture.

Creating a development archive is deliberately separate from release clearance.
No command changes a supplied dependency source tree.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
PINS = {
    "ffmpeg": {
        "env": "POC_FFMPEG_SOURCE_DIR", "repository": "https://github.com/FFmpeg/FFmpeg.git",
        "revision": "894da5ca7d742e4429ffb2af534fcda0103ef593", "marker": "configure",
    },
    "nv-codec-headers": {
        "env": "POC_NV_CODEC_HEADERS_SOURCE_DIR", "repository": "https://github.com/FFmpeg/nv-codec-headers.git",
        "revision": "e844e5b26f46bb77479f063029595293aa8f812d", "marker": "include/ffnvcodec/nvEncodeAPI.h",
    },
}
PACKAGE_ITEMS = ["src", "scripts", "tests", "docs", "LICENSES", "sources/compliance.json",
                 "sources/frida-lock.json", "LICENSE", "THIRD_PARTY_LICENSES.md", "README.md",
                 "package.json", "Dockerfile.source", ".dockerignore"]
IGNORED = {".git", ".hg", ".svn", "__pycache__", ".DS_Store", "node_modules"}
DECISIONS = {"gpl-version-compatibility", "gfxstream-interface-compatibility",
             "nvidia-runtime-exception", "in-target-frida-payload", "host-corresponding-source-scope"}


def fail(message):
    raise ValueError(message)


def run(*args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def env_path(name, default):
    return (ROOT / os.environ.get(name, str(default))).resolve()


def source_paths():
    paths = {name: env_path(pin["env"], ROOT / "sources" / name) for name, pin in PINS.items()}
    paths["frida"] = env_path("POC_FRIDA_SOURCE_DIR", ROOT / "sources/frida")
    if os.environ.get("POC_EMULATOR_SOURCE_DIR"):
        paths["emulator"] = env_path("POC_EMULATOR_SOURCE_DIR", "")
    elif (ROOT / "sources/emulator").is_dir():
        paths["emulator"] = ROOT / "sources/emulator"
    return paths


def git_info(path):
    def git(*args):
        result = subprocess.run(["git", "-C", str(path), *args], capture_output=True, text=True)
        return result.stdout.strip() if result.returncode == 0 else None
    # An exported source directory may live inside the Expo repository. Its
    # enclosing repository commit is not the dependency's source revision.
    top = git("rev-parse", "--show-toplevel")
    if top is None or Path(top).resolve() != Path(path).resolve():
        return {"revision": None, "modified": None}
    # Do not record remote URLs: local credentials may be embedded in them.
    return {"revision": git("rev-parse", "HEAD"), "modified": bool(git("status", "--porcelain"))}


def fetch(_args):
    if os.environ.get("POC_OFFLINE") == "1":
        fail("fetch needs network; unset POC_OFFLINE or use existing sources with create")
    for name, pin in PINS.items():
        path = source_paths()[name]
        if path.exists():
            if not (path / pin["marker"]).is_file():
                fail(f"Invalid {name} source directory: {path}")
            print(f"Preserving existing {name}: {path}", flush=True)
            continue
        if os.environ.get(pin["env"]):
            fail(f"Explicit {pin['env']} does not exist: {path}; supplied sources are never replaced")
        path.parent.mkdir(parents=True, exist_ok=True)
        # A failed fetch remains inspectable; it is never silently reset or cleaned.
        run("git", "init", path)
        run("git", "-C", path, "remote", "add", "origin", pin["repository"])
        run("git", "-C", path, "fetch", "--depth=1", "origin", pin["revision"])
        run("git", "-C", path, "checkout", "--detach", "FETCH_HEAD")
        if git_info(path)["revision"] != pin["revision"]:
            fail(f"Unexpected {name} revision")
    run(sys.executable, ROOT / "scripts/frida-source.py", "fetch")
    run(sys.executable, ROOT / "scripts/fetch-host-source.py")


def copy_sources(source, destination, allowed_fixtures=()):
    """Copy all source, including uncommitted edits, without VCS credentials.

    Do not exclude every directory called 'build': upstream projects use that
    name for source files. Reject build products instead of silently hiding them.
    """
    source = source.resolve()
    if not source.is_dir():
        fail(f"Missing source directory: {source}; run fetch or set the source-directory environment variable")
    if destination.resolve().is_relative_to(source):
        fail(f"Archive staging directory must not be inside its source: {source}")
    for current, directories, files in os.walk(source, followlinks=False):
        directories[:] = sorted(d for d in directories if d not in IGNORED)
        for name in sorted(directories + files):
            path = Path(current) / name
            if name in IGNORED or name.endswith(".pyc"):
                continue
            relative = path.relative_to(source)
            if path.is_symlink():
                target = os.readlink(path)
                if os.path.isabs(target) or not path.resolve().is_relative_to(source):
                    fail(f"Source symlink leaves its tree: {path}; vendor its target inside the source tree")
                output = destination / relative
                output.parent.mkdir(parents=True, exist_ok=True)
                output.symlink_to(target)
            elif path.is_file():
                # Source snapshots must not substitute proprietary/opaque binary
                # archives for the corresponding editable source.
                with path.open("rb") as stream:
                    native = stream.read(4) == b"\x7fELF"
                if (path.suffix in {".o", ".a", ".so"} or ".so." in name or native) and relative.as_posix() not in allowed_fixtures:
                    fail(f"Build product in source tree: {path}; use a fresh source tree and an external build directory")
                output = destination / relative
                output.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, output)


def inventory(directory):
    entries = {}
    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory).as_posix()
        if relative == "source-manifest.json":
            continue
        if path.is_symlink():
            entries[relative] = {"symlink": os.readlink(path)}
        elif path.is_file():
            entries[relative] = {"sha256": sha(path), "executable": bool(path.stat().st_mode & 0o111)}
    return entries


def valid_source_url(value):
    if not isinstance(value, str) or any(c.isspace() for c in value) or any(c in value for c in "()<>\\"):
        return False
    parsed = urlparse(value)
    return parsed.scheme == "https" and bool(parsed.hostname) and not parsed.username and not parsed.password and not parsed.fragment


def compliance_errors(record, decisions_only=False):
    errors = []
    distribution = record.get("distribution", {})
    treatment = distribution.get("injectedAgentTreatment")
    if treatment in (None, "unresolved"):
        errors.append("Injected-agent/host licensing relationship is unresolved")
    elif treatment != "combined-program":
        # Other reviewed outcomes need a corresponding archive policy before
        # release creation/verification can omit the current host-source checks.
        errors.append(f"Release packaging has not been reviewed for injected-agent treatment: {treatment}")
    if distribution.get("releaseReady") is not True:
        errors.append("distribution.releaseReady is not true")
    decisions = {item.get("id"): item for item in record.get("decisions", [])}
    for key in sorted(DECISIONS):
        item = decisions.get(key, {})
        if item.get("status") != "resolved" or not item.get("evidence"):
            errors.append(f"Unresolved decision or missing evidence: {key}")
    if treatment == "combined-program":
        source = record.get("host", {}).get("correspondingSource", {})
        if source.get("status") != "resolved" or not source.get("scope") or not source.get("evidence"):
            errors.append("Host corresponding-source scope and evidence are unresolved")
        if not re.fullmatch(r"[a-f0-9]{64}", str(source.get("manifestSha256", ""))):
            errors.append("Host corresponding-source manifest SHA-256 is missing")
    if decisions_only:
        return errors
    evidence = record.get("releaseEvidence", {})
    for key in ["binaryInventorySha256", "rebuildVerificationSha256", "modifiedDependencyRebuildSha256"]:
        if not re.fullmatch(r"[a-f0-9]{64}", str(evidence.get(key, ""))):
            errors.append(f"Missing release evidence SHA-256: {key}")
    if not valid_source_url(evidence.get("publishedSourceUrl")):
        errors.append("Missing permanent HTTPS source download URL")
    return errors


def check_release(args):
    record = read_json(args.compliance)
    errors = compliance_errors(record, getattr(args, "decisions_only", False))
    if errors:
        fail("Release prerequisites are incomplete:\n- " + "\n- ".join(errors))
    print("Release decisions and evidence references are present. This check does not supply legal permission.")


def record_release(args):
    record = read_json(args.compliance)
    errors = compliance_errors(record, decisions_only=True)
    if errors:
        fail("Resolve release decisions first:\n- " + "\n- ".join(errors))
    if not valid_source_url(args.source_url):
        fail("A permanent HTTPS source download URL is required")
    evidence = Path(args.evidence_dir)
    for field, filename in [("binaryInventorySha256", "binary-inventory.json"),
                            ("rebuildVerificationSha256", "rebuild-verification.json"),
                            ("modifiedDependencyRebuildSha256", "modified-dependency-rebuild.json")]:
        record["releaseEvidence"][field] = sha(evidence / filename)
    record["releaseEvidence"]["publishedSourceUrl"] = args.source_url
    output = Path(args.output)
    if output.exists():
        fail(f"Refusing to overwrite release record: {output}")
    write_json(output, record)
    print(f"Recorded evidence references in {output}; create --release validates their content")


def validate_build_evidence(files, load_json, binary_dir=None):
    """Tie successful rebuild records to archived source and released binaries."""
    build = load_json("release-evidence/binary-inventory.json")
    if build.get("schemaVersion") != 1 or build.get("sourceBuild") is not True:
        fail("Binary inventory must come from POC_SOURCE_BUILD=1")
    for key, prefix in [("expo", "src/"), ("ffmpeg", "sources/ffmpeg/"),
                        ("nvCodecHeaders", "sources/nv-codec-headers/"), ("buildScripts", "scripts/")]:
        source = build.get("sources", {}).get(key, {})
        entries = source.get("entries")
        if not isinstance(entries, list) or not entries:
            fail(f"Missing build source inventory: {key}")
        encoded = json.dumps(entries, ensure_ascii=False, separators=(",", ":")).encode()
        if hashlib.sha256(encoded).hexdigest() != source.get("sha256"):
            fail(f"Invalid build source inventory digest: {key}")
        for entry in entries:
            path = entry.get("path", "")
            if not path or Path(path).is_absolute() or ".." in Path(path).parts:
                fail(f"Unsafe build source path: {path}")
            actual = files.get(prefix + path, {})
            if entry.get("type") not in {"file", "symlink"}:
                fail(f"Unknown source inventory entry type: {path}")
            if entry.get("type") == "file" and not re.fullmatch(r"[a-f0-9]{64}", str(entry.get("sha256", ""))):
                fail(f"Missing source SHA-256: {path}")
            if entry.get("type") == "file" and actual.get("sha256") != entry.get("sha256"):
                fail(f"Source changed since native build: {prefix + path}")
            if entry.get("type") == "symlink" and actual.get("symlink") != entry.get("target"):
                fail(f"Source symlink changed since native build: {prefix + path}")
        # Added source files can also change a rebuild. Match the complete path
        # set using the same exclusions as build.mjs's fingerprintTree().
        excluded_outputs = []
        directory = source.get("directory")
        if directory:
            for name in ["buildDirectory", "ffmpegBuildDirectory", "outputDirectory"]:
                output = build.get("paths", {}).get(name)
                if output and Path(output) != Path(directory) and Path(output).is_relative_to(Path(directory)):
                    excluded_outputs.append(Path(output).relative_to(Path(directory)))
        archived_paths = set()
        for name in files:
            if not name.startswith(prefix):
                continue
            relative = name[len(prefix):]
            path = Path(relative)
            if any(part in {".git", "build", "__pycache__"} or part.endswith(".pyc") for part in path.parts):
                continue
            if any(path.is_relative_to(output) for output in excluded_outputs):
                continue
            archived_paths.add(relative)
        recorded_paths = {entry["path"] for entry in entries}
        if len(recorded_paths) != len(entries) or recorded_paths != archived_paths:
            fail(f"Source file set changed since native build: {key}")
    outputs = {Path(item["path"]).name: item["sha256"] for item in build.get("outputs", [])}
    if set(outputs) != {"inject", "libgpu_capture.so"}:
        fail("Binary inventory must identify inject and libgpu_capture.so")
    frida_build = load_json("release-evidence/frida-build.json")
    if frida_build.get("sourceBuild") is not True:
        fail("Missing Frida source-build provenance")
    build_script_hash = frida_build.get("buildScriptSha256")
    if (not re.fullmatch(r"[a-f0-9]{64}", str(build_script_hash)) or
            build_script_hash != files.get("scripts/frida-source.py", {}).get("sha256")):
        fail("Frida devkit build script does not match the archived build machinery")
    expected_sources = dict(frida_build.get("sourceInputs", {}))
    if not expected_sources:
        fail("Missing Frida source input inventory")
    for prefix, replacement in frida_build.get("sourceOverrides", {}).items():
        if Path(prefix).is_absolute() or ".." in Path(prefix).parts:
            fail("Unsafe Frida override prefix")
        expected_sources = {p: v for p, v in expected_sources.items() if not p.startswith(prefix + "/")}
        expected_sources.update({prefix + "/" + p: v for p, v in replacement.items()})
    for relative, expected in expected_sources.items():
        actual = files.get("sources/frida/" + relative, {})
        if not expected or any(actual.get(key) != value for key, value in expected.items()):
            fail(f"Frida source changed since devkit build: {relative}")
    archived_frida_paths = {name.removeprefix("sources/frida/") for name in files
                            if name.startswith("sources/frida/") and name != "sources/frida/source-state.json"}
    if set(expected_sources) != archived_frida_paths:
        fail("Frida source file set changed since devkit build")
    native_inputs = {Path(item["path"]).name: item["sha256"] for item in build.get("inputs", [])}
    frida_outputs = frida_build.get("outputs", {})
    for kit in ["gum", "core"]:
        for filename in [f"frida-{kit}.h", f"libfrida-{kit}.a"]:
            expected = frida_outputs.get(f"{kit}/{filename}")
            if not expected or native_inputs.get(filename) != expected:
                fail(f"Native binary did not use the inventoried source-built {filename}")
    if binary_dir:
        for filename, digest in outputs.items():
            binary = Path(binary_dir) / filename
            if not binary.is_file() or sha(binary) != digest:
                fail(f"Release binary does not match source-build inventory: {filename}")
    inventory_hash = files["release-evidence/binary-inventory.json"]["sha256"]
    rebuilt = load_json("release-evidence/rebuild-verification.json")
    modified = load_json("release-evidence/modified-dependency-rebuild.json")
    for name, evidence in [("rebuild", rebuilt), ("modified dependency", modified)]:
        if evidence.get("passed") is not True or evidence.get("binaryInventorySha256") != inventory_hash:
            fail(f"{name} evidence does not establish a successful check for this binary inventory")
    rebuilt_outputs = {Path(item["path"]).name: item["sha256"] for item in rebuilt.get("outputs", [])}
    if rebuilt_outputs != outputs:
        fail("Rebuild evidence refers to different binary outputs")
    if modified.get("dependency") != "ffmpeg" or modified.get("originalSourceSha256") != build["sources"]["ffmpeg"]["sha256"]:
        fail("Modified dependency test did not start from the archived FFmpeg source")
    for key in ["modifiedLibrarySha256", "modifiedSourceSha256"]:
        if not re.fullmatch(r"[a-f0-9]{64}", str(modified.get(key, ""))):
            fail(f"Modified dependency evidence is missing {key}")
    if (modified.get("markerFoundInCapture") is not True or
            modified.get("originalLibrarySha256") != outputs["libgpu_capture.so"] or
            modified.get("modifiedLibrarySha256") == outputs["libgpu_capture.so"] or
            modified.get("modifiedSourceSha256") == modified.get("originalSourceSha256")):
        fail("Modified dependency evidence does not demonstrate relinking into the capture library")


def create(args):
    package = read_json(ROOT / "package.json")
    version = args.version or package["version"]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]*", version):
        fail("Version must be a safe archive name")
    output = Path(args.output or ROOT / f"artifacts/sources/emulator-capture-source-{version}.tar.gz").resolve()
    if output.exists():
        fail(f"Refusing to overwrite existing archive: {output}")
    record = read_json(args.compliance)
    if args.source_url and not valid_source_url(args.source_url):
        fail("--source-url must be an HTTPS download URL without credentials, fragments or Markdown delimiters")
    if args.release:
        check_release(args)
        if not args.binary_dir:
            fail("Release archives require --binary-dir to bind the source to the shipped native binaries")
        if not args.source_url or args.source_url != record["releaseEvidence"]["publishedSourceUrl"]:
            fail("Release --source-url must match releaseEvidence.publishedSourceUrl")
    with_build_evidence = bool(args.release or getattr(args, "with_build_evidence", False)
                               or args.evidence_dir or args.binary_dir)
    if with_build_evidence and (not args.evidence_dir or not args.binary_dir):
        fail("Build-evidence validation requires both --evidence-dir and --binary-dir")
    paths = source_paths()
    for name, pin in PINS.items():
        if not (paths[name] / pin["marker"]).is_file():
            fail(f"Missing {name} source: {paths[name]}")
    # Frida's fetch receipt inventories its recursive sources and dependency pins.
    receipt = paths["frida"] / "source-state.json"
    if not receipt.is_file():
        fail(f"Missing Frida source receipt {receipt}; run frida-source.py fetch first")
    run(sys.executable, ROOT / "scripts/frida-source.py", "verify")
    spec = importlib.util.spec_from_file_location("frida_source", Path(__file__).with_name("frida-source.py"))
    frida = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(frida)
    frida_overrides = frida.overrides(paths["frida"])
    if args.release and "emulator" not in paths:
        fail("Release archive requires POC_EMULATOR_SOURCE_DIR containing the reviewed host-source scope and manifest")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="capture-sources-", dir=output.parent) as temporary:
        stage = Path(temporary) / f"emulator-capture-source-{version}"
        stage.mkdir()
        for item in PACKAGE_ITEMS:
            source = ROOT / item
            if source.is_dir():
                copy_sources(source, stage / item)
            elif source.is_file():
                (stage / item).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, stage / item)
            else:
                fail(f"Missing package source input: {source}")
        # Archive the selected compliance record, including an explicitly supplied one.
        write_json(stage / "sources/compliance.json", record)
        (stage / "SOURCES.md").write_text(
            f"# Source companion\n\nBuild/source identifier: `{version}`.\n\n"
            "This directory contains the source snapshot and its `source-manifest.json`.\n"
            "See [rebuild instructions](docs/rebuilding-from-source.md).\n\n"
            + (f"[Published archive]({args.source_url}).\n" if args.source_url else "Development snapshot; no source release URL has been assigned.\n"))
        dependencies = {}
        for name, path in paths.items():
            fixtures = read_json(receipt)["files"].keys() if name == "frida" else ()
            copy_sources(path, stage / "sources" / name, allowed_fixtures=fixtures)
            dependencies[name] = {**git_info(path), "directory": f"sources/{name}"}
        # Bake edited dependency subtrees into the portable archive. No absolute
        # path from the developer's machine is required by the recipient.
        for relative, replacement in frida_overrides.items():
            target = stage / "sources/frida" / relative
            shutil.rmtree(target)
            copy_sources(replacement, target)
        if frida_overrides:
            state = read_json(stage / "sources/frida/source-state.json")
            state["files"] = frida.inventory(stage / "sources/frida")
            state["originalReceiptSha256"] = sha(receipt)
            state["modifiedSubtrees"] = sorted(frida_overrides)
            write_json(stage / "sources/frida/source-state.json", state)
        if args.evidence_dir:
            evidence = Path(args.evidence_dir).resolve()
            copy_sources(evidence, stage / "release-evidence")
        if args.release:
            if not args.evidence_dir:
                fail("Release archives require --evidence-dir with binary-inventory.json, rebuild-verification.json and modified-dependency-rebuild.json")
            for field, filename in [("binaryInventorySha256", "binary-inventory.json"),
                                    ("rebuildVerificationSha256", "rebuild-verification.json"),
                                    ("modifiedDependencyRebuildSha256", "modified-dependency-rebuild.json")]:
                path = stage / "release-evidence" / filename
                if not path.is_file() or sha(path) != record["releaseEvidence"][field]:
                    fail(f"Missing or mismatched evidence: {filename}")
            host_manifest = stage / "sources/emulator/source-manifest.json"
            if not host_manifest.is_file() or sha(host_manifest) != record["host"]["correspondingSource"]["manifestSha256"]:
                fail("Host source-manifest.json does not match the reviewed manifest")
            spec = importlib.util.spec_from_file_location("host_source", Path(__file__).with_name("fetch-host-source.py"))
            host = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(host)
            host.verify_source(stage / "sources/emulator", record["host"]["correspondingSource"]["manifestSha256"])
        if with_build_evidence:
            validate_build_evidence(inventory(stage), lambda name: read_json(stage / name), args.binary_dir)
        manifest = {"schemaVersion": 1, "package": package["name"], "version": version,
                    "releaseReady": bool(args.release), "buildEvidenceVerified": with_build_evidence,
                    "dependencies": dependencies,
                    "limitations": [] if args.release else compliance_errors(record),
                    "files": inventory(stage)}
        write_json(stage / "source-manifest.json", manifest)
        # One archive contains the editable inputs; no proprietary compiler or emulator binaries.
        with tarfile.open(output, "w:gz", format=tarfile.PAX_FORMAT) as archive:
            archive.add(stage, arcname=stage.name, recursive=True)
    digest = sha(output)
    output.with_name(output.name + ".sha256").write_text(f"{digest}  {output.name}\n")
    if args.source_url:
        (ROOT / "SOURCES.md").write_text(
            "# Corresponding source\n\n"
            f"Native build/source identifier: `{version}`.\n\n"
            f"[Download the matching source and rebuild archive]({args.source_url}).\n\n"
            f"SHA-256: `{digest}`.\n\n"
            + ("This archive passed the configured release-evidence checks.\n" if args.release else
               "**Development archive: release compliance remains incomplete.** See its source-manifest.json.\n")
            + "\nRebuild instructions are in `docs/rebuilding-from-source.md` inside the archive.\n")
    print(json.dumps({"archive": str(output), "sha256": digest, "releaseReady": bool(args.release),
                      "buildEvidenceVerified": with_build_evidence}, indent=2))


def verify(args):
    """Verify without extracting untrusted paths, links or special files."""
    if getattr(args, "with_build_evidence", False) and not getattr(args, "binary_dir", None):
        fail("Explicit --with-build-evidence verification requires --binary-dir")
    with tarfile.open(args.archive, "r:gz") as archive:
        members = archive.getmembers()
        names = [m.name.rstrip("/") for m in members]
        if len(names) != len(set(names)):
            fail("Duplicate archive entries")
        roots = {name.split("/")[0] for name in names}
        if len(roots) != 1:
            fail("Archive must have exactly one root directory")
        prefix = next(iter(roots)) + "/"
        manifests = [m for m in members if m.name == prefix + "source-manifest.json"]
        if len(manifests) != 1 or not manifests[0].isfile():
            fail("Missing source-manifest.json")
        manifest = json.load(archive.extractfile(manifests[0]))
        actual = {}
        for member in members:
            path = Path(member.name)
            if path.is_absolute() or ".." in path.parts or not (member.name + "/").startswith(prefix):
                fail(f"Unsafe archive path: {member.name}")
            relative = member.name[len(prefix):]
            if member.isdir() or relative == "source-manifest.json":
                continue
            if member.issym():
                target = os.path.normpath(str(Path(member.name).parent / member.linkname))
                if os.path.isabs(member.linkname) or not target.startswith(prefix):
                    fail(f"Unsafe source symlink: {member.name}")
                actual[relative] = {"symlink": member.linkname}
            elif member.isfile():
                digest = hashlib.sha256()
                stream = archive.extractfile(member)
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
                actual[relative] = {"sha256": digest.hexdigest(), "executable": bool(member.mode & 0o111)}
            else:
                fail(f"Unsupported archive entry: {member.name}")
        if actual != manifest.get("files"):
            fail("Source archive contents do not match its manifest")
        if args.release and manifest.get("releaseReady") is not True:
            fail("This is a development archive, not a release archive")
        with_build_evidence = manifest.get("buildEvidenceVerified") is True or manifest.get("releaseReady") is True
        if (getattr(args, "with_build_evidence", False) or getattr(args, "binary_dir", None)) and not with_build_evidence:
            fail("Archive has no validated build evidence; the supplied binaries cannot be matched")

        def archived_json(relative):
            target = next((m for m in members if m.name == prefix + relative), None)
            if target is None or not target.isfile():
                fail(f"Missing release record: {relative}")
            return json.load(archive.extractfile(target))

        if manifest.get("releaseReady") is True:
            record = archived_json("sources/compliance.json")
            errors = compliance_errors(record)
            if errors:
                fail("Archived release prerequisites are incomplete:\n- " + "\n- ".join(errors))
            for field, filename in [("binaryInventorySha256", "binary-inventory.json"),
                                    ("rebuildVerificationSha256", "rebuild-verification.json"),
                                    ("modifiedDependencyRebuildSha256", "modified-dependency-rebuild.json")]:
                relative = "release-evidence/" + filename
                if actual.get(relative, {}).get("sha256") != record["releaseEvidence"][field]:
                    fail(f"Missing or mismatched archived evidence: {filename}")
            if actual.get("sources/emulator/source-manifest.json", {}).get("sha256") != record["host"]["correspondingSource"]["manifestSha256"]:
                fail("Archived host source manifest does not match the reviewed manifest")
            host_manifest = archived_json("sources/emulator/source-manifest.json")
            host_files = {name.removeprefix("sources/emulator/"): value for name, value in actual.items()
                          if name.startswith("sources/emulator/") and name != "sources/emulator/source-manifest.json"}
            if host_manifest.get("files") != host_files:
                fail("Archived host source files do not match their reviewed inventory")
        if with_build_evidence:
            validate_build_evidence(actual, archived_json, getattr(args, "binary_dir", None))
        print(f"Verified {len(actual)} files; releaseReady={manifest.get('releaseReady')}; "
              f"buildEvidenceVerified={with_build_evidence}; SHA-256={sha(args.archive)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("fetch", help="Download pinned editable sources; preserve existing overrides").set_defaults(func=fetch)
    pack = commands.add_parser("create", help="Create a self-contained editable-source archive (development by default)")
    pack.add_argument("--version")
    pack.add_argument("--output")
    pack.add_argument("--release", action="store_true")
    pack.add_argument("--source-url")
    pack.add_argument("--with-build-evidence", action="store_true", help="Validate source/rebuild evidence for a development archive without claiming release readiness")
    pack.add_argument("--evidence-dir", help="Completed rebuild evidence; also requires --binary-dir")
    pack.add_argument("--binary-dir", help="Match these native outputs to archived source/rebuild evidence; also requires --evidence-dir")
    pack.add_argument("--compliance", default=str(ROOT / "sources/compliance.json"))
    pack.set_defaults(func=create)
    check = commands.add_parser("check-release", help="Check recorded compatibility/source decisions before release work")
    check.add_argument("--compliance", default=str(ROOT / "sources/compliance.json"))
    check.add_argument("--decisions-only", action="store_true", help="Check reviewed decisions before generating build evidence")
    check.set_defaults(func=check_release)
    record = commands.add_parser("record-release", help="Record hashes of completed rebuild checks without changing legal decisions")
    record.add_argument("--compliance", default=str(ROOT / "sources/compliance.json"))
    record.add_argument("--evidence-dir", required=True)
    record.add_argument("--source-url", required=True)
    record.add_argument("--output", required=True)
    record.set_defaults(func=record_release)
    validate = commands.add_parser("verify", help="Check archive paths and all content hashes without extracting")
    validate.add_argument("archive")
    validate.add_argument("--release", action="store_true")
    validate.add_argument("--with-build-evidence", action="store_true", help="Require validated build evidence and --binary-dir, independently of legal release readiness")
    validate.add_argument("--binary-dir", help="Also verify these binaries match the archived source-build evidence")
    validate.set_defaults(func=verify)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        sys.exit(f"source-archive: {error}")
