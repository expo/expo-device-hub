---
"@expo/hub-client": minor
---

On Android, a view that replaces the stream canvas, such as a switch between 2D and 3D, keeps showing the screen: the last frame is copied into the new canvas, and the MSE fallback draws into the current canvas. `canvasFrameNumber` and `markCanvasFrame` count the frames the client paints into a canvas.
