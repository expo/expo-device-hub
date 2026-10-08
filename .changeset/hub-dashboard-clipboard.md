---
"expo-device-hub": minor
---

Paste and copy text between the browser and an iOS simulator from the dashboard. The toolbar under the device has Copy from Simulator and Paste from Device, with the labels, order and toasts of serve-sim's preview. As in serve-sim, a Command+V paste with text shows the same toasts as Paste from Device, and a Command+V paste without text shows a toast only when it fails. When the browser does not allow clipboard access, the inspector's Clipboard section opens: paste the text there, or copy the text that the app copied. When the browser also refuses that Copy, the section copies the selected text with the browser's copy command. Paste and Copy need the simulator's hardware keyboard; the section says so when it is off. When the `expo-device-hub` CLI stops on Ctrl+C or SIGTERM, it waits for serve-sim to release the clipboard reader on the devices it opened.
