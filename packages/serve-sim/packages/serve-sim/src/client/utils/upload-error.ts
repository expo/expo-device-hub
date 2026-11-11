import { UNSUPPORTED_INSTALL_FORMAT } from "../../app-install-format";
import { APP_FOLDER_GUIDANCE, APP_FOLDER_UNREADABLE } from "./app-drop-folder";
import type { DropKind } from "./drop";

/** The message for a dropped file that is not media, an app folder, or an app archive. */
export const UNSUPPORTED_DROP = "Unsupported file type";

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
  // Host output ends with a newline.
  const text = message.trim();
  if (text === UNSUPPORTED_INSTALL_FORMAT) {
    const body = /\.ipa$/i.test(name)
      ? `This is a device build. ${DROP_AN_APP}`
      : /\.zip$/i.test(name)
        ? "Zip archives are not supported. Drop the .app folder or a .tar.gz archive."
        : // The host rejects an archive without a gzip header.
          `This file is not a valid .tar.gz archive. ${DROP_AN_APP}`;
    return { title: `Cannot install ${name}`, body };
  }
  if (text === UNSUPPORTED_DROP) {
    return {
      title: `Cannot add ${name}`,
      body: "Drop an image, a video, a Simulator .app folder, or a .tar.gz archive.",
    };
  }
  if (text === APP_FOLDER_GUIDANCE) {
    return { title: `${name} is not a Simulator app`, body: DROP_AN_APP };
  }
  if (text.startsWith(APP_FOLDER_UNREADABLE)) {
    const cause = text.slice(APP_FOLDER_UNREADABLE.length).trim();
    return {
      title: `Cannot read ${name}`,
      body: "Drop a .tar.gz archive instead. Folder drops can lose symlinks and file permissions.",
      details: cause || undefined,
    };
  }
  const full = text || (kind === "app" ? "Installation failed" : "Upload failed");
  const body = full.split(/\r?\n/, 1)[0]!.trim();
  return {
    title: kind === "app" ? `Could not install ${name}` : `Could not add ${name} to Photos`,
    body,
    details: full !== body || body.length > BODY_MAX_CHARS ? full : undefined,
  };
}
