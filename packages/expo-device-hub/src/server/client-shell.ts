import { type PlatformFilter } from '../platform-filter';

/** Fill the runtime values consumed by the exported dashboard shell. */
export function configureClientShell(
  html: string,
  mountPath: string,
  platform: PlatformFilter | undefined
): string {
  return html.replaceAll('{{mount}}', mountPath).replaceAll('{{platform}}', platform ?? '');
}
