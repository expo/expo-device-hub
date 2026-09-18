"""Archive integrity tests; no network, upstream builds, or legal sign-off."""
import argparse
from contextlib import redirect_stdout
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/source-archive.py"
SPEC = importlib.util.spec_from_file_location("capture_source_archive", SCRIPT)
archive_tool = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(archive_tool)


class SourceArchiveTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="capture-source-tests-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "package"
        self.root.mkdir()
        self.output = Path(temporary.name) / "output"
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(archive_tool, "ROOT", self.root).start()
        mock.patch.dict(os.environ, {}, clear=True).start()
        # Only Frida's recursive-source verification subprocess is a fixture:
        # create(), copying, git provenance, inventory, tar and verify are real.
        self.frida_verify = mock.patch.object(archive_tool, "run", side_effect=self.verify_frida).start()
        self.record = {
            "distribution": {"injectedAgentTreatment": "unresolved", "releaseReady": False},
            "host": {"correspondingSource": {"status": "unresolved"}},
            "decisions": [],
            "releaseEvidence": {},
        }
        directories = {"src", "scripts", "tests", "docs", "LICENSES"}
        for item in archive_tool.PACKAGE_ITEMS:
            if item in directories:
                self.write(item + "/fixture.txt", "editable package input\n")
            else:
                self.write(item, "fixture package file\n")
        self.write("package.json", json.dumps({"name": "@expo/emulator-capture", "version": "1.2.3"}))
        self.write("sources/compliance.json", json.dumps(self.record))
        for name, pin in archive_tool.PINS.items():
            self.write("sources/" + name + "/" + pin["marker"], "editable dependency input\n")
        self.write("sources/frida/source-state.json", '{"files": {}}\n')
        self.write("sources/frida/frida-core/src/fixture.c", "/* locally modified Frida source */\n")
        self.write("sources/frida/releng/build/fixture.py", "# upstream build machinery is source\n")

    def write(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content)
        return path

    def verify_frida(self, *args, **kwargs):
        self.assertEqual(list(map(str, args[1:])), [str(self.root / "scripts/frida-source.py"), "verify"])
        self.assertFalse(kwargs)

    def create(self, **overrides):
        values = dict(version=None, output=str(self.output / "source.tar.gz"),
                      compliance=str(self.root / "sources/compliance.json"),
                      release=False, source_url=None, evidence_dir=None, binary_dir=None)
        values.update(overrides)
        with redirect_stdout(io.StringIO()):
            archive_tool.create(argparse.Namespace(**values))
        return Path(values["output"])

    def verify(self, archive, release=False, **overrides):
        arguments = dict(archive=str(archive), release=release, binary_dir=None, with_build_evidence=False)
        arguments.update(overrides)
        with redirect_stdout(io.StringIO()):
            archive_tool.verify(argparse.Namespace(**arguments))

    def build_evidence(self):
        """Synthetic successful records bound to this fixture's actual inputs."""
        self.write("scripts/frida-source.py", "# fixture devkit build machinery\n")
        source_inputs = {}
        for key, directory in [("expo", "src"), ("ffmpeg", "sources/ffmpeg"),
                               ("nvCodecHeaders", "sources/nv-codec-headers"), ("buildScripts", "scripts")]:
            entries = [{"path": name, "type": "file", "sha256": item["sha256"]}
                       for name, item in archive_tool.inventory(self.root / directory).items()]
            digest = hashlib.sha256(json.dumps(entries, separators=(",", ":")).encode()).hexdigest()
            source_inputs[key] = {"directory": str(self.root / directory), "entries": entries, "sha256": digest}
        binaries = self.root.parent / "checked-binaries"
        binaries.mkdir()
        outputs = []
        for name in ["inject", "libgpu_capture.so"]:
            binary = binaries / name
            binary.write_bytes(("fixture native output: " + name).encode())
            outputs.append({"path": str(binary), "sha256": archive_tool.sha(binary)})
        frida = {
            "sourceBuild": True,
            "buildScriptSha256": archive_tool.sha(self.root / "scripts/frida-source.py"),
            "sourceInputs": {name: {"sha256": item["sha256"]}
                             for name, item in archive_tool.inventory(self.root / "sources/frida").items()
                             if name != "source-state.json"},
            "sourceOverrides": {}, "outputs": {},
        }
        native_inputs = []
        for kit in ["gum", "core"]:
            for name in [f"frida-{kit}.h", f"libfrida-{kit}.a"]:
                digest = hashlib.sha256(("fixture devkit input " + name).encode()).hexdigest()
                frida["outputs"][f"{kit}/{name}"] = digest
                native_inputs.append({"path": f"/fixture/{kit}/{name}", "sha256": digest})
        build = {"schemaVersion": 1, "sourceBuild": True, "sources": source_inputs,
                 "inputs": native_inputs, "outputs": outputs}
        evidence = self.root / "fixture-build-evidence"
        evidence.mkdir()
        # Native JSON.stringify preserves entry key order, which is part of the
        # fingerprint format; production copies this record without reformatting.
        (evidence / "binary-inventory.json").write_text(json.dumps(build, indent=2) + "\n")
        inventory_hash = archive_tool.sha(evidence / "binary-inventory.json")
        archive_tool.write_json(evidence / "frida-build.json", frida)
        archive_tool.write_json(evidence / "rebuild-verification.json", {
            "passed": True, "binaryInventorySha256": inventory_hash, "outputs": outputs,
        })
        archive_tool.write_json(evidence / "modified-dependency-rebuild.json", {
            "passed": True, "binaryInventorySha256": inventory_hash, "dependency": "ffmpeg",
            "originalSourceSha256": source_inputs["ffmpeg"]["sha256"],
            "modifiedSourceSha256": hashlib.sha256(b"modified fixture source").hexdigest(),
            "originalLibrarySha256": outputs[1]["sha256"],
            "modifiedLibrarySha256": hashlib.sha256(b"modified fixture library").hexdigest(),
            "markerFoundInCapture": True,
        })
        return evidence, binaries

    def contents(self, archive):
        with tarfile.open(archive, "r:gz") as stream:
            return {member.name: stream.extractfile(member).read()
                    for member in stream.getmembers() if member.isfile()}

    def rewrite(self, archive, transform):
        """Rewrite members without extracting; transform can tamper with metadata."""
        output = archive.with_name("rewritten.tar.gz")
        with tarfile.open(archive, "r:gz") as source, tarfile.open(output, "w:gz") as target:
            for original in source.getmembers():
                member = copy.copy(original)
                data = source.extractfile(original).read() if original.isfile() else None
                result = transform(member, data)
                if result is None:
                    continue
                member, data = result
                if data is not None:
                    member.size = len(data)
                target.addfile(member, io.BytesIO(data) if data is not None else None)
        return output

    def test_host_source_requirements_follow_reviewed_relationship(self):
        # Neither an unresolved classification nor an unsupported alternative
        # can be turned into a release by setting releaseReady alone.
        self.record["distribution"]["releaseReady"] = True
        self.record["decisions"] = [
            {"id": key, "status": "resolved", "evidence": ["fixture review"]}
            for key in archive_tool.DECISIONS
        ]
        for treatment, message in [
            ("unresolved", "licensing relationship is unresolved"),
            ("separate-work", "Release packaging has not been reviewed"),
        ]:
            with self.subTest(treatment=treatment):
                self.record["distribution"]["injectedAgentTreatment"] = treatment
                errors = archive_tool.compliance_errors(self.record, decisions_only=True)
                self.assertEqual(len(errors), 1)
                self.assertIn(message, errors[0])
                self.write("sources/compliance.json", json.dumps(self.record))
                with self.assertRaisesRegex(ValueError, message):
                    self.create(release=True)

        self.record["distribution"]["injectedAgentTreatment"] = "combined-program"
        errors = archive_tool.compliance_errors(self.record, decisions_only=True)
        self.assertIn("Host corresponding-source scope and evidence are unresolved", errors)
        self.assertIn("Host corresponding-source manifest SHA-256 is missing", errors)

    def test_development_archive_preserves_modified_sources_and_excludes_git(self):
        self.write("sources/ffmpeg/locally-modified.c", "/* uncommitted change */\n")
        self.write("sources/ffmpeg/.git/config", "remote url with credentials must never ship\n")
        self.write("sources/ffmpeg/.git/objects/private", b"git object")
        executable = self.write("sources/ffmpeg/rebuild-helper.sh", "#!/bin/sh\nexit 0\n")
        executable.chmod(0o755)
        archive = self.create()
        self.verify(archive)
        contents = self.contents(archive)
        prefix = "emulator-capture-source-1.2.3/"
        self.assertEqual(contents[prefix + "sources/ffmpeg/locally-modified.c"], b"/* uncommitted change */\n")
        self.assertIn(prefix + "sources/frida/releng/build/fixture.py", contents)
        self.assertFalse(any("/.git/" in name for name in contents))
        manifest = json.loads(contents[prefix + "source-manifest.json"])
        self.assertFalse(manifest["releaseReady"])
        self.assertTrue(manifest["limitations"])
        self.assertTrue(manifest["files"]["sources/ffmpeg/rebuild-helper.sh"]["executable"])
        self.assertIn(hashlib.sha256(archive.read_bytes()).hexdigest(), archive.with_name(archive.name + ".sha256").read_text())
        self.frida_verify.assert_called_once()

    def test_explicit_source_override_uses_local_modified_tree(self):
        custom = self.root.parent / "my-ffmpeg"
        custom.mkdir()
        (custom / "configure").write_text("modified configure\n")
        (custom / "custom.c").write_text("modified source\n")
        os.environ["POC_FFMPEG_SOURCE_DIR"] = str(custom)
        archive = self.create()
        self.verify(archive)
        contents = self.contents(archive)
        self.assertEqual(contents["emulator-capture-source-1.2.3/sources/ffmpeg/custom.c"], b"modified source\n")
        self.assertEqual((custom / "configure").read_text(), "modified configure\n")

    def test_internal_source_symlinks_are_preserved(self):
        source = self.write("sources/ffmpeg/shared.c", "source\n")
        (source.parent / "alias.c").symlink_to("shared.c")
        archive = self.create()
        self.verify(archive)
        with tarfile.open(archive, "r:gz") as stream:
            link = stream.getmember("emulator-capture-source-1.2.3/sources/ffmpeg/alias.c")
            self.assertTrue(link.issym())
            self.assertEqual(link.linkname, "shared.c")

    def test_external_source_symlinks_are_rejected(self):
        outside = self.write("private.txt", "not a dependency source\n")
        source = self.root / "sources/ffmpeg"
        for target in [str(outside), "../../private.txt"]:
            with self.subTest(target=target):
                link = source / "outside-link"
                link.symlink_to(target)
                with self.assertRaisesRegex(ValueError, "symlink leaves its tree"):
                    self.create()
                link.unlink()

    def test_native_build_products_cannot_substitute_for_source(self):
        for filename in ["capture.o", "libcapture.a", "libcapture.so", "libcapture.so.2"]:
            with self.subTest(filename=filename):
                binary = self.write("sources/ffmpeg/" + filename, b"compiled binary fixture")
                with self.assertRaisesRegex(ValueError, "Build product in source tree"):
                    self.create()
                binary.unlink()

    def test_extensionless_elf_is_rejected(self):
        self.write("sources/ffmpeg/encoder", b"\x7fELF" + bytes(64))
        with self.assertRaisesRegex(ValueError, "Build product in source tree"):
            self.create()

    def test_frida_override_is_baked_into_portable_archive(self):
        custom = self.root.parent / "custom-frida-core"
        custom.mkdir()
        (custom / "modified.c").write_text("/* edited Frida source */\n")
        os.environ["POC_FRIDA_SOURCE_OVERRIDES"] = json.dumps({"frida-core": str(custom)})
        archive = self.create()
        self.verify(archive)
        contents = self.contents(archive)
        prefix = "emulator-capture-source-1.2.3/sources/frida/"
        self.assertEqual(contents[prefix + "frida-core/modified.c"], b"/* edited Frida source */\n")
        self.assertNotIn(prefix + "frida-core/src/fixture.c", contents)
        state = json.loads(contents[prefix + "source-state.json"])
        self.assertEqual(state["modifiedSubtrees"], ["frida-core"])
        self.assertIn("frida-core/modified.c", state["files"])
        self.assertNotIn(str(custom), json.dumps(state))

    def test_create_refuses_to_overwrite_existing_archive(self):
        archive = self.create()
        original = archive.read_bytes()
        with self.assertRaisesRegex(ValueError, "Refusing to overwrite"):
            self.create()
        self.assertEqual(archive.read_bytes(), original)

    def test_staging_cannot_be_inside_source_tree(self):
        source = self.root / "sources/ffmpeg"
        with self.assertRaisesRegex(ValueError, "must not be inside"):
            archive_tool.copy_sources(source, source / "staging")
        self.assertFalse((source / "staging").exists())

    def test_corrupt_compressed_archive_is_rejected(self):
        archive = self.create()
        archive.write_bytes(b"not a gzip archive")
        with self.assertRaises((tarfile.TarError, OSError, ValueError)):
            self.verify(archive)

    def test_tampered_file_content_is_rejected(self):
        archive = self.create()
        def tamper(member, data):
            if member.name.endswith("sources/ffmpeg/configure"):
                data = b"injected configure command\n"
            return member, data
        with self.assertRaisesRegex(ValueError, "do not match its manifest"):
            self.verify(self.rewrite(archive, tamper))

    def test_tampered_executable_bit_is_rejected(self):
        archive = self.create()
        def tamper(member, data):
            if member.name.endswith("sources/ffmpeg/configure"):
                member.mode ^= 0o111
            return member, data
        with self.assertRaisesRegex(ValueError, "do not match its manifest"):
            self.verify(self.rewrite(archive, tamper))

    def test_unsafe_archive_paths_are_rejected_before_extraction(self):
        archive = self.create()
        for path in ["/absolute/escape", "emulator-capture-source-1.2.3/../../escape"]:
            with self.subTest(path=path):
                def tamper(member, data):
                    if member.name.endswith("sources/ffmpeg/configure"):
                        member.name = path
                    return member, data
                with self.assertRaises(ValueError):
                    self.verify(self.rewrite(archive, tamper))
        self.assertFalse((self.root.parent / "escape").exists())

    def test_unsafe_archive_symlinks_are_rejected(self):
        source = self.write("sources/ffmpeg/shared.c", "source\n")
        (source.parent / "alias.c").symlink_to("shared.c")
        archive = self.create()
        for target in ["/etc/passwd", "../../../../escape"]:
            with self.subTest(target=target):
                def tamper(member, data):
                    if member.issym():
                        member.linkname = target
                    return member, data
                with self.assertRaisesRegex(ValueError, "Unsafe source symlink"):
                    self.verify(self.rewrite(archive, tamper))

    def test_duplicate_archive_paths_are_rejected(self):
        archive = self.create()
        def tamper(member, data):
            if member.name.endswith("sources/ffmpeg/configure"):
                member.name = "emulator-capture-source-1.2.3/package.json"
            return member, data
        with self.assertRaisesRegex(ValueError, "Duplicate archive entries"):
            self.verify(self.rewrite(archive, tamper))

    def test_special_archive_entries_are_rejected(self):
        archive = self.create()
        def tamper(member, data):
            if member.name.endswith("sources/ffmpeg/configure"):
                member.type = tarfile.FIFOTYPE
                member.size = 0
                data = None
            return member, data
        with self.assertRaisesRegex(ValueError, "Unsupported archive entry"):
            self.verify(self.rewrite(archive, tamper))

    def test_incomplete_compliance_cannot_create_release_archive(self):
        with self.assertRaisesRegex(ValueError, "Release prerequisites are incomplete"):
            self.create(release=True, source_url="https://example.org/source.tar.gz")
        self.frida_verify.assert_not_called()
        self.assertFalse((self.output / "source.tar.gz").exists())

    def test_development_archive_cannot_pass_release_verification(self):
        archive = self.create()
        with self.assertRaisesRegex(ValueError, "development archive"):
            self.verify(archive, release=True)

    def test_manifest_release_flag_cannot_bypass_compliance_checks(self):
        archive = self.create()
        def tamper(member, data):
            if member.name.endswith("/source-manifest.json"):
                manifest = json.loads(data)
                manifest["releaseReady"] = True
                data = json.dumps(manifest).encode()
            return member, data
        with self.assertRaisesRegex(ValueError, "Archived release prerequisites are incomplete"):
            self.verify(self.rewrite(archive, tamper), release=True)

    def test_development_build_evidence_does_not_claim_legal_release_readiness(self):
        evidence, binaries = self.build_evidence()
        archive = self.create(with_build_evidence=True, evidence_dir=str(evidence), binary_dir=str(binaries))
        self.verify(archive)
        self.verify(archive, with_build_evidence=True, binary_dir=str(binaries))
        contents = self.contents(archive)
        manifest = json.loads(contents["emulator-capture-source-1.2.3/source-manifest.json"])
        self.assertTrue(manifest["buildEvidenceVerified"])
        self.assertFalse(manifest["releaseReady"])
        self.assertTrue(manifest["limitations"])
        with self.assertRaisesRegex(ValueError, "development archive"):
            self.verify(archive, release=True)

    def test_development_evidence_and_binary_arguments_activate_validation(self):
        evidence, binaries = self.build_evidence()
        archive = self.create(evidence_dir=str(evidence), binary_dir=str(binaries))
        self.verify(archive, with_build_evidence=True, binary_dir=str(binaries))
        manifest = json.loads(self.contents(archive)["emulator-capture-source-1.2.3/source-manifest.json"])
        self.assertTrue(manifest["buildEvidenceVerified"])

    def test_partial_build_evidence_arguments_are_not_silently_ignored(self):
        for arguments in [{"with_build_evidence": True}, {"evidence_dir": "fixture"}, {"binary_dir": "fixture"}]:
            with self.subTest(arguments=arguments):
                with self.assertRaisesRegex(ValueError, "requires both --evidence-dir and --binary-dir"):
                    self.create(**arguments)
        self.frida_verify.assert_not_called()

    def test_development_create_rejects_wrong_binary_when_evidence_is_supplied(self):
        evidence, binaries = self.build_evidence()
        (binaries / "inject").write_bytes(b"old output")
        with self.assertRaisesRegex(ValueError, "Release binary does not match"):
            self.create(with_build_evidence=True, evidence_dir=str(evidence), binary_dir=str(binaries))
        self.assertFalse((self.output / "source.tar.gz").exists())

    def test_development_verify_rejects_changed_binary(self):
        evidence, binaries = self.build_evidence()
        archive = self.create(evidence_dir=str(evidence), binary_dir=str(binaries))
        (binaries / "libgpu_capture.so").write_bytes(b"different build output")
        with self.assertRaisesRegex(ValueError, "Release binary does not match"):
            self.verify(archive, with_build_evidence=True, binary_dir=str(binaries))

    def test_development_verify_checks_embedded_build_evidence_even_without_binary_arguments(self):
        evidence, binaries = self.build_evidence()
        archive = self.create(evidence_dir=str(evidence), binary_dir=str(binaries))
        rebuild = json.loads((evidence / "rebuild-verification.json").read_text())
        rebuild["passed"] = False
        bad_record = json.dumps(rebuild).encode()
        def tamper(member, data):
            if member.name.endswith("/release-evidence/rebuild-verification.json"):
                data = bad_record
            if member.name == "emulator-capture-source-1.2.3/source-manifest.json":
                manifest = json.loads(data)
                manifest["files"]["release-evidence/rebuild-verification.json"]["sha256"] = hashlib.sha256(bad_record).hexdigest()
                data = json.dumps(manifest).encode()
            return member, data
        with self.assertRaisesRegex(ValueError, "does not establish a successful check"):
            self.verify(self.rewrite(archive, tamper))

    def test_source_only_archive_cannot_silently_ignore_supplied_binaries(self):
        archive = self.create()
        with self.assertRaisesRegex(ValueError, "no validated build evidence"):
            self.verify(archive, binary_dir="unrelated-binaries")
        with self.assertRaisesRegex(ValueError, "requires --binary-dir"):
            self.verify(archive, with_build_evidence=True)

    def test_build_evidence_flag_cannot_bypass_missing_records(self):
        archive = self.create()
        def tamper(member, data):
            if member.name == "emulator-capture-source-1.2.3/source-manifest.json":
                manifest = json.loads(data)
                manifest["buildEvidenceVerified"] = True
                data = json.dumps(manifest).encode()
            return member, data
        with self.assertRaisesRegex(ValueError, "Missing release record"):
            self.verify(self.rewrite(archive, tamper))

    def test_invalid_source_download_links_are_rejected(self):
        for url in ["http://example.org/source.tar.gz", "https://user:token@example.org/a", "https://example.org/a)bad", "https://example.org/a#fragment"]:
            with self.subTest(url=url):
                with self.assertRaisesRegex(ValueError, "HTTPS download URL"):
                    self.create(source_url=url)
        self.frida_verify.assert_not_called()


