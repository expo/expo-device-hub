import { parseAppIconResponse } from './android-app-icon';
import { type HostActionResult, type RunHostAction } from './exec-ws';
import { type ForegroundApp } from './types';

/**
 * Host-side app-bundle introspection for iOS simulators, ported from the
 * serve-sim preview client (`client/utils/app-icon.ts`) so the Hub shows the
 * same details serve-sim's own app-detection panel does. Every lookup is a
 * typed host action on the middleware exec channel (serve-sim #136) — the same
 * transport `setAppearance` and logs already use — never a shell command.
 */

export type { HostActionResult as ExecResult, RunHostAction } from './exec-ws';

/** The {@link ForegroundApp} fields resolvable from the installed app bundle. */
export type IosAppDetails = Pick<
  ForegroundApp,
  'label' | 'version' | 'build' | 'minOS' | 'executable' | 'appPath' | 'iconDataUrl'
>;

/**
 * Resolve display name, versions, and icon for an installed app:
 * `app.container` (simctl get_app_container) → `app.infoPlist` (plutil JSON) →
 * `app.iconPath` + `file.readBase64` for a loose icon PNG. Returns null when the
 * bundle can't be located (e.g. the process is not a plain app — SpringBoard
 * has no user-visible container on some runtimes). Icons compiled solely into
 * Assets.car yield no `iconDataUrl`; callers should fall back to a placeholder.
 * With `includeIcon: false` the icon is left to {@link fetchIosAppIcon} and the
 * result carries no `iconDataUrl` key.
 */
export async function fetchIosAppDetails(
  run: RunHostAction,
  udid: string,
  bundleId: string,
  { includeIcon = true }: { includeIcon?: boolean } = {},
): Promise<IosAppDetails | null> {
  const ctn: HostActionResult = await run('app.container', { udid, bundleId });
  if (ctn.exitCode !== 0) return null;
  const appPath = ctn.stdout.trim();
  if (!appPath) return null;

  const plist = await run('app.infoPlist', { path: `${appPath}/Info.plist` });
  let info: any = {};
  if (plist.exitCode === 0) {
    try {
      info = JSON.parse(plist.stdout);
    } catch {}
  }

  // Icon name: CFBundleIcons → primary → last CFBundleIconFiles entry (the
  // largest variant), with the legacy flat keys as fallbacks.
  let iconName: string | undefined;
  const primary =
    info?.CFBundleIcons?.CFBundlePrimaryIcon ?? info?.['CFBundleIcons~ipad']?.CFBundlePrimaryIcon;
  const iconFiles: string[] | undefined = primary?.CFBundleIconFiles ?? info?.CFBundleIconFiles;
  if (iconFiles && iconFiles.length > 0) iconName = iconFiles[iconFiles.length - 1];
  else if (typeof info?.CFBundleIconFile === 'string') iconName = info.CFBundleIconFile;

  let iconDataUrl: string | undefined;
  if (includeIcon && iconName) {
    // Loose PNGs commonly sit next to Assets.car under a handful of names.
    const candidates = [
      `${iconName}@3x.png`,
      `${iconName}@2x.png`,
      `${iconName}.png`,
      `${iconName}60x60@3x.png`,
      `${iconName}60x60@2x.png`,
    ];
    const find = await run('app.iconPath', { appPath, candidates });
    const iconPath = find.stdout.trim();
    if (iconPath) {
      const b64 = await run('file.readBase64', { path: iconPath });
      if (b64.exitCode === 0) {
        iconDataUrl = `data:image/png;base64,${b64.stdout.replace(/\s+/g, '')}`;
      }
    }
  }

  return {
    appPath,
    label: info.CFBundleDisplayName ?? info.CFBundleName,
    version: info.CFBundleShortVersionString,
    build: info.CFBundleVersion,
    minOS: info.MinimumOSVersion,
    executable: info.CFBundleExecutable,
    ...(includeIcon ? { iconDataUrl } : {}),
  };
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/** Waits before each retry of the icon request. */
const ICON_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

/**
 * The app's icon from serve-sim's `/api/apps/icon` route (`appIconEndpoint` in
 * `/api`): one plain GET, so it also reaches a tunneled server whose exec-ws
 * socket the page cannot open. Null when the app has no loose icon PNG.
 *
 * Not cached: the route reads the installed bundle on each request, so a
 * reinstalled build shows its new icon. A network error or a 5xx (the route
 * answers 503 while simctl fails) is retried a few times. A 4xx is not,
 * because the same request gets the same answer.
 */
export async function fetchIosAppIcon(
  appIconUrl: string,
  bundleId: string,
  {
    fetchImpl = fetch,
    signal,
    retryDelaysMs = ICON_RETRY_DELAYS_MS,
  }: { fetchImpl?: FetchImpl; signal?: AbortSignal; retryDelaysMs?: readonly number[] } = {},
): Promise<string | null> {
  const url = new URL(appIconUrl);
  url.searchParams.set('bundleId', bundleId);
  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < retryDelaysMs.length;
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), { cache: 'no-store', signal });
    } catch (err) {
      if (signal?.aborted || !canRetry) throw err;
      await delay(retryDelaysMs[attempt]!, signal);
      continue;
    }
    if (res.ok) return parseAppIconResponse(await res.json());
    if (res.status < 500 || !canRetry) {
      throw new Error(`app icon request failed with ${res.status}`);
    }
    await delay(retryDelaysMs[attempt]!, signal);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Details (icon included) are immutable per installed build, so cache them
// process-wide keyed by udid:bundleId — switching between apps re-applies
// instantly. Rejections are evicted so a transient exec-ws failure retries on
// the next foreground change instead of pinning the miss forever.
const detailsCache = new Map<string, Promise<IosAppDetails | null>>();

export function getIosAppDetails(
  run: RunHostAction,
  udid: string,
  bundleId: string,
  options: { includeIcon?: boolean } = {},
): Promise<IosAppDetails | null> {
  const key = `${udid}:${bundleId}:${options.includeIcon !== false}`;
  const cached = detailsCache.get(key);
  if (cached) return cached;
  const pending = fetchIosAppDetails(run, udid, bundleId, options).catch((err) => {
    detailsCache.delete(key);
    throw err;
  });
  detailsCache.set(key, pending);
  return pending;
}
