// Opt-in simulator slimming. A booted simulator runs about 400 launchd services;
// most serve the phone's owner, not an app under test or a stream. In an
// isolated VM the push daemon cannot reach Apple and retries its TLS handshake
// without end, which keeps an idle simulator at about half a core.
//
// Services are switched off with `launchctl disable`, which persists across
// reboots on iOS 18.5 and later, and stopped with `launchctl bootout`, through
// `simctl spawn`, without a reboot. Only the needed change is made: a label
// that is already disabled is not disabled again, and only running services
// are stopped.
//
// The category list is derived from simslim (https://github.com/plu/simslim,
// MIT License, Copyright (c) 2026 Interlap). Here each label belongs to exactly
// one category, so a category's state on a device is exact.
import { simctl } from "./simctl";

export interface SlimCategory {
  id: string;
  /** What an app under test loses while the category is off. */
  loses: string;
  labels: readonly string[];
}

/** The default profile is the first eight categories. */
export const SLIM_CATEGORIES: readonly SlimCategory[] = [
  {
    id: "telemetry",
    loses: "DeviceCheck and App Attest, SKAdNetwork and AdAttributionKit postbacks, diagnostics and feedback uploads.",
    labels: [
      "com.apple.ap.adprivacyd", "com.apple.ap.promotedcontentd", "com.apple.diagnosticextensionsd",
      "com.apple.feedbackd", "com.apple.rtcreportingd", "com.apple.securityuploadd", "com.apple.geoanalyticsd",
      "com.apple.triald", "com.apple.followupd", "com.apple.purplebuddy.budd", "com.apple.devicecheckd",
    ],
  },
  {
    id: "widgets",
    loses: "WidgetKit timelines, Live Activities, and lock screen posters stop updating.",
    labels: ["com.apple.PosterBoard", "com.apple.chronod", "com.apple.liveactivitiesd"],
  },
  {
    id: "siri",
    loses: "Siri and App Intents invocation, Speech recognition, Apple Intelligence and Writing Tools, Siri suggestions.",
    labels: [
      "com.apple.assistantd", "com.apple.assistant_cdmd", "com.apple.assistant_service", "com.apple.siriactionsd",
      "com.apple.siriinferenced", "com.apple.siriknowledged", "com.apple.sirittsd", "com.apple.siri.context.service",
      "com.apple.siri.acousticsignature", "com.apple.corespeechd", "com.apple.voiced", "com.apple.voicebankingd",
      "com.apple.speechmodeltrainingd", "com.apple.intelligenceplatformd", "com.apple.intelligencecontextd",
      "com.apple.intelligenceflowd", "com.apple.intelligencetasksd", "com.apple.generativeexperiencesd",
      "com.apple.knowledgeconstructiond", "com.apple.naturallanguaged", "com.apple.textunderstandingd",
      "com.apple.modelcatalogd", "com.apple.modelmanagerd", "com.apple.mlhostd", "com.apple.mlruntimed",
      "com.apple.suggestd", "com.apple.parsecd", "com.apple.parsec-fbf", "com.apple.proactiveeventtrackerd",
    ],
  },
  {
    id: "family",
    loses: "FamilyControls, ManagedSettings, DeviceActivity, and Screen Time.",
    labels: [
      "com.apple.familycircled", "com.apple.FamilyControlsAgent", "com.apple.familynotification",
      "com.apple.askpermissiond", "com.apple.asktod", "com.apple.ScreenTimeAgent",
      "com.apple.ScreenTimeSettingsAgent", "com.apple.UsageTrackingAgent",
    ],
  },
  {
    id: "messaging",
    loses: "iMessage and FaceTime identity, sending from the message composer, and CallKit call services.",
    labels: [
      "com.apple.identityservicesd", "com.apple.ids_simd", "com.apple.imautomatichistorydeletionagent",
      "com.apple.imcore.imtransferagent", "com.apple.imdpersistence.IMDPersistenceAgent",
      "com.apple.facetimemessagestored", "com.apple.telephonyutilities.callservicesd",
    ],
  },
  {
    id: "connectivity",
    loses: "WatchConnectivity, CarPlay, AirDrop and Continuity, SharePlay, Find My, and Memoji stickers.",
    labels: [
      "com.apple.rapportd", "com.apple.companiond", "com.apple.carkitd", "com.apple.wcd", "com.apple.tvremoted",
      "com.apple.avatarsd", "com.apple.stickersd", "com.apple.sociallayerd", "com.apple.announced",
      "com.apple.findmy.findmylocated",
    ],
  },
  {
    // Without rapportd (connectivity), homed retries its connection in a loop.
    id: "home",
    loses: "HomeKit. Switch it off with connectivity: without rapportd, homed retries in a loop.",
    labels: ["com.apple.homed", "com.apple.homeeventsd"],
  },
  {
    // The largest idle cost in an isolated VM: apsd retries its TLS handshake forever.
    id: "push",
    loses: "Remote push notifications (APNs). `simctl push` still delivers.",
    labels: ["com.apple.apsd"],
  },
  {
    id: "photos",
    loses: "PhotoKit, the photo library picker, `simctl addmedia`, Live Text, and the media library.",
    labels: [
      "com.apple.photoanalysisd", "com.apple.photosface", "com.apple.mediaanalysisd",
      "com.apple.mediaanalysisd.service", "com.apple.mediastream.mstreamd", "com.apple.medialibraryd",
      "com.apple.assetsd", "com.apple.assetsd.nebulad",
    ],
  },
  {
    id: "search",
    loses: "CoreSpotlight indexing; Spotlight and Settings search return nothing.",
    labels: [
      "com.apple.searchd", "com.apple.searchtoold", "com.apple.spotlightknowledged",
      "com.apple.spotlightknowledged.updater", "com.apple.corespotlightservice",
    ],
  },
  {
    id: "icloud",
    loses: "CloudKit, iCloud Drive, iCloud Keychain, Apple Account sign-in, and backup.",
    labels: [
      "com.apple.appleaccountd", "com.apple.appleaccounttransparencyd", "com.apple.appleidsetupd", "com.apple.akd",
      "com.apple.cloudd", "com.apple.cloudphotod", "com.apple.ckdiscretionaryd", "com.apple.cloudsettingssyncagent",
      "com.apple.bird", "com.apple.syncdefaultsd", "com.apple.cdpd", "com.apple.sosd", "com.apple.SecureBackupDaemon",
      "com.apple.TrustedPeersHelper", "com.apple.protectedcloudstorage.protectedcloudkeysyncing",
      "com.apple.icloudmailagent", "com.apple.icloudsubscriptionoptimizerd", "com.apple.communicationtrustd",
    ],
  },
  {
    id: "store",
    loses: "StoreKit and in-app purchase, the App Store, Apple Music, Wallet, and Apple Pay.",
    labels: [
      "com.apple.appstored", "com.apple.appstorecomponentsd", "com.apple.itunescloudd", "com.apple.itunesstored",
      "com.apple.storekitd", "com.apple.amsaccountsd", "com.apple.amsengagementd", "com.apple.amsondevicestoraged",
      "com.apple.passd", "com.apple.financed", "com.apple.videosubscriptionsd", "com.apple.assetsubscriptiond",
      "com.apple.musicd",
    ],
  },
  {
    id: "pim",
    loses: "Contacts and contact pickers, EventKit calendars and reminders, and Mail.",
    labels: [
      "com.apple.email.maild", "com.apple.exchangesyncd", "com.apple.dataaccess.dataaccessd", "com.apple.calaccessd",
      "com.apple.remindd", "com.apple.contactsd", "com.apple.contacts.postersyncd", "com.apple.peopled",
    ],
  },
  {
    id: "web",
    loses: "Universal links and associated domains, web push, and Safari sync.",
    labels: [
      "com.apple.SafariBookmarksSyncAgent", "com.apple.Safari.History", "com.apple.Safari.passwordbreachd",
      "com.apple.Safari.SafeBrowsing.Service", "com.apple.safarifetcherd", "com.apple.WebBookmarks.webbookmarksd",
      "com.apple.webkit.adattributiond", "com.apple.webkit.webpushd", "com.apple.webprivacyd", "com.apple.swcd",
    ],
  },
  {
    id: "health",
    loses: "HealthKit, fitness, and workouts.",
    labels: [
      "com.apple.healthd", "com.apple.healthappd", "com.apple.healthcontentd", "com.apple.healtheventsd",
      "com.apple.healthrecordsd", "com.apple.finhealthd", "com.apple.fitcore", "com.apple.fitcore.session",
      "com.apple.fitnesscoachingd", "com.apple.fitnessintelligenced", "com.apple.activityawardsd",
      "com.apple.activitysharingd",
    ],
  },
  {
    // navd is Maps' navigation daemon: without it Maps retries in a tight loop and takes
    // over a core, so it stays with Maps here and out of the default profile.
    id: "apps",
    loses: "Maps (it retries without navd and uses a full core), WeatherKit, MapKit snapshots, Game Center, game controllers, News, and Tips.",
    labels: [
      "com.apple.navd", "com.apple.newsd", "com.apple.weatherd", "com.apple.Maps.mapssyncd", "com.apple.Maps.mapspushd",
      "com.apple.Maps.geocorrectiond", "com.apple.maps.destinationd", "com.apple.MapKit.SnapshotService",
      "com.apple.jetpackassetd", "com.apple.tipsd", "com.apple.gamed", "com.apple.gamesaved",
      "com.apple.GameController.gamecontrollerd",
    ],
  },
  {
    id: "other",
    loses: "On-demand assets (dictionaries, fonts, speech and vision models), ID verification, and managed configuration.",
    labels: [
      "com.apple.merchantd", "com.apple.coreidvd", "com.apple.businessservicesd", "com.apple.deviceaccessd",
      "com.apple.replicatord", "com.apple.linkd", "com.apple.ind", "com.apple.storagedatad",
      "com.apple.StatusKitAgent", "com.apple.countryd", "com.apple.mobileassetd",
      "com.apple.managedconfiguration.passcodenagd",
    ],
  },
];