class BuildEvidenceTests(unittest.TestCase):
    """Use synthetic source/binary bytes to test record binding, not rebuilding."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="capture-evidence-tests-")
        self.addCleanup(temporary.cleanup)
        self.binary_dir = Path(temporary.name)
        self.files = {}
        sources = {}
        for key, prefix, path in [
            ("expo", "src/", "capture.cpp"),
            ("ffmpeg", "sources/ffmpeg/", "libavcodec/allcodecs.c"),
            ("nvCodecHeaders", "sources/nv-codec-headers/", "include/ffnvcodec/nvEncodeAPI.h"),
            ("buildScripts", "scripts/", "build.mjs"),
        ]:
            digest = hashlib.sha256(("synthetic " + key + " source").encode()).hexdigest()
            entries = [{"path": path, "type": "file", "sha256": digest}]
            sources[key] = {"entries": entries, "sha256": self.json_hash(entries)}
            self.files[prefix + path] = {"sha256": digest, "executable": False}
        frida_script_hash = hashlib.sha256(b"synthetic Frida build machinery").hexdigest()
        self.files["scripts/frida-source.py"] = {"sha256": frida_script_hash, "executable": False}
        sources["buildScripts"]["entries"].append({"path": "frida-source.py", "type": "file", "sha256": frida_script_hash})
        sources["buildScripts"]["sha256"] = self.json_hash(sources["buildScripts"]["entries"])
        outputs = []
        for name in ["inject", "libgpu_capture.so"]:
            binary = self.binary_dir / name
            binary.write_bytes(("synthetic binary bytes: " + name).encode())
            outputs.append({"path": str(binary), "sha256": archive_tool.sha(binary)})
        self.frida_build = {
            "sourceBuild": True,
            "buildScriptSha256": frida_script_hash,
            "sourceInputs": {"subprojects/frida-gum/gum/gum.c": {
                "sha256": hashlib.sha256(b"synthetic Frida source").hexdigest(),
            }},
            "sourceOverrides": {},
            "outputs": {},
        }
        self.files["sources/frida/subprojects/frida-gum/gum/gum.c"] = {
            **self.frida_build["sourceInputs"]["subprojects/frida-gum/gum/gum.c"], "executable": False,
        }
        inputs = []
        for kit in ["gum", "core"]:
            for filename in [f"frida-{kit}.h", f"libfrida-{kit}.a"]:
                digest = hashlib.sha256(("synthetic devkit file: " + filename).encode()).hexdigest()
                self.frida_build["outputs"][f"{kit}/{filename}"] = digest
                inputs.append({"path": f"/fixture/devkits/{kit}/{filename}", "sha256": digest})
        self.build = {"schemaVersion": 1, "sourceBuild": True, "sources": sources, "inputs": inputs, "outputs": outputs}
        inventory_hash = self.json_hash(self.build)
        self.files["release-evidence/binary-inventory.json"] = {"sha256": inventory_hash, "executable": False}
        self.rebuilt = {"passed": True, "binaryInventorySha256": inventory_hash, "outputs": copy.deepcopy(outputs)}
        self.modified = {
            "passed": True, "binaryInventorySha256": inventory_hash, "dependency": "ffmpeg",
            "originalSourceSha256": sources["ffmpeg"]["sha256"],
            "modifiedSourceSha256": hashlib.sha256(b"synthetically modified source").hexdigest(),
            "originalLibrarySha256": outputs[1]["sha256"],
            "modifiedLibrarySha256": hashlib.sha256(b"synthetically modified binary").hexdigest(),
            "markerFoundInCapture": True,
        }
        self.records = {
            "release-evidence/binary-inventory.json": self.build,
            "release-evidence/frida-build.json": self.frida_build,
            "release-evidence/rebuild-verification.json": self.rebuilt,
            "release-evidence/modified-dependency-rebuild.json": self.modified,
        }

    @staticmethod
    def json_hash(value):
        return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()

    def validate(self, binary_dir=True):
        archive_tool.validate_build_evidence(self.files, self.records.__getitem__,
                                            self.binary_dir if binary_dir else None)

    def test_matching_source_binary_and_rebuild_records_pass(self):
        self.validate()
        # An already archived record can be checked without local binary paths.
        self.validate(binary_dir=False)

    def test_stale_source_is_rejected(self):
        self.files["sources/ffmpeg/libavcodec/allcodecs.c"]["sha256"] = hashlib.sha256(b"later edit").hexdigest()
        with self.assertRaisesRegex(ValueError, "Source changed since native build"):
            self.validate()

    def test_new_source_file_after_build_is_rejected(self):
        self.files["sources/ffmpeg/libavcodec/new-codec.c"] = {
            "sha256": hashlib.sha256(b"added after build").hexdigest(), "executable": False,
        }
        with self.assertRaisesRegex(ValueError, "Source file set changed since native build"):
            self.validate()

    def test_path_set_matches_native_fingerprint_exclusions(self):
        source = self.build["sources"]["ffmpeg"]
        source["directory"] = "/build/source/ffmpeg"
        self.build["paths"] = {"ffmpegBuildDirectory": "/build/source/ffmpeg/custom-output"}
        for relative in ["build/helper.c", "tools/build/generated.c", "__pycache__/entry.pyc", "custom-output/config.h"]:
            self.files["sources/ffmpeg/" + relative] = {
                "sha256": hashlib.sha256(relative.encode()).hexdigest(), "executable": False,
            }
        self.validate()

    def test_new_frida_source_file_after_devkit_build_is_rejected(self):
        self.files["sources/frida/subprojects/frida-gum/gum/new-code.c"] = {
            "sha256": hashlib.sha256(b"added Frida code").hexdigest(), "executable": False,
        }
        with self.assertRaisesRegex(ValueError, "Frida source file set changed"):
            self.validate()

    def test_frida_receipt_is_not_treated_as_a_compiled_source_input(self):
        self.files["sources/frida/source-state.json"] = {"sha256": "a" * 64, "executable": False}
        self.validate()

    def test_missing_built_source_is_rejected(self):
        del self.files["src/capture.cpp"]
        with self.assertRaisesRegex(ValueError, "Source changed since native build"):
            self.validate()

    def test_old_binary_is_rejected(self):
        (self.binary_dir / "libgpu_capture.so").write_bytes(b"old release output")
        with self.assertRaisesRegex(ValueError, "Release binary does not match"):
            self.validate()

    def test_stale_frida_source_is_rejected(self):
        self.files["sources/frida/subprojects/frida-gum/gum/gum.c"]["sha256"] = hashlib.sha256(b"later Frida edit").hexdigest()
        with self.assertRaisesRegex(ValueError, "Frida source changed since devkit build"):
            self.validate()

    def test_devkit_build_must_use_archived_frida_build_script(self):
        self.frida_build["buildScriptSha256"] = hashlib.sha256(b"different Frida build machinery").hexdigest()
        with self.assertRaisesRegex(ValueError, "Frida devkit build script does not match"):
            self.validate()

    def test_native_binary_must_use_inventoried_source_built_devkits(self):
        self.build["inputs"][0]["sha256"] = hashlib.sha256(b"unrelated prebuilt devkit").hexdigest()
        with self.assertRaisesRegex(ValueError, "did not use the inventoried source-built"):
            self.validate()

    def test_rebuild_record_for_other_binary_is_rejected(self):
        self.rebuilt["outputs"][0]["sha256"] = hashlib.sha256(b"other injector").hexdigest()
        with self.assertRaisesRegex(ValueError, "different binary outputs"):
            self.validate()

    def test_stale_evidence_inventory_hash_is_rejected(self):
        self.modified["binaryInventorySha256"] = hashlib.sha256(b"old inventory").hexdigest()
        with self.assertRaisesRegex(ValueError, "successful check for this binary inventory"):
            self.validate()

    def test_modified_test_must_start_from_archived_source(self):
        self.modified["originalSourceSha256"] = hashlib.sha256(b"other source").hexdigest()
        with self.assertRaisesRegex(ValueError, "did not start from the archived FFmpeg source"):
            self.validate()

    def test_wrong_modified_dependency_results_are_rejected(self):
        original = copy.deepcopy(self.modified)
        changes = {
            "originalLibrarySha256": hashlib.sha256(b"other baseline binary").hexdigest(),
            "modifiedLibrarySha256": self.modified["originalLibrarySha256"],
            "modifiedSourceSha256": self.modified["originalSourceSha256"],
            "markerFoundInCapture": False,
        }
        for key, value in changes.items():
            with self.subTest(field=key):
                self.modified.clear()
                self.modified.update(original)
                self.modified[key] = value
                with self.assertRaisesRegex(ValueError, "does not demonstrate relinking"):
                    self.validate()

    def test_missing_modified_hashes_are_rejected(self):
        original = copy.deepcopy(self.modified)
        for key in ["modifiedLibrarySha256", "modifiedSourceSha256"]:
            with self.subTest(field=key):
                self.modified.clear()
                self.modified.update(original)
                del self.modified[key]
                with self.assertRaises(ValueError):
                    self.validate()

    def test_malformed_modified_hashes_are_rejected(self):
        original = copy.deepcopy(self.modified)
        for key in ["modifiedLibrarySha256", "modifiedSourceSha256"]:
            with self.subTest(field=key):
                self.modified.clear()
                self.modified.update(original)
                self.modified[key] = "not-a-sha256"
                with self.assertRaises(ValueError):
                    self.validate()

    def test_tampered_source_inventory_digest_is_rejected(self):
        self.build["sources"]["expo"]["entries"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "Invalid build source inventory digest"):
            self.validate()

    def test_unknown_source_entry_type_is_rejected(self):
        source = self.build["sources"]["expo"]
        source["entries"] = [{"path": "missing.c", "type": "unknown"}]
        source["sha256"] = self.json_hash(source["entries"])
        with self.assertRaises(ValueError):
            self.validate()

    def test_missing_source_file_hash_cannot_match_missing_archive_file(self):
        source = self.build["sources"]["expo"]
        source["entries"] = [{"path": "missing.c", "type": "file"}]
        source["sha256"] = self.json_hash(source["entries"])
        with self.assertRaises(ValueError):
            self.validate()

    def test_unsafe_source_inventory_path_is_rejected(self):
        source = self.build["sources"]["expo"]
        source["entries"][0]["path"] = "../outside.c"
        source["sha256"] = self.json_hash(source["entries"])
        with self.assertRaisesRegex(ValueError, "Unsafe build source path"):
            self.validate()

    def test_prebuilt_devkit_inventory_is_rejected(self):
        self.build["sourceBuild"] = False
        with self.assertRaisesRegex(ValueError, "POC_SOURCE_BUILD=1"):
            self.validate()


if __name__ == "__main__":
    unittest.main()
