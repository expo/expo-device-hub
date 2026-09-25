import type { DeviceLogFields } from "./device-log-format";
import type { LogSnapshotLine } from "./logs-poll";

export type DisplayLine = DeviceLogFields & { id: number };
export type LogRows = { lines: DisplayLine[]; held: DisplayLine[]; paused: boolean; nextId: number };
export const EMPTY_LOG_ROWS: LogRows = { lines: [], held: [], paused: false, nextId: 1 };
const MAX_LOG_ROWS = 2000;
const capRows = (rows: DisplayLine[]): DisplayLine[] => rows.slice(-MAX_LOG_ROWS);

type LogRowsAction =
  | { type: "reset" | "clear" | "toggle-pause" }
  | { type: "append"; batch: LogSnapshotLine[] };

export function updateLogRows(state: LogRows, action: LogRowsAction): LogRows {
  switch (action.type) {
    case "reset": return EMPTY_LOG_ROWS;
    case "clear": return { ...state, lines: [], held: [] };
    case "toggle-pause":
      return state.paused
        ? { ...state, paused: false, lines: capRows([...state.lines, ...state.held]), held: [] }
        : { ...state, paused: true };
    case "append": {
      const rows = action.batch.map((line, index) => ({ ...line.fields, id: state.nextId + index }));
      const next = { ...state, nextId: state.nextId + rows.length };
      return state.paused
        ? { ...next, held: capRows([...state.held, ...rows]) }
        : { ...next, lines: capRows([...state.lines, ...rows]) };
    }
  }
}
