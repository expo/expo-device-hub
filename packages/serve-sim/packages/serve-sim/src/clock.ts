// Intl only, so the browser bundle can import it.
import { isHostAlias } from "./time-zone";

export const HOST_CLOCK = "host";

// Without a zone: read in the simulator's zone, so 09:00 is 09:00 on its clock.
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const ZONED =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-](\d{2}):?(\d{2}))$/i;

/** Milliseconds since 1970 of a wall time read as UTC, or null for a day or time that does not exist. */
function wallTime(fields: readonly string[]): number | null {
  const [year, month, day, hour, minute, second = 0] = fields.map(Number) as number[];
  const time = Date.UTC(year!, month! - 1, day, hour, minute, second);
  const check = new Date(time);
  const exists =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month! - 1 &&
    check.getUTCDate() === day &&
    check.getUTCHours() === hour &&
    check.getUTCMinutes() === minute &&
    check.getUTCSeconds() === second;
  return exists ? time : null;
}

/**
 * "host", a date and time with `Z` or an offset (returned in UTC), or a date and time without
 * one (kept, to read in the simulator's zone); null for anything else.
 */
export function normalizeClock(value: string): string | null {
  const trimmed = value.trim();
  if (isHostAlias(trimmed)) return HOST_CLOCK;
  const local = LOCAL.exec(trimmed);
  if (local) {
    const [, year, month, day, hour, minute, second = "00"] = local;
    if (wallTime(local.slice(1, 7).filter((part) => part !== undefined)) === null) return null;
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  }
  const zoned = ZONED.exec(trimmed);
  if (!zoned) return null;
  const [, date, time, , offsetHours, offsetMinutes] = zoned;
  if (Number(offsetHours ?? 0) > 23 || Number(offsetMinutes ?? 0) > 59) return null;
  if (normalizeClock(`${date}T${time!.slice(0, 5)}`) === null) return null;
  const parsed = Date.parse(trimmed.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const DAY_MS = 86_400_000;

/** How far `zone`'s wall clock is ahead of UTC at `at`, in milliseconds. */
function zoneOffset(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return wall - Math.floor(at / 1000) * 1000;
}

/** Whether a normalized value has no zone of its own, so it is read in the simulator's. */
export function clockNeedsZone(value: string): boolean {
  return LOCAL.test(value);
}

/**
 * Milliseconds since 1970 of a normalized value; one without a zone is read in `zone`. Null for
 * a wall time that daylight saving time skips there; a repeated one is its first occurrence.
 */
export function clockTarget(value: string, zone: string): number | null {
  const local = LOCAL.exec(value);
  if (!local) return Date.parse(value);
  const wall = wallTime(local.slice(1, 7).filter((part) => part !== undefined))!;
  // The offsets a day either side cover one daylight saving change; of the instants that show
  // this wall time there, the earlier is its first occurrence.
  const shown = [zoneOffset(zone, wall - DAY_MS), zoneOffset(zone, wall + DAY_MS)]
    .map((offset) => wall - offset)
    .filter((target) => target + zoneOffset(zone, target) === wall);
  return shown.length > 0 ? Math.min(...shown) : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `zone`'s wall time at `at`, to the second, as `YYYY-MM-DDTHH:mm:ss`. */
export function zoneWallTime(zone: string, at: number): string {
  const second = Math.floor(at / 1000) * 1000;
  return new Date(second + zoneOffset(zone, second)).toISOString().slice(0, 19);
}

/**
 * The value `clock.get` reports for an offset: host, or the shifted time now as `zone`'s wall
 * time with its offset, so it shows the simulator's clock and still names one instant.
 */
export function clockValue(offsetMs: number, now: number, zone: string): string {
  if (offsetMs === 0) return HOST_CLOCK;
  const at = Math.floor((now + offsetMs) / 1000) * 1000;
  const offset = zoneOffset(zone, at);
  // UTC says so; an offset with seconds (local mean time, before about 1972) has no ISO form.
  if (zone === "UTC" || offset % 60_000 !== 0) {
    return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  const minutes = Math.abs(offset) / 60_000;
  const sign = offset < 0 ? "-" : "+";
  return `${zoneWallTime(zone, at)}${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}
