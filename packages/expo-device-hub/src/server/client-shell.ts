import { type PlatformFilter } from '../platform-filter';
import { type Transport } from '../transport';

/** Hosts strip the mount prefix before passing requests to the plugin handler. */
export function isClientShellRequest(request: Request): boolean {
  if (request.method !== 'GET') return false;
  const { pathname } = new URL(request.url);
  return pathname === '/' || pathname === '/index.html' || /^\/device\/[^/]+\/?$/.test(pathname);
}

/** Fill the runtime values consumed by the exported dashboard shell. */
export function configureClientShell(
  html: string,
  mountPath: string,
  platform: PlatformFilter | undefined,
  transport: Transport | undefined,
  hideSidebar: boolean,
  hideBootDevice: boolean
): string {
  return html
    .replaceAll('{{mount}}', mountPath)
    .replaceAll('{{platform}}', platform ?? '')
    .replaceAll('{{transport}}', transport ?? '')
    .replaceAll('{{hideSidebar}}', String(hideSidebar))
    .replaceAll('{{hideBootDevice}}', String(hideBootDevice));
}
