import { useEffect, useReducer, useState } from "react";
import { EMPTY_LOG_ROWS, updateLogRows } from "../utils/log-rows";
import { startLogsPoll } from "../utils/logs-poll";

export function useDeviceLogs(path: string, open: boolean) {
  const [rows, dispatch] = useReducer(updateLogRows, EMPTY_LOG_ROWS);
  const [errored, setErrored] = useState(false);
  useEffect(() => {
    if (!open) return;
    dispatch({ type: "reset" });
    setErrored(false);
    let since = 0;
    return startLogsPoll(path, {
      getSince: () => since,
      setSince: (seq) => { since = seq; },
      onBatch: (batch) => dispatch({ type: "append", batch }),
      onError: setErrored,
    });
  }, [open, path]);
  return {
    lines: rows.lines,
    paused: rows.paused,
    errored,
    clear: () => dispatch({ type: "clear" }),
    togglePause: () => dispatch({ type: "toggle-pause" }),
  };
}
