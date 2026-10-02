// Opt-in simulator slimming (docs/simulator-slimming.md): catalog.ts is the data, launchd.ts applies
// it, cli.ts wires it into serve-sim. This is the only surface serve-sim imports.
export { SLIM_OPTION, parseSlimOption, registerSlimCommand, startSlimInBackground } from "./cli";
