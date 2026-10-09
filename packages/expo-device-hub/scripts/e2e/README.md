# Device Hub client UI E2E

This suite mounts the existing `src/Dashboard.tsx`, its shared UI components and
the built `@expo/hub-client`. It uses real browser WebRTC/WebSockets, real
serve-sim, and the existing native `ServeSimLaunchFixture` to prove input reaches
UIKit. The fixture serves one pinned device through Hub's discovery protocol;
vendored serve-sim URLs use the production client URL adapter.
The native fixture records software-keyboard appearance so shifted typing waits
for UIKit readiness as well as WebSocket admission.

It covers advancing H264 video, native keyboard/shifted characters, refused and
delayed admission recovery, gesture cancellation on blur, pooled native controls
and subscription reconnects after both a close and a silent OPEN connection, and
video/input recovery after a backend restart. The blur assertion has a negative
regression test that injects stale movement during the native end wait.

## Run

Install dependencies and build the client/UI packages:

```sh
bun install --frozen-lockfile
bun run --filter '@expo/hub-client' build
bun run --filter '@expo/hub-components' build
```

Build serve-sim and its existing native fixture on macOS with Xcode:

```sh
cd packages/serve-sim/packages/serve-sim
bun run build.ts
bash Sources/ServeSimLaunchFixture/build.sh
```

From the repository root, point the suite at a dedicated Simulator you created
and booted for this run:

```sh
HUB_E2E_UDID=<owned-booted-udid> bun run --filter expo-device-hub test:e2e:client
```

The default runner opens isolated headless Chrome. Set `HUB_E2E_BROWSER` to its
executable when it is not at the default macOS path. To use the collaborative
browser instead, run with `--interactive` and open the printed URL. The same
browser scenarios run automatically; there are no manual assertion steps.

```sh
cd packages/expo-device-hub
HUB_E2E_UDID=<owned-booted-udid> bun run test:e2e:client --interactive
```

Missing device, native build or browser prerequisites fail the run. This is an
explicit macOS/native lane; ordinary `bun test` does not run or silently skip it.
The runner uses free loopback ports, a private serve-sim state directory and an
isolated browser profile. It stops only its own server/browser and leaves the
caller-owned Simulator booted.

The printed evidence directory retains `verification.json`, `native-fixture.tsv`,
`wire.json`, `backend.log` and the dashboard bundle. Headless runs also save
`dashboard.png`; collaborative runs can record the same UI using the preview.
Subscription recovery requires fresh native sample timestamps to reach all three rendered Activity charts; upstream traffic alone cannot pass. Negative harness tests reject unavailable, stale and paused charts and samples from the retired connection.

Wire evidence omits tokens and typed text; native fixture text is test input only.

Check the harness with:

```sh
cd packages/expo-device-hub
bun run typecheck:e2e:client
../@expo/hub-client/node_modules/.bin/oxlint scripts/e2e
../@expo/hub-client/node_modules/.bin/oxfmt --check scripts/e2e
```

## Boundaries

The entry mounts the production dashboard with Bun and the same Tailwind plugin;
it does not exercise Expo's exported shell or Hub's real host discovery server.
DOM keyboard/pointer events are dispatched through production React handlers.
Shifted typing includes Shift down/up, matching the desktop event sequence;
OS focus/trusted-event delivery needs separate browser interaction coverage.
The pause/resume case dispatches `visibilitychange` while the page stays visible;
it proves the visibility handler resumes the same peer, not a real background cycle.
The proxy deliberately faults input/control connections. It does not replace
WebRTC, fabricate decoded frames, or stub native input results.

Full token-gated session replacement, decoder stalls with continuing RTP,
Safari/iPad and Android remain separate acceptance work. A complete middleware
restart can change its authentication identity; the restart case currently proves
video/input recovery, while subscription recovery is checked on a dropped control
connection and a silent OPEN channel with the same middleware identity.
