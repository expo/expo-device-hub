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
}

/** The Hub device the panel shows, as the dashboard names it. */
export interface NetworkDeviceRef {
  platform: "ios" | "android";
  /** udid (iOS) or adb serial (Android). */
  id: string;
  name: string;
  /** For example `iOS 27.1`. */
  version: string;
}

/**
 * The Metro server to read the app from.
 *
 * As an Expo CLI plugin the Hub runs inside the Metro server, so the request that reached it names
 * Metro's port. The standalone CLI serves the Hub from its own port, so it needs
 * `EXPO_DEVICE_HUB_METRO_URL`. Without it, the request's port has no Metro, and the panel reports
 * that it cannot find one.
 */
export function metroOriginFor(
  requestUrl: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const configured = env.EXPO_DEVICE_HUB_METRO_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      return null;
    }
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
    const { id, deviceName, appId, webSocketDebuggerUrl } = page as Record<string, unknown>;
    if (typeof id !== "string" || typeof webSocketDebuggerUrl !== "string") return [];
    return [
      {
        id,
        deviceName: typeof deviceName === "string" ? deviceName : "",
        appId: typeof appId === "string" ? appId : "",
        webSocketDebuggerUrl,
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

/**
 * The target that runs on the device, trying each of its names in order. When one device runs
 * several connected apps, the one Metro listed last (the most recently connected) wins.
 */
export function pickTarget(
  targets: InspectorTarget[],
  deviceNames: readonly string[],
): InspectorTarget | null {
  for (const name of deviceNames) {
    const match = targets.filter((target) => target.deviceName === name).at(-1);
    if (match) return match;
  }
  return null;
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
