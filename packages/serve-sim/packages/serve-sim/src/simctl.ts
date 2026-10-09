import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { simulatorBootEnv } from "./additional-dylibs";

const execFileAsync = promisify(execFile);

function commandOutput(args: string[], stdout: string): string {
  const insert = (args[0] === "getenv" && args[2] === "DYLD_INSERT_LIBRARIES")
    || (args[0] === "spawn" && args[2] === "launchctl" && args[3] === "getenv" && args[4] === "DYLD_INSERT_LIBRARIES");
  return insert ? stdout.replace(/\n$/, "") : stdout.trim();
}

export async function simctl(args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", ...args], {
    encoding: "utf8",
    env: args[0] === "boot" || args[0] === "bootstatus" ? simulatorBootEnv(args[1]!) : { ...process.env },
    timeout,
  });
  return commandOutput(args, stdout);
}

export function simctlSync(args: string[], timeout = 30_000): string {
  const stdout = execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf8",
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  return commandOutput(args, stdout);
}
