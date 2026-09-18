#!/usr/bin/env python3
"""Fetch editable Frida sources separately from an offline devkit build.

The fetch receipt is a source inventory, not a claim of release clearance or a
successful offline rebuild. An actual successful build writes a second receipt.
Requires Python 3.11+, Git, and npm; Linux builds additionally need the toolchain
listed in Dockerfile.source. Local source trees are never reset or cleaned.
"""
import argparse
import configparser
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / "sources/frida-lock.json"
IGNORED = {".git", ".hg", ".svn", "__pycache__", ".DS_Store", "node_modules"}


def fail(message):
    raise ValueError(message)


def run(*args, **kwargs):
    directory = kwargs.get("cwd")
    print("+ " + (f"[{directory}] " if directory else "") + " ".join(str(a) for a in args), flush=True)
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def source_dir():
    return (ROOT / os.environ.get("POC_FRIDA_SOURCE_DIR", "sources/frida")).resolve()


def sha(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def files(root):
    for current, directories, names in os.walk(root):
        directories[:] = sorted(d for d in directories if d not in IGNORED)
        for name in directories[:]:
            path = Path(current) / name
            if path.is_symlink():
                yield path
                directories.remove(name)
        for name in sorted(names):
            if name in IGNORED or name.endswith(".pyc"):
                continue
            path = Path(current) / name
            if path.name == "source-state.json" and path.parent == root:
                continue
            yield path


def inventory(root):
    result = {}
    for path in files(root):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            target = os.readlink(path)
            if os.path.isabs(target) or not path.resolve().is_relative_to(root):
                fail(f"Source symlink escapes source tree: {path}")
            result[relative] = {"symlink": target}
        else:
            result[relative] = {"sha256": sha(path)}
    return result


def git_revision(path):
    if not (path / ".git").exists():
        return None
    return run("git", "-C", path, "rev-parse", "HEAD", capture_output=True, text=True).stdout.strip()


def clone(repository, revision, path):
    if path.exists():
        if not (path / ".git").exists():
            fail(f"Existing directory is not a Git checkout: {path}; use verify/build for exported sources")
        actual = git_revision(path)
        if re.fullmatch(r"[a-f0-9]{40}", revision) and actual != revision:
            fail(f"Preserving {path}: expected {revision}, found {actual}; use source overrides for another version")
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        run("git", "init", path)
        run("git", "-C", path, "remote", "add", "origin", repository)
        run("git", "-C", path, "fetch", "--depth=1", "origin", revision)
        run("git", "-C", path, "checkout", "--detach", "FETCH_HEAD")
    run("git", "-C", path, "submodule", "update", "--init", "--recursive", "--depth=1")


def wrap_definition(path, source_root=None, seen=None):
    seen = set() if seen is None else seen
    identity = path.resolve()
    if identity in seen:
        fail(f"Cyclic Meson wrap redirect: {path}")
    seen.add(identity)
    parser = configparser.ConfigParser(interpolation=None)
    if not parser.read(path):
        fail(f"Missing Meson wrap: {path}")
    section = next((s for s in parser.sections() if s.startswith("wrap-")), None)
    if section is None:
        fail(f"Invalid Meson wrap: {path}")
    if section == "wrap-redirect":
        filename = parser[section].get("filename")
        if not filename or Path(filename).is_absolute():
            fail(f"Invalid Meson wrap redirect: {path}")
        redirected = Path(os.path.normpath(path.parent / filename))
        boundary = source_root if source_root is not None else path.parent
        if not redirected.resolve().is_relative_to(boundary.resolve()):
            fail(f"Meson wrap redirect leaves source tree: {path}")
        return wrap_definition(redirected, boundary, seen)
    return path, parser[section]


def wrap_target(path, source_root=None):
    path, definition = wrap_definition(path, source_root)
    directory = definition.get("directory", path.stem)
    target = path.parent / directory
    if not target.resolve().is_relative_to(path.parent.resolve()):
        fail(f"Unsafe wrap directory: {path}")
    return target


def wrap_build_marker(path, source_root=None):
    _, definition = wrap_definition(path, source_root)
    method = definition.get("method", "meson")
    # Match the pinned Meson resolver's required source-tree entry point.
    markers = {"meson": "meson.build", "cmake": "CMakeLists.txt", "cargo": "Cargo.toml"}
    if method not in markers:
        fail(f"Unsupported Meson wrap method {method!r}: {path}")
    return wrap_target(path, source_root) / markers[method]


def build_roots(source):
    """Follow actual subproject edges, never arbitrary wraps in test fixtures."""
    pending = [source, source / "subprojects/frida-gum", source / "subprojects/frida-core"]
    dependencies = source / "dependency-sources"
    if dependencies.is_dir():
        pending.extend(sorted(p for p in dependencies.iterdir() if p.is_dir()))
    visited = set()
    while pending:
        project = pending.pop(0)
        if project in visited or not project.is_dir():
            continue
        if not project.resolve().is_relative_to(source.resolve()):
            fail(f"Frida build root leaves the source tree: {project}")
        visited.add(project)
        yield project
        for wrap in sorted((project / "subprojects").glob("*.wrap")):
            target = wrap_target(wrap, source)
            if target is not None:
                pending.append(target)


def project_wraps(source):
    return sorted({wrap for project in build_roots(source)
                   for wrap in (project / "subprojects").glob("*.wrap")})


def download_wraps(source, meson):
    # Repeat because downloaded subprojects may contribute further wraps.
    processed = set()
    while True:
        roots = sorted({p.parent.parent for p in project_wraps(source)})
        pending = [(project, tuple((p.name, sha(p)) for p in sorted((project / "subprojects").glob("*.wrap"))))
                   for project in roots]
        pending = [entry for entry in pending if entry not in processed]
        if not pending:
            break
        for entry in pending:
            project, _signature = entry
            markers = [wrap_build_marker(wrap, source)
                       for wrap in sorted((project / "subprojects").glob("*.wrap"))]
            missing = [marker for marker in markers if not marker.is_file()]
            for marker in missing:
                target = marker.parent
                # Git checkouts leave empty directories for uninitialized
                # submodules. Meson's download command incorrectly considers
                # any existing directory already downloaded. Remove only the
                # empty placeholder so the pinned wrap can supply its source.
                if target.exists() or target.is_symlink():
                    if target.is_symlink() or not target.is_dir() or any(target.iterdir()):
                        fail(f"Preserving incomplete Meson dependency: {target}; expected {marker.name}")
                    target.rmdir()
            if missing:
                run(sys.executable, meson, "subprojects", "download", "--sourcedir", project)
                for marker in missing:
                    if not marker.is_file():
                        fail(f"Missing Meson dependency: {marker.parent}; expected {marker.name} after download")
            processed.add(entry)


def npm_inputs(source):
    # GumJS/runtime and Core agent build scripts live below their project roots,
    # not necessarily in the root itself. Include those nested package locks,
    # while skipping disabled binding projects, test fixtures and example apps.
    excluded = IGNORED | {"subprojects", "dependency-sources", "releng", "npm-cache",
                          "test", "tests", "testcases", "test cases", "fixtures", "examples", "docs"}
    result = set()
    for project in build_roots(source):
        for current, directories, names in os.walk(project):
            directories[:] = sorted(d for d in directories if d not in excluded)
            if "package-lock.json" in names:
                lock = Path(current) / "package-lock.json"
                if not (lock.parent / "package.json").is_file():
                    fail(f"Build package lock has no package.json: {lock}")
                result.add(lock)
    return sorted(result)


def fetch(_args):
    if os.environ.get("POC_OFFLINE") == "1":
        fail("fetch is the network phase; unset POC_OFFLINE")
    if platform.system() != "Linux" or platform.machine() not in {"x86_64", "amd64"}:
        fail("Fetch on Linux x86_64 or through source-container.sh so npm caches the target-platform optional packages")
    source = source_dir()
    lock = read_json(LOCK)
    if os.environ.get("POC_FRIDA_SOURCE_DIR") and not source.exists():
        fail(f"Explicit source override does not exist: {source}")
    clone(lock["repository"], lock["revision"], source)
    for relative, expected in lock["requiredRevisions"].items():
        if git_revision(source / relative) != expected:
            fail(f"Frida release pin mismatch: {relative}")
    deps_file = source / "releng/deps.toml"
    manifest = tomllib.loads(deps_file.read_text())
    repositories = {}
    # Include the whole pinned dependency manifest, not only currently retained
    # archive members: embedded helpers and alternative relinks need their source.
    for name, spec in manifest.items():
        if not isinstance(spec, dict) or "url" not in spec or "version" not in spec:
            continue
        if not re.fullmatch(r"[a-f0-9]{40}", spec["version"]):
            fail(f"Dependency is not commit pinned: {name}")
        destination = source / "dependency-sources" / name
        clone(spec["url"], spec["version"], destination)
        repositories[destination.relative_to(source).as_posix()] = {
            "repository": spec["url"], "revision": spec["version"],
        }
    meson = source / "releng/meson/meson.py"
    if not meson.is_file():
        fail("Pinned Meson submodule is missing")
    download_wraps(source, meson)
    cache = source / "npm-cache"
    for lockfile in npm_inputs(source):
        # npm's integrity-checked cache is portable. --ignore-scripts prevents
        # platform-specific package postinstalls during the download phase.
        run("npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cache,
            cwd=lockfile.parent)
    receipt = {
        "schemaVersion": 1, "version": lock["version"], "rootRevision": git_revision(source),
        "lockSha256": sha(LOCK), "dependencyManifestSha256": sha(deps_file),
        "repositories": repositories, "files": inventory(source),
        "offlineBuildValidated": False,
        "scope": "Pinned source inputs and npm cache; source closure must also pass a clean offline build.",
        "payloadSourceAudit": "Pending: verify regeneration of upstream embedded/bootstrap payloads before release; source inventory alone does not prove this.",
    }
    write_json(source / "source-state.json", receipt)
    verify(_args)


def verify(_args):
    source = source_dir()
    receipt_path = source / "source-state.json"
    if not receipt_path.is_file():
        fail(f"Missing {receipt_path}; run fetch in the network-enabled environment first")
    receipt = read_json(receipt_path)
    if receipt.get("schemaVersion") != 1 or receipt.get("lockSha256") != sha(LOCK):
        fail("Frida source receipt does not match sources/frida-lock.json")
    recorded = receipt.get("files")
    if not isinstance(recorded, dict) or not recorded:
        fail("Empty Frida source inventory")
    for relative in recorded:
        if not relative or Path(relative).is_absolute() or ".." in Path(relative).parts:
            fail(f"Unsafe inventory path: {relative}")
    # inventory() checks both file and directory symlinks before traversing or
    # hashing them. Compare the single scan with the receipt instead of reading
    # every source file twice, which is expensive on a Docker bind mount.
    actual_inventory = inventory(source)
    missing = recorded.keys() - actual_inventory.keys()
    if missing:
        fail(f"Missing Frida input: {min(missing)}")
    if actual_inventory.keys() != recorded.keys():
        fail("Frida source file set changed; fetch a fresh source tree or use POC_FRIDA_SOURCE_OVERRIDES")
    for relative, expected in recorded.items():
        if actual_inventory[relative] != expected:
            fail(f"Frida source changed: {relative}; use POC_FRIDA_SOURCE_OVERRIDES for editable replacement trees")
    for wrap in project_wraps(source):
        marker = wrap_build_marker(wrap, source)
        if not marker.is_file():
            fail(f"Missing Meson dependency: {marker.parent}; expected {marker.name}; rerun fetch")
    print(f"Verified {len(recorded)} Frida source inputs; this is not proof of an offline build.")
    return actual_inventory


def overrides(source):
    value = json.loads(os.environ.get("POC_FRIDA_SOURCE_OVERRIDES", "{}"))
    if not isinstance(value, dict):
        fail("POC_FRIDA_SOURCE_OVERRIDES must be a JSON object mapping relative source paths to directories")
    result = {}
    for key, directory in value.items():
        replacement = (ROOT / directory).resolve()
        if not replacement.is_dir():
            fail(f"Missing source override: {replacement}")
        if key.startswith("dependency:"):
            name = key.removeprefix("dependency:")
            if not re.fullmatch(r"[a-zA-Z0-9_-]+", name):
                fail(f"Unsafe dependency override: {key}")
            targets = {wrap_target(p, source) for p in project_wraps(source) if p.name == name + ".wrap"}
            targets.discard(None)
            if not targets:
                fail(f"No fetched Meson wrap targets for {key}; specify an exact source subtree")
            extra = source / "dependency-sources" / name
            if extra.is_dir():
                targets.add(extra)
            relatives = sorted(path.relative_to(source).as_posix() for path in targets)
        else:
            relatives = [key]
        for relative in relatives:
            path = Path(relative)
            if path.is_absolute() or ".." in path.parts or relative in {"", "."}:
                fail(f"Unsafe source override: {relative}")
            if not (source / path).is_dir():
                fail(f"Unknown Frida source override: {relative}")
            if relative in result and result[relative] != replacement:
                fail(f"Conflicting replacements for {relative}")
            result[relative] = replacement
    ordered = sorted(result)
    for index, relative in enumerate(ordered):
        if any(Path(other).is_relative_to(Path(relative)) for other in ordered[index + 1:]):
            fail(f"Overlapping Frida source overrides: {relative}")
    return result


def build_inputs(source, selected, source_inputs=None):
    return {
        "sourceReceiptSha256": sha(source / "source-state.json"),
        "sourceInputs": inventory(source) if source_inputs is None else source_inputs,
        "sourceOverrides": {relative: inventory(path) for relative, path in selected.items()},
        "buildScriptSha256": sha(Path(__file__).resolve()),
        "compilerEnvironment": {key: os.environ.get(key) for key in
                                ["CC", "CXX", "AR", "LD", "NM", "STRIP", "VALAC",
                                 "CFLAGS", "CXXFLAGS", "LDFLAGS", "PKG_CONFIG_PATH"]},
    }


def reuse_devkits(output, expected):
    receipt_path = output / "build-provenance.json"
    if not receipt_path.is_file():
        return False
    receipt = read_json(receipt_path)
    if receipt.get("schemaVersion") != 1 or receipt.get("sourceBuild") is not True:
        return False
    if any(receipt.get(key) != value for key, value in expected.items()):
        return False
    outputs = receipt.get("outputs", {})
    required = {f"{kit}/{name}" for kit in ["gum", "core"]
                for name in [f"libfrida-{kit}.a", f"frida-{kit}.h"]}
    if set(outputs) != required:
        return False
    for relative, checksum in outputs.items():
        path = output / relative
        if path.is_symlink() or not path.is_file() or sha(path) != checksum:
            return False
    print(f"Reusing verified Frida devkits in {output}")
    return True


def directory_has_contents(path):
    if not path.exists():
        return False
    return not path.is_dir() or next(path.iterdir(), None) is not None


def native_build_dir(tree):
    # The pinned devkit generator only inlines compiler dependencies beneath
    # its REPO_ROOT. Keep generated headers (including glibconfig.h and the
    # Core API) there too, without modifying the original fetched source tree.
    return tree / "build"


def fallback_dependencies(tree):
    result = set()
    for wrap in project_wraps(tree):
        definition, _ = wrap_definition(wrap, tree)
        result.update([wrap.stem, definition.stem])
        parser = configparser.ConfigParser(interpolation=None)
        parser.read(definition)
        if parser.has_section("provide"):
            for name, value in parser["provide"].items():
                if name == "dependency_names":
                    # Upstream pcre2.wrap uses spaces, even though the pinned
                    # Meson provider parser expects commas. Explicit dependency
                    # selectors also prevent its initial optional system probe
                    # from accepting distro PCRE2 before the explicit fallback.
                    result.update(n.lower() for n in re.split(r"[,\s]+", value.strip()) if n)
                elif name != "program_names":
                    result.add(name.lower())
    return sorted(result)


def normalize_wrap_providers(tree):
    """Fix malformed provider lists only in the private build copy.

    Pinned Meson accepts commas, but some upstream wraps separate dependency
    names with spaces. Without a registered provider even force_fallback_for
    permits the initial optional system dependency lookup.
    """
    adaptations = []
    definitions = sorted({wrap_definition(wrap, tree)[0] for wrap in project_wraps(tree)})
    for path in definitions:
        parser = configparser.ConfigParser(interpolation=None)
        parser.read(path)
        raw = parser.get("provide", "dependency_names", fallback=None)
        if raw is None:
            continue
        parsed = [name.strip() for name in raw.split(",")]
        names = [name for name in re.split(r"[,\s]+", raw.strip()) if name]
        if parsed == names:
            continue
        before = sha(path)
        parser["provide"]["dependency_names"] = ", ".join(names)
        buffer = io.StringIO()
        parser.write(buffer)
        path.write_text(buffer.getvalue())
        adaptations.append({"path": path.relative_to(tree).as_posix(),
                            "beforeSha256": before, "afterSha256": sha(path),
                            "dependencyNames": names})
    return adaptations


def verify_devkit_headers(output, env=None):
    env = dict(os.environ) if env is None else env
    compiler = shlex.split(env.get("CC") or "cc")
    for kit in ["gum", "core"]:
        header = output / kit / f"frida-{kit}.h"
        # No dependency include paths: a devkit must expose its API standalone.
        run(*compiler, "-x", "c", "-fsyntax-only", "-include", header, "-",
            input="\n", text=True, env=env)


def verify_configured_sources(tree, native, fallbacks):
    dependencies_file = native / "meson-info/intro-dependencies.json"
    targets_file = native / "meson-info/intro-targets.json"
    dependencies = read_json(dependencies_file)
    targets = read_json(targets_file)
    bundled = set(fallbacks)
    for dependency in dependencies:
        if dependency.get("name") in bundled and dependency.get("type") != "internal":
            fail(f"Bundled dependency resolved outside its source subproject: {dependency['name']} "
                 f"({dependency.get('type')}); refusing native compilation")
    # The pinned Meson introspector omits many overridden internal dependencies.
    # Also require the actual local archive target for the PCRE2 dependency whose
    # malformed wrap previously allowed a distro library to bypass source builds.
    pcre2 = [target for target in targets if target.get("name") == "pcre2-8"
             and target.get("type") == "static library"]
    if len(pcre2) != 1:
        fail("Expected one source-built pcre2-8 static-library target; refusing native compilation")
    target = pcre2[0]
    definition = Path(target.get("defined_in", "")).resolve()
    outputs = target.get("filename", [])
    if not definition.is_relative_to(tree.resolve()) or not outputs or any(
            not Path(path).resolve().is_relative_to(native.resolve()) or Path(path).suffix != ".a"
            for path in outputs):
        fail("PCRE2 static-library target leaves the private source/build tree; refusing native compilation")
    return {"bundledDependencyNames": sorted(bundled),
            "pcre2StaticTarget": {key: target.get(key) for key in ["name", "id", "defined_in", "filename"]},
            "dependenciesSha256": sha(dependencies_file), "targetsSha256": sha(targets_file)}


def build(_args):
    if platform.system() != "Linux" or platform.machine() not in {"x86_64", "amd64"}:
        fail("Frida devkits must be built on Linux x86_64; use source-container.sh")
    verified_inputs = verify(_args)
    source = source_dir()
    lock = read_json(LOCK)
    output = (ROOT / os.environ.get("POC_FRIDA_DEVKIT_OUTPUT_DIR", "build/frida-devkits")).resolve()
    work = (ROOT / os.environ.get("POC_FRIDA_BUILD_DIR", "build/frida-source-build")).resolve()
    if work.is_relative_to(source) or output.is_relative_to(source):
        fail("Build and devkit output directories must be outside the source tree")
    selected = overrides(source)
    inputs = build_inputs(source, selected, source_inputs=verified_inputs)
    if reuse_devkits(output, inputs):
        return
    if directory_has_contents(work) or directory_has_contents(output):
        fail("Existing Frida build is incomplete or its source, overrides, build script, compiler settings or devkit hashes changed. "
             "Set fresh POC_FRIDA_BUILD_DIR and POC_FRIDA_DEVKIT_OUTPUT_DIR; existing builds are preserved")
    work.mkdir(parents=True, exist_ok=True)
    tree = work / "source"
    shutil.copytree(source, tree, symlinks=True, ignore=shutil.ignore_patterns(*IGNORED, "*.pyc"))
    for relative, replacement in selected.items():
        destination = tree / relative
        shutil.rmtree(destination)
        shutil.copytree(replacement, destination, symlinks=True, ignore=shutil.ignore_patterns(*IGNORED, "*.pyc"))
    wrap_provider_adaptations = normalize_wrap_providers(tree)
    # Frida normally derives its version from Git. Exported archives intentionally
    # omit Git metadata. Adapt only the private build copy, recording this change.
    top = tree / "meson.build"
    old = top.read_text()
    new, count = re.subn(r"version:\s*run_command\('releng'\s*/\s*'frida_version\.py',\s*check:\s*true\)\.stdout\(\)\.strip\(\)",
                         "version: '" + lock["version"] + "'", old, count=1)
    if count != 1:
        fail("Unrecognized upstream version detection; review the source-export adaptation")
    top.write_text(new)
    env = dict(os.environ)
    env.update({"FRIDA_DEPS": str(work / "deps"), "FRIDA_ALLOWED_PREBUILDS": "",
                "npm_config_cache": str(tree / "npm-cache"), "npm_config_offline": "true",
                "npm_config_audit": "false", "npm_config_fund": "false",
                "GIT_TERMINAL_PROMPT": "0", "GIT_ALLOW_PROTOCOL": "file"})
    meson = tree / "releng/meson/meson.py"
    # Build the matching Vala compiler from its fetched sources. The distro Vala
    # compiler is only a bootstrap tool and is recorded by the caller's image.
    vala = tree / "dependency-sources/vala"
    prefix = work / "toolchain"
    run(sys.executable, meson, "setup", work / "vala-build", vala, f"--prefix={prefix}",
        "--wrap-mode=nodownload", "-Ddefault_library=static", env=env)
    jobs = os.environ.get("POC_BUILD_JOBS", "2")
    run(sys.executable, meson, "compile", "-C", work / "vala-build", "-j", jobs, env=env)
    run(sys.executable, meson, "install", "-C", work / "vala-build", env=env)
    env["PATH"] = str(prefix / "bin") + os.pathsep + env.get("PATH", "")
    compilers = sorted((prefix / "bin").glob("valac-*"))
    if not compilers:
        fail("Pinned Vala build did not install its compiler; refusing to fall back to the system compiler")
    env["VALAC"] = str(compilers[0])
    vala_version = run(env["VALAC"], "--version", env=env, capture_output=True, text=True).stdout.strip()
    if not vala_version.endswith("-frida"):
        fail(f"Frida Core requires the Frida Vala fork; built compiler reports {vala_version!r}")
    for lockfile in npm_inputs(tree):
        run("npm", "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
            cwd=lockfile.parent, env=env)
    native = native_build_dir(tree)
    native.mkdir()
    # Meson options are documented by the pinned source's meson.options files.
    # Force all fetched wrap dependencies to source so installed system libraries
    # cannot silently replace the LGPL dependencies a recipient is modifying.
    fallbacks = fallback_dependencies(tree)
    configure = [tree / "configure", "--without-prebuilds=toolchain,sdk", "--",
                 "--wrap-mode=nodownload", "--force-fallback-for=" + ",".join(fallbacks),
                 "-Dfrida-gum:devkits=gum", "-Dfrida-core:devkits=core",
                 "-Dfrida_tools=disabled", "-Dfrida_python=disabled", "-Dfrida_node=disabled",
                 "-Dfrida_clr=disabled", "-Dfrida_swift=disabled", "-Dfrida_qml=disabled",
                 "-Dfrida-gum:tests=disabled", "-Dfrida-core:tests=disabled",
                 "-Dfrida-core:compat=disabled", "-Dfrida-core:fruity_backend=disabled",
                 "-Dfrida-core:droidy_backend=disabled", "-Dfrida-core:barebone_backend=disabled",
                 "-Dfrida-core:compiler_backend=disabled", "-Dfrida-gum:v8=disabled"]
    run(*configure, cwd=native, env=env)
    source_dependency_validation = verify_configured_sources(tree, native, fallbacks)
    run("make", "-j" + jobs, cwd=native, env=env)
    outputs = {}
    for kit in ["gum", "core"]:
        destination = output / kit
        destination.mkdir(parents=True)
        for filename in [f"libfrida-{kit}.a", f"frida-{kit}.h"]:
            # Only take devkit products, not the uncombined intermediate archive.
            candidates = [p for p in native.rglob(filename) if "devkit" in p.as_posix()]
            if len(candidates) != 1:
                fail(f"Expected exactly one generated devkit product {filename}; found {candidates}")
            shutil.copy2(candidates[0], destination / filename)
            outputs[f"{kit}/{filename}"] = sha(destination / filename)
    verify_devkit_headers(output, env)
    write_json(output / "build-provenance.json", {
        "schemaVersion": 1, "version": lock["version"], "sourceBuild": True,
        **inputs,
        "versionAdaptation": {"path": "meson.build", "beforeSha256": hashlib.sha256(old.encode()).hexdigest(),
                              "afterSha256": sha(top)},
        "wrapProviderAdaptations": wrap_provider_adaptations,
        "configure": [str(a) for a in configure], "outputs": outputs,
        "sourceDependencyValidation": source_dependency_validation,
        "devkitHeadersValidated": True,
        "valaCompilerVersion": vala_version,
        "networkPolicy": "No prebuilt bundles; Meson nodownload and npm offline. Run in Docker --network=none for enforcement.",
        "profile": "Linux x86_64 capture/injection devkits; compatibility targets, remote mobile backends, compiler backend and V8 disabled. Not the upstream prebuilt release profile.",
        "payloadSourceAudit": "Pending: main-build success does not prove every embedded upstream payload was regenerated.",
    })
    print(f"Built source devkits in {output}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["fetch", "verify", "build"])
    args = parser.parse_args()
    try:
        globals()[args.command](args)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"frida-source: {error}\n")


if __name__ == "__main__":
    main()
