# LLP 0025: Session events record every device interaction

**Type:** Spec
**Status:** Draft
**Systems:** ServeEmu, ServeSim, HubClient, Hub
**Author:** Claude Code (Claude Opus 5.5), directed by Krystof Woldrich
**Date:** 2026-11-13
**Related:** LLP 0000, LLP 0013

> File paths such as `src/…` are relative to `packages/serve-emu/packages/serve-emu`, unless the text gives a path from the repository root.

## Summary

Every user or API interaction that changes or captures a device adds an entry to that device's session events. On Android, the session events are serve-emu's session recording (`GET /api/session`). On iOS, they are serve-sim's event log (`GET /api/event-log`). A read, such as a poll, adds no entry.

serve-emu records input as before. It now also records input sent with `record: false`, such as the Hub's Reload button, and device actions such as screenshots, rotation, device settings, and app actions. Replay sends only input that was recorded for replay, so these new entries do not change what a replay does.

> **Provenance.** Krystof Woldrich asked for this change and for the rule in [Rule](#rule) [confirmed] (Krystof Woldrich, 2026-11-13, in the task for this change). The design choices below are Claude Code's, and human review is pending.

## Rule

<a id="rule"></a>**Every user or API interaction with a device must be recorded in that device's session events.** This applies to each new route, WebSocket message, and Hub control that changes or captures a device, on Android and on iOS. A read adds no entry, because the Hub and EAS poll the servers, and a poll is not activity.

Why: an EAS device session stops after its idle time. eas-cli reads activity from these events: a new newest entry (its `id` and `at`), a new `replayStartedAt`, or `replaying: true` [observed: `readExpoDeviceHubInputLogAsync` in expo/eas-cli#4890, open on 2026-11-13]. An interaction that is not in the events does not count as activity, so the session can stop while a person uses it. The Hub's Events panel also shows these entries [observed: `mapAndroidSessionEvent` in `packages/@expo/hub-client/src/android-events.ts`].

## Entries

<a id="entries"></a>A serve-emu entry has `id`, `at`, `delayMs`, `source`, and `kind`:

| `kind`     | Content                                           | Replayed                           |
| ---------- | ------------------------------------------------- | ---------------------------------- |
| `gesture`  | `gesture`: tap, swipe, touch, text, key, button   | Yes, unless it has `replay: false` |
| `location` | `location`: a geo fix                             | Yes                                |
| `action`   | `action`: a device action, always `replay: false` | No                                 |

`replay` is present, and `false`, only on an entry that replay skips. A replayable entry keeps the shape it had before this change, so older readers see no difference [observed: `#record` in `src/session-recorder.ts`].

An `action` has a `type` and flat fields:

| Route                                                                                                                           | `action`                                                              |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `POST /api/screenshot`                                                                                                          | `{ type: "screenshot" }`                                              |
| `POST /api/orientation`                                                                                                         | `{ type: "orientation", orientation }`                                |
| `POST /api/fold`                                                                                                                | `{ type: "fold", posture }` or `{ type: "fold", hingeAngle }`         |
| `POST /api/uimode`, `POST /api/night-mode`                                                                                      | `{ type: "setting", setting: "night-mode", value }`                   |
| `POST /api/font-scale`, `display-density`, `network`, `reduce-motion`, `high-text-contrast`, `font-weight`, `software-keyboard` | `{ type: "setting", setting, value }`                                 |
| `POST /api/apps/install`                                                                                                        | `{ type: "app", action: "install" }`                                  |
| `POST /api/apps/launch`, `clear`, `force-stop`, `reset-permissions`                                                             | `{ type: "app", action, packageName }`                                |
| `POST /api/apps/grant`, `revoke`                                                                                                | `{ type: "app", action, packageName, permission }`                    |
| `POST /api/files/import`                                                                                                        | `{ type: "file-import" }`                                             |
| `POST /api/route`, `DELETE /api/route`, `POST /api/route/control`                                                               | `{ type: "route", action: "start" \| "stop" \| "pause" \| "resume" }` |
| `POST /api/camera/image`, `DELETE /api/camera/image`                                                                            | `{ type: "camera", action: "set-image" \| "clear-image", facing }`    |

The `source` of an action is `rest:` and the route path after `/api/`, for example `rest:orientation`. An action copies only validated values from the request. It does not copy an APK, an imported file, or a route's points, because these bodies can be large. A reader must accept an unknown `type`; `parseSessionSnapshot` in `src/shared/api-contracts.ts` does.

## `record: false`

<a id="record-false"></a>Before this change, an input with `record: false` added no entry [observed: `shouldRecord` in `src/middleware.ts` and `src/server.ts`]. The Hub's Reload button sends the `R` key that way [observed: `reload` in `packages/@expo/hub-client/src/useAndroidDevice.ts`]. The reason was not written down. A replayed Reload would restart the app in the middle of the replay, so the likely reason is to keep it out of replay [inferred].

Now `record: false` means "do not replay". The input adds a `gesture` entry with `replay: false`. Inside serve-emu, `SessionRecordMode` names the three cases: `replay` (the default), `activity` (`record: false`), and `none`. Replay sends its own input with `none`, so a replay does not record itself [observed: `replayTouchInput` in `src/client-touch-state.ts`]. A touch whose parts use different modes releases with the mode that records the most, as the boolean did before.

## Replay

<a id="replay"></a>Replay sends the `gesture` and `location` entries that do not have `replay: false`, in order [observed: `replayPlan` in `src/session-recorder.ts`]:

- The delay of a skipped entry moves to the next replayed entry, so the time between replayed inputs stays as recorded.
- Skipped entries before the first replayed entry, or after the last one, add no wait. The first replayed entry keeps its own delay, as before.
- A session that has only skipped entries cannot replay. `POST /api/session/replay` answers `400` with `session has no replayable events`.
- While a replay runs, the recorder records nothing, as before. `replaying` and `replayStartedAt` already show the replay as activity.

Actions are not replayed, for these reasons:

- A screenshot during an EAS session writes an artifact [observed: `src/screenshot-artifacts.ts`]. A replayed screenshot would add artifacts that nobody asked for.
- `apps/install` and `files/import` need the uploaded file, which the entry does not keep. `apps/clear` deletes app data.
- Replay sent only input before this change. Keeping that scope keeps the behavior of existing replays.

## Where entries are recorded

<a id="recording"></a>Each handler records its own entry right after the device call succeeds, with the values it already validated, so a request that fails adds no entry [observed: `src/middleware.ts`, `src/server.ts`]. Input records in `enqueueGesture` and `applyLocation`. A device action calls `recordAction(action, source)` on the device's recorder. The app routes build their entry with `appSessionAction` in `src/session-recorder.ts`, and the upload routes record after the upload succeeds. `handleCameraRequest` in `src/camera.ts`, which both servers share, records through its `recordAction` hook. The router records a camera change only when the device already has an app, because the device has no session events before that.

serve-emu has two copies of each route: `src/middleware.ts`, which the Hub mounts, and `src/server.ts`, the standalone server. A new route that changes or captures the device must record in both. `tests/middleware-session-events.test.ts` sends every action route to both servers against a fake `adb` and checks that each one adds its entry. Add a row to `ACTION_CASES` for each new route.

An earlier draft of this change recorded actions from one table of routes, applied after each response. Krystof Woldrich chose calls in each handler instead [confirmed] (Krystof Woldrich, 2026-11-13).

These interactions add no entry:

| Interaction                                                                                                                    | Reason                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `POST /api/devices/select`, `/api/avds/start`, `/api/avds/stop`; the Hub's `/api/devices/boot`, `shutdown`, `remove`, `create` | They act on the device fleet, not on one device's session.                                |
| `PUT /api/stream-mode`, `PATCH /api/stream-settings`, `/webrtc/offer`, `/webrtc/close`, the WebSocket `reset-video` message    | They change how viewers receive the stream. A viewer sends some of them without a person. |
| `DELETE /api/session`, `POST /api/session/replay`, `POST /api/session/replay/stop`                                             | They act on the recording itself. Replay state shows a replay.                            |
| `GET` routes and the logcat and metrics streams                                                                                | They are reads.                                                                           |

## Paging

<a id="paging"></a>`GET /api/session` returns one of two bodies [observed: `src/middleware.ts`, `src/server.ts`]:

- **Snapshot**: `events` (all retained events) and the replay state at the top level: `recording`, `replaying`, `replayStatus`, `replayStartedAt`, `replayCompletedAt`, `replayCancelledAt`, `lastError`.
- **Page**: the newest `limit` events before the exclusive `before` cursor, the same top-level replay state, `session` (the summary, which repeats the replay state), `nextBefore`, and `hasMore`. `limit` is 50 by default and at most 200 [observed: `src/session-api.ts`].

The middleware, which the Hub mounts at `/vendor/serve-emu`, returns the snapshot when the request has neither `limit` nor `before`. Another parameter, such as `device`, does not ask for a page. The Hub client polls without them and reads the whole snapshot, so its response stays the same [observed: `useAndroidDevice.ts` in `packages/@expo/hub-client/src`]. With `limit` or `before`, the middleware returns a page. The standalone server always returns a page, as before.

A page carries the replay state at both levels, so a reader of the snapshot and a reader of the page both work. eas-cli reads `session` when it is present and the top level when it is not, and polls `?limit=1` every 5 seconds [observed: `readExpoDeviceHubInputLogAsync` and `POLL_INTERVAL_MS` in expo/eas-cli#4890]. Before this change, the middleware ignored `limit`, so that response held the whole recording, up to 1 MiB, on every poll [observed: `src/middleware.ts` on `main`, 2026-11-13]. An invalid `limit` or `before` now answers `400` on the middleware.

## Open questions

- Should replay apply rotation, fold, and device settings? Gestures recorded in landscape are replayed in the current orientation [inferred].
- serve-sim's event log was not checked against [the rule](#rule) in this change.
- A running route moves the location without input, so it does not count as activity after its start entry.
- The Hub client could poll pages instead of the whole snapshot. Its clear watermark reads the whole snapshot today.
