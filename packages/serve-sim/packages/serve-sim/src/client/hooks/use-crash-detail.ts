import { useEffect, useMemo, useState } from "react";
import type { CrashDetailResponse } from "../../crash/protocol";
import type { CrashSummary } from "../../crash/store";
import { createCrashDetailController, EMPTY_CRASH_DETAIL } from "../utils/crash-detail";
import { crashDetailUrl } from "../utils/crash-format";
import { simAuthHeaders } from "../utils/sim-endpoint";

export function useCrashDetail(path: string, crashes: CrashSummary[]) {
  const [state, setState] = useState(EMPTY_CRASH_DETAIL);
  const controller = useMemo(() => createCrashDetailController(async (id, occurrence, signal, key) => {
    const response = await fetch(crashDetailUrl(path, id, occurrence, key), { headers: simAuthHeaders(), signal });
    if (!response.ok) throw new Error(`Crash detail request failed (${response.status}).`);
    return await response.json() as CrashDetailResponse;
  }, setState), [path]);
  useEffect(() => {
    setState(EMPTY_CRASH_DETAIL);
    return () => controller.dispose();
  }, [controller]);
  useEffect(() => controller.sync(crashes), [controller, crashes]);
  return { ...state, load: controller.load, select: controller.select, step: controller.step, close: controller.close };
}
