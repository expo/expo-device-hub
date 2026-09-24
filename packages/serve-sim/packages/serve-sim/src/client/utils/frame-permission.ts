export type FramePermission = "camera" | "clipboard-read";

type PermissionsPolicy = { allowsFeature(feature: string): boolean };
type PolicyDocument = Document & { permissionsPolicy?: PermissionsPolicy; featurePolicy?: PermissionsPolicy };

/** True when this page is framed and the embedding page has not granted the permission. */
export function framePolicyBlocks(permission: FramePermission): boolean {
  if (window.parent === window) return false;
  const doc: PolicyDocument = document;
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  return policy ? !policy.allowsFeature(permission) : false;
}

const REQUESTED_KEY = "serve-sim:frame-permission-requested:";

/** Asks the embedding page at most once per tab until it grants; it reloads this frame when it does. */
export function requestFramePermission(permission: FramePermission): void {
  try {
    if (window.sessionStorage.getItem(`${REQUESTED_KEY}${permission}`)) return;
    window.sessionStorage.setItem(`${REQUESTED_KEY}${permission}`, "1");
  } catch {}
  // The request carries no data, so any target origin is safe.
  window.parent.postMessage({ type: "serve-sim:permission-request", permission }, "*");
}

/** True once, on the first load after the embedding page granted a permission this page asked for. */
export function takeFramePermissionGrant(permission: FramePermission): boolean {
  try {
    if (!window.sessionStorage.getItem(`${REQUESTED_KEY}${permission}`) || framePolicyBlocks(permission)) {
      return false;
    }
    window.sessionStorage.removeItem(`${REQUESTED_KEY}${permission}`);
    return true;
  } catch {
    return false;
  }
}
