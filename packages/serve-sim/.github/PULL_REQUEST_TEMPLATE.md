## What

<!-- One behavior change. Under roughly 400 changed lines. Split anything larger into a stack. -->

## Why

## Evidence

<!-- Match the evidence to the change. "Builds and typechecks" is not evidence. -->

Check every line. Where a line does not apply, write `n/a` and why after it.

- [ ] `bun run check` is green.
- [ ] `bun run build` then `bun run test` is green.
- [ ] Simulator-backed tests for the touched area ran on a simulator you booted: `SERVE_SIM_TEST_UDID=<udid> bun run test:e2e -- <paths>`. Tests, UDID, device, Xcode:
- [ ] Change under `Sources/StreamingPolicy`: `swift test --filter StreamingPolicyTests` in `packages/serve-sim` is green.
- [ ] The failing test came first. Commit:
- [ ] Evidence for this change type is below. UI: screenshot or video. CLI or native: the command and its output. Docs only: say so.

```
paste the command and its output here
```

## Rollback

<!-- "Plain revert", or what a reverter must know: a state file format, a new flag, a schema. -->
