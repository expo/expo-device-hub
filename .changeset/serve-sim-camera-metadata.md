---
"@expo/serve-sim": minor
---

Deliver barcodes and QR codes in a feed injected with `serve-sim camera` to the app's `AVCaptureMetadataOutput`, so scanners such as expo-camera's `onBarcodeScanned` work in the Simulator. Codes are found with Vision a few times a second and reported through the preview layer's `transformedMetadataObjectForMetadataObject:`.
