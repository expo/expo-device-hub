import type { configureCapability } from "../../launch-manager";

export function capabilityHarness({
  publish = async () => {},
  remove = async () => {},
}: {
  publish?: (udid: string, portFile: string) => Promise<void>;
  remove?: (udid: string) => Promise<void>;
} = {}): typeof configureCapability {
  return async (udid, definition, { enabled, bundleId = null, options = {} }) => {
    const context = { udid, enabled, bundleId, options };
    if (!enabled) {
      await remove(udid);
      await definition.setEnabled(context);
      return;
    }
    const prepared = await definition.setEnabled(context);
    if (!prepared) throw new Error("Capability declined to start");
    try {
      await publish(udid, prepared.env?.SIMNET_PROXY_PORT_FILE ?? "");
    } catch (error) {
      prepared.failed?.(error);
      await prepared.rollback?.(error);
      throw error;
    }
    prepared.committed?.();
  };
}
