import { describe, expect, mock, test } from "bun:test";
import {
  attachEmulatorCapture,
  emulatorCaptureAttachCommand,
  linuxPtraceProblem,
  parseAttachOutput,
  type AttachRunResult,
  type EmulatorCaptureAttachDependencies,
} from "../emulator-capture-attach";
import type { EmulatorCapture } from "../emulator-capture";

const SOCKET_DIRECTORY = "/tmp/expo-emulator-capture";

function capture(platform: EmulatorCapture["platform"], library = "/cache/agent.lib") {
  return {
    library: mock(() => Promise.resolve(library)),
    problem: () => null,
    socketDirectory: SOCKET_DIRECTORY,
    platform,
  } satisfies EmulatorCapture;
}

const LLDB_LOADED = [
  "(lldb) process attach --pid 4242",
  "Process 4242 stopped",
  "(lldb) expression -- (int) setenv(...)",
  "(int) $0 = 0",
  "(int) $1 = 0",
  "(void *) $2 = 0x0000000c4f2d0aa0",
  "(char *) $3 = 0x0000000000000000",
  "Process 4242 detached",
].join("\n");

const GDB_LOADED = [
  "$1 = 0",
  "$2 = 0",
  "$3 = (void *) 0x55d0c1a2b2c0",
  "$4 = 0x0",
  "[Inferior 1 (process 4242) detached]",
].join("\n");

/** Dependencies for one attach: the debugger prints `output`, the socket shows up after `polls`. */
function dependencies(
  output: string | AttachRunResult,
  overrides: EmulatorCaptureAttachDependencies & { polls?: number } = {},
) {
  let polls = 0;
  const run = mock(() =>
    Promise.resolve(typeof output === "string" ? { code: 0, output } : output),
  );
  const ensureDirectory = mock(() => Promise.resolve());
  return {
    run,
    ensureDirectory,
    readText: () => null,
    uid: () => 501,
    socketReady: () => ++polls > (overrides.polls ?? 1),
    wait: () => Promise.resolve(),
    logSize: () => 0,
    readLogFrom: () => "",
    ...overrides,
  } satisfies EmulatorCaptureAttachDependencies;
}

describe("emulatorCaptureAttachCommand", () => {
  test("lldb sets the socket and log, loads the agent, and detaches", () => {
    const { command, args } = emulatorCaptureAttachCommand("darwin", {
      processId: 4242,
      library: '/Users/a "b"/agent.dylib',
      socket: "/tmp/s/emulator-5554.sock",
      log: "/tmp/s/emulator-5554.log",
    });
    expect(command).toBe("lldb");
    expect(args.slice(0, 4)).toEqual(["--batch", "--no-lldbinit", "--attach-pid", "4242"]);
    const lines = args.filter((_, index) => args[index - 1] === "--one-line");
    expect(lines).toEqual([
      "process handle --stop false --pass true --notify false SIGUSR1 SIGUSR2 SIGALRM SIGVTALRM SIGPROF SIGCHLD SIGPIPE SIGWINCH SIGIO",
      'expression -- (int) setenv("EXPO_EMULATOR_CAPTURE_SOCKET", "/tmp/s/emulator-5554.sock", 1)',
      'expression -- (int) setenv("EXPO_EMULATOR_CAPTURE_LOG", "/tmp/s/emulator-5554.log", 1)',
      'expression -- (void *) dlopen("/Users/a \\"b\\"/agent.dylib", 2)',
      "expression -- (char *) dlerror()",
      "process detach",
    ]);
  });

  test("gdb loads only libc's symbols, then calls the same functions", () => {
    const { command, args } = emulatorCaptureAttachCommand("linux", {
      processId: 4242,
      library: "/cache/agent.so",
      socket: "/tmp/s/emulator-5554.sock",
      log: "/tmp/s/emulator-5554.log",
    });
    expect(command).toBe("gdb");
    expect(args).toContain("set auto-solib-add off");
    // QEMU's own signals pass through, so that they do not unwind the calls.
    const handle = args.find((arg) => arg.startsWith("handle "));
    expect(handle).toStartWith("handle SIGUSR1 SIGUSR2 SIGALRM");
    expect(handle).toEndWith("SIG44 nostop noprint pass");
    expect(args.indexOf(handle!)).toBeLessThan(args.indexOf("-p"));
    expect(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2)).toEqual(["-p", "4242"]);
    const commands = args.filter((_, index) => args[index - 1] === "-ex");
    expect(commands).toEqual([
      "sharedlibrary libc\\.so",
      "set unwindonsignal on",
      'call (int) setenv("EXPO_EMULATOR_CAPTURE_SOCKET", "/tmp/s/emulator-5554.sock", 1)',
      'call (int) setenv("EXPO_EMULATOR_CAPTURE_LOG", "/tmp/s/emulator-5554.log", 1)',
      'call (void *) dlopen("/cache/agent.so", 2)',
      "call (char *) dlerror()",
      "detach",
    ]);
  });
});

