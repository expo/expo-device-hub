import { Option, type Command } from "commander";
import { readFileSync } from "fs";
import { z } from "zod";
import { findBootedDevice, resolveDevice } from "./device";
import {
  deleteKeychainValues,
  KEYCHAIN_FORMATS,
  listKeychainKeys,
  setKeychainValues,
  type KeychainFormatName,
  type KeychainTarget,
  type KeychainWriteSummary,
} from "./keychain";
import { KEYCHAIN_ACCESSIBLE, type KeychainAccessible } from "./sim-keychain";

interface KeychainCliOptions {
  format: KeychainFormatName;
  service?: string;
  accessGroup?: string;
  accessible?: KeychainAccessible;
  username?: string;
  device?: string;
  json?: boolean;
}

const KeychainEntries = z.record(z.string(), z.string());

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function targetOf(bundleId: string, opts: KeychainCliOptions): KeychainTarget {
  const udid = opts.device ? resolveDevice(opts.device) : findBootedDevice();
  if (!udid) fail("No booted simulator. Boot one or pass -d <udid|name>.");
  return {
    udid,
    bundleId,
    format: opts.format,
    options: {
      service: opts.service,
      username: opts.username,
      accessGroup: opts.accessGroup,
      accessible: opts.accessible,
    },
  };
}

/** `key=value` arguments, then the file's pairs; a later key wins. */
export function parseKeychainEntries(
  pairs: string[],
  fileText: string | null,
): [key: string, value: string][] {
  const entries = new Map<string, string>();
  for (const [index, pair] of pairs.entries()) {
    const split = pair.indexOf("=");
    // The argument may be a bare secret, so the message names its position, not its text.
    if (split <= 0) throw new Error(`Expected key=value in entry ${index + 1}.`);
    entries.set(pair.slice(0, split), pair.slice(split + 1));
  }
  if (fileText !== null) {
    let payload: unknown = null;
    try {
      payload = JSON.parse(fileText);
    } catch {}
    const parsed = KeychainEntries.safeParse(payload);
    if (!parsed.success) {
      throw new Error("--from-file must hold a JSON object of string keys and values.");
    }
    for (const [key, value] of Object.entries(parsed.data)) entries.set(key, value);
  }
  if (entries.size === 0) throw new Error("Pass key=value pairs or --from-file.");
  return [...entries];
}

function report(
  target: KeychainTarget,
  verb: "set" | "delete",
  summary: KeychainWriteSummary,
  json?: boolean,
) {
  if (json) {
    console.log(JSON.stringify({ udid: target.udid, bundleId: target.bundleId, ...summary }));
  } else if (!summary.applied) {
    console.log(
      `${target.bundleId} did not answer, so the change applies when it next starts. ` +
        "Pass --relaunch to apply it now.",
    );
  } else {
    for (const { key, ok, message } of summary.keys) {
      (ok ? console.log : console.error)(`${verb} ${key}: ${message}`);
    }
  }
  if (summary.applied && summary.keys.some(({ ok }) => !ok)) {
    process.exit(1);
  }
}

async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function withTargetOptions(command: Command, deviceOpt: readonly [string, string]): Command {
  return command
    .addOption(
      new Option("--format <format>", "How the app stores its values")
        .choices(KEYCHAIN_FORMATS)
        .default("expo-secure-store"),
    )
    .option(
      "--service <name>",
      "expo-secure-store: its keychainService option (default app). generic-password: the item service. react-native-keychain takes none; its keys are services",
    )
    .option("--access-group <group>", "Keychain access group (default: the app's own)")
    .option(...deviceOpt)
    .option("-j, --json", "Print JSON");
}

export function registerKeychainCommands(
  program: Command,
  deviceOpt: readonly [string, string],
): void {
  const keychain = program
    .command("keychain")
    .description("Write, delete, and list keychain values inside an installed app");

  withTargetOptions(
    keychain
      .command("set")
      .description("Set values the app reads from its keychain, such as sign-in tokens")
      .argument("<bundle-id>")
      .argument(
        "[entries...]",
        "key=value pairs; other processes can see them, so prefer --from-file",
      )
      .option("--from-file <path>", "JSON object of string keys and values; - reads stdin")
      .addOption(
        new Option("--accessible <when>", "When the item is readable").choices(KEYCHAIN_ACCESSIBLE),
      )
      .option("--username <name>", "react-native-keychain: the username stored with each password")
      .option("--relaunch", "Restart the app so it reads the new values"),
    deviceOpt,
  ).action(
    (
      bundleId: string,
      pairs: string[],
      opts: KeychainCliOptions & { fromFile?: string; relaunch?: boolean },
    ) =>
      run(async () => {
        const fileText =
          opts.fromFile === undefined
            ? null
            : readFileSync(opts.fromFile === "-" ? 0 : opts.fromFile, "utf8");
        const entries = parseKeychainEntries(pairs, fileText);
        const target = targetOf(bundleId, opts);
        report(
          target,
          "set",
          await setKeychainValues(target, entries, { relaunch: opts.relaunch }),
          opts.json,
        );
      }),
  );

  withTargetOptions(
    keychain
      .command("delete")
      .description("Delete values from the app's keychain")
      .argument("<bundle-id>")
      .argument("<keys...>")
      .option("--relaunch", "Restart the app so it reads the change"),
    deviceOpt,
  ).action((bundleId: string, keys: string[], opts: KeychainCliOptions & { relaunch?: boolean }) =>
    run(async () => {
      const target = targetOf(bundleId, opts);
      report(
        target,
        "delete",
        await deleteKeychainValues(target, keys, { relaunch: opts.relaunch }),
        opts.json,
      );
    }),
  );

  withTargetOptions(
    keychain
      .command("list")
      .description("List the keys the app stored; values are never shown")
      .argument("<bundle-id>"),
    deviceOpt,
  ).action((bundleId: string, opts: KeychainCliOptions) =>
    run(async () => {
      const target = targetOf(bundleId, opts);
      const keys = await listKeychainKeys(target);
      if (opts.json) console.log(JSON.stringify({ udid: target.udid, bundleId, keys }));
      else for (const key of keys) console.log(key);
    }),
  );
}
