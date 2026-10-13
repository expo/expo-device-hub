import { $ } from "bun";

interface Simulator {
  udid: string;
  state: string;
}

export async function listSimulators(filter: "booted" | "available"): Promise<Simulator[]> {
  const { devices } = (await $`xcrun simctl list devices ${filter} -j`.json()) as {
    devices: Record<string, Simulator[]>;
  };
  return Object.values(devices).flat();
}
