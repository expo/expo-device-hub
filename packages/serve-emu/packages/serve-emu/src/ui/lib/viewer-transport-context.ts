import { createContext, useContext } from "react";
import type { StreamTransport } from "../../stream-settings";

export type ViewerTransportControls = {
  transport: StreamTransport | null;
  availableTransports: readonly StreamTransport[];
  switchingTo: StreamTransport | null;
  error: string | null;
  selectTransport: (transport: StreamTransport) => void;
  statsDownloadStatus: "idle" | "downloading" | "complete" | "error";
  statsDownloadMessage: string | null;
  downloadStats: () => void | Promise<void>;
};

export const ViewerTransportControlsContext =
  createContext<ViewerTransportControls | null>(null);

export function useViewerTransportControls(): ViewerTransportControls | null {
  return useContext(ViewerTransportControlsContext);
}
