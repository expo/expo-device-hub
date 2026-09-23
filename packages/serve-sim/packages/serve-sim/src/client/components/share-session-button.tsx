import { Share } from "lucide-react";
import { toast as sonnerToast } from "sonner";
import { ShareLinkToastContent } from "./app-toasts";
import { IconButton } from "./icon-button";
import {
  copyTextToClipboard,
  previewShareUrl,
  type ShareConfig,
  shareLinkCarriesToken,
} from "../utils/share-link";

const SHARE_TOAST_ID = "share-session-link";
const COPIED_TOAST_MS = 4500;
// This toast shows the URL for the reader to copy by hand, so leave time to select it.
const MANUAL_COPY_TOAST_MS = 15_000;

export function ShareSessionButton({ config }: { config: ShareConfig | null | undefined }) {
  const carriesToken = shareLinkCarriesToken(config);

  const share = async () => {
    const url = previewShareUrl(window.location, config);
    const copied = await copyTextToClipboard(url);
    sonnerToast.custom(() => <ShareLinkToastContent toast={{ url, copied, carriesToken }} />, {
      id: SHARE_TOAST_ID,
      duration: copied ? COPIED_TOAST_MS : MANUAL_COPY_TOAST_MS,
    });
  };

  return (
    <IconButton
      onClick={() => void share()}
      aria-label="Share session"
      title={carriesToken ? "Copy share link (includes access token)" : "Copy share link"}
    >
      <Share size={18} strokeWidth={1.75} />
    </IconButton>
  );
}
