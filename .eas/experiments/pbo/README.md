# Temporary PBO comparison

Run `.eas/workflows/emulator-capture-pbo.yml` manually with EAS CLI. It has no push
or PR trigger. Each device gets its own VM and runs normal readback twice then
PBO readback on the same emulator boot, first with lavapipe, then with SwiftShader.
The two cases are a 1280-pixel stream alone and that stream plus a native recording.

The workflow builds the checked-out agent, runs its native/JS tests, samples guest
requestAnimationFrame counts and host CPU, and decodes the captured H.264 to count
changed, repeated, skipped, torn and unknown-color frames. Artifacts include logs,
CSV arrival/PTS data, analysis JSON and sample video. FPS is a measurement, not a
pass threshold. Missing, undecodable, torn or unknown-color captures fail the summary.
The arrival metric starts at the agent timestamp; it is not end-to-end display latency.

The scripts derive from the earlier Linux timing harness used in LLP 0023. They
start and stop their own emulators on isolated EAS VMs. The performance foldable job tests its
booted display. The separate `fold-transitions` job folds and unfolds during a
PBO stream and fixed-canvas recording, checks changed stream sizes and recording
placements, and decodes the recording.
