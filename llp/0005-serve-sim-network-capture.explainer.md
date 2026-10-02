# LLP 0005: Network capture

**Type:** Explainer
**Status:** Active
**Systems:** ServeSim
**Author:** Gabe Debes
**Date:** 2026-09-29
**Revised:** 2026-10-02 (moved into the LLP corpus from `packages/serve-sim/packages/serve-sim/docs/network-capture-security.md`; links and paths updated)
**Related:** LLP 0003

> File paths such as `src/…` are relative to `packages/serve-sim/packages/serve-sim`, unless the text gives a path from the repository root.

Network capture decrypts supported simulator HTTP(S) traffic. Capture is metadata-only by default;
headers, query values, and bodies require explicit opt-in because they can contain credentials.

## How it works

The panel turns capture on for a device without a reboot, and its reboot action turns capture on or
off per device. `--network-capture` defaults capture on for the
devices serve-sim serves, including ones already booted; reconnecting never overrides an explicit
choice. Capture starts after the device finishes booting, so apps that launch during boot are not
captured until they are relaunched.

Enabling capture starts a local mitmproxy, trusts its certificate authority in the simulator, and sets
`DYLD_INSERT_LIBRARIES` in the simulator's launchd. Supported `NSURLSession` configurations in
subsequently launched third-party apps use that proxy. Apple system apps are excluded, and
`URLSession.shared` bypasses capture.

The host's system proxy and keychain are unchanged. Stopping capture clears the launchd injection and
stops the proxy. A running app's new sessions then connect directly; sessions it created while capture
was on keep the stopped proxy and fail until the app is relaunched. Rebooting the simulator also clears
the launchd injection.

serve-sim keeps one capture CA per user, in `~/Library/Application Support/serve-sim/capture-ca/`
(folder mode `0700`, files `0600`; `SERVE_SIM_CAPTURE_CA_DIR` overrides it), and every capture session
uses it, so the simulator trusts one serve-sim root however often capture restarts. The imported CA certificate remains in the simulator keychain after capture stops or
the device reboots; teardown does not remove it. To make a new CA, delete `capture-ca/`; the next
capture start creates one and trusts it, and erasing the simulator removes the old root.

### Upstream proxy

Captured traffic goes direct by default. `--network-capture-proxy http://host:port` forwards it through
one HTTP proxy, including an EAS local-egress proxy supplied by build-tools. `none` explicitly selects
direct traffic. macOS proxy settings, bypass lists, PAC files, and auto-discovery are not read.
All captured destinations use the configured
proxy, so it must also be able to reach any local destinations the app uses.

Basic proxy authentication uses `http://user:password@host:port`. Percent-encode reserved characters
in the username or password. A credential-bearing launch argument is visible in serve-sim's process
arguments and may be saved in shell history. serve-sim removes credentials from the address given to
mitmproxy and writes them to a mode-600 config file in its private session directory. That directory is removed
on shutdown; credentials are not included in capture metadata, panel messages, or HAR files.
Proxy authentication headers are redacted when header capture is enabled. HTTP proxy connections
are unencrypted, so use a trusted network or a loopback tunnel for an authenticated upstream.
SOCKS, HTTPS proxy endpoints, Digest, NTLM, and Negotiate authentication are not supported.

mitmproxy uses absolute-form requests for plain HTTP and CONNECT for HTTPS. An upstream connection
or authentication failure fails the captured request; it does not fall back to direct traffic.
An IP address or localhost proxy on the capture proxy's own port is rejected without a DNS lookup.
Other host names that resolve to the capture proxy and loops through another proxy are not detected.

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
2. Credential words anywhere in the name: `token`, `secret`, `passw`, `credential`, `cookie`, and
   `session`, so joined names such as `X-CSRFToken` and `x-apitoken` are redacted too. `key` and `auth`
   are matched only as delimited words, so `keep-alive` and `:authority` stay readable.
3. Credential prefixes, including `authorization`, `authentication`, `sessionid`, `oidc`, `jwt`,
   `principal`, and `assertion`.
4. Explicit names: `cookie2`, `set-cookie2`, `x-firebase-appcheck`, and `x-amz-content-sha256`.

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
| `capture.har` | A HAR document rebuilt on download and at most once a minute, with entries in request start order |

The event log grows throughout the session. The HAR entry log is periodically compacted to the newest
10,000 entries, and the rebuilt HAR contains those entries. These are entry-count limits, not disk-byte
limits; there is no age-based expiry. Clearing the panel clears the in-memory request list, not the
session's recorded files.

