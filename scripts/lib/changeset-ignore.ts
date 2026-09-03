export async function getChangesetIgnoreList(
  root = process.cwd(),
): Promise<Set<string>> {
  const changesetConfig = await Bun.file(
    `${root}/.changeset/config.json`,
  ).json();
  return new Set<string>(
    Array.isArray(changesetConfig.ignore) ? changesetConfig.ignore : [],
  );
}