describe("parseAttachOutput", () => {
  test("reads the library handle or dlerror's text", () => {
    expect(parseAttachOutput("darwin", LLDB_LOADED)).toEqual({ loaded: true });
    expect(
      parseAttachOutput(
        "darwin",
        '(void *) $2 = 0x0000000000000000\n(char *) $3 = 0x000000016f9e3c80 "dlopen(/x): image not found"',
      ),
    ).toEqual({ loaded: false, error: "dlopen(/x): image not found" });
    expect(parseAttachOutput("linux", GDB_LOADED)).toEqual({ loaded: true });
    expect(
      parseAttachOutput(
        "linux",
        '$3 = (void *) 0x0\n$4 = 0x7f3a2c0012a0 "/x.so: cannot open shared object file"',
      ),
    ).toEqual({ loaded: false, error: "/x.so: cannot open shared object file" });
    expect(parseAttachOutput("darwin", "error: attach failed: lost connection")).toBeNull();
  });
});

test("linuxPtraceProblem allows scope 0 and root, and explains the rest", () => {
  expect(linuxPtraceProblem("0\n", 1000)).toBeNull();
  expect(linuxPtraceProblem(null, 1000)).toBeNull();
  expect(linuxPtraceProblem("1", 0)).toBeNull();
  expect(linuxPtraceProblem("1\n", 1000)).toContain("sudo sysctl kernel.yama.ptrace_scope=0");
  expect(linuxPtraceProblem("2", 1000)).toContain("Only root");
  expect(linuxPtraceProblem("3", 1000)).toContain("kernel.yama.ptrace_scope is 3");
});

