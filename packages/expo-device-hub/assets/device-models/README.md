# Device models

The 3D preview's models. Expo authored them in
[expo/expo-simulators-3d-models](https://github.com/expo/expo-simulators-3d-models).
They were copied unchanged from that repository at `644e92e45338138535773d79f9f54c70b1370c52`.

| File                   | Source path                                                | Last changed in | Bytes     | SHA-256                                                            |
| ---------------------- | ---------------------------------------------------------- | --------------- | --------- | ------------------------------------------------------------------ |
| `iphone-duo.glb`       | `folding-lab/assets/duo-calculated-web.glb`                | `644e92e4`      | 5,668,260 | `828932db3031b18a0a80e3044debd801065f7d5b267e1e4cef1bc03c4f2e7797` |
| `pixel-9-pro-fold.glb` | `folding-lab/assets/pixel-calculated-web.glb`              | `644e92e4`      | 4,433,536 | `473d63bd774193ae0ae803b2e52119ccde06eb179cf621dffa01045f8497a737` |
| `pixel-9-pro.glb`      | `phones/google-pixel-9-pro/viewer/assets/authored-web.glb` | `9de945af`      | 2,021,240 | `f2f14b5dee8b9a298329705bc325ed33f857d8ce5763d9a4df0cd1e9a0a6e24f` |
| `iphone-18-pro.glb`    | `phones/iphone-18-pro/viewer/assets/authored-web.glb`      | `e365a8ce`      | 2,676,016 | `be8652a56a7137ac95f5171ecb9084a2aa60ee4c413703e77cbc45bdf33782a8` |

All four use meters, Y up, and the display facing +Z. They need the Meshopt
decoder. The two foldables bend their flexible meshes with the calculated
bending in `@expo/hub-components/foldable`, which ports that repository's
`scripts/procedural_duo_bend.mjs` and `scripts/procedural_pixel_bend.mjs`
at the same commit.

The dashboard imports these files as Metro assets, so `expo export` copies them
into `dist/client`. Another consumer, such as the Expo website, hosts the same
files and passes their URLs to `StreamPanel` as `deviceModelAssets`.
