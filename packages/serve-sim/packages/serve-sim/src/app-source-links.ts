import { posix } from "node:path";
import { MAX_SYMLINK_HOPS } from "./host-paths";

export type AppSourceLink = { target: string; hard?: boolean };

/** Resolve measured names, never filesystem aliases, before creating or copying links. */
// @ref LLP 0003#installing-a-simulator-app — links must use exact entry names inside the source
export function resolveAppSourceLink(
  name: string,
  paths: ReadonlyMap<string, boolean>,
  links: ReadonlyMap<string, AppSourceLink>,
  check?: () => void,
): string {
  const pending = name.split("/");
  const resolved: string[] = [];
  let hops = 0;
  const invalid = () =>
    new Error("App source contains an unsafe link; use relative targets and exact entry names.");
  while (pending.length) {
    check?.();
    const component = pending.shift()!;
    if (!component || component === ".") continue;
    if (component === "..") {
      if (!resolved.length) throw invalid();
      resolved.pop();
      continue;
    }
    const entry = [...resolved, component].join("/");
    const link = links.get(entry);
    if (link) {
      if (posix.isAbsolute(link.target)) throw invalid();
      if (++hops > MAX_SYMLINK_HOPS)
        throw new Error("App source contains a cyclic or excessive link chain.");
      if (link.hard) resolved.length = 0;
      pending.unshift(...link.target.split("/"));
    } else {
      const directory = paths.get(entry);
      if (directory === undefined || (pending.length > 0 && !directory)) throw invalid();
      resolved.push(component);
    }
  }
  return resolved.join("/");
}
