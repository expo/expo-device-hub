---
"@expo/hub-client": major
"expo-device-hub": minor
---

Group device-client data and actions into features with explicit discovery, loading, readiness,
and failure states. Add typed write results, per-key write errors, retained data during refresh,
and opt-in activity subscriptions. Migrate the shared inspector and dashboard to the new API.
`useDeviceScreenClient()` keeps its flat `screen`, `status`, and `error`; `status` now uses the
feature states, so `ready` replaces `streaming`. An iOS `DeviceClientProvider` with a relative
`baseUrl` no longer fails to render. Replace `inputError` with an `input` feature: its status and
error describe the input channel, and `data.rejected` reports a refused command (Android) until
the next input. Remove the `ConnectionStatus`, `DeviceCapabilities`, and `DeviceAppearance` types.
