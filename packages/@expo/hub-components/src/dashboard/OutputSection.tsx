import { type DeviceClient } from '@expo/hub-client';
import { LogsSection } from './LogsSection';

/** @deprecated Use {@link LogsSection}. Kept for downstream compatibility. */
export function OutputSection({ client }: { client?: DeviceClient }) {
  return <LogsSection client={client} />;
}
