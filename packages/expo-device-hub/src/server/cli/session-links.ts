import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Keep bearer links accessible to the operator without writing them to captured output. */
export function saveSessionLinks(links: readonly string[]): { path: string; remove(): void } {
  const directory = mkdtempSync(join(tmpdir(), 'expo-device-hub-'));
  const path = join(directory, 'dashboard-links.txt');
  const remove = () => rmSync(directory, { recursive: true, force: true });
  try {
    writeFileSync(path, `${links.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    remove();
    throw error;
  }
  return { path, remove };
}
