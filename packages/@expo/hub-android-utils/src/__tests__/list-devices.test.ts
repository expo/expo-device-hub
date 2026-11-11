import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDevices } from "../list-devices";

// A fake SDK: one emulator over the network whose `emu avd name` fails, one
// phone whose getprop fails, and one phone that works.
const ADB = `#!/bin/sh
case "$*" in
  "devices -l") printf 'List of devices attached\\n127.0.0.1:5555 device\\nbroken device\\nphone device\\n' ;;
  "-s 127.0.0.1:5555 shell getprop") echo '[ro.kernel.qemu]: [1]' ;;
  "-s phone shell getprop") echo '[ro.product.model]: [Pixel]' ;;
  *) exit 1 ;;
esac
`;

let sdk: string;
let savedHome: string | undefined;

beforeAll(() => {
  sdk = mkdtempSync(join(tmpdir(), "fake-sdk-"));
  mkdirSync(join(sdk, "platform-tools"));
  mkdirSync(join(sdk, "cmdline-tools/latest/bin"), { recursive: true });
  writeFileSync(join(sdk, "platform-tools/adb"), ADB);
  writeFileSync(join(sdk, "cmdline-tools/latest/bin/avdmanager"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(sdk, "platform-tools/adb"), 0o755);
  chmodSync(join(sdk, "cmdline-tools/latest/bin/avdmanager"), 0o755);
  savedHome = process.env.ANDROID_HOME;
  process.env.ANDROID_HOME = sdk;
});

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
