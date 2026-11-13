---
"@expo/serve-sim": patch
"@expo/hub-client": patch
---

Show the name of the foreground iOS app on hosts where the simulator runtime is mounted outside serve-sim's allowed paths, for example Safari and Settings in an EAS simulator session. serve-sim now sends `label` with each `/appstate` event. It reads the name from the bundle path that simctl reports, so the client no longer needs `app.infoPlist` for the name. hub-client uses that label, and a bundle read that finds no name no longer clears it.