/** Every category above `photos`: what only a person holding the phone would notice, plus remote push. */
export const DEFAULT_SLIM_CATEGORIES: readonly string[] = [
  "telemetry", "widgets", "siri", "family", "messaging", "connectivity", "home", "push",
];

export interface SlimProfile {
  categories: string[];
  labels: string[];
}

/** Turns `default`, `all`, or a comma-separated list of category ids into a profile. */
export function resolveSlimProfile(spec = "default"): SlimProfile {
  const ids = new Set<string>();
  const requested = spec.split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of requested.length ? requested : ["default"]) {
    if (id === "default") DEFAULT_SLIM_CATEGORIES.forEach((d) => ids.add(d));
    else if (id === "all") SLIM_CATEGORIES.forEach((c) => ids.add(c.id));
    else if (SLIM_CATEGORIES.some((c) => c.id === id)) ids.add(id);
    else throw new Error(`Unknown slim category "${id}". Use default, all, or: ${SLIM_CATEGORIES.map((c) => c.id).join(", ")}`);
  }
  const chosen = SLIM_CATEGORIES.filter((c) => ids.has(c.id));
  return { categories: chosen.map((c) => c.id), labels: chosen.flatMap((c) => c.labels) };
}

type Run = (args: string[]) => Promise<string>;
type Failure = { label: string; error: string };

