"""Exercise Docker argument wiring with a logging Docker CLI; no VM is started."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


PACKAGE = Path(__file__).resolve().parents[1]


class SourceContainerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="capture-container-tests-")
        self.addCleanup(temporary.cleanup)
        self.temporary = Path(temporary.name).resolve()
        self.package = self.temporary / "package with spaces"
        scripts = self.package / "scripts"
        scripts.mkdir(parents=True)
        for name in ["source-container.sh", "container-source-paths.py"]:
            shutil.copy2(PACKAGE / "scripts" / name, scripts / name)
        (self.package / "Dockerfile.source").write_text("FROM fixture\n")
        self.external = self.temporary / "external dependency with spaces"
        self.external.mkdir()
        self.log = self.temporary / "docker-argv.jsonl"
        executables = self.temporary / "bin"
        executables.mkdir()
        docker = executables / "docker"
        docker.write_text(f"#!{sys.executable}\n" + r'''
import json, os, sys
arguments = sys.argv[1:]
with open(os.environ["DOCKER_TEST_LOG"], "a") as log:
    log.write(json.dumps(arguments) + "\n")
if arguments[:2] == ["image", "inspect"]:
    sys.exit(0 if os.environ.get("MOCK_DOCKER_IMAGE_EXISTS", "1") == "1" else 1)
if arguments[0] == "build":
    sys.exit(int(os.environ.get("MOCK_DOCKER_BUILD_EXIT", "0")))
if arguments[0] == "run":
    sys.exit(int(os.environ.get("MOCK_DOCKER_RUN_EXIT", "0")))
sys.exit(99)
''')
        docker.chmod(0o755)
        self.environment = {key: value for key, value in os.environ.items() if not key.startswith("POC_")}
        self.environment.update(PATH=str(executables) + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin"),
                                DOCKER_TEST_LOG=str(self.log))

    def run_wrapper(self, *arguments, env=None):
        return subprocess.run(["bash", str(self.package / "scripts/source-container.sh"), *arguments],
                              env={**self.environment, **(env or {})}, cwd=self.temporary,
                              capture_output=True, text=True)

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def run_call(self):
        calls = [call for call in self.calls() if call[0] == "run"]
        self.assertEqual(len(calls), 1)
        return calls[0]

    @staticmethod
    def option_values(arguments, option):
        return [arguments[index + 1] for index, value in enumerate(arguments[:-1]) if value == option]

    def forwarded_environment(self, arguments):
        return dict(value.split("=", 1) for value in self.option_values(arguments, "--env"))

    def test_cached_image_runs_source_command_with_intact_arguments(self):
        result = self.run_wrapper("create", "--version", "local-build", "--output", "artifacts/source archive.tar.gz")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(call[0] == "build" for call in self.calls()))
        arguments = self.run_call()
        self.assertEqual(arguments[-7:], ["python3", "scripts/source-archive.py", "create", "--version", "local-build", "--output", "artifacts/source archive.tar.gz"])
        self.assertEqual(self.option_values(arguments, "--platform"), ["linux/amd64"])
        self.assertIn(f"type=bind,source={self.package},target=/work", self.option_values(arguments, "--mount"))

    def test_missing_image_is_built_before_run(self):
        result = self.run_wrapper("fetch", env={"MOCK_DOCKER_IMAGE_EXISTS": "0"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([call[0] for call in self.calls()], ["image", "build", "run"])
        build = self.calls()[1]
        self.assertEqual(self.option_values(build, "--platform"), ["linux/amd64"])
        self.assertEqual(self.option_values(build, "-f"), [str(self.package / "Dockerfile.source")])
        self.assertEqual(build[-1], str(self.package))

    def test_forced_image_rebuild_skips_cache_inspection(self):
        result = self.run_wrapper("fetch", env={"POC_REBUILD_IMAGE": "1"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([call[0] for call in self.calls()], ["build", "run"])

    def test_external_paths_with_spaces_are_mounted_once(self):
        selected = str(self.external)
        result = self.run_wrapper("rebuild", env={"POC_FFMPEG_SOURCE_DIR": selected,
                                                   "POC_NV_CODEC_HEADERS_SOURCE_DIR": selected})
        self.assertEqual(result.returncode, 0, result.stderr)
        arguments = self.run_call()
        mounts = self.option_values(arguments, "--mount")
        self.assertEqual(mounts.count(f"type=bind,source={selected},target={selected}"), 1)
        forwarded = self.forwarded_environment(arguments)
        self.assertEqual(forwarded["POC_FFMPEG_SOURCE_DIR"], selected)
        self.assertEqual(forwarded["POC_NV_CODEC_HEADERS_SOURCE_DIR"], selected)
        self.assertEqual(arguments[-2:], ["bash", "scripts/rebuild-from-source.sh"])

    def test_package_absolute_paths_are_translated_and_relative_paths_preserved(self):
        result = self.run_wrapper("rebuild", env={"POC_BUILD_DIR": str(self.package / "build outputs"),
                                                   "POC_FFMPEG_SOURCE_DIR": "sources/custom ffmpeg"})
        self.assertEqual(result.returncode, 0, result.stderr)
        arguments = self.run_call()
        forwarded = self.forwarded_environment(arguments)
        self.assertEqual(forwarded["POC_BUILD_DIR"], "/work/build outputs")
        self.assertEqual(forwarded["POC_FFMPEG_SOURCE_DIR"], "sources/custom ffmpeg")
        self.assertEqual(len(self.option_values(arguments, "--mount")), 1)

    def test_nvrtc_mounts_parent_directory_for_companion_libraries(self):
        library = self.external / "libnvrtc.so.12"
        library.write_text("fixture library")
        result = self.run_wrapper("rebuild", env={"POC_NVRTC_LIBRARY": str(library),
                                                   "POC_FFMPEG_SOURCE_DIR": str(self.external)})
        self.assertEqual(result.returncode, 0, result.stderr)
        arguments = self.run_call()
        mounts = self.option_values(arguments, "--mount")
        self.assertEqual(mounts.count(f"type=bind,source={self.external},target={self.external}"), 1)
        self.assertEqual(self.forwarded_environment(arguments)["POC_NVRTC_LIBRARY"], str(library))

    def test_frida_json_overrides_translate_package_paths_and_mount_external_paths(self):
        local = self.package / "modified dependencies/core"
        local.mkdir(parents=True)
        relative = self.package / "modified dependencies/glib"
        relative.mkdir()
        overrides = {"subprojects/frida-core": str(local), "dependency-sources/glib": "modified dependencies/glib",
                     "dependency-sources/libffi": str(self.external)}
        result = self.run_wrapper("rebuild", env={"POC_FRIDA_SOURCE_OVERRIDES": json.dumps(overrides),
                                                   "POC_NV_CODEC_HEADERS_SOURCE_DIR": str(self.external)})
        self.assertEqual(result.returncode, 0, result.stderr)
        arguments = self.run_call()
        forwarded = json.loads(self.forwarded_environment(arguments)["POC_FRIDA_SOURCE_OVERRIDES"])
        self.assertEqual(forwarded["subprojects/frida-core"], "/work/modified dependencies/core")
        self.assertEqual(forwarded["dependency-sources/glib"], "/work/modified dependencies/glib")
        self.assertEqual(forwarded["dependency-sources/libffi"], str(self.external))
        self.assertEqual(self.option_values(arguments, "--mount").count(f"type=bind,source={self.external},target={self.external}"), 1)

    def test_offline_container_disables_network(self):
        result = self.run_wrapper("rebuild", env={"POC_CONTAINER_OFFLINE": "1"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--network=none", self.run_call())

    def test_arbitrary_command_and_exit_status_are_forwarded(self):
        result = self.run_wrapper("run", "python3", "script with spaces.py", "argument with spaces", env={"MOCK_DOCKER_RUN_EXIT": "37"})
        self.assertEqual(result.returncode, 37, result.stderr)
        self.assertEqual(self.run_call()[-3:], ["python3", "script with spaces.py", "argument with spaces"])

    def test_failed_image_build_does_not_run_container(self):
        result = self.run_wrapper("rebuild", env={"MOCK_DOCKER_IMAGE_EXISTS": "0", "MOCK_DOCKER_BUILD_EXIT": "23"})
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertFalse(any(call[0] == "run" for call in self.calls()))

    def test_missing_external_directory_is_rejected(self):
        result = self.run_wrapper("rebuild", env={"POC_BUILD_DIR": str(self.temporary / "does not exist")})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("External mount does not exist", result.stderr)
        self.assertFalse(any(call[0] == "run" for call in self.calls()))

    def test_invalid_override_json_is_rejected_before_run(self):
        result = self.run_wrapper("rebuild", env={"POC_FRIDA_SOURCE_OVERRIDES": "not JSON"})
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call[0] == "run" for call in self.calls()))

    def test_empty_run_command_is_rejected(self):
        result = self.run_wrapper("run")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call[0] == "run" for call in self.calls()))

    def test_help_does_not_invoke_docker(self):
        result = self.run_wrapper("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Usage:", result.stdout)
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
