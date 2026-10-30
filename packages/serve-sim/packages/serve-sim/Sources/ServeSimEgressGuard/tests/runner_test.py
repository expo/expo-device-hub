"""Runner ownership tests; no compiler, dylib or network operation is needed."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

RUNNER = Path(__file__).with_name("run.py")


class RunnerOwnershipTests(unittest.TestCase):
    def test_simulator_runner_keeps_evidence_when_private_cleanup_fails(self):
        runner = RUNNER.with_name("simulator.py")
        for cleanup_error in (OSError("test deletion failure"), KeyboardInterrupt("test cancel")):
            with self.subTest(error=type(cleanup_error).__name__), tempfile.TemporaryDirectory() as parent_name:
                parent = Path(parent_name)
                work = parent / "owned"
                work.mkdir()
                evidence = parent / "evidence"
                with contextlib.ExitStack() as stack:
                    stack.enter_context(patch.object(sys, "argv", [str(runner), "--runtime", "test", "--evidence", str(evidence)]))
                    stack.enter_context(patch("subprocess.check_output", return_value="test-head"))
                    stack.enter_context(patch("subprocess.Popen", side_effect=AssertionError("No command may run")))
                    stack.enter_context(patch("tempfile.mkdtemp", return_value=str(work)))
                    stack.enter_context(patch("shutil.copytree", side_effect=OSError("test setup failure")))
                    stack.enter_context(patch("shutil.rmtree", side_effect=cleanup_error))
                    stack.enter_context(patch("signal.signal"))
                    stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                    with self.assertRaises(SystemExit) as exit_result:
                        runpy.run_path(str(runner), run_name="__main__")
                self.assertEqual(exit_result.exception.code, 1)
                result = json.loads((evidence / "results.json").read_text())
                self.assertEqual(result["status"], "FAILED_CLEANUP")
                self.assertFalse(result["privateOutputsRemoved"])
                self.assertIn("test setup failure", result["error"])
                self.assertIn(str(cleanup_error), result["cleanupError"])
                self.assertTrue(work.is_dir())

    def test_caller_directory_and_symlink_are_not_accepted(self):
        for symlink in (False, True):
            with self.subTest(symlink=symlink), tempfile.TemporaryDirectory(prefix="serve-sim-egress-", dir="/tmp") as name, tempfile.TemporaryDirectory() as evidence_parent:
                parent = Path(name)
                sentinel = parent / "keep"
                sentinel.write_text("unrelated caller data")
                work = parent
                if symlink:
                    work = parent / "link"
                    work.symlink_to(parent, target_is_directory=True)
                # An unsupported ownership override must fail before touching any path.
                result = subprocess.run([sys.executable, str(RUNNER), "--work-dir", str(work),
                                         "--baseline-dir", str(parent / "missing"),
                                         "--evidence", str(Path(evidence_parent) / "evidence"), "--skip-benchmark"],
                                        text=True, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(sentinel.read_text(), "unrelated caller data")

    def check_failure_cleanup(self, fail_evidence):
        with tempfile.TemporaryDirectory() as parent_name:
            parent = Path(parent_name)
            sentinel = parent / "keep"
            sentinel.write_text("caller data")
            created = []
            allocate = tempfile.TemporaryDirectory

            def fresh(*args, **kwargs):
                directory = allocate(*args, **kwargs)
                created.append(Path(directory.name))
                return directory

            argv = [str(RUNNER), "--baseline-dir", str(parent / "missing"),
                    "--evidence", str(parent / "evidence"), "--skip-benchmark"]
            fake_compiler = subprocess.CompletedProcess([], 0, "test compiler\n")
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(sys, "argv", argv))
                stack.enter_context(patch("platform.system", return_value="Darwin"))
                stack.enter_context(patch("platform.platform", return_value="test host"))
                stack.enter_context(patch("subprocess.run", return_value=fake_compiler))
                stack.enter_context(patch("tempfile.TemporaryDirectory", side_effect=fresh))
                stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                if fail_evidence:
                    stack.enter_context(patch("shutil.copyfile", side_effect=OSError("test evidence failure")))
                with self.assertRaises(OSError):
                    runpy.run_path(str(RUNNER), run_name="__main__")
            self.assertEqual(len(created), 1)
            self.assertFalse(created[0].exists())
            self.assertEqual(sentinel.read_text(), "caller data")

    def test_only_fresh_directory_is_removed_on_failure(self):
        self.check_failure_cleanup(False)

    def test_fresh_directory_is_removed_if_evidence_copy_fails(self):
        self.check_failure_cleanup(True)


if __name__ == "__main__":
    unittest.main()
