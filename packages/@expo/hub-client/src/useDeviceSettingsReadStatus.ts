import { useCallback, useState } from "react";

import { type DeviceSettingsStatus } from "./types";

type ReadState = { scope: string | null; status: DeviceSettingsStatus };

/** Settings availability; refreshes keep their settled status until a result changes it. */
export function useDeviceSettingsReadStatus(scope: string | null) {
  const [read, setRead] = useState<ReadState>({ scope: null, status: "idle" });
  const resetRead = useCallback(() => {
    setRead({ scope, status: scope === null ? "idle" : "loading" });
  }, [scope]);
  const settleRead = useCallback(
    (result: "ready" | "error") => {
      setRead((current) => {
        if (scope === null || current.scope !== scope) return current;
        return current.status === result ? current : { scope, status: result };
      });
    },
    [scope],
  );
  const deviceSettingsStatus =
    scope === null ? "idle" : read.scope === scope ? read.status : "loading";

  return { deviceSettingsStatus, resetRead, settleRead };
}
