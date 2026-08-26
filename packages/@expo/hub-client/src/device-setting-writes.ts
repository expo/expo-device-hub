import { type DeviceSettingKey, type DeviceSettings } from './types';

/** Opaque identity for one in-flight option write. */
export interface DeviceSettingWriteToken {
  readonly key: DeviceSettingKey;
  readonly generation: number;
  readonly id: number;
}

/**
 * Tracks option writes independently by key.
 *
 * A key may have at most one live write, while different keys can be written
 * concurrently. Resetting advances the generation so completions from a
 * previous device/configuration cannot affect the current one.
 */
export class DeviceSettingWriteTracker {
  readonly #active = new Map<DeviceSettingKey, DeviceSettingWriteToken>();
  #generation = 0;
  #nextId = 0;

  start(key: DeviceSettingKey): DeviceSettingWriteToken | null {
    if (this.#active.has(key)) return null;
    const token = { key, generation: this.#generation, id: ++this.#nextId };
    this.#active.set(key, token);
    return token;
  }

  isCurrent(token: DeviceSettingWriteToken): boolean {
    return token.generation === this.#generation && this.#active.get(token.key) === token;
  }

  finish(token: DeviceSettingWriteToken): boolean {
    if (!this.isCurrent(token)) return false;
    this.#active.delete(token.key);
    return true;
  }

  reset(): void {
    this.#generation++;
    this.#active.clear();
  }

  get pending(): ReadonlySet<DeviceSettingKey> {
    return new Set(this.#active.keys());
  }
}

/**
 * Apply the authoritative value for one failed option write without replacing
 * unrelated optimistic values that may still be in flight.
 */
export function mergeAuthoritativeDeviceSetting(
  current: DeviceSettings | null,
  key: DeviceSettingKey,
  authoritative: DeviceSettings,
): DeviceSettings {
  const next = { ...(current ?? {}) };
  const value = authoritative[key];
  if (typeof value === 'string') next[key] = value;
  else delete next[key];
  return next;
}
