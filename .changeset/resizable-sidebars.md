---
"expo-device-hub": patch
"@expo/hub-components": patch
---

Add resizable sidebars. Drag the vertical seam between either sidebar (devices or logs) and the device stream to resize that column; a small grey grip fades in on the seam while it's hovered or dragged. Widths clamp so the stream keeps enough room next to the other sidebar. Backed by a new dependency-free `ResizeHandle` primitive and a `width` prop on `Sidebar`/`LogSidebar`.
