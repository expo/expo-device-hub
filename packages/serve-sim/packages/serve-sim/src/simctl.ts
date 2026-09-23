import { execFile, execFileSync } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export async function simctl(args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", ...args], {
    encoding: "utf8",
    timeout,
  });
  return stdout.trim();
}

export function simctlSync(args: string[], timeout = 30_000): string {
  return execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  }).trim();
}