Normal session teardown removes the device's capture directory. A process exit that skips teardown, such
as a failed start or a shutdown that runs past its time limit, also removes it; this includes hosts that
embed the middleware. A later capture start sweeps abandoned
directories while preserving active recordings. A recording's owner is its process ID and that
process's start time, so a crashed recording whose process ID now belongs to another process counts as
abandoned. Files can remain after a crash or forced kill, a failed
final write, or failed cleanup.
`capture har --out <path>` writes a separate recording that is retained after the command stops. Like
the session's, its entry log is compacted to the newest 10,000 entries, so a longer recording keeps
its newest 10,000 requests. It
starts with the completed requests the session already recorded, read as a stream from
`{base}/network-capture.ndjson`, then adds new requests from the live stream. Once it has begun, it
keeps recording when capture goes off and on again (a disable, a reboot with capture, a restart after a
failure) and appends the new session's requests; it stops on Ctrl-C or when the stream closes. Requests
are matched by id and start time, since ids restart at `r1` in each session; a body is fetched with the
start time too, and the server does not return a newer session's body for it. An existing HAR is checked
for `log.entries` by streaming it without keeping its values, and `--events` cannot name the HAR or another recording file. Each
recording also claims its event log, so a second live recording refuses the same `--events`. The
files are named after the HAR, so several recordings can share a folder: for `morning.har`, the event
log is `morning.network-capture.json` and the entry log is `morning.entries.ndjson`. An existing
recording that already holds requests (HAR entries or a non-empty entry log) is not replaced unless
`--force` is passed, so rerunning a stopped `capture har` with the same `--out` cannot lose it. With
`--force`, the recording at `--out` is replaced only once the capture stream shows capture is on
(`capturing`, not `starting`) and the session's earlier requests can be read; a refused connection, a
device with capture off, a start that fails, or a session whose earlier requests cannot be read leaves
it as it was, and so does a stream that closes before capture is on (the command fails). The three
files are each written in full to a temp file and only then renamed into place, so a failed write, such
as on a full disk, leaves all of them intact. The session's earlier requests are downloaded to an owner-only temp file beside the
recording, and the new entry log and HAR are built from it in temp files, before anything at `--out`
changes, so if they stop part way or hold an unreadable entry,
`capture har` fails and leaves the recording as it was, rather than reporting a complete recording. Temp files a killed run left beside the HAR and entry log
are removed when the next run starts.

Capture folders are created readable by their owner only (mode `0700`), and a session folder an
earlier run left is set to `0700` again when capture starts (a `capture har --out` folder is the user's
and is left as it is), and every capture file, including
a `capture har --out` target and its logs, is created with mode `0600` whatever the process umask allows.
A file that already exists, such as a HAR being recorded over, is set to mode `0600` before anything is
written to it. A write that the file accepts only in part continues with the rest. A batch append that
fails part way is cut back to the previous length, so the retry does
not split or duplicate a line. Rewrites go through a temp file with a random name, created exclusively
and renamed into place. On macOS, the default temporary directory is private to the user as well; a
shared temporary directory or `SERVE_SIM_STATE_DIR` override still needs a parent that others cannot
rename or replace.

## Remote and hosted use

Capture HTTP routes require the server's session token and a same-origin check. The preview supplies
the token automatically. Other clients must send `Authorization: Bearer <token>`; capture routes reject
a token in the query string, which could end up in URL logs. Capture responses use
`Cache-Control: no-store, private`.
The HAR, entry-log (`network-capture.ndjson`), and body routes answer only for devices this server
process runs, although the device state directory is shared with other serve-sim servers.

While capture is on, the Activity panel's Network rate comes from the proxy, which cannot tell apps
apart. It then counts every captured app on the device and is labeled "all apps".

Use `--require-token` when exposing the standalone server beyond loopback. Without it, the preview is
public and includes the token used by capture and control routes. So on a non-loopback `--host` without
`--require-token`, serve-sim refuses network capture: it exits for `--network-capture`, and the
preview's capture controls report that capture needs `--require-token`. The middleware applies the same
rule for every host that embeds it: without `requirePreviewToken`, capture is refused unless the host
passes `loopbackOnly` because it listens on loopback only. expo-device-hub passes it from its `--host`,
so it refuses capture on a non-loopback host. Embedded hosts that enable `requirePreviewToken` must
protect access to their preview page.

Capture does not upload artifacts automatically. A hosted deployment's collection of temporary files,
downloads, or process logs has its own access and retention rules.

## Certificate pinning

Apps that reject the capture CA, including apps that pin certificates, can fail HTTPS requests while
using the proxy. Certificate errors appear on the request row, but a TLS failure alone does not prove
pinning. Stop capture and relaunch the app, or reboot without capture, to restore a direct connection.