describe("attachEmulatorCapture", () => {
  test("installs the agent, runs the debugger, and waits for the socket", async () => {
    const macCapture = capture("darwin", "/cache/agent.dylib");
    const deps = dependencies(LLDB_LOADED, { polls: 3 });
    await attachEmulatorCapture(macCapture, { serial: "emulator-5554", processId: 4242 }, deps);
    expect(macCapture.library).toHaveBeenCalledTimes(1);
    expect(deps.ensureDirectory).toHaveBeenCalledWith(SOCKET_DIRECTORY);
    const [command, args, timeoutMs] = deps.run.mock.calls[0] as unknown as [
      string,
      string[],
      number,
    ];
    expect(command).toBe("lldb");
    expect(args).toContain('expression -- (void *) dlopen("/cache/agent.dylib", 2)');
    expect(timeoutMs).toBe(180_000);
  });

  test("an install or encoder problem stops it before the debugger", async () => {
    const broken = {
      ...capture("linux"),
      library: () => Promise.reject(new Error("x264 build 165 (libx264.so.165) is missing.")),
    };
    const deps = dependencies(GDB_LOADED);
    await expect(
      attachEmulatorCapture(broken, { serial: "emulator-5554", processId: 4242 }, deps),
    ).rejects.toThrow("x264 build 165");
    expect(deps.run).not.toHaveBeenCalled();
  });

  test("macOS: a refused attach says how to allow it", async () => {
    const deps = dependencies({
      code: 1,
      output:
        "error: attach failed: Not allowed to attach to process.  Look in the console messages (Console.app), near the debugserver entries.",
    });
    await expect(
      attachEmulatorCapture(capture("darwin"), { serial: "emulator-5554", processId: 4242 }, deps),
    ).rejects.toThrow("sudo DevToolsSecurity -enable");
  });

  test("a missing debugger names its install command", async () => {
    const missing = Object.assign(new Error("spawn lldb ENOENT"), { code: "ENOENT" });
    await expect(
      attachEmulatorCapture(
        capture("darwin"),
        { serial: "emulator-5554", processId: 4242 },
        dependencies({ code: null, output: "", spawnError: missing }),
      ),
    ).rejects.toThrow("xcode-select --install");
    await expect(
      attachEmulatorCapture(
        capture("linux"),
        { serial: "emulator-5554", processId: 4242 },
        dependencies({ code: null, output: "", spawnError: missing }),
      ),
    ).rejects.toThrow("sudo apt install gdb");
  });

  test("Linux: ptrace scope 1 stops it before the debugger", async () => {
    const deps = dependencies(GDB_LOADED, {
      readText: (path) => (path.endsWith("ptrace_scope") ? "1\n" : null),
    });
    await expect(
      attachEmulatorCapture(capture("linux"), { serial: "emulator-5554", processId: 4242 }, deps),
    ).rejects.toThrow("kernel.yama.ptrace_scope is 1");
    expect(deps.run).not.toHaveBeenCalled();
  });

  test("Linux: an agent that the process maps already is not loaded again", async () => {
    const deps = dependencies(GDB_LOADED, {
      readText: (path) =>
        path === "/proc/4242/maps" ? "7f00-7f10 r-xp 0 /cache/libexpo_emulator_capture.so\n" : "0",
      readLogFrom: () => "[expo-emulator-capture] capture disabled: x264 is missing\n",
    });
    await expect(
      attachEmulatorCapture(capture("linux"), { serial: "emulator-5554", processId: 4242 }, deps),
    ).rejects.toThrow(
      "The capture agent turned itself off in this emulator: x264 is missing. The agent is loaded in this emulator already.",
    );
    expect(deps.run).not.toHaveBeenCalled();
  });

  test("Linux: a call that a signal undid says so", async () => {
    const deps = dependencies({
      code: 0,
      output:
        "The program being debugged was signaled while in a function called from GDB.\nGDB has restored the context to what it was before the call.\n[Inferior 1 (process 4242) detached]",
    });
    await expect(
      attachEmulatorCapture(capture("linux"), { serial: "emulator-5554", processId: 4242 }, deps),
    ).rejects.toThrow("A signal stopped the emulator during the attach");
  });

  test("a failed dlopen gives dlerror's text", async () => {
    const deps = dependencies('$3 = (void *) 0x0\n$4 = 0x7f3a "agent.so: wrong ELF class"');
    await expect(
      attachEmulatorCapture(capture("linux"), { serial: "emulator-5554", processId: 4242 }, deps),
    ).rejects.toThrow("The emulator did not load the capture agent: agent.so: wrong ELF class");
  });

  test("an agent that turns itself off gives its reason from the new log lines", async () => {
    const readLogFrom = mock((_path: string, offset: number) =>
      offset === 120
        ? "[expo-emulator-capture] capture disabled: renderer symbols are missing\n"
        : "",
    );
    const deps = dependencies(LLDB_LOADED, {
      socketReady: () => false,
      logSize: () => 120,
      readLogFrom,
    });
    await expect(
      attachEmulatorCapture(capture("darwin"), { serial: "emulator-5554", processId: 4242 }, deps),
    ).rejects.toThrow(
      "The capture agent turned itself off in this emulator: renderer symbols are missing.",
    );
    expect(readLogFrom).toHaveBeenCalledWith(`${SOCKET_DIRECTORY}/emulator-5554.log`, 120);
  });
});
