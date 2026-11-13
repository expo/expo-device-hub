---
"@expo/serve-sim": minor
---

The simulated camera is a device-wide feed. `serve-sim camera enable` connects it for every app, including apps opened outside serve-sim, and `serve-sim camera disable` disconnects it without restarting apps or changing camera permissions. Apps see the camera connect and disconnect the way a device sees camera hardware. Photos from the fake camera now reach the app's `AVCapturePhotoCaptureDelegate`, and a capture while the camera is disconnected fails with `AVErrorDeviceWasDisconnected`. Disabling the last capability with no serve-sim session running removes the capability loader.

Camera discovery honors requested device types. Requests that exclude wide-angle cameras receive only native matches and may return no devices.
