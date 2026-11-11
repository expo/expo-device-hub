import { describe, expect, test } from "bun:test";
import { UNSUPPORTED_INSTALL_FORMAT } from "../app-install-format";
import { APP_FOLDER_GUIDANCE, APP_FOLDER_UNREADABLE } from "../client/utils/app-drop-folder";
import { describeUploadError } from "../client/utils/upload-error";

describe("describeUploadError", () => {
  test.each([
    [
      "device-build.ipa",
      "This is a device build. Drop a Simulator .app folder or a .tar.gz archive.",
    ],
    ["Build.ZIP", "Zip archives are not supported. Drop the .app folder or a .tar.gz archive."],
  ])("says why %s cannot be installed", (name, body) => {
    expect(describeUploadError(name, "media", UNSUPPORTED_INSTALL_FORMAT)).toEqual({
      title: `Cannot install ${name}`,
      body,
    });
  });

  test("names a folder that is not an app", () => {
    expect(describeUploadError("Photos", "app", APP_FOLDER_GUIDANCE)).toEqual({
      title: "Photos is not a Simulator app",
      body: "Drop a Simulator .app folder or a .tar.gz archive.",
    });
  });

  test("suggests an archive for an unreadable folder and keeps the browser error", () => {
    const text = describeUploadError("App.app", "app", `${APP_FOLDER_UNREADABLE}\naccess denied.`);
    expect(text.title).toBe("Cannot read App.app");
    expect(text.body).toContain("Archives keep symlinks");
    expect(text.details).toBe("access denied.");
    expect(describeUploadError("App.app", "app", APP_FOLDER_UNREADABLE).details).toBeUndefined();
  });

  test("shows the first line of a host error and keeps the full text as details", () => {
    expect(describeUploadError("App.tgz", "app", "  first line\r\nsecond line\n")).toEqual({
      title: "Could not install App.tgz",
      body: "first line",
      details: "first line\r\nsecond line",
    });
  });

  test("keeps a short one-line error without details", () => {
    expect(describeUploadError("clip.mov", "media", "File too large (max 500MB)")).toEqual({
      title: "Could not add clip.mov to Photos",
      body: "File too large (max 500MB)",
    });
  });

  test("moves a long one-line error into details and falls back to a generic message", () => {
    const long = "x".repeat(91);
    expect(describeUploadError("App.tgz", "app", long)).toMatchObject({
      body: long,
      details: long,
    });
    expect(describeUploadError("App.tgz", "app")).toEqual({
      title: "Could not install App.tgz",
      body: "Installation failed",
    });
  });
});
