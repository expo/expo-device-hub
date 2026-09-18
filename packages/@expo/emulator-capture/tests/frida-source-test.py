#!/usr/bin/env python3
"""Source receipt and replacement-path checks; no network or native compiler."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("frida_source", Path(__file__).resolve().parents[1] / "scripts/frida-source.py")
frida = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(frida)


class SourceInputs(unittest.TestCase):
    def test_inventory_excludes_git_credentials_and_generated_node_modules(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            for name in [".git/config", "node_modules/package/index.js", "library/source.c"]:
                file = source / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("input")
            self.assertEqual(list(frida.inventory(source)), ["library/source.c"])

    def test_inventory_rejects_escaping_directory_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            source.mkdir()
            (source / "external").symlink_to(source.parent, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "escapes"):
                frida.inventory(source)

    def test_receipt_detects_modified_removed_and_added_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            file = source / "library.c"
            file.write_text("original")
            receipt = {"schemaVersion": 1, "lockSha256": frida.sha(frida.LOCK), "files": frida.inventory(source)}
            frida.write_json(source / "source-state.json", receipt)
            with patch.dict(os.environ, {"POC_FRIDA_SOURCE_DIR": str(source)}):
                frida.verify(None)
                file.write_text("modified")
                with self.assertRaisesRegex(ValueError, "changed"):
                    frida.verify(None)
                file.unlink()
                with self.assertRaisesRegex(ValueError, "Missing"):
                    frida.verify(None)
                file.write_text("original")
                (source / "extra.c").write_text("unexpected")
                with self.assertRaisesRegex(ValueError, "file set changed"):
                    frida.verify(None)

    def test_overrides_reject_escape_and_accept_existing_editable_dependency(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            replacement = root / "edited-glib"
            (source / "subprojects/glib").mkdir(parents=True)
            replacement.mkdir()
            with patch.dict(os.environ, {"POC_FRIDA_SOURCE_OVERRIDES": json.dumps({"../bad": str(replacement)})}):
                with self.assertRaisesRegex(ValueError, "Unsafe"):
                    frida.overrides(source)
            with patch.dict(os.environ, {"POC_FRIDA_SOURCE_OVERRIDES": json.dumps({"subprojects/glib": str(replacement)})}):
                self.assertEqual(frida.overrides(source), {"subprojects/glib": replacement.resolve()})

    def test_verify_and_build_inputs_share_one_source_hashing_pass(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            (source / "library.c").write_text("original")
            receipt = {"schemaVersion": 1, "lockSha256": frida.sha(frida.LOCK), "files": frida.inventory(source)}
            frida.write_json(source / "source-state.json", receipt)
            with patch.dict(os.environ, {"POC_FRIDA_SOURCE_DIR": str(source)}), \
                    patch.object(frida, "inventory", wraps=frida.inventory) as scan:
                verified = frida.verify(None)
                inputs = frida.build_inputs(source, {}, source_inputs=verified)
                self.assertIs(inputs["sourceInputs"], verified)
                self.assertEqual(scan.call_count, 1)

    def test_verify_rejects_unsafe_receipt_before_scanning_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            receipt = {"schemaVersion": 1, "lockSha256": frida.sha(frida.LOCK),
                       "files": {"../outside.c": {"sha256": "invalid"}}}
            frida.write_json(source / "source-state.json", receipt)
            with patch.dict(os.environ, {"POC_FRIDA_SOURCE_DIR": str(source)}), \
                    patch.object(frida, "inventory") as scan:
                with self.assertRaisesRegex(ValueError, "Unsafe inventory path"):
                    frida.verify(None)
                scan.assert_not_called()

    def test_verify_rejects_empty_uninitialized_wrapped_submodule(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            subprojects = source / "subprojects"
            (subprojects / "gvdb").mkdir(parents=True)
            (subprojects / "gvdb.wrap").write_text("[wrap-git]\nurl = https://invalid.test/gvdb.git\n")
            receipt = {"schemaVersion": 1, "lockSha256": frida.sha(frida.LOCK), "files": frida.inventory(source)}
            frida.write_json(source / "source-state.json", receipt)
            with patch.dict(os.environ, {"POC_FRIDA_SOURCE_DIR": str(source)}):
                with self.assertRaisesRegex(ValueError, "Missing Meson dependency"):
                    frida.verify(None)

    def test_wrap_directory_must_remain_in_subprojects(self):
        with tempfile.TemporaryDirectory() as temporary:
            wrap = Path(temporary) / "glib.wrap"
            wrap.write_text("[wrap-git]\ndirectory = ../outside\n")
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                frida.wrap_target(wrap)

    def test_download_repairs_only_empty_wrapped_submodule_and_skips_complete_projects(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            target = source / "subprojects/gvdb"
            target.mkdir(parents=True)
            (target.parent / "gvdb.wrap").write_text("[wrap-git]\nurl = https://invalid.test/gvdb.git\n")

            def download(*_args):
                self.assertFalse(target.exists())
                target.mkdir()
                (target / "meson.build").write_text("project('gvdb', 'c')\n")

            with patch.object(frida, "run", side_effect=download) as command:
                frida.download_wraps(source, source / "meson.py")
                command.assert_called_once()
                frida.download_wraps(source, source / "meson.py")
                command.assert_called_once()

    def test_download_preserves_nonempty_incomplete_dependency(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            target = source / "subprojects/gvdb"
            target.mkdir(parents=True)
            (target.parent / "gvdb.wrap").write_text("[wrap-git]\n")
            edited = target / "edited.c"
            edited.write_text("preserve my changes")
            with patch.object(frida, "run") as command:
                with self.assertRaisesRegex(ValueError, "Preserving incomplete"):
                    frida.download_wraps(source, source / "meson.py")
                command.assert_not_called()
            self.assertEqual(edited.read_text(), "preserve my changes")

    def test_wrap_redirect_uses_final_build_method(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            (source / "alias.wrap").write_text("[wrap-redirect]\nfilename = direct.wrap\n")
            (source / "direct.wrap").write_text("[wrap-git]\ndirectory = source\nmethod = cmake\n")
            self.assertEqual(frida.wrap_build_marker(source / "alias.wrap", source),
                             source / "source/CMakeLists.txt")

    def test_existing_empty_mount_directory_is_usable_but_nonempty_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "mounted-output"
            self.assertFalse(frida.directory_has_contents(directory))
            directory.mkdir()
            self.assertFalse(frida.directory_has_contents(directory))
            (directory / "previous-result").write_text("preserve")
            self.assertTrue(frida.directory_has_contents(directory))
            self.assertTrue(frida.directory_has_contents(directory / "previous-result"))

    def test_native_layout_keeps_generated_headers_inside_devkit_source_boundary(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            native = frida.native_build_dir(source)
            dependencies = [source / "gum/gum.h", native / "subprojects/glib/glibconfig.h",
                            native / "subprojects/frida-core/src/frida-core.h", Path("/usr/include/stdio.h")]
            # The pinned devkit generator deliberately excludes headers outside
            # REPO_ROOT. Both generated public headers must survive that filter.
            eligible = [h for h in dependencies if h.is_relative_to(source)]
            self.assertEqual(eligible, dependencies[:-1])

    def test_fallbacks_include_dependency_names_even_when_wrap_uses_spaces(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            wraps = source / "subprojects"
            wraps.mkdir()
            (wraps / "pcre2.wrap").write_text(
                "[wrap-git]\n[provide]\ndependency_names=libpcre2-8 libpcre2-16, libpcre2-32\n")
            (wraps / "glib.wrap").write_text(
                "[wrap-git]\n[provide]\ndependency_names=glib-2.0, gio-2.0\n"
                "gobject-2.0=libgobject_dep\nprogram_names=glib-genmarshal\n")
            self.assertEqual(frida.fallback_dependencies(source),
                             ["gio-2.0", "glib", "glib-2.0", "gobject-2.0",
                              "libpcre2-16", "libpcre2-32", "libpcre2-8", "pcre2"])

    @unittest.skipUnless(shutil.which("cc"), "requires a C compiler for standalone header validation")
    def test_devkit_header_validation_rejects_unbundled_dependency(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            for kit in ["gum", "core"]:
                header = output / kit / f"frida-{kit}.h"
                header.parent.mkdir()
                header.write_text("typedef int FridaFixture;\n")
            env = dict(os.environ, CC=shutil.which("cc"))
            frida.verify_devkit_headers(output, env)
            (output / "gum/frida-gum.h").write_text("#include <frida-missing-fixture-config.h>\n")
            with self.assertRaises(subprocess.CalledProcessError):
                frida.verify_devkit_headers(output, env)

    def test_configured_sources_guard_rejects_system_dependency_or_missing_local_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            tree = Path(temporary) / "source"
            native = tree / "build"
            dependencies_file = native / "meson-info/intro-dependencies.json"
            targets_file = native / "meson-info/intro-targets.json"
            dependencies = [{"name": "threads", "type": "system"}]
            target = {"name": "pcre2-8", "type": "static library", "id": "fixture@sta",
                      "defined_in": str(tree / "subprojects/pcre2/meson.build"),
                      "filename": [str(native / "subprojects/pcre2/libpcre2-8.a")]}
            frida.write_json(dependencies_file, dependencies)
            frida.write_json(targets_file, [target])
            names = ["pcre2", "libpcre2-8", "glib-2.0"]
            result = frida.verify_configured_sources(tree, native, names)
            self.assertEqual(result["pcre2StaticTarget"]["id"], "fixture@sta")
            for name in ["libpcre2-8", "glib-2.0"]:
                with self.subTest(system_dependency=name):
                    frida.write_json(dependencies_file, dependencies + [{"name": name, "type": "pkgconfig"}])
                    with self.assertRaisesRegex(ValueError, "outside its source subproject"):
                        frida.verify_configured_sources(tree, native, names)
            frida.write_json(dependencies_file, dependencies)
            frida.write_json(targets_file, [])
            with self.assertRaisesRegex(ValueError, "Expected one source-built"):
                frida.verify_configured_sources(tree, native, names)
            frida.write_json(targets_file, [dict(target, filename=["/usr/lib/libpcre2-8.a"])])
            with self.assertRaisesRegex(ValueError, "leaves the private"):
                frida.verify_configured_sources(tree, native, names)

    def test_dependency_alias_replaces_every_wrap_copy_and_inventory_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            replacement = Path(temporary) / "edited-glib"
            replacement.mkdir()
            expected = set()
            for project in ["subprojects/frida-gum", "subprojects/frida-core"]:
                directory = source / project / "subprojects/glib"
                directory.mkdir(parents=True)
                (directory.parent / "glib.wrap").write_text("[wrap-git]\ndirectory = glib\n")
                expected.add(directory.relative_to(source).as_posix())
            (source / "dependency-sources/glib").mkdir(parents=True)
            expected.add("dependency-sources/glib")
            with patch.dict(os.environ, {"POC_FRIDA_SOURCE_OVERRIDES": json.dumps({"dependency:glib": str(replacement)})}):
                self.assertEqual(frida.overrides(source), {path: replacement.resolve() for path in expected})

    def test_build_graph_excludes_meson_fixtures_and_follows_real_transitive_wraps(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            active = ["subprojects/frida-gum/subprojects/glib.wrap",
                      "subprojects/frida-gum/subprojects/glib/subprojects/libffi.wrap"]
            fixtures = ["releng/meson/test cases/failing/fixture/subprojects/broken.wrap",
                        "subprojects/frida-gum/tests/fixture/subprojects/broken.wrap"]
            for relative in active + fixtures:
                wrap = source / relative
                wrap.parent.mkdir(parents=True, exist_ok=True)
                wrap.write_text("[wrap-git]\nurl = https://invalid.test/fixture.git\n")
                if relative in active:
                    (wrap.parent / wrap.stem).mkdir(exist_ok=True)
            self.assertEqual({p.relative_to(source).as_posix() for p in frida.project_wraps(source)}, set(active))

    def test_wrap_redirect_follows_sibling_project_but_rejects_cycles_and_escape(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            direct = source / "subprojects/frida-gum/subprojects/glib.wrap"
            redirect = source / "subprojects/frida-core/subprojects/glib.wrap"
            for path in [direct, redirect]:
                path.parent.mkdir(parents=True)
            direct.write_text("[wrap-git]\nurl = https://invalid.test/glib.git\n")
            (direct.parent / "glib").mkdir()
            redirect.write_text("[wrap-redirect]\nfilename = ../../frida-gum/subprojects/glib.wrap\n")
            self.assertEqual(frida.wrap_target(redirect, source), direct.parent / "glib")
            self.assertIn(direct.parent / "glib", set(frida.build_roots(source)))
            redirect.write_text("[wrap-redirect]\nfilename = glib.wrap\n")
            with self.assertRaisesRegex(ValueError, "Cyclic"):
                frida.wrap_target(redirect, source)
            redirect.write_text("[wrap-redirect]\nfilename = ../../../../outside.wrap\n")
            with self.assertRaisesRegex(ValueError, "leaves source tree"):
                frida.wrap_target(redirect, source)

    def test_npm_inputs_include_nested_runtime_packages_but_skip_disabled_bindings_and_fixtures(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            active = ["subprojects/frida-gum/bindings/gumjs/package-lock.json",
                      "subprojects/frida-core/lib/agent/package-lock.json"]
            fixtures = ["releng/meson/test cases/failing/fixture/package-lock.json",
                        "subprojects/frida-core/tests/fixtures/package-lock.json",
                        "subprojects/frida-node/package-lock.json"]
            for relative in active + fixtures:
                lock = source / relative
                lock.parent.mkdir(parents=True, exist_ok=True)
                lock.write_text("{}")
                (lock.parent / "package.json").write_text("{}")
            self.assertEqual({p.relative_to(source).as_posix() for p in frida.npm_inputs(source)}, set(active))

    def test_reuse_requires_matching_sources_overrides_and_all_devkit_hashes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            (source / "source-state.json").write_text("{}")
            (source / "library.c").write_text("baseline")
            output = root / "devkits"
            outputs = {}
            for kit in ["gum", "core"]:
                for name in [f"libfrida-{kit}.a", f"frida-{kit}.h"]:
                    path = output / kit / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("built")
                    outputs[path.relative_to(output).as_posix()] = frida.sha(path)
            inputs = frida.build_inputs(source, {})
            receipt = {"schemaVersion": 1, "sourceBuild": True, **inputs, "outputs": outputs}
            frida.write_json(output / "build-provenance.json", receipt)
            self.assertTrue(frida.reuse_devkits(output, inputs))
            modified = dict(inputs, sourceOverrides={"subprojects/glib": {"glib.c": {"sha256": "changed"}}})
            self.assertFalse(frida.reuse_devkits(output, modified))
            (source / "library.c").write_text("modified")
            self.assertFalse(frida.reuse_devkits(output, frida.build_inputs(source, {})))
            (output / "gum/libfrida-gum.a").write_text("tampered")
            self.assertFalse(frida.reuse_devkits(output, inputs))


if __name__ == "__main__":
    unittest.main()
