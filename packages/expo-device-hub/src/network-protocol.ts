/**
 * Messages on the Network panel socket (`/api/network/ws`), shared by the Hub server and the
 * dashboard. The server watches the app's network traffic through the React Native inspector in
 * the Metro server the Hub runs in, and streams it per device.
 */

/** One request the app made, in the shape the panel renders. Header values are redacted. */
export interface NetworkRequest {
  /** The inspector's request id, unique within one inspector connection. */
  id: string;
  method: string;
  url: string;
  /** Epoch ms when the app started the request. */
  startedAt: number;
  /** Epoch ms when the response finished or the request failed. */
  finishedAt?: number;
  status?: number;
  statusText?: string;
  mimeType?: string;
  /** CDP resource type, for example `Fetch` or `XHR`. */
  resourceType?: string;
  /** Bytes received, as the inspector reports them. */
  encodedDataLength?: number;
  /** The failure text when the request did not complete. */
  failed?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  /** The request body as the app sent it, when it was text. */
  requestBody?: string;
}

/** A response body the panel asked for. */
export interface NetworkResponseBody {
  body: string;
  /** The body is base64, because it was not text. */
  base64Encoded: boolean;
}

/**
 * Where the panel is in finding the app.
 *
 * - `searching`: no app on this device is connected to the Metro server yet.
 * - `attached`: the Hub follows the app's requests.
 * - `unavailable`: the Hub cannot read a Metro server, so there is nothing to attach to.
 */
export type NetworkInspectorState = "searching" | "attached" | "unavailable";

export interface NetworkInspectorStatus {
  state: NetworkInspectorState;
  /** The app the Hub follows, while `attached`. */
  app?: { id: string; deviceName: string };
  /** Why the state is `unavailable` or `searching`, for the panel to show. */
  message?: string;
}

export type NetworkServerMessage =
  | { type: "status"; status: NetworkInspectorStatus }
  | { type: "snapshot"; requests: NetworkRequest[] }
  | { type: "request"; request: NetworkRequest }
  | { type: "cleared" }
  | { type: "response-body"; id: string; body: NetworkResponseBody | null; error?: string };

export type NetworkClientMessage = { type: "clear" } | { type: "get-response-body"; id: string };

/** The most requests the Hub keeps for one device; older ones are dropped first. */
export const NETWORK_MAX_REQUESTS = 500;
