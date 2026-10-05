---
"@expo/serve-sim": patch
"expo-device-hub": patch
---

Internal change: session tokens must not be empty and can now contain only letters, digits, and `-._~`. Other tokens are refused, and the CLI tools throw an error.
