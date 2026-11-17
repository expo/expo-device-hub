export const UNSUPPORTED_INSTALL_FORMAT =
  "Simulator installs require a Simulator .app bundle or .tar.gz/.tgz archive. Device .ipa builds and .zip archives are not supported.";

export function isUnsupportedAppArchive(name: string): boolean {
  return /\.(?:ipa|zip)$/i.test(name);
}

/** Starts the error of an `app.install` with `launch` that installed the app but could not open it. */
export const APP_NOT_OPENED = "The app was installed but did not open.";
