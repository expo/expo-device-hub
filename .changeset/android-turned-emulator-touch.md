---
"expo-device-hub": patch
---

Taps and swipes on an Android emulator in gRPC screenshot mode now land where they are aimed when the emulator is turned while the app stays upright, such as the home screen, and when an orientation lock turns the screen while the emulator stays upright. With gRPC input, touches on a turned emulator also no longer land a quarter turn away in apps that rotate with it.
