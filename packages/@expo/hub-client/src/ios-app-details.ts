import { type ForegroundApp } from './types';

/**
 * Host-side app-bundle introspection for iOS simulators, ported from the
 * serve-sim preview client (`client/utils/app-icon.ts`) so the Hub shows the
 * same details serve-sim's own app-detection panel does. Every lookup is a
 * shell command on the host, issued through the middleware exec channel the
 * caller provides — the same transport `setAppearance` and logs already use.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs one shell command on the serve-sim host and resolves its output. */
export type ExecCommand = (command: string) => Promise<ExecResult>;

/** The {@link ForegroundApp} fields resolvable from the installed app bundle. */
export type IosAppDetails = Pick<
  ForegroundApp,
  'label' | 'version' | 'build' | 'minOS' | 'executable' | 'appPath' | 'iconDataUrl'
>;

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Resolve display name, versions, and icon for an installed app:
 * `simctl get_app_container` → Info.plist via `plutil -convert json` → icon
 * PNG via `base64`. Returns null when the bundle can't be located (e.g. the
 * process is not a plain app — SpringBoard has no user-visible container on
 * some runtimes). Icons compiled solely into Assets.car yield no
 * `iconDataUrl`; callers should fall back to a placeholder.
 */
export async function fetchIosAppDetails(
  exec: ExecCommand,
  udid: string,
  bundleId: string,
): Promise<IosAppDetails | null> {
  const ctn = await exec(`xcrun simctl get_app_container ${udid} ${shellEscape(bundleId)} app`);
  if (ctn.exitCode !== 0) return null;
  const appPath = ctn.stdout.trim();
  if (!appPath) return null;

  const plist = await exec(`plutil -convert json -o - ${shellEscape(`${appPath}/Info.plist`)}`);
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
  if (iconName) {
    // Loose PNGs commonly sit next to Assets.car under a handful of names.
    const candidates = [
      `${iconName}@3x.png`,
      `${iconName}@2x.png`,
      `${iconName}.png`,
      `${iconName}60x60@3x.png`,
      `${iconName}60x60@2x.png`,
    ];
    const find = await exec(
      `bash -c ${shellEscape(
        candidates
          .map(
            (c) =>
              `[ -f ${shellEscape(`${appPath}/${c}`)} ] && echo ${shellEscape(`${appPath}/${c}`)} && exit 0`,
          )
          .join('; ') + '; exit 1',
      )}`,
    );
    const iconPath = find.stdout.trim();
    if (iconPath) {
      const b64 = await exec(`base64 -i ${shellEscape(iconPath)}`);
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
    iconDataUrl,
  };
}

// Details (icon included) are immutable per installed build, so cache them
// process-wide keyed by udid:bundleId — switching between apps re-applies
// instantly. Rejections are evicted so a transient exec-ws failure retries on
// the next foreground change instead of pinning the miss forever.
const detailsCache = new Map<string, Promise<IosAppDetails | null>>();

export function getIosAppDetails(
  exec: ExecCommand,
  udid: string,
  bundleId: string,
): Promise<IosAppDetails | null> {
  const key = `${udid}:${bundleId}`;
  const cached = detailsCache.get(key);
  if (cached) return cached;
  const pending = fetchIosAppDetails(exec, udid, bundleId).catch((err) => {
    detailsCache.delete(key);
    throw err;
  });
  detailsCache.set(key, pending);
  return pending;
}
