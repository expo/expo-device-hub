import { type PlatformFilter } from '../platform-filter';
import { type StreamMode } from '../stream-mode';

/** Fill the runtime values consumed by the exported dashboard shell. */
export function configureClientShell(
  html: string,
  mountPath: string,
  platform: PlatformFilter | undefined,
  streamMode: StreamMode | undefined
): string {
  return html
    .replaceAll('{{mount}}', mountPath)
    .replaceAll('{{platform}}', platform ?? '')
    .replaceAll('{{streamMode}}', streamMode ?? '');
}
