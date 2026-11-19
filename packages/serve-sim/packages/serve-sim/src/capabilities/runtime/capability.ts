/** A dylib loaded inside each eligible app process. */
export interface PreparedCapability {
  dylib: string;
  env?: Record<string, string>;
  committed?(): void;
  failed?(error: unknown): void;
  rollback?(error: unknown): Promise<void>;
}

/** `allApps` includes system apps such as Safari. */
export type CapabilityScope = "userApps" | "allApps";

export interface CapabilityContext {
  udid: string;
  /** Optional launch target; does not narrow the capability scope. */
  bundleId: string | null;
  /** Capability-specific options, such as a camera source. */
  options: Record<string, string>;
  enabled: boolean;
}

/** Startup plus deferred also attaches to apps that were running when enabled. */
export type CapabilityLoadPhase = "startup" | "deferred" | "startupAndDeferred";

export interface CapabilityDefinition {
  name: string;
  defaultEnabled: boolean;
  exclusive?: boolean;
  /** Fixed by the capability, not the caller. */
  scope: CapabilityScope;
  /** Delay before loading on the app main queue; defaults to zero. */
  loadDelayMs?: number;
  loadPhase?: CapabilityLoadPhase;
  /** The dylib path if it is already built, without building it; null when enabling would build it. */
  prebuiltDylib?(): string | null;
  /** Starts/stops host resources. Return null to decline enabling. */
  setEnabled(ctx: CapabilityContext): Promise<PreparedCapability | null>;
}

export interface CapabilityOverrides {
  enable?: string[];
  disable?: string[];
}
