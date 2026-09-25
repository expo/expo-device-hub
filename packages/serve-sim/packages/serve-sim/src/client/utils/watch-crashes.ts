import type { CrashStreamFrame } from "../../crash/protocol";
import { parseCrashFrame } from "./crash-stream";
import { openHostEventStream } from "./exec";

export function watchCrashes(
  path: string,
  onFrame: (frame: CrashStreamFrame) => void,
  onError: () => void,
): () => void {
  const stream = openHostEventStream(path);
  stream.onmessage = ({ data }) => {
    const frame = parseCrashFrame(data);
    if (frame) onFrame(frame);
  };
  stream.onerror = onError;
  return () => stream.close();
}
