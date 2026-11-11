import { UNSUPPORTED_INSTALL_FORMAT } from "../../app-install-format";
import { APP_FOLDER_GUIDANCE, APP_FOLDER_UNREADABLE } from "./app-drop-folder";
import type { DropKind } from "./drop";

export type UploadErrorText = {
  /** Names the file. */
  title: string;
  /** What to do next, or the first line of a host error. */
  body: string;
  /** The full error text, when the body shows only part of it. */
  details?: string;
};

const DROP_AN_APP = "Drop a Simulator .app folder or a .tar.gz archive.";
// About two lines of body text in the 320px toast.
const BODY_MAX_CHARS = 90;

export function describeUploadError(name: string, kind: DropKind, message = ""): UploadErrorText {
  if (message === UNSUPPORTED_INSTALL_FORMAT) {
    const body = /\.ipa$/i.test(name)
      ? `This is a device build. ${DROP_AN_APP}`
      : /\.zip$/i.test(name)
        ? "Zip archives are not supported. Drop the .app folder or a .tar.gz archive."
        : DROP_AN_APP;
    return { title: `Cannot install ${name}`, body };
  }
  if (message === APP_FOLDER_GUIDANCE) {
    return { title: `${name} is not a Simulator app`, body: DROP_AN_APP };
  }
  if (message.startsWith(APP_FOLDER_UNREADABLE)) {
    const cause = message.slice(APP_FOLDER_UNREADABLE.length).trim();
    return {
      title: `Cannot read ${name}`,
      body: "Drop a .tar.gz archive instead. Archives keep symlinks and file permissions; folder drops can lose them.",
      details: cause || undefined,
    };
  }
  const text = message.trim() || (kind === "app" ? "Installation failed" : "Upload failed");
  const body = text.split(/\r?\n/, 1)[0]!.trim();
  return {
    title: kind === "app" ? `Could not install ${name}` : `Could not add ${name} to Photos`,
    body,
    details: text !== body || body.length > BODY_MAX_CHARS ? text : undefined,
  };
}
