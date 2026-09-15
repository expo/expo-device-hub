// EAS Workflows run from the monorepo root. Keep the project identity shared
// with the web app, without resolving its assets relative to this directory.
const { name, slug, owner, extra } = require('./packages/expo-device-hub/app.json').expo;

module.exports = { expo: { name, slug, owner, extra } };
