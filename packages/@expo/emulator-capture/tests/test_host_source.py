"""Offline host-source verification fixtures; no SDK downloads or legal sign-off."""
import argparse
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/fetch-host-source.py"
SPEC = importlib.util.spec_from_file_location("capture_host_source", SCRIPT)
host_source = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host_source)


class HostSourceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="capture-host-source-tests-")
        self.addCleanup(temporary.cleanup)
        self.work = Path(temporary.name)
        self.root = self.work / "package"
        self.root.mkdir()
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(host_source, "ROOT", self.root).start()
        mock.patch.dict(os.environ, {}, clear=True).start()
        self.download = mock.patch.object(
            host_source.subprocess, "run", side_effect=AssertionError("Unexpected network/download")
        ).start()
        self.source = self.work / "reviewed-scope"
        self.source.mkdir()
        (self.source / "README.md").write_text("Editable host source fixture\n")
        (self.source / "build.sh").write_text("#!/bin/sh\nexit 0\n")
        (self.source / "build.sh").chmod(0o755)
        (self.source / "README-link").symlink_to("README.md")
        files = {
            "README.md": {"sha256": host_source.sha(self.source / "README.md"), "executable": False},
            "build.sh": {"sha256": host_source.sha(self.source / "build.sh"), "executable": True},
            "README-link": {"symlink": "README.md"},
        }
        (self.source / "source-manifest.json").write_text(json.dumps({"files": files}))
        self.manifest_hash = host_source.sha(self.source / "source-manifest.json")
        self.compliance = self.root / "compliance.json"
        self.scope = {
            "status": "resolved", "scope": "Reviewed fixture source modules",
            "manifestSha256": self.manifest_hash, "evidence": ["fixture review"],
            "archiveUrl": None, "archiveSha256": None,
        }
        self.record()

    def record(self):
        # This binary URL must never be used as a fallback for missing source.
        self.compliance.write_text(json.dumps({"host": {
            "archiveUrl": "https://example.invalid/emulator-SDK-binary.zip",
            "correspondingSource": self.scope,
        }}))

    def fetch(self, required=False):
        output = io.StringIO()
        with redirect_stdout(output):
            host_source.fetch(argparse.Namespace(compliance=self.compliance, required=required))
        return output.getvalue()

    def source_archive(self):
        archive = self.work / "source.tar.gz"
        with tarfile.open(archive, "w:gz") as stream:
            stream.add(self.source, arcname="host-source")
        return archive

    def selected_archive(self, entries):
        archive = self.work / "selected.tar"
        with tarfile.open(archive, "w") as stream:
            for name, kind, value in entries:
                member = tarfile.TarInfo(name)
                if kind == "file":
                    member.size = len(value)
                    stream.addfile(member, io.BytesIO(value))
                else:
                    member.type = kind
                    if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                        member.linkname = value
                    stream.addfile(member)
        return archive

    def test_reviewed_existing_override_is_verified_without_downloading_or_changes(self):
        os.environ["POC_EMULATOR_SOURCE_DIR"] = str(self.source)
        original = (self.source / "README.md").read_bytes()
        result = self.fetch(required=True)
        self.assertIn("Preserved and verified existing host source", result)
        self.assertEqual((self.source / "README.md").read_bytes(), original)
        self.assertTrue((self.source / "README-link").is_symlink())
        self.download.assert_not_called()

    def test_changed_existing_override_is_rejected_and_never_replaced(self):
        os.environ["POC_EMULATOR_SOURCE_DIR"] = str(self.source)
        (self.source / "README.md").write_text("My local changes\n")
        with self.assertRaisesRegex(ValueError, "contents do not match"):
            self.fetch(required=True)
        self.assertEqual((self.source / "README.md").read_text(), "My local changes\n")
        self.download.assert_not_called()

    def test_missing_explicit_override_is_not_populated(self):
        missing = self.work / "my-explicit-source"
        os.environ["POC_EMULATOR_SOURCE_DIR"] = str(missing)
        with self.assertRaisesRegex(ValueError, "supplied source paths are never populated"):
            self.fetch()
        self.assertFalse(missing.exists())
        self.download.assert_not_called()

    def test_missing_source_url_does_not_fall_back_to_sdk_archive(self):
        self.assertIn("SDK archive is not a source substitute", self.fetch())
        with self.assertRaisesRegex(ValueError, "no reviewed correspondingSource"):
            self.fetch(required=True)
        self.assertFalse((self.root / "sources/emulator").exists())
        self.download.assert_not_called()

    def test_unresolved_record_reports_pending_and_required_fails_without_download(self):
        self.scope["status"] = "unresolved"
        self.record()
        self.assertIn("pending", self.fetch())
        with self.assertRaisesRegex(ValueError, "resolved host source scope"):
            self.fetch(required=True)
        self.download.assert_not_called()

    def test_incomplete_review_evidence_is_not_enough_for_download(self):
        self.scope["evidence"] = []
        self.record()
        with self.assertRaisesRegex(ValueError, "missing its supporting evidence"):
            self.fetch(required=True)
        self.download.assert_not_called()

    def test_valid_archive_preserves_files_links_and_executable_bits(self):
        extracted = host_source.extract_source(self.source_archive(), self.work / "extracted")
        self.assertEqual(host_source.verify_source(extracted, self.manifest_hash), 3)
        self.assertEqual((extracted / "README-link").readlink(), Path("README.md"))
        self.assertTrue((extracted / "build.sh").stat().st_mode & 0o111)

    def test_changed_manifest_hash_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "does not match the reviewed manifest hash"):
            host_source.verify_source(self.source, "0" * 64)

    def test_unlisted_file_and_changed_executable_bit_are_rejected(self):
        extra = self.source / "extra.c"
        extra.write_text("/* unexpected input */\n")
        with self.assertRaisesRegex(ValueError, "contents do not match"):
            host_source.verify_source(self.source, self.manifest_hash)
        extra.unlink()
        (self.source / "build.sh").chmod(0o644)
        with self.assertRaisesRegex(ValueError, "contents do not match"):
            host_source.verify_source(self.source, self.manifest_hash)

    def test_path_traversal_absolute_and_root_dot_entries_are_rejected(self):
        for index, path in enumerate(["host-source/../escape", "/tmp/escape", "."]):
            with self.subTest(path=path):
                archive = self.selected_archive([(path, "file", b"unsafe")])
                with self.assertRaisesRegex(ValueError, "Unsafe host archive path"):
                    host_source.extract_source(archive, self.work / f"bad-{index}")

    def test_escaping_symlink_and_symlink_chain_are_rejected(self):
        for index, entries in enumerate([
            [("host-source/escape", tarfile.SYMTYPE, "../../outside")],
            [("host-source/a", tarfile.SYMTYPE, "."),
             ("host-source/b", tarfile.SYMTYPE, "a/..")],
        ]):
            with self.subTest(entries=entries):
                archive = self.selected_archive(entries)
                with self.assertRaisesRegex(ValueError, "symlink"):
                    host_source.extract_source(archive, self.work / f"links-{index}")

    def test_entries_beneath_archive_symlink_are_rejected(self):
        archive = self.selected_archive([
            ("host-source/a", tarfile.SYMTYPE, "actual-directory"),
            ("host-source/a/source.c", "file", b"/* source */"),
        ])
        with self.assertRaisesRegex(ValueError, "non-directory parent"):
            host_source.extract_source(archive, self.work / "symlink-parent")

    def test_native_binary_extension_and_extensionless_elf_are_rejected(self):
        for index, (name, content) in enumerate([
            ("host-source/libgfxstream_backend.so", b"binary fixture"),
            ("host-source/emulator", b"\x7fELF" + bytes(64)),
        ]):
            with self.subTest(name=name):
                archive = self.selected_archive([(name, "file", content)])
                with self.assertRaisesRegex(ValueError, "Native binary"):
                    host_source.extract_source(archive, self.work / f"binary-{index}")

    def test_hardlinks_special_files_and_duplicate_entries_are_rejected(self):
        for index, entries in enumerate([
            [("host-source/link", tarfile.LNKTYPE, "host-source/source.c")],
            [("host-source/device", tarfile.CHRTYPE, None)],
            [("host-source/dup", "file", b"a"), ("host-source/dup", "file", b"b")],
        ]):
            with self.subTest(entries=entries):
                archive = self.selected_archive(entries)
                with self.assertRaisesRegex(ValueError, "Unsupported|Duplicate"):
                    host_source.extract_source(archive, self.work / f"unsupported-{index}")

    def test_reviewed_download_is_verified_before_installing_default_tree(self):
        archive = self.source_archive()
        self.scope.update(archiveUrl="https://example.invalid/reviewed-source.tar.gz",
                          archiveSha256=host_source.sha(archive))
        self.record()
        def download_fixture(command, check):
            self.assertTrue(check)
            self.assertEqual(command[-1], self.scope["archiveUrl"])
            self.assertIn("--proto-redir", command)
            shutil.copyfile(archive, command[command.index("--output") + 1])
        self.download.side_effect = download_fixture
        self.assertIn("Fetched and verified", self.fetch(required=True))
        self.assertEqual(host_source.verify_source(self.root / "sources/emulator", self.manifest_hash), 3)
        self.download.assert_called_once()

    def test_wrong_download_checksum_does_not_install_source(self):
        archive = self.source_archive()
        self.scope.update(archiveUrl="https://example.invalid/reviewed-source.tar.gz", archiveSha256="0" * 64)
        self.record()
        self.download.side_effect = lambda command, check: shutil.copyfile(archive, command[command.index("--output") + 1])
        with self.assertRaisesRegex(ValueError, "archive SHA-256 does not match"):
            self.fetch(required=True)
        self.assertFalse((self.root / "sources/emulator").exists())

    def test_offline_mode_never_downloads_a_missing_reviewed_source(self):
        self.scope.update(archiveUrl="https://example.invalid/source.tar.gz", archiveSha256="a" * 64)
        self.record()
        os.environ["POC_OFFLINE"] = "1"
        with self.assertRaisesRegex(ValueError, "unavailable offline"):
            self.fetch(required=True)
        self.download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
