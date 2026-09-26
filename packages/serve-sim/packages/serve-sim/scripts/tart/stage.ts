import { existsSync } from "fs";
import { join } from "path";
import { assertHostModules, GUEST_PATH, guestPkgPath, shellEscape, type TartGuest } from "./guest";

export const GUEST_PKG = "/tmp/serve-sim-pkg";
export const GUEST_SIMPB = "/tmp/simpb";

// The suite `tart test` runs with no arguments. Listed rather than matched by
// name so a new test file joins it on purpose.
const CLIPBOARD_SUITE = [
  "src/__tests__/pasteboard-copy.e2e.test.ts",
  "src/__tests__/pasteboard-endpoint.test.ts",
  "src/__tests__/pasteboard-inject.e2e.test.ts",
  "src/__tests__/pasteboard-request.test.ts",
  "src/__tests__/sim-clipboard.e2e.test.ts",
  "src/__tests__/sim-clipboard.test.ts",
];

export function resolveTestFiles(pkgDir: string, args: string[]): string[] {
  if (args.length) return args;
  return CLIPBOARD_SUITE.filter((file) => existsSync(join(pkgDir, file)));
}

function simpbFiles(pkgDir: string): string[] {
  const dir = join(pkgDir, "dist", "simpb");
  return ["libSimPasteboardReader.dylib", "serve-sim-pasteboard"]
    .map((name) => join(dir, name))
    .filter((path) => existsSync(path));
}

export async function stageGuest(guest: TartGuest): Promise<void> {
  const { pkgDir } = guest.config;
  await guest.ssh(
    `rm -rf ${GUEST_SIMPB} ${GUEST_PKG}/src ${GUEST_PKG}/dist ${GUEST_PKG}/Sources ${GUEST_PKG}/node_modules && mkdir -p ${GUEST_SIMPB} ${GUEST_PKG}`,
  );

  const binaries = simpbFiles(pkgDir);
  if (binaries.length) await guest.scp(binaries, `${GUEST_SIMPB}/`);

  if (existsSync(join(pkgDir, "dist", "simpb", "PasteboardFixture.app", "PasteboardFixture"))) {
    await guest.tarTo(join(pkgDir, "dist", "simpb"), ["PasteboardFixture.app"], GUEST_SIMPB);
  }

  const extras = ["bun.lock", "bun.lockb", "dev.ts", "dist", "Sources"].filter((name) =>
    existsSync(join(pkgDir, name)),
  );
  await guest.tarTo(pkgDir, ["src", "package.json", ...extras], GUEST_PKG);
}

export async function warmFixture(guest: TartGuest, udid: string): Promise<void> {
  const quoted = shellEscape(udid);
  const code = await guest.sshInherit(`${GUEST_PATH}
set -euo pipefail
if [[ ! -d ${GUEST_SIMPB}/PasteboardFixture.app ]]; then
  exit 0
fi
xcrun simctl install ${quoted} ${GUEST_SIMPB}/PasteboardFixture.app >/dev/null
xcrun simctl privacy ${quoted} grant pasteboard dev.expo.serve-sim.pasteboard-fixture >/dev/null
`);
  if (code !== 0) throw new Error("failed to install the pasteboard fixture on the guest");
}

export async function runGuestTests(
  guest: TartGuest,
  files: string[],
  udid: string,
): Promise<number> {
  assertHostModules(guest.config);
  const shareModules = shellEscape(`${guestPkgPath(guest.config)}/node_modules`);
  const quoted = files.map(shellEscape).join(" ");
  const quotedUdid = shellEscape(udid);
  return guest.sshInherit(`${GUEST_PATH}
set -euo pipefail
chmod -R 755 ${GUEST_SIMPB}
xattr -cr ${GUEST_SIMPB} 2>/dev/null || true
export SERVE_SIM_SIMPB_DIR=${GUEST_SIMPB}
export SERVE_SIM_TEST_UDID=${quotedUdid}
ln -sfn ${shareModules} ${GUEST_PKG}/node_modules
cd ${GUEST_PKG}
bash Sources/build-test-fixtures.sh
echo "user=$(whoami) console=$(stat -f %Su /dev/console) pwd=$PWD simpb=$SERVE_SIM_SIMPB_DIR"
exec bun test --max-concurrency=1 ${quoted}
`);
}

export async function testOnce(guest: TartGuest, files: string[], udid: string): Promise<number> {
  await stageGuest(guest);
  await warmFixture(guest, udid);
  return runGuestTests(guest, files, udid);
}
