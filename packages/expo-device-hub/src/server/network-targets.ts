/**
 * Finding the app to watch for the Network panel: the Metro server the Hub runs in, the React
 * Native inspector targets it lists, and the one that runs on a given Hub device.
 */

export interface InspectorTarget {
  /** Page id, unique per device connection. */
  id: string;
  /** How the app names its device, for example `iPhone 17 Pro (iOS 27.1)`. */
  deviceName: string;
  /** Bundle id or package name. */
  appId: string;
  webSocketDebuggerUrl: string;
  /**
   * React Native's stable id for the physical or virtual device, shared by every app on it. Two
   * devices with the same name have different ids.
   */
  logicalDeviceId?: string;
}

/** Why a Metro URL was not used. */
export class MetroUrlError extends Error {}

/** The Hub device the panel shows, as the dashboard names it. */
export interface NetworkDeviceRef {
  platform: "ios" | "android";
  /** udid (iOS) or adb serial (Android). */
  id: string;
  name: string;
  /** For example `iOS 27.1`. */
  version: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The Metro server to read the app from.
 *
 * As an Expo CLI plugin the Hub runs inside the Metro server, so the request that reached it names
 * Metro's port. The standalone CLI serves the Hub from its own port, so it needs
 * `EXPO_DEVICE_HUB_METRO_URL`. Without it, the request's port has no Metro, and the panel reports
 * that it cannot find one.
 *
 * Throws `MetroUrlError` for a configured URL that is unusable or not on loopback.
 */
export function metroOriginFor(
  requestUrl: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const configured = env.EXPO_DEVICE_HUB_METRO_URL?.trim();
  if (configured) {
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      throw new MetroUrlError(`EXPO_DEVICE_HUB_METRO_URL is not a URL: ${configured}`);
    }
    // @ref LLP 0014#metro — the inspector session carries the app's traffic, so it never leaves
    // the host, and Expo CLI serves the inspector to loopback sockets only anyway.
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw new MetroUrlError(
        "EXPO_DEVICE_HUB_METRO_URL must name a Metro server on this machine (127.0.0.1, localhost, or [::1]).",
      );
    }
    return url.origin;
  }
  try {
    const url = new URL(requestUrl);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    // @ref LLP 0014#metro — Expo CLI serves the inspector to loopback sockets only.
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}

/**
 * The `Origin` values to offer the inspector, in order.
 *
 * @ref LLP 0014#origin — React Native's proxy accepts its own base URL or a loopback host name,
 * and Expo CLI then closes any debugger whose origin host is not exactly its base URL's host,
 * which is `127.0.0.1:<port>` by default. Offer that first, then `localhost`.
 */
export function inspectorOrigins(metroOrigin: string): string[] {
  const { port, protocol } = new URL(metroOrigin);
  const suffix = port ? `:${port}` : "";
  return [
    ...new Set([metroOrigin, `${protocol}//127.0.0.1${suffix}`, `${protocol}//localhost${suffix}`]),
  ];
}

/** Read the inspector targets from Metro's `/json/list`. Throws when Metro cannot be read. */
export async function listInspectorTargets(
  metroOrigin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InspectorTarget[]> {
  const response = await fetchImpl(`${metroOrigin}/json/list`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`Metro answered /json/list with ${response.status}`);
  const pages: unknown = await response.json();
  if (!Array.isArray(pages)) throw new Error("Metro's /json/list is not a list");
  return pages.flatMap((page): InspectorTarget[] => {
    if (!page || typeof page !== "object") return [];
    const { id, deviceName, appId, webSocketDebuggerUrl, reactNative } = page as Record<
      string,
      unknown
    >;
    if (typeof id !== "string" || typeof webSocketDebuggerUrl !== "string") return [];
    const logicalDeviceId =
      reactNative && typeof reactNative === "object"
        ? (reactNative as Record<string, unknown>).logicalDeviceId
        : undefined;
    return [
      {
        id,
        deviceName: typeof deviceName === "string" ? deviceName : "",
        appId: typeof appId === "string" ? appId : "",
        webSocketDebuggerUrl,
        ...(typeof logicalDeviceId === "string" && logicalDeviceId ? { logicalDeviceId } : {}),
      },
    ];
  });
}

/**
 * The names React Native may give an iOS simulator, best first. It reports the device's own name
 * [observed: a simulator named `iPhone Duo (iOS 27.1)` is listed in `/json/list` as exactly that],
 * so the Hub's name comes first; `<name> (<version>)` covers a name without the version.
 */
export function iosInspectorDeviceNames(
  device: Pick<NetworkDeviceRef, "name" | "version">,
): string[] {
  return [...new Set([device.name, `${device.name} (${device.version})`])];
}

/**
 * How React Native names an Android device: `<model> - <release> - API <sdk>`, from `getprop`
 * [observed: `sdk_gphone16k_arm64 - 17 - API 37` for an emulator with those props]. Null when a
 * prop is missing.
 */
export function androidInspectorDeviceName(props: Record<string, string>): string | null {
  const model = props["ro.product.model"];
  const release = props["ro.build.version.release"];
  const sdk = props["ro.build.version.sdk"];
  if (!model || !release || !sdk) return null;
  return `${model} - ${release} - API ${sdk}`;
}

export type TargetMatch =
  | { kind: "match"; target: InspectorTarget }
  | { kind: "none" }
  /**
   * Several apps answer to the device's name, and the Hub cannot tell which runs on this device:
   * they report different devices, or some report none.
   */
  | { kind: "ambiguous"; deviceName: string; reason: "shared-name" | "unidentified" };

/**
 * The target that runs on the device, trying each of its names in order. When one device runs
 * several connected apps, the one Metro listed last (the most recently connected) wins.
 *
 * @ref LLP 0014#matching-a-device — a name is all the Hub can match on, so when apps on two
 * devices share it (two simulators or emulators of one model), the Hub cannot tell which is this
 * device's and attaches to neither.
 */
export function matchTarget(
  targets: InspectorTarget[],
  deviceNames: readonly string[],
): TargetMatch {
  for (const name of deviceNames) {
    const matches = targets.filter((target) => target.deviceName === name);
    if (matches.length === 0) continue;
    // Several apps answer to one name only safely when each reports the same device. A target
    // without an id could be on any device, so it makes a shared name ambiguous too.
    const devices = new Set(matches.map((target) => target.logicalDeviceId));
    devices.delete(undefined);
    if (devices.size > 1) return { kind: "ambiguous", deviceName: name, reason: "shared-name" };
    if (matches.length > 1 && matches.some((target) => target.logicalDeviceId === undefined)) {
      return { kind: "ambiguous", deviceName: name, reason: "unidentified" };
    }
    return { kind: "match", target: matches.at(-1)! };
  }
  return { kind: "none" };
}

/**
 * The target's debugger URL on `metroOrigin`. `/json/list` builds the URL from the host it was
 * asked on, so keep only its path and query.
 */
export function debuggerUrlOn(metroOrigin: string, target: InspectorTarget): string {
  const listed = new URL(target.webSocketDebuggerUrl);
  const url = new URL(`${listed.pathname}${listed.search}`, metroOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
