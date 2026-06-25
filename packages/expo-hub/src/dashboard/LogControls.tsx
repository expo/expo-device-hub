import { Button } from '../../components/Button';

/**
 * Attach / Detach / Clear controls for the logs panel. Logs are off by default,
 * so the user opts in with Attach and stops streaming with Detach (kept lines
 * remain); Clear drops the collected lines.
 */
export function LogControls({
  enabled,
  hasLogs,
  onAttach,
  onDetach,
  onClear,
}: {
  enabled: boolean;
  hasLogs: boolean;
  onAttach: () => void;
  onDetach: () => void;
  onClear: () => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <Button size="2xs" theme="secondary" disabled={enabled} onClick={onAttach}>
        Attach
      </Button>
      <Button size="2xs" theme="secondary" disabled={!enabled} onClick={onDetach}>
        Detach
      </Button>
      <Button size="2xs" theme="tertiary" disabled={!hasLogs} onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
