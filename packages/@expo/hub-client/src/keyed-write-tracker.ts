/** Opaque identity for one in-flight write. */
export interface KeyedWriteToken<Key extends string> {
  readonly key: Key;
  readonly generation: number;
  readonly id: number;
}

/**
 * Tracks writes independently by key.
 *
 * A key may have at most one live write, while different keys can be written
 * concurrently. Resetting advances the generation so completions from a
 * previous device/configuration cannot affect the current one.
 */
export class KeyedWriteTracker<Key extends string> {
  readonly #active = new Map<Key, KeyedWriteToken<Key>>();
  #generation = 0;
  #nextId = 0;

  start(key: Key): KeyedWriteToken<Key> | null {
    if (this.#active.has(key)) return null;
    const token = { key, generation: this.#generation, id: ++this.#nextId };
    this.#active.set(key, token);
    return token;
  }

  isCurrent(token: KeyedWriteToken<Key>): boolean {
    return token.generation === this.#generation && this.#active.get(token.key) === token;
  }

  finish(token: KeyedWriteToken<Key>): boolean {
    if (!this.isCurrent(token)) return false;
    this.#active.delete(token.key);
    return true;
  }

  reset(): void {
    this.#generation++;
    this.#active.clear();
  }

  get pending(): ReadonlySet<Key> {
    return new Set(this.#active.keys());
  }
}
