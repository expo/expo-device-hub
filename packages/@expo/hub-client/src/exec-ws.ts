/**
 * One-shot requests over the serve-sim middleware's **exec-ws** control socket,
 * mirroring the serve-sim client's `utils/exec.ts` (serve-sim #136).
 *
 * Wire protocol (JSON text frames):
 *   client → {token}                  first frame; must match the exec token
 *   server → {ready:true}             auth accepted
 *   client → {id, action, params}     run one typed simulator action
 *   server → {id, stdout, stderr, exitCode} | {id, error}
 *   client → {id, ui:{…}}             simulator-settings request (in-process)
 *   server → {id, status} | {id, ok} | {id, error}
 *
 * The channel runs a fixed set of host actions (`app.container`,
 * `app.infoPlist`, `appearance.set`, …) rather than shell commands: the preview
 * link is shareable, so no value the page sends ever reaches a shell. Each
 * request here opens its own short-lived socket; the log stream keeps a
 * long-lived one (see `useIosDevice`).
 *
 * The exec token doubles as the session token of a `--require-token` server,
 * so the socket also names it as the `serve-sim.token.<token>` subprotocol
 * (see `./access-token`). The first `{token}` frame is still sent: an older
 * middleware needs it, and a newer one ignores a token frame once it has
 * accepted the subprotocol.
 */

import { openAccessTokenWebSocket } from './access-token';

export interface HostActionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type HostActionParams = Record<string, string | number | boolean | string[] | undefined>;

/** Runs one typed serve-sim host action and resolves its output. */
export type RunHostAction = (action: string, params?: HostActionParams) => Promise<HostActionResult>;

export interface UiRequestPayload {
  device: string;
  option?: string;
  value?: string;
}

/** Reply to a simulator-settings (`ui`) request. */
export interface UiRequestResult {
  /** Present on a read (no `option`): every UI option's current value. */
  status?: Record<string, string>;
  /** Present on a write. */
  ok?: boolean;
}

type ExecReply = { ready?: boolean; id?: number; error?: string } & Partial<HostActionResult> &
  UiRequestResult;

const ACTION_TIMEOUT_MS = 10_000;
const UI_TIMEOUT_MS = 5_000;

/**
 * connect → `{token}` → wait for `{ready}` → `{id: 1, ...body}` → resolve the
 * `{id: 1, …}` reply. Rejects on socket failure, timeout, or an `error` reply.
 */
function execWsRequest(
  execWsUrl: string,
  execToken: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<ExecReply> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = openAccessTokenWebSocket(execWsUrl, execToken);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      run();
    };
    timer = setTimeout(() => finish(() => reject(new Error('exec-ws timeout'))), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ token: execToken }));
    ws.onmessage = (event) => {
      let msg: ExecReply;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.ready) {
        ws.send(JSON.stringify({ id: 1, ...body }));
        return;
      }
      if (msg.id === 1) {
        if (msg.error) finish(() => reject(new Error(msg.error)));
        else finish(() => resolve(msg));
      }
    };
    ws.onerror = () => finish(() => reject(new Error('exec-ws error')));
    ws.onclose = () => finish(() => reject(new Error('exec-ws closed')));
  });
}

/**
 * Run one typed host action. A rejected action (unknown name, invalid params)
 * resolves like a failed process — `exitCode: 1` with the message in `stderr` —
 * matching serve-sim's `runHostAction`; transport failures reject.
 */
export async function runHostAction(
  execWsUrl: string,
  execToken: string,
  action: string,
  params?: HostActionParams,
): Promise<HostActionResult> {
  let reply: ExecReply;
  try {
    reply = await execWsRequest(execWsUrl, execToken, { action, params }, ACTION_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof Error && isActionRejection(err.message)) {
      return { stdout: '', stderr: err.message, exitCode: 1 };
    }
    throw err;
  }
  return {
    stdout: reply.stdout ?? '',
    stderr: reply.stderr ?? '',
    exitCode: reply.exitCode ?? 1,
  };
}

// Transport failures use these exact messages (see execWsRequest); anything
// else came back from the server as an `{id, error}` reply.
function isActionRejection(message: string): boolean {
  return !['exec-ws timeout', 'exec-ws error', 'exec-ws closed'].includes(message);
}

/**
 * Simulator-settings request, handled in-process by the middleware (the
 * underlying `simctl ui` / ax-tool spawn). A read omits `option` and resolves
 * `{status}`; a write sends `{option, value}` and resolves `{ok}`. Rejects with
 * the server's message for invalid requests or failed sets.
 */
export async function hostUiRequest(
  execWsUrl: string,
  execToken: string,
  payload: UiRequestPayload,
): Promise<UiRequestResult> {
  const reply = await execWsRequest(execWsUrl, execToken, { ui: payload }, UI_TIMEOUT_MS);
  const result: UiRequestResult = {};
  if (reply.status !== undefined) result.status = reply.status;
  if (reply.ok !== undefined) result.ok = reply.ok;
  return result;
}
