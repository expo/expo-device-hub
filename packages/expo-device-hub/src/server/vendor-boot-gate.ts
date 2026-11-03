/**
 * Boot admission for the start routes of the vendored device servers, which
 * boot a device without going through `device-actions.ts`:
 *
 * - serve-sim `POST /grid/api/start` with `{udid}` boots a shut-down simulator
 *   before it streams it.
 * - serve-emu `POST /api/avds/start` with `{avd}` launches an emulator.
 *
 * The Hub admits these requests before it forwards them, so a Hub-mounted
 * server cannot boot past the host policy.
 *
 * @ref LLP 0018#gated-routes — the routes that boot a device, and which are gated
 */

import {
  type AdmissionRequest,
  type BootAdmission,
  defaultBootAdmission,
  isObject,
} from "./boot-admission";

/** Far larger than either server accepts (serve-emu reads at most 8 KiB). */
const MAX_START_BODY_BYTES = 64 * 1024;

export interface VendorStartRoute {
  /** The Hub path of the `POST` route. */
  path: string;
  /**
   * The workload the parsed JSON body would start, or `null` to forward a
   * malformed body and let the server answer it with its own error.
   */
  identify(body: unknown): AdmissionRequest | null;
  /** The status the server answers a failed start with, so a refusal reads like one. */
  refusalStatus: number;
  /** Read the adb serial from a successful response, for the attempt record. */
  readsSerial: boolean;
}

/** serve-sim mounted under `prefix`. */
export const serveSimStartRoute = (prefix: string): VendorStartRoute => ({
  path: `${prefix}/grid/api/start`,
  identify(body) {
    const udid = isObject(body) && typeof body.udid === "string" ? body.udid : "";
    return udid ? { platform: "ios", udid, name: udid } : null;
  },
  refusalStatus: 500,
  readsSerial: false,
});

/** serve-emu mounted under `prefix`. */
export const serveEmuStartRoute = (prefix: string): VendorStartRoute => ({
  path: `${prefix}/api/avds/start`,
  identify(body) {
    const avd = isObject(body) && typeof body.avd === "string" ? body.avd.trim() : "";
    return avd ? { platform: "android", avdName: avd, serial: null, name: avd } : null;
  },
  refusalStatus: 400,
  readsSerial: true,
});

/**
 * Admit a request to `route`, then forward it; any other request is forwarded
 * untouched. Without a host policy the start request is forwarded untouched
 * too, its body unread. With one, the body is read once
 * and the server gets a request rebuilt with the same bytes; a refusal is
 * answered here in the server's `{ok: false, error}` shape and never reaches
 * the server. The attempt is finished once the server answers, so the
 * device's native state decides when its slot is free.
 */
export async function admitVendorStart<R extends Response | null>(
  request: Request,
  route: VendorStartRoute,
  forward: (request: Request) => Promise<R>,
  admission: BootAdmission = defaultBootAdmission,
): Promise<R | Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== route.path) {
    return forward(request);
  }
  if (!(await admission.constrained())) return forward(request);

  const body = await readBoundedBody(request);
  if (body === null) {
    return Response.json({ ok: false, error: "Request body is too large" }, { status: 413 });
  }
  const rebuilt = new Request(request, { body });
  const target = route.identify(parseJson(body));
  if (!target) return forward(rebuilt);

  const admitted = await admission.admit(target);
  if (!admitted.ok) {
    return Response.json({ ok: false, error: admitted.error }, { status: route.refusalStatus });
  }
  try {
    const response = await forward(rebuilt);
    if (route.readsSerial && response?.ok) {
      const serial = await readSerial(response);
      if (serial) await admitted.ticket.reserveSerial(serial);
    }
    return response;
  } finally {
    await admitted.ticket.finish();
  }
}

async function readBoundedBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_START_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

async function readSerial(response: Response): Promise<string | null> {
  try {
    const data: unknown = await response.clone().json();
    return isObject(data) && typeof data.serial === "string" ? data.serial : null;
  } catch {
    return null;
  }
}
