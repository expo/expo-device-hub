// @ref LLP 0003#single-device-sessions — session target and layout contract
/** Immutable server policy. Device selection preferences must never override it. */
export class SingleDevicePolicy {
  readonly device: string;

  constructor(device: string) {
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(device)) {
      throw new Error("single-device requires a simulator UDID");
    }
    this.device = device.toUpperCase();
  }

  resolveTarget(requested?: string | null): string {
    if (requested != null && requested.toUpperCase() !== this.device) {
      throw new Error("This single-device session cannot access another device.");
    }
    return this.device;
  }

  scopeAction(action: string, params: Record<string, unknown> = {}): Record<string, unknown> {
    // These act on host-wide state or create a separate server outside this policy.
    if (["server.detach", "server.kill", "home.watch"].includes(action)) {
      throw new Error(`Action ${action} is unavailable in single-device mode.`);
    }
    if (params.udid !== undefined && typeof params.udid !== "string") {
      throw new Error("Invalid single-device target.");
    }
    // Action schemas discard this field for file-only operations. Every device
    // action gets a concrete target, including when the client omits one.
    return { ...params, udid: this.resolveTarget(params.udid as string | undefined) };
  }
}
