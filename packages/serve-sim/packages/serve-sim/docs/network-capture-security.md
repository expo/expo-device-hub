# Network capture

Network capture decrypts supported simulator HTTP(S) traffic. Capture is metadata-only by default;
headers, query values, and bodies require explicit opt-in because they can contain credentials.

## How it works

The UI reboot action turns capture on or off per device. `--network-capture` only defaults capture on
for devices serve-sim boots; reconnecting never overrides an explicit choice. Capture starts after the
device finishes booting, so apps that launch during boot are not captured until they are relaunched.

Enabling capture starts a local mitmproxy, trusts its certificate authority in the simulator, and sets
`DYLD_INSERT_LIBRARIES` in the simulator's launchd. Supported `NSURLSession` configurations in
subsequently launched third-party apps use that proxy. Apple system apps are excluded, and
`URLSession.shared` bypasses capture.

The host's system proxy and keychain are unchanged. Stopping capture clears the launchd injection and
stops the proxy; apps already using it need relaunching. Rebooting the simulator also clears the launchd
injection. The imported CA certificate remains in the simulator keychain after capture stops or the
device reboots; teardown does not remove it.

## What is recorded

Capture includes exchanges from supported sessions in other third-party apps on the device, not just
the app currently displayed. It is not a complete record of device traffic.

Metadata includes method, URL, status, MIME type, byte counts, time to first byte, duration, and failure
reason. URL query values are redacted unless `query` is enabled.

Use `--network-capture-field` to opt into additional fields:

| Field | Contents |
| --- | --- |
| `header` | Request and response headers, with values redacted for credential-bearing names |
| `query` | Query-string values |
| `request-body` | Request bodies, without redaction |
| `response-body` | Response bodies, without redaction |

For example:

```bash
serve-sim <udid> --network-capture --network-capture-field header,request-body
```

Each body preview is capped at 512 KiB. The in-memory store retains at most 500 requests and allows
16 MiB for stored headers and bodies. Full transfer sizes are recorded even when previews are truncated
or omitted. The session HAR records a request when its response arrives, so a request that is still in
flight when 500 newer requests have started leaves the store first and is not recorded.

Request and response bodies sent with `gzip`, `deflate`, or `br` content-encoding are decoded, and
decoding stops at the 512 KiB cap, so a small compressed body cannot expand without limit. `br` uses
the brotli module that ships with mitmproxy. A compressed body that ends early, or that carries data
after its first gzip member, is marked truncated. Other encodings, stacked encodings such as
`gzip, br`, and bodies that fail to decode keep their wire bytes, which appear as base64 when they are
not UTF-8 text.

## Redaction and its limits

Header values are replaced with `[REDACTED]` when their names match one of the rules in
`src/capture/redact.ts`:

1. Delimited credential words, including `auth`, `token`, `secret`, `password`, `session`, `cookie`, and
   `key`. This also redacts non-secret headers such as `Idempotency-Key` and `Sec-WebSocket-Key`.
2. Credential prefixes, including `authorization`, `authentication`, `sessionid`, `oidc`, `jwt`,
   `principal`, and `assertion`.
3. Explicit names: `cookie2`, `set-cookie2`, `x-firebase-appcheck`, and `x-amz-content-sha256`.

When headers are enabled, raw header values pass through the proxy's private reporting queue and
token-protected loopback control channel. The control server redacts them before adding them to the
store, preview stream, panel, or artifacts. Query-value redaction happens in the proxy addon.

- Bodies are not redacted. A captured login or OAuth body can contain passwords, codes, and tokens.
- Header redaction checks names, not values. A credential in an unusual header such as `x-acme-blob`
  survives.
- Query parameter names are retained, even if a name itself contains sensitive data. Bare query tokens
  without `=` are redacted when `query` is disabled. URL paths are retained and can also contain secrets.
- Traffic that bypasses the configured proxy is not captured.

Use test accounts or a staging environment when capturing sensitive workflows.

## Files and retention

Each captured device writes to `$TMPDIR/serve-sim/capture-<udid>/`, or beneath `SERVE_SIM_STATE_DIR` when
that override is set:

| File | Contents |
| --- | --- |
| `network-capture.json` | Newline-delimited session and capture events, including started, finished, metadata, and clear events |
| `capture.entries.ndjson` | One HAR entry per completed exchange |
| `capture.har` | A HAR document rebuilt periodically and before download |

The event log grows throughout the session. The HAR entry log is periodically compacted to the newest
10,000 entries, and the rebuilt HAR contains those entries. These are entry-count limits, not disk-byte
limits; there is no age-based expiry. Clearing the panel clears the in-memory request list, not the
session's recorded files.

Normal session teardown removes the device's capture directory. A process exit that skips teardown, such
as a failed start or a shutdown that runs past its time limit, also removes it; this includes hosts that
embed the middleware. A later capture start sweeps abandoned
directories while preserving active recordings. Files can remain after a crash or forced kill, a failed
final write, or failed cleanup.
`capture har --out <path>` writes a separate recording that is retained after the command stops. It
starts with the completed requests the session already recorded, read as a stream from
`{base}/network-capture.ndjson`, then adds new requests from the live stream. The
files are named after the HAR, so several recordings can share a folder: for `morning.har`, the event
log is `morning.network-capture.json` and the entry log is `morning.entries.ndjson`.

On macOS, the default temporary directory is private to the user. Artifact code relies on its containing
directory's permissions; a shared temporary directory or `SERVE_SIM_STATE_DIR` override needs equivalent
protection.

## Remote and hosted use

Capture HTTP routes require the server's session token and a same-origin check. The preview supplies
the token automatically. Other clients can use `Authorization: Bearer <token>`; query tokens are also
accepted but can appear in URL logs. Capture responses use `Cache-Control: no-store, private`.
The HAR, entry-log (`network-capture.ndjson`), and body routes answer only for devices this server
process runs, although the device state directory is shared with other serve-sim servers.

While capture is on, the Activity panel's Network rate comes from the proxy, which cannot tell apps
apart. It then counts every captured app on the device and is labeled "all apps".

Use `--require-token` when exposing the standalone server beyond loopback. Without it, the preview is
public and includes the token used by capture and control routes. Embedded hosts can enable the broader
gate with `requirePreviewToken` and must protect access to their preview page.

Capture does not upload artifacts automatically. A hosted deployment's collection of temporary files,
downloads, or process logs has its own access and retention rules.

## Certificate pinning

Apps that reject the capture CA, including apps that pin certificates, can fail HTTPS requests while
using the proxy. Certificate errors appear on the request row, but a TLS failure alone does not prove
pinning. Stop capture and relaunch the app, or reboot without capture, to restore a direct connection.
