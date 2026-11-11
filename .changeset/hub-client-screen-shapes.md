---
"@expo/hub-client": minor
---

Add `@expo/hub-client/shapes`, a separate entry point that shows a device screen in the shape of its device. `DeviceShape` clips its children to the screen shape of the client's device and follows its display and orientation. `useScreenShape`, `resolveScreenShape`, and `SCREEN_SHAPES` look the shapes up, and `screenShapeClipPath` and the geometry helpers give the CSS for other elements. The table has iPhones from the iPhone X, iPads with rounded corners, the iPhone Duo's cover and inner display, the Pixel 9 and Pixel 10 families, and both displays of the Pixel 9 Pro Fold and the Pixel 10 Pro Fold. Apps that do not import the entry do not bundle it.
