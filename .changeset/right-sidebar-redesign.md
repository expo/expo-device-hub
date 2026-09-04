---
'expo-device-hub': minor
---

Redesign the dashboard to the new Expo look: white sidebars around a gray stream canvas, separated by hairline seams.

- Inspector sections have bolder titles and full-width separators, and they animate open and closed. The order is Current app, Device options, Stream options, Events, Logs; the first two start open.
- Current app is collapsible and hosts the activity charts. It lists App ID, Version, and Build number; the minimum OS and PID rows are gone, and Android skips the name and icon line.
- Rows show a label on the left and a control on the right, without dividers. Every choice is a select pill, so device settings no longer use segmented controls. Toggles are compact, and action buttons match the pills and press in while held.
- Clicking another select while one is open switches menus in one click.
- Activity and WebRTC charts are gradient sparkline cards, and the CPU chart scales to at least 100%. The WebRTC statistics table has no divider lines.
- The controls under the device stream are a pill toolbar with Save, Theme, Home, and Reload, plus a separate Rotate button, each with a tooltip. The Android Back and Recents keys and the shut down and remove actions moved into Device options.
- The device title and toolbar hug the device frame. Docked sidebars follow the resize handle without easing, and slide-over sidebars use a hairline seam instead of a shadow.
