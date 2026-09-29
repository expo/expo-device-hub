import { GUEST_PATH, shellEscape, type TartGuest } from "./guest";
import { parseSimctlDevices, pickAvailableNamed, pickBootedIphone, pickBootedNamed } from "./simctl";

const DEVICE_NAME = process.env.TART_DEVICE_NAME ?? "iPhone 17";

async function simctlList(guest: TartGuest, extra: "booted" | "available"): Promise<string> {
  return guest.ssh(`${GUEST_PATH}\nxcrun simctl list devices ${extra} -j`);
}

export async function bootSim(guest: TartGuest): Promise<string> {
  const booted = parseSimctlDevices(await simctlList(guest, "booted"));
  const preferred = pickBootedNamed(booted, DEVICE_NAME);
  if (preferred) return preferred;
  const already = pickBootedIphone(booted);
  if (already) {
    const name = booted.find((device) => device.udid === already)?.name ?? already;
    console.log(`reusing booted ${name} (wanted ${DEVICE_NAME})`);
    return already;
  }

  const available = parseSimctlDevices(await simctlList(guest, "available"));
  const udid = pickAvailableNamed(available, DEVICE_NAME);
  if (!udid) throw new Error(`no available ${DEVICE_NAME}`);

  const quoted = shellEscape(udid);
  const code = await guest.sshInherit(`${GUEST_PATH}
set -euo pipefail
echo booting ${quoted}
xcrun simctl boot ${quoted}
xcrun simctl bootstatus ${quoted} -b
`);
  if (code !== 0) throw new Error(`failed to boot ${DEVICE_NAME} on the guest`);
  return udid;
}
