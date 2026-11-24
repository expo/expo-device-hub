import { type PlatformFilter } from "../platform-filter";
import { type Transport } from "../transport";

/** Fill the runtime values consumed by the exported dashboard shell. */
export function configureClientShell(
  html: string,
  mountPath: string,
  platform: PlatformFilter | undefined,
  transport: Transport | undefined,
  hideSidebar: boolean,
  hideBootDevice: boolean,
  singleDevice?: string,
): string {
  return html
    .replaceAll("{{singleDevice}}", singleDevice ?? "")
    .replaceAll("{{mount}}", mountPath)
    .replaceAll("{{platform}}", platform ?? "")
    .replaceAll("{{transport}}", transport ?? "")
    .replaceAll("{{hideSidebar}}", String(hideSidebar))
    .replaceAll("{{hideBootDevice}}", String(hideBootDevice));
}
