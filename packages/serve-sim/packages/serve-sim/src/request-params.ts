export function booleanParam(params: URLSearchParams, name: string): boolean {
  const raw = params.get(name);
  if (raw === null) return false;
  const value = raw.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "no";
}
