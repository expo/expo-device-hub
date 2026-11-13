import { type AndroidUtilsResult, result } from "./errors";
import { type ListAdbSerialsFn, listAdbSerials } from "./wait-for-adb-offline";

/** Lowest emulator console port; emulator console ports are even. */
export const EMULATOR_PORT_MIN = 5554;
/** Highest emulator console port — adb's emulator serial range tops out at `emulator-5682`. */
export const EMULATOR_PORT_MAX = 5682;

/** Bounds the adb listing, so a stalled adb server fails the boot instead of hanging it. */
const LIST_SERIALS_TIMEOUT_MS = 30_000;

/**
 * Lowest free even emulator console port not held by an emulator adb knows.
 *
 * Scans every serial in `adb devices -l` for `emulator-<port>` entries,
 * whatever their state: an emulator that is still booting or `offline`
 * already holds its console port. Returns the lowest even port in
 * [{@link EMULATOR_PORT_MIN}, {@link EMULATOR_PORT_MAX}] not in use as
 * `value`. A listing failure is returned immediately in `error`, with a `null`
 * value. `listSerialsFn` is injectable for testing.
 *
 * An emulator spawned moments ago may not be listed yet, so two boots at once
 * can still pick the same port; the caller checks which AVD comes online.
 *
 * @throws when every port in the range is taken.
 */
export async function freeEmulatorPort(
  listSerialsFn: ListAdbSerialsFn = listAdbSerials,
): Promise<AndroidUtilsResult<number | null>> {
  const listed = await listSerialsFn({ timeoutMs: LIST_SERIALS_TIMEOUT_MS });
  if (listed.error) return result(null, listed.error);

  const used = new Set<number>();
  for (const serial of listed.value) {
    const port = Number(/^emulator-(\d+)$/.exec(serial)?.[1]);
    if (Number.isFinite(port)) used.add(port);
  }
  for (let port = EMULATOR_PORT_MIN; port <= EMULATOR_PORT_MAX; port += 2) {
    if (!used.has(port)) return result(port);
  }
  throw new Error("No free emulator console port available");
}