/** Labels `launchctl print-disabled` reports as disabled (`=> disabled` or `=> true`). */
export function parseDisabled(output: string): Set<string> {
  const disabled = new Set<string>();
  for (const match of output.matchAll(/"([^"]+)"\s*=>\s*(disabled|true)\b/g)) disabled.add(match[1]!);
  return disabled;
}

/** Labels `launchctl list` reports with a PID, that is, running. */
export function parseRunning(output: string): Set<string> {
  const running = new Set<string>();
  for (const line of output.split("\n")) {
    const [pid, , label] = line.trim().split(/\s+/);
    if (label && /^\d+$/.test(pid ?? "")) running.add(label);
  }
  return running;
}

async function readServices(udid: string, run: Run): Promise<{ disabled: Set<string>; running: Set<string> }> {
  const [disabled, running] = await Promise.all([
    run(["spawn", udid, "launchctl", "print-disabled", "system"]),
    run(["spawn", udid, "launchctl", "list"]),
  ]);
  return { disabled: parseDisabled(disabled), running: parseRunning(running) };
}

/**
 * Runs `launchctl <verb> system/<label>` for each label. CoreSimulator serializes
 * `simctl spawn` at about 0.1 s each, so more than four at a time gains nothing.
 */
async function launchctlEach(udid: string, verb: string, labels: string[], run: Run): Promise<{ done: string[]; failed: Failure[] }> {
  const done: string[] = [];
  const failed: Failure[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, labels.length) }, async () => {
    while (next < labels.length) {
      const label = labels[next++]!;
      try {
        await run(["spawn", udid, "launchctl", verb, `system/${label}`]);
        done.push(label);
      } catch (error) {
        const stderr = (error as { stderr?: unknown }).stderr;
        failed.push({ label, error: String(stderr || error).trim().split("\n")[0]!.slice(0, 200) });
      }
    }
  }));
  return { done: done.sort(), failed };
}

