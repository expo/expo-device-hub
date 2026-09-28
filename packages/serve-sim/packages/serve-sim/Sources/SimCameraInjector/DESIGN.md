# Device-wide camera lifecycle

The camera has `allApps` scope. One selected source feeds every eligible app
carrying the serve-sim capability loader. There is no foreground-app target.

Enable starts or updates the host helper and publishes the camera capability.
The capability loader loads the injector on the app's main queue. The injector installs
its methods once and monitors the helper every 200 ms on the main queue.

Disable stops the helper and removes the capability record. Loaded injectors
mark their devices disconnected, release shared-memory mappings and IOSurfaces,
clear cached frames and preview contents, and post
`AVCaptureDeviceWasDisconnectedNotification`. New camera queries stop returning
fake devices. Existing discovery-session getters reflect current availability.
Enable reconnects loaded injectors to the new helper and posts the matching
connected notification. No dylib unloading or method swapping is needed.

The version 3 control header preserves its 64-byte size and adds an atomic
active byte and helper process ID. The helper clears active before exiting; the
injector also checks process liveness to detect an unexpected helper exit.
Shared source access is serialized against teardown. A connection generation
prevents queued frames from an earlier connection reaching an output or preview.

Camera controls never call simulator privacy grant/reset, terminate, or launch.
The real permission APIs remain unchanged, including denied/not-determined
states. Apps that check authorization before opening the camera still need
camera permission. Grant it through the app’s permission prompt or the preview’s
Permissions control; enabling the feed does not grant it. The injector can
deliver frames without authorization, so receiving frames alone does not verify
that permission was granted.

An app started before the serve-sim session cannot acquire the capability loader in
place. An app that ignores AVFoundation device-change notifications may need to
reopen its camera UI. Neither limitation justifies an automatic restart.

The device tests exercise two running apps through repeated red/blue/red image
cycles, unchanged launch records and SpringBoard PID, real permission values,
disconnected discovery, and cessation of sample delivery. Tests pin their
simulator explicitly and remove the device-wide insert in teardown.

## Browser frames

The preview captures video with getUserMedia and sends bounded JPEG frames over
the authenticated control WebSocket. The host forwards them to the camera helper
through a length-prefixed socket stream. Congested frames are dropped.

Enable or a source switch claims the feed for that browser connection. Frames
from older viewers cannot reclaim it, and those viewers stop their local capture.
Cleanup releases only its own claim; an explicit Disable disconnects the feed
for everyone.

The stream source is disconnected until its first valid frame. Closing or timing
out the frame channel disconnects the device; the next valid stream reconnects
it. Source generations prevent an old browser channel from publishing into a
new source or disconnecting its replacement. Browser capture cancellation stops
tracks, including a permission request that completes after cancellation.

The browser needs HTTPS or localhost and the user's normal camera permission.
Simulator camera permission APIs remain unchanged.
