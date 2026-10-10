# LLP 0010: serve-sim clipboard

**Type:** Explainer
**Status:** Draft
**Systems:** ServeSim
**Author:** Gabe Debes
**Date:** 2026-10-06
**Related:** LLP 0003, LLP 0007

> File paths such as `src/…` are relative to `packages/serve-sim/packages/serve-sim`, unless the text gives a path from the repository root.

## Summary

serve-sim moves text between the browser clipboard and the simulator pasteboard. This document explains how serve-sim reads and writes the simulator pasteboard, and why it works that way.

A first implementation was rolled back because it did not work as planned on the VM. This design is the second attempt, and it is kept as simple as possible [confirmed: Gabe Debes, 2026-09-30].

## Reading and writing the simulator pasteboard

`POST /api/pasteboard` reads the simulator pasteboard as text. `PUT /api/pasteboard` with `{"text": "…"}` writes it. [LLP 0003](0003-serve-sim-http-api.spec.md#pasteboard) lists the route.

- **Reads use `simctl pbpaste`.** This needs no code inside the simulator [observed: `src/sim-pasteboard.ts`].
- **Writes use a small tool that runs inside the simulator,** `Sources/SimPasteboard`, started with `simctl spawn`. Unlike `simctl pbcopy`, it works without a GUI login session, which headless workers such as EAS do not have [observed: `Sources/SimPasteboard/sim-pasteboard.m`].
- **One lock per simulator** serializes writes, so two writes cannot interleave. A plain read does not take the lock [observed: `withSimPasteboardLock` and `readSimPasteboardResult` in `src/sim-pasteboard.ts`].
- **Text is limited to 4 MiB** in both directions. Larger text returns a JSON 413 [observed: `src/middleware.ts`, and the read limit in `readPasteboardText` in `src/sim-pasteboard.ts`]. A `PUT` body can be up to 8 MiB, because JSON escaping can double the text. The route answers a larger body with the same JSON 413 [observed: `src/middleware.ts`]. The standalone server refuses a body over 8 MiB before the route runs, with the plain-text 413 that it sends for every route [observed: `servePreview` in `src/runtime.ts`].

## Who may use the pasteboard API

The pasteboard holds user data, so the route needs the preview token and a browser Origin. The Origin must be the preview's own origin (the request's `Host`) or an origin that the CORS policy allows: loopback or a `--cors-origin`. A request without an Origin is refused, because browsers send one on every `POST` and `PUT` [observed: `isAllowedOrigin` in `src/middleware-utils.ts`].

The same-Host rule lets a hosted preview use its own clipboard without an extra flag [confirmed: Gabe Debes, 2026-09-27]. A client that is not a browser can set any `Host` and `Origin`, so for that client the token is the real boundary.

Responses carry `Cache-Control: no-store`, so a proxy does not keep clipboard text [observed: `src/middleware.ts`].
