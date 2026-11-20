export async function readReleaseManifest(path: string | undefined): Promise<string[]> {
  if (!path) throw new Error("Expected a release manifest path.");
  const contents = (await Bun.file(path).text()).trim();
  if (!contents) throw new Error("The release manifest is empty.");
  return contents.split(/\r?\n/);
}
