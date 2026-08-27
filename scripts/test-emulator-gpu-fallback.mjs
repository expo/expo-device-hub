import { spawn, spawnSync } from "node:child_process";

// Usage: node scripts/test-emulator-gpu-fallback.mjs [AVD_NAME]
const avdName = process.argv[2] ?? "Pixel_9";
const hardwareRenderingError =
  "Your GPU cannot be used for hardware rendering";

// The real server keeps Node alive. This timer plays that role while leaving
// the emulator process and its pipes unreferenced, just like expo-device-hub.
const serverKeepAlive = setInterval(() => {}, 60_000);

function stopEmulatorAttempt(emulator) {
  if (process.platform === "win32" && emulator.pid) {
    const stopped = spawnSync(
      "taskkill",
      ["/PID", String(emulator.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    if (!stopped.error && stopped.status === 0) return;
  } else if (emulator.pid) {
    try {
      process.kill(-emulator.pid, "SIGKILL");
      return;
    } catch {
      // The process may have exited between emitting output and being signaled.
    }
  }

  emulator.kill("SIGKILL");
}

function startEmulator(gpuMode) {
  return new Promise((resolve) => {
    const emulator = spawn(
      "emulator",
      [
        "-avd",
        avdName,
        "-no-audio",
        "-no-window",
        "-gpu",
        gpuMode,
        "-no-boot-anim",
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdoutTail = "";
    let stderrTail = "";
    let fallbackRequested = false;
    let finished = false;

    emulator.once("spawn", () => {
      emulator.unref();
      emulator.stdout.unref();
      emulator.stderr.unref();
    });

    const inspectOutput = (tail, data) => {
      const output = tail + data.toString();

      if (
        gpuMode === "host" &&
        !fallbackRequested &&
        output.includes(hardwareRenderingError)
      ) {
        fallbackRequested = true;
        console.log(
          "[fallback] Hardware rendering is unavailable; stopping the host GPU attempt.",
        );
        stopEmulatorAttempt(emulator);
      }

      return output.slice(-(hardwareRenderingError.length - 1));
    };

    emulator.stdout.on("data", (data) => {
      console.log("[stdout]", data.toString());
      stdoutTail = inspectOutput(stdoutTail, data);
    });

    emulator.stderr.on("data", (data) => {
      console.error("[stderr]", data.toString());
      stderrTail = inspectOutput(stderrTail, data);
    });

    emulator.on("error", (error) => {
      console.error("[error]", error);

      if (!finished) {
        finished = true;
        resolve({ fallbackRequested, error });
      }
    });

    emulator.on("close", (code, signal) => {
      console.log("[close]", { gpuMode, code, signal });

      if (!finished) {
        finished = true;
        resolve({ fallbackRequested, code });
      }
    });
  });
}

try {
  const hostAttempt = await startEmulator("host");

  if (hostAttempt.fallbackRequested && !hostAttempt.error) {
    console.log("[fallback] Retrying with -gpu software.");
    const softwareAttempt = await startEmulator("software");
    process.exitCode = softwareAttempt.error ? 1 : (softwareAttempt.code ?? 1);
  } else {
    process.exitCode = hostAttempt.error ? 1 : (hostAttempt.code ?? 1);
  }
} finally {
  clearInterval(serverKeepAlive);
}
