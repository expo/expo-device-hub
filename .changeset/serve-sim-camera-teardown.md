---
"@expo/serve-sim": patch
---

Stop apps from crashing when they close a barcode scanner on a camera feed injected with `serve-sim camera`. Releasing the scanner's `AVCaptureMetadataOutput` no longer runs AVFoundation's `-dealloc` on serve-sim's fake connection.
