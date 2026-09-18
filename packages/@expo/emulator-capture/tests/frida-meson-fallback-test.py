#!/usr/bin/env python3
"""Configure-only regression using fetched pinned Meson, a fake system PCRE2,
and a local replacement. Run in Dockerfile.source after the source fetch.
"""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("frida_source", ROOT / "scripts/frida-source.py")
frida = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(frida)
MESON = frida.source_dir() / "releng/meson/meson.py"


class PinnedMesonFallback(unittest.TestCase):
    @unittest.skipUnless(MESON.is_file() and shutil.which("ninja") and shutil.which("pkg-config")
                         and shutil.which("cc"), "requires fetched Meson plus ninja/pkg-config/cc")
    def test_normalized_provider_bypasses_available_system_dependency(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            project = source / "subprojects/pcre2"
            project.mkdir(parents=True)
            (source / "meson.build").write_text(
                "project('provider-regression', 'c')\n"
                "dep = dependency('libpcre2-8', required: false)\n"
                "if not dep.found()\n"
                "  dep = dependency('libpcre2-8', fallback: ['pcre2', 'libpcre2_8'])\n"
                "endif\n"
                "origin = dep.get_variable(internal: 'source_origin', pkgconfig: 'source_origin')\n"
                "message('SOURCE_ORIGIN=' + origin)\n"
                "assert(origin == 'source', 'system PCRE2 bypassed source fallback')\n")
            (project / "meson.build").write_text(
                "project('pcre2', 'c', version: '10.44')\n"
                "libpcre2_8 = declare_dependency(variables: {'source_origin': 'source'})\n"
                "meson.override_dependency('libpcre2-8', libpcre2_8)\n")
            (project.parent / "pcre2.wrap").write_text(
                "[wrap-git]\nurl=https://invalid.test/pcre2.git\nrevision=unused\n"
                "[provide]\ndependency_names=libpcre2-8 libpcre2-16 libpcre2-32 libpcre2-posix\n")
            pcdir = root / "pkgconfig"
            pcdir.mkdir()
            (pcdir / "libpcre2-8.pc").write_text(
                "source_origin=system\nName: fixture PCRE2\nDescription: system fallback trap\n"
                "Version: 10.42\nLibs:\nCflags:\n")
            env = dict(os.environ, PKG_CONFIG_LIBDIR=str(pcdir), PKG_CONFIG_PATH="")

            def configure(build_name):
                return subprocess.run(
                    [sys.executable, str(MESON), "setup", str(root / build_name), str(source),
                     "--wrap-mode=nodownload", "--force-fallback-for=pcre2,libpcre2-8"],
                    env=env, capture_output=True, text=True)

            before = configure("before")
            self.assertNotEqual(before.returncode, 0, before.stdout + before.stderr)
            self.assertIn("SOURCE_ORIGIN=system", before.stdout)
            adaptations = frida.normalize_wrap_providers(source)
            self.assertEqual(len(adaptations), 1)
            self.assertNotEqual(adaptations[0]["beforeSha256"], adaptations[0]["afterSha256"])
            after = configure("after")
            self.assertEqual(after.returncode, 0, after.stdout + after.stderr)
            self.assertIn("SOURCE_ORIGIN=source", after.stdout)
            self.assertEqual(frida.normalize_wrap_providers(source), [])


if __name__ == "__main__":
    unittest.main()
