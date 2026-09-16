# Third-party licenses

Original Expo code in this repository is generally licensed under [MIT](LICENSE), unless a package or file states otherwise. The repository also contains separately licensed packages, vendored code, and native dependencies. Their original copyrights, license terms, notices, and source-distribution requirements continue to apply.

| Package or source tree | License information |
| --- | --- |
| `expo-device-hub` and original Expo utility/UI packages | MIT, subject to their package and file notices. |
| `serve-sim` submodule | [Apache-2.0 license](packages/serve-sim/LICENSE) and [attribution notice](packages/serve-sim/NOTICE). |
| `serve-emu` | [Apache-2.0 license](packages/serve-emu/LICENSE). |
| `@expo/emulator-capture` | [Original source license](packages/@expo/emulator-capture/LICENSE), [third-party inventory](packages/@expo/emulator-capture/THIRD_PARTY_LICENSES.md), and [upstream license copies with permalinks](packages/@expo/emulator-capture/LICENSES/README.md). Its native binaries combine original MIT code with FFmpeg, Frida, and other separately licensed components. |

This is an overview, not an exhaustive inventory of every transitive dependency. Dependencies installed through package managers retain their own licenses. Check the package's included license files when using or redistributing it, especially when copying dependencies into an application, installer, or container.

The emulator-capture inventory is preliminary. Verification of the final native artifacts, complete attribution notices, and corresponding source/rebuild distribution remains pending. Listing a dependency or copying its license does not by itself fulfill all of its distribution requirements.
