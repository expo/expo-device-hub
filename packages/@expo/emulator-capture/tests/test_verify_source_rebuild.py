"""Validate rebuild-driver wiring with synthetic outputs, not a native build."""
import argparse
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock


PACKAGE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("capture_verify_rebuild", PACKAGE / "scripts/verify-source-rebuild.py")
rebuild = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rebuild)


class RebuildDriverTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="capture-rebuild-driver-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        (self.root / "scripts").mkdir()
        # The driver uses the real source-copying helper on a small source tree.
        shutil.copy2(PACKAGE / "scripts/source-archive.py", self.root / "scripts/source-archive.py")
        self.source = self.root / "sources/ffmpeg"
        (self.source / "libavcodec").mkdir(parents=True)
        self.codec = self.source / "libavcodec/allcodecs.c"
        self.codec.write_text("const AVCodec *avcodec_find_encoder_by_name(const char *name)\n{\n    return 0;\n}\n")
        self.original_source = self.codec.read_bytes()
        self.work = self.root / "verification-work"
        self.evidence = self.root / "evidence"
        self.calls = []
        self.marker = b"expo-emulator-capture-modified-ffmpeg-proof"

    @staticmethod
    def sha(data):
        return hashlib.sha256(data).hexdigest()

    def fake_rebuild(self, command, *, cwd, env, check):
        """Emulate output files solely to verify the driver's paths and checks."""
        self.assertEqual(command, ["bash", "scripts/rebuild-from-source.sh"])
        self.assertEqual(cwd, self.root)
        self.assertTrue(check)
        self.calls.append(dict(env))
        build = Path(env["POC_BUILD_DIR"])
        output = Path(env["POC_DIST_DIR"])
        build.mkdir(parents=True)
        output.mkdir(parents=True)
        source = (self.root / env.get("POC_FFMPEG_SOURCE_DIR", "sources/ffmpeg")).resolve()
        source_bytes = (source / "libavcodec/allcodecs.c").read_bytes()
        contents = b"synthetic baseline output"
        if self.marker in source_bytes:
            contents += self.marker
        library = output / "libgpu_capture.so"
        library.write_bytes(contents)
        injector = output / "inject"
        injector.write_bytes(b"synthetic injector output")
        inventory = {"schemaVersion": 1, "sourceBuild": True,
                     "sources": {"ffmpeg": {"sha256": self.sha(source_bytes)}},
                     "outputs": [{"path": str(path), "sha256": self.sha(path.read_bytes())}
                                 for path in [library, injector]]}
        (build / "native-build.json").write_text(json.dumps(inventory))
        devkits = Path(env["POC_FRIDA_DEVKIT_OUTPUT_DIR"])
        if len(self.calls) == 1:
            self.assertFalse(devkits.exists(), "Baseline must use a new Frida output directory")
            devkits.mkdir(parents=True)
            (devkits / "build-provenance.json").write_text('{"fixture": "fresh Frida build receipt"}\n')
        else:
            self.assertEqual(devkits, Path(self.calls[0]["POC_FRIDA_DEVKIT_OUTPUT_DIR"]))
            self.assertTrue((devkits / "build-provenance.json").is_file())
        return argparse.Namespace(returncode=0)

    def test_clean_baseline_overrides_old_frida_dirs_and_second_run_shares_fresh_devkits(self):
        environment = {"POC_FRIDA_BUILD_DIR": "/old/frida-build", "POC_FRIDA_DEVKIT_OUTPUT_DIR": "/old/devkits",
                       "POC_FFMPEG_BUILD_DIR": "/old/ffmpeg-objects", "POC_BUILD_DIR": "/old/build",
                       "POC_DIST_DIR": "/old/output", "POC_FFMPEG_SOURCE_DIR": "sources/ffmpeg"}
        with mock.patch.object(rebuild, "ROOT", self.root), \
                mock.patch.object(rebuild.platform, "system", return_value="Linux"), \
                mock.patch.object(rebuild.platform, "machine", return_value="x86_64"), \
                mock.patch.object(rebuild.subprocess, "run", side_effect=self.fake_rebuild), \
                mock.patch.dict(os.environ, environment, clear=True), \
                mock.patch.object(rebuild.sys, "argv", ["verify-source-rebuild.py", "--work-dir", str(self.work),
                                                      "--evidence-dir", str(self.evidence)]), \
                redirect_stdout(io.StringIO()):
            rebuild.main()
        self.assertEqual(len(self.calls), 2)
        for env in self.calls:
            self.assertEqual(env["POC_FRIDA_BUILD_DIR"], str(self.work / "frida-build"))
            self.assertEqual(env["POC_FRIDA_DEVKIT_OUTPUT_DIR"], str(self.work / "frida-devkits"))
        self.assertEqual(self.calls[0]["POC_FFMPEG_BUILD_DIR"], str(self.work / "baseline/ffmpeg"))
        self.assertEqual(self.calls[1]["POC_FFMPEG_BUILD_DIR"], str(self.work / "modified/ffmpeg"))
        self.assertEqual(self.calls[1]["POC_FFMPEG_SOURCE_DIR"], str(self.work / "modified-ffmpeg"))
        self.assertEqual(self.codec.read_bytes(), self.original_source)
        self.assertIn(self.marker, (self.work / "modified-ffmpeg/libavcodec/allcodecs.c").read_bytes())
        self.assertEqual((self.evidence / "frida-build.json").read_bytes(),
                         (self.work / "frida-devkits/build-provenance.json").read_bytes())
        inventory = self.evidence / "binary-inventory.json"
        modified = json.loads((self.evidence / "modified-dependency-rebuild.json").read_text())
        checked = json.loads((self.evidence / "rebuild-verification.json").read_text())
        self.assertEqual(modified["binaryInventorySha256"], self.sha(inventory.read_bytes()))
        self.assertEqual(checked["binaryInventorySha256"], self.sha(inventory.read_bytes()))
        self.assertTrue(modified["markerFoundInCapture"])
        self.assertNotEqual(modified["originalLibrarySha256"], modified["modifiedLibrarySha256"])
        self.assertFalse(checked["gpuRuntimeTested"])


if __name__ == "__main__":
    unittest.main()
