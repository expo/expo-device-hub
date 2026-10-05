import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { FeatureState, HubError, HubResult, Writes } from './types';

export function hubError(cause: unknown): HubError {
  if (
    cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    'retryable' in cause &&
    'message' in cause
  )
    return cause as HubError;
  const message = cause instanceof Error ? cause.message : String(cause || 'Request failed');
  const code = /401|403|unauthori|forbidden/i.test(message)
    ? 'auth'
    : /timeout|timed out/i.test(message)
      ? 'timeout'
      : /invalid|parse|JSON/i.test(message)
        ? 'invalid-response'
        : 'network';
  return { code, message, retryable: code === 'network' || code === 'timeout' };
}
export const failure = (
  code: HubError['code'],
  message: string,
  retryable = false,
): HubResult<never> => ({ ok: false, error: { code, message, retryable } });
export function checkResponse(response: Response): Response {
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response;
}

/** Tracks real read outcomes; never infers success from a default/empty value. */
export class FeatureRead {
  status: FeatureState<unknown>['status'] = 'loading';
  error: HubError | null = null;
  loaded = false;
  private failures = 0;
  private action: (() => void) | undefined;
  constructor(private notify: () => void) {}
  isStopped() {
    return this.status === 'error' || this.status === 'unsupported';
  }
  reset = () => {
    this.loaded = false;
    this.failures = 0;
    this.begin();
  };
  idle = () => {
    this.status = 'idle';
    this.error = null;
    this.notify();
  };
  begin = () => {
    this.status = 'loading';
    this.error = null;
    this.notify();
  };
  ready = () => {
    this.status = 'ready';
    this.error = null;
    this.loaded = true;
    this.failures = 0;
    this.notify();
  };
  unsupported = () => {
    this.status = 'unsupported';
    this.error = null;
    this.loaded = false;
    this.notify();
  };
  fail = (cause: unknown, automatic = false): boolean => {
    this.error = hubError(cause);
    this.status =
      automatic && this.error.retryable && ++this.failures < 3 ? 'reconnecting' : 'error';
    this.notify();
    return this.status === 'reconnecting';
  };
  bind = (action: () => void) => {
    this.action = action;
    return () => {
      if (this.action === action) this.action = undefined;
    };
  };
  refresh = () => {
    if (!this.action || this.status === 'unsupported') return;
    this.failures = 0;
    this.begin();
    this.action();
  };
}

export class FeatureSession {
  constructor(readonly scope = '') {}
  private version = 0;
  private listeners = new Set<() => void>();
  private reads = new Map<string, FeatureRead>();
  private writes = new Map<string, Writes<string>>();
  private generations = new Map<string, object>();
  resolved = false;
  notify = () => {
    ++this.version;
    for (const listener of this.listeners) listener();
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.version;
  read = (key: string): FeatureRead => {
    let read = this.reads.get(key);
    if (!read) {
      read = new FeatureRead(this.notify);
      this.reads.set(key, read);
    }
    return read;
  };
  resolve = () => {
    this.resolved = true;
    this.read('config').ready();
  };
  getWrites = (key: string): Writes<string> => {
    let writes = this.writes.get(key);
    if (!writes) {
      writes = { pending: new Set(), errors: new Map() };
      this.writes.set(key, writes);
    }
    return writes;
  };
  invalidate = () => {
    for (const key of this.generations.keys()) this.generations.set(key, {});
  };
  resetWrites = (key: string) => {
    this.generations.set(key, {});
    this.writes.delete(key);
    this.notify();
  };
  write = async (name: string, keys: readonly string[], run: () => unknown): Promise<HubResult> => {
    const before = this.getWrites(name);
    if (keys.some((key) => before.pending.has(key)))
      return failure('busy', 'An update is already in progress', true);
    const generation = this.generations.get(name) ?? {};
    this.generations.set(name, generation);
    const errors = new Map(before.errors);
    keys.forEach((key) => errors.delete(key));
    this.writes.set(name, { pending: new Set([...before.pending, ...keys]), errors });
    this.notify();
    let result: HubResult;
    try {
      const value = await run();
      result =
        value === false
          ? failure('rejected', 'The backend rejected the update')
          : { ok: true, value: undefined };
    } catch (cause) {
      result = { ok: false, error: hubError(cause) };
    }
    if (this.generations.get(name) !== generation)
      return failure('cancelled', 'The target changed');
    const current = this.getWrites(name);
    const pending = new Set(current.pending);
    const nextErrors = new Map(current.errors);
    for (const key of keys) {
      pending.delete(key);
      if (!result.ok) nextErrors.set(key, result.error);
    }
    this.writes.set(name, { pending, errors: nextErrors });
    this.notify();
    return result;
  };
}

export function useFeatureSession(scope: string): FeatureSession {
  const session = useMemo(() => new FeatureSession(scope), [scope]);
  useEffect(() => () => session.invalidate(), [session]);
  useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  return session;
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Bound backend reads/writes; target cleanup can still abort sooner. Wrap a
 * session-token fetch so gated backends keep their auth header.
 */
export function withFeatureDeadline(
  fetchImpl: FetchFn = (input, init) => globalThis.fetch(input, init),
): FetchFn {
  return (input, init = {}) => {
    const deadline = AbortSignal.timeout(10_000);
    return fetchImpl(input, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
    });
  };
}
export const fetchFeature = withFeatureDeadline();
