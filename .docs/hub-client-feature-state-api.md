# Hub client feature-state API

Status: implemented. This is a breaking change to `@expo/hub-client`'s existing hooks.

The public contract is in [`types.ts`](../packages/@expo/hub-client/src/types.ts). The
[README](../packages/@expo/hub-client/README.md) contains usage, state transitions, and the
1.x migration table. Shared inspector components in `@expo/hub-components` and the
`expo-device-hub` dashboard use the new contract.

## Decisions from review

- Keep `resolving` and `loading` separate. The former discovers configuration and support;
  the latter reads feature data or establishes a subscription. A UI may use one loader for both.
- Group data and actions by feature. Every feature has `status`, `data`, `error`, `refresh`.
  Named feature types extend `Feature<D>`; there is no second generic parameter for actions.
- Keep seven states: resolving, unsupported, idle, loading, ready, reconnecting, error.
- Keep prior data during refresh or failure of the same resource. Changing device or app
  invalidates affected data, pending writes, and late responses.
- Subscription intent is `enabled`, independent of status. Logs, events, activity, and
  telemetry are opt-in. Attach/detach are idempotent, not reference-counted, and have one owner
  per client feature.
- Keep reads and writes independent: write errors do not turn an otherwise readable feature
  into a failed read. Writes return `HubResult`; overlapping operations report `busy`.
- Location stores its nullable fix directly in `data`, without a redundant `fix` wrapper.
- Use explicit operation outcomes. Empty arrays and null foreground-app/location values can
  be successful data. No first video frame is required for settings to become ready.
- Optimism depends on the operation. Simple settings are optimistic; capture changes wait
  for replacement video before their write promise settles.

## Expected transitions

| Scenario | Transition |
| --- | --- |
| Automatic initial read | resolving → loading → ready |
| Unsupported in configuration | resolving → unsupported |
| Unsupported discovered by a read | resolving → loading → unsupported |
| On-demand read | resolving → idle → loading → ready |
| Open an opt-in stream | resolving → idle → loading → ready |
| Attach during discovery | resolving → loading → ready |
| Detach | ready/reconnecting/error → idle, retaining data |
| Refresh current data | ready → loading → ready, retaining data |
| Automatic recovery | loading/ready → reconnecting → ready |
| Retry exhaustion | reconnecting → error |
| Authentication failure during discovery | resolving → error |
| Retry discovery after fixing the cause | error → resolving → loading → ready |
| Switch device | any state → resolving, clearing old target data |
| Switch foreground app | permissions → loading, clearing old app data |

`unsupported` requires known absence, not a transient failure. Polls and subscription
retries stop after three consecutive reported failures or immediately for a non-retryable
error; explicit refresh starts another attempt. Discovery and the Android `/api` poll are
the exception: they have no other recovery path, so they keep retrying (with backoff for
iOS discovery) and show non-retryable errors such as auth as `error` until a retry
succeeds. Each feature's refresh restarts only the transport that serves it; iOS logs,
events, and activity share one exec-ws socket and restart together. Error codes come from
the HTTP status or the error type, not from message text. Transport-specific video recovery
retains its existing fallback and reconnect policies.

## Verification

Lifecycle tests exercise the public Android hook through discovery, initial reads, refresh,
read failure, target changes, write overlap, and empty log subscriptions. Permissions tests
cover late responses from an old foreground app. Existing transport tests cover replacement
video, timeout recovery, and controls during encoder/source changes. UI tests render migrated
inspector components with feature states.
