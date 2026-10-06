import type { Feature } from '@expo/hub-client';
import { Button } from '../primitives';
import { SectionNote } from './SectionNote';

/** Shared feedback; existing content stays visible during refresh and failure. */
export function FeatureNotice({ feature }: { feature: Feature<unknown> }) {
  if (feature.status === 'resolving') return <SectionNote>Checking availability…</SectionNote>;
  if (feature.status === 'loading')
    return <SectionNote>{feature.data === undefined ? 'Loading…' : 'Refreshing…'}</SectionNote>;
  if (feature.status === 'reconnecting')
    return <SectionNote role="status">{`${feature.error.message} Retrying…`}</SectionNote>;
  if (feature.status === 'error')
    return (
      <>
        <SectionNote role="alert">{feature.error.message}</SectionNote>
        {feature.error.retryable && (
          <Button theme="secondary" size="xs" onClick={feature.refresh}>
            Retry
          </Button>
        )}
      </>
    );
  return null;
}
