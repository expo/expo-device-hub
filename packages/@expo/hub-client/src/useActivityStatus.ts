import { useCallback, useState } from "react";

import { type DeviceActivityStatus } from "./types";

/** Keep stream readiness scoped to the device and credentials that produced it. */
export function useActivityStatus(scope: string | null) {
  const initialStatus = scope === null ? "idle" : "loading";
  const [state, setState] = useState<{ scope: string | null; status: DeviceActivityStatus }>({
    scope,
    status: initialStatus,
  });
  if (state.scope !== scope) setState({ scope, status: initialStatus });

  const setActivityStatus = useCallback(
    (status: DeviceActivityStatus) => {
      setState((current) =>
        scope !== null && current.scope === scope && current.status !== status
          ? { scope, status }
          : current,
      );
    },
    [scope],
  );

  return {
    activityStatus: state.scope === scope ? state.status : initialStatus,
    setActivityStatus,
  };
}
