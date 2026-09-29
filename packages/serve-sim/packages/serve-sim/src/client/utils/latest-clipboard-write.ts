/** Keep browser clipboard writes ordered while discarding results from older Copy actions. */
export function createLatestClipboardWriter(write: (text: string) => Promise<void>) {
  let generation = 0;
  let pending: Promise<void> = Promise.resolve();
  return {
    begin: () => ++generation,
    isCurrent: (value: number) => value === generation,
    write(value: number, text: string, stillSelected: () => boolean): Promise<boolean> {
      const result = pending.catch(() => {}).then(async () => {
        if (value !== generation || !stillSelected()) return false;
        await write(text);
        return true;
      });
      pending = result.then(() => {}, () => {});
      return result;
    },
  };
}