export interface SlimResult {
  /** Newly disabled in this call. */
  disabled: string[];
  /** Were running and are now stopped. */
  stopped: string[];
  failed: Failure[];
}

/** Switches the profile's services off in the booted simulator `udid`. */
export async function slimSimulator(udid: string, profile: SlimProfile, run: Run = simctl): Promise<SlimResult> {
  const state = await readServices(udid, run);
  const disable = await launchctlEach(udid, "disable", profile.labels.filter((l) => !state.disabled.has(l)), run);
  const failedToDisable = new Set(disable.failed.map((f) => f.label));
  const stop = await launchctlEach(udid, "bootout",
    profile.labels.filter((l) => state.running.has(l) && !failedToDisable.has(l)), run);
  return { disabled: disable.done, stopped: stop.done, failed: [...disable.failed, ...stop.failed] };
}

/** Switches the profile's services back on. launchd starts them on demand or at the next boot. */
export async function restoreSimulator(udid: string, profile: SlimProfile, run: Run = simctl): Promise<{ enabled: string[]; failed: Failure[] }> {
  const { disabled } = await readServices(udid, run);
  const enable = await launchctlEach(udid, "enable", profile.labels.filter((l) => disabled.has(l)), run);
  return { enabled: enable.done, failed: enable.failed };
}

export interface SlimCategoryStatus {
  category: SlimCategory;
  inDefault: boolean;
  /** How many of the category's services are disabled on the device. */
  off: number;
}

export async function slimStatus(udid: string, run: Run = simctl): Promise<SlimCategoryStatus[]> {
  const { disabled } = await readServices(udid, run);
  return SLIM_CATEGORIES.map((category) => ({
    category,
    inDefault: DEFAULT_SLIM_CATEGORIES.includes(category.id),
    off: category.labels.filter((l) => disabled.has(l)).length,
  }));
}

export function describeSlim(udid: string, profile: SlimProfile, result: SlimResult): string {
  const failed = result.failed.length ? `, ${result.failed.length} failed` : "";
  return `[slim] ${udid}: ${profile.categories.join(",")}: ${result.disabled.length} disabled, ` +
    `${result.stopped.length} stopped${failed}`;
}
