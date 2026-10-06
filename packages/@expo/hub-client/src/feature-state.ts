import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { FeatureState, HubError, HubResult, Writes } from './types';

/** A request failure that carries its HTTP status or an explicit error code. */
export class HubRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: HubError['code'],
  ) {
    super(message);
    this.name = 'HubRequestError';
  }
}
export const httpError = (status: number, message = `Request failed (${status})`) =>
  new HubRequestError(message, status);
export const invalidResponse = (message: string) =>
  new HubRequestError(message, undefined, 'invalid-response');

function statusCode(status: number): HubError['code'] {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404 || status === 405 || status === 501) return 'unsupported';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 409 || status === 423) return 'busy';
  if (status === 429 || status >= 500) return 'network';
  return 'rejected';
}
const RETRYABLE = new Set<HubError['code']>(['network', 'timeout', 'busy']);

export function hubError(cause: unknown): HubError {
  if (
    cause &&
    typeof cause === 'object' &&
    !(cause instanceof Error) &&
    'code' in cause &&
    'retryable' in cause &&
    'message' in cause
  )
    return cause as HubError;
  const message = cause instanceof Error ? cause.message : String(cause || 'Request failed');
  const name = cause instanceof Error || cause instanceof DOMException ? cause.name : '';
  let code: HubError['code'];
  if (cause instanceof HubRequestError && (cause.code || cause.status !== undefined))
    code = cause.code ?? statusCode(cause.status!);
  else if (name === 'TimeoutError') code = 'timeout';
  else if (name === 'AbortError') code = 'cancelled';
  else if (name === 'SyntaxError') code = 'invalid-response';
  // exec-ws and EventSource report no status; their messages are our own text.
  else if (/unauthori|forbidden/i.test(message)) code = 'auth';
  else if (/timeout|timed out/i.test(message)) code = 'timeout';
  else code = 'network';
  return { code, message, retryable: RETRYABLE.has(code) };
}
export const failure = (
  code: HubError['code'],
  message: string,
  retryable = false,
): HubResult<never> => ({ ok: false, error: { code, message, retryable } });
export function checkResponse(response: Response, message?: string): Response {
  if (!response.ok) throw httpError(response.status, message && `${message} (${response.status})`);
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
  /** Notifies only on a visible change, so steady polls do not re-render. */
  private set(status: FeatureState<unknown>['status'], error: HubError | null, loaded: boolean) {
    const same =
      this.status === status &&
      this.loaded === loaded &&
      (this.error === error ||
        (!!this.error &&
          !!error &&
          this.error.code === error.code &&
          this.error.message === error.message &&
          this.error.retryable === error.retryable));
    this.status = status;
    this.error = same ? this.error : error;
    this.loaded = loaded;
    if (!same) this.notify();
  }
  reset = () => {
    this.failures = 0;
    this.set('loading', null, false);
  };
  idle = () => this.set('idle', null, this.loaded);
  begin = () => this.set('loading', null, this.loaded);
  ready = () => {
    this.failures = 0;
    this.set('ready', null, true);
  };
  unsupported = () => this.set('unsupported', null, false);
  /**
   * Records a failure and returns whether the caller should retry. `automatic`
   * retries stop after 3 retryable failures. `'always'` is for reads that must
   * recover without the UI: the caller retries every time, and a non-retryable
   * error (such as auth) still shows as `error` until a retry succeeds.
   */
  fail = (cause: unknown, automatic: boolean | 'always' = false): boolean => {
    const error = hubError(cause);
    const reconnecting =
      error.retryable && (automatic === 'always' || (automatic && ++this.failures < 3));
    this.set(reconnecting ? 'reconnecting' : 'error', error, this.loaded);
    return reconnecting || automatic === 'always';
  };
  bind = (action: () => void) => {
    this.action = action;
    return () => {
      if (this.action === action) this.action = undefined;
    };
  };
  /** Start a new attempt with a fresh failure count, keeping the last data. */
  restart = () => {
    if (this.status === 'unsupported') return;
    this.failures = 0;
    this.begin();
  };
  refresh = () => {
    if (!this.action || this.status === 'unsupported') return;
    this.restart();
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
    const changed = !this.resolved;
    this.resolved = true;
    this.read('config').ready();
    if (changed) this.notify();
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
    // A busy or cancelled write changed nothing, so it is not a field error.
    const error = 'error' in result ? result.error : null;
    for (const key of keys) {
      pending.delete(key);
      if (error && error.code !== 'busy' && error.code !== 'cancelled') nextErrors.set(key, error);
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

/**
 * One restart counter per feature, so a Retry on one feature restarts only the
 * transport that serves it. `names` must be a stable (module-level) array.
 */
export function useFeatureRevisions<K extends string>(
  session: FeatureSession,
  names: readonly K[],
): Record<K, number> {
  const [revisions, setRevisions] = useState(
    () => Object.fromEntries(names.map((name) => [name, 0])) as Record<K, number>,
  );
  useEffect(() => {
    const cleanups = names.map((name) =>
      session
        .read(name)
        .bind(() => setRevisions((current) => ({ ...current, [name]: current[name] + 1 }))),
    );
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [session, names]);
  return revisions;
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
