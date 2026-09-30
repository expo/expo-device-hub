import { type PlatformFilter } from '../platform-filter';
import { type Transport } from '../transport';

export type ClientShellOptions = {
  mountPath: string;
  platform?: PlatformFilter;
  transport?: Transport;
  hideSidebar?: boolean;
  hideBootDevice?: boolean;
  /** Under `--require-token`, for the Share button's link. The gate already let this page through. */
  sessionToken?: string;
  shareUrl?: string;
};

// These land in a single-quoted string inside a <script>. A URL path may keep a quote.
function jsStringContent(value: string): string {
  return value.replace(
    /[\\'"<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

/** Fill the runtime values consumed by the exported dashboard shell. */
export function configureClientShell(
  html: string,
  {
    mountPath,
    platform,
    transport,
    hideSidebar = false,
    hideBootDevice = false,
    sessionToken,
    shareUrl,
  }: ClientShellOptions
): string {
  return html
    .replaceAll('{{mount}}', mountPath)
    .replaceAll('{{platform}}', platform ?? '')
    .replaceAll('{{transport}}', transport ?? '')
    .replaceAll('{{hideSidebar}}', String(hideSidebar))
    .replaceAll('{{hideBootDevice}}', String(hideBootDevice))
    .replaceAll('{{sessionToken}}', jsStringContent(sessionToken ?? ''))
    .replaceAll('{{shareUrl}}', jsStringContent(shareUrl ?? ''));
}
