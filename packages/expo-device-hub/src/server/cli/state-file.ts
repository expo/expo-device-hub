import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What a running CLI Hub records, as serve-sim records each helper in `server-<udid>.json`. The CLI
 * mints the session token and otherwise only prints it, so a process that started the Hub, such
 * as the EAS worker, reads it here.
 */
export type HubState = {
  pid: number;
  port: number;
  /** Where the Hub answers on this machine. */
  url: string;
  /** The session token. Present only under `--require-token`. */
  token?: string;
};

type Env = Record<string, string | undefined>;

/** Directory where the CLI records each running Hub. Override with `EXPO_DEVICE_HUB_STATE_DIR`. */
export function hubStateDir(env: Env = process.env): string {
  return env.EXPO_DEVICE_HUB_STATE_DIR || join(tmpdir(), 'expo-device-hub');
}

export function hubStateFile(port: number, env: Env = process.env): string {
  return join(hubStateDir(env), `server-${port}.json`);
}

/** The Hub's URL on this machine: a wildcard bind answers on loopback. */
export function localHubUrl(host: string, port: number): string {
  const local = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${local.includes(':') ? `[${local}]` : local}:${port}`;
}

/** Atomic, and readable only by its owner, because it can hold the session token. */
export function writeHubState(state: HubState, env: Env = process.env): string {
  const file = hubStateFile(state.port, env);
  mkdirSync(hubStateDir(env), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/** Removes the file only if `ownerPid` wrote it, so a Hub that exits late keeps a newer one's. */
export function clearHubState(port: number, ownerPid: number, env: Env = process.env): void {
  const file = hubStateFile(port, env);
  try {
    const state = JSON.parse(readFileSync(file, 'utf-8')) as Partial<HubState>;
    if (state.pid === ownerPid) unlinkSync(file);
  } catch {}
}

/**
 * Writes the Hub's record and returns a function that removes it once. The CLI removes it when
 * shutdown starts, before the Hub stops accepting connections, and again at exit as a fallback.
 */
export function publishHubState(state: HubState, env: Env = process.env): () => void {
  writeHubState(state, env);
  let withdrawn = false;
  return () => {
    if (withdrawn) return;
    withdrawn = true;
    clearHubState(state.port, state.pid, env);
  };
}
