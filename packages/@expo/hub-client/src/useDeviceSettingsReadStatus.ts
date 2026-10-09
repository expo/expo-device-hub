import { useCallback, useState } from "react";

import { type DeviceSettingsStatus } from "./types";

type ReadState = { scope: string | null; status: DeviceSettingsStatus };

/** Shared initial-read lifecycle; a failed background refresh keeps usable settings ready. */
export function useDeviceSettingsReadStatus(scope: string | null) {
  const [read, setRead] = useState<ReadState>({ scope: null, status: "idle" });
  const resetRead = useCallback(() => {
    setRead({ scope, status: scope === null ? "idle" : "loading" });
  }, [scope]);
  const settleRead = useCallback(
    (result: "ready" | "error") => {
      setRead((current) => {
        if (scope === null || current.scope !== scope) return current;
        const status = result === "ready" || current.status === "ready" ? "ready" : "error";
        return current.status === status ? current : { scope, status };
      });
    },
    [scope],
  );
  const deviceSettingsStatus =
    scope === null ? "idle" : read.scope === scope ? read.status : "loading";

  return { deviceSettingsStatus, resetRead, settleRead };
}
