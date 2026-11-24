/**
 * A display orientation read that fails without running adb, so `/api` and `/health` report
 * `null` as they do before the first read. For tests that do not check the orientation.
 */
export async function readNoOrientation(): Promise<never> {
  throw new Error("display orientation is not read in this test");
}
