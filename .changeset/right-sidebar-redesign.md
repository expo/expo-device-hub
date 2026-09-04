---
'expo-device-hub': minor
---

Redesign the right inspector sidebar: bolder collapsible section headers with full-width separators, label/control rows without dividers, select pills for every choice (device settings now use dropdowns instead of segmented controls), compact toggles, and gradient sparkline cards for the Activity and WebRTC charts. The center stream canvas is now gray between white sidebars, separated only by hairline seams. The controls under the device stream are a pill toolbar (Save, Theme, Home, Reload) plus a separate Rotate button with hover tooltips; the Android Back and Recents keys and the shut down / remove actions moved into Device options. Sections animate open and closed with centered titles, and docked sidebars follow the resize handle without easing. The device title and toolbar hug the device frame, and the Current app section uses the same title row and 14 px label/value scale as the other sections.
