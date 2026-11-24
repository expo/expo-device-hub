import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDevices } from "../list-devices";

// A fake SDK: one emulator over the network whose `emu avd name` fails, one
// phone whose getprop fails, and one phone that works.
const ADB_REPLIES: Record<string, string> = {
  "devices -l": "List of devices attached\n127.0.0.1:5555 device\nbroken device\nphone device\n",
  "-s 127.0.0.1:5555 shell getprop": "[ro.kernel.qemu]: [1]\n",
  "-s phone shell getprop": "[ro.product.model]: [Pixel]\n",
};

// POSIX runs the fake adb as a shell script.
const ADB_SH = `#!/bin/sh
case "$*" in
${Object.entries(ADB_REPLIES)
  .map(([args, reply]) => `  ${JSON.stringify(args)}) printf ${JSON.stringify(reply)} ;;`)
  .join("\n")}
  *) exit 1 ;;
esac
`;

// Windows needs a real adb.exe, so the fake adb is compiled with Bun.
const ADB_TS = `const replies: Record<string, string> = ${JSON.stringify(ADB_REPLIES)};
const reply = replies[process.argv.slice(2).join(" ")];
if (reply === undefined) process.exit(1);
process.stdout.write(reply);
`;

const isWindows = process.platform === "win32";

let sdk: string;
let savedHome: string | undefined;

function writeFakeAdb(platformTools: string): void {
  if (!isWindows) {
    writeFileSync(join(platformTools, "adb"), ADB_SH);
    chmodSync(join(platformTools, "adb"), 0o755);
    return;
  }
  const source = join(sdk, "fake-adb.ts");
  writeFileSync(source, ADB_TS);
  const build = Bun.spawnSync([
    process.execPath,
    "build",
    "--compile",
    source,
    "--outfile",
    join(platformTools, "adb.exe"),
  ]);
  if (build.exitCode !== 0) throw new Error(`Could not build fake adb.exe: ${build.stderr}`);
}

function writeFakeAvdmanager(bin: string): void {
  if (isWindows) {
    writeFileSync(join(bin, "avdmanager.bat"), "@echo off\r\nexit /b 0\r\n");
    return;
  }
  writeFileSync(join(bin, "avdmanager"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "avdmanager"), 0o755);
}

beforeAll(() => {
  sdk = mkdtempSync(join(tmpdir(), "fake-sdk-"));
  const platformTools = join(sdk, "platform-tools");
  const bin = join(sdk, "cmdline-tools", "latest", "bin");
  mkdirSync(platformTools);
  mkdirSync(bin, { recursive: true });
  writeFakeAdb(platformTools);
  writeFakeAvdmanager(bin);
  savedHome = process.env.ANDROID_HOME;
  process.env.ANDROID_HOME = sdk;
}, 60_000);

afterAll(() => {
  if (savedHome === undefined) delete process.env.ANDROID_HOME;
  else process.env.ANDROID_HOME = savedHome;
  rmSync(sdk, { recursive: true, force: true });
});

test("one failed device does not hide the others", async () => {
  const listed = await listDevices();
  expect(listed.value.map((device) => device.serial).sort()).toEqual(["127.0.0.1:5555", "phone"]);
  expect(listed.error).not.toBeNull();
});
