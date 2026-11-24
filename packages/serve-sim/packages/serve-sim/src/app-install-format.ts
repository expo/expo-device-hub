export const UNSUPPORTED_INSTALL_FORMAT =
  "Simulator installs require a Simulator .app bundle or .tar.gz/.tgz archive. Device .ipa builds and .zip archives are not supported.";

export function isUnsupportedAppArchive(name: string): boolean {
  return /\.(?:ipa|zip)$/i.test(name);
}
