// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// The 3D preview's device models are GLB files that the dashboard imports as assets.
config.resolver.assetExts.push("glb");

module.exports = config;
