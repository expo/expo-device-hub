export type SimctlDevice = {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
};

export function parseSimctlDevices(json: string): SimctlDevice[] {
  const data = JSON.parse(json) as {
    devices?: Record<string, SimctlDevice[]>;
  };
  return Object.values(data.devices ?? {}).flat();
}

export function pickBootedNamed(devices: SimctlDevice[], name: string): string | null {
  return devices.find((device) => device.state === "Booted" && device.name === name)?.udid ?? null;
}

export function pickBootedIphone(devices: SimctlDevice[]): string | null {
  return devices.find((device) => device.state === "Booted" && /iPhone/i.test(device.name))?.udid ?? null;
}

export function pickAvailableNamed(devices: SimctlDevice[], name: string): string | null {
  return devices.find((device) => device.name === name && device.isAvailable !== false)?.udid ?? null;
}
