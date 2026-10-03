type FramePermission = "clipboard-read";

type PermissionsPolicy = { allowsFeature(feature: string): boolean };
type PolicyDocument = Document & { permissionsPolicy?: PermissionsPolicy; featurePolicy?: PermissionsPolicy };

/** On a failed read, an uninspectable frame policy may be the cause. */
export function frameMayNeedPermissionAfterFailure(permission: FramePermission, browserHasReadApi: boolean): boolean {
  if (!browserHasReadApi) return false;
  if (window.parent === window) return false;
  const doc: PolicyDocument = document;
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  return !policy || !policy.allowsFeature(permission);
}

const REQUESTED_KEY = "serve-sim:frame-permission-requested:";

/** Asks the embedding page, which ignores questions it has answered and reloads this frame when it grants. */
export function requestFramePermission(permission: FramePermission): void {
  try {
    window.sessionStorage.setItem(`${REQUESTED_KEY}${permission}`, "1");
  } catch {}
  // The request carries no data, so any target origin is safe.
  window.parent.postMessage({ type: "serve-sim:permission-request", permission }, "*");
}

/** True once, on the first load after the embedding page granted a permission this page asked for. */
export function takeFramePermissionGrant(permission: FramePermission): boolean {
  try {
    const key = `${REQUESTED_KEY}${permission}`;
    if (!window.sessionStorage.getItem(key)) return false;
    if (window.parent === window) {
      window.sessionStorage.removeItem(key);
      return false;
    }
    const doc: PolicyDocument = document;
    const policy = doc.permissionsPolicy ?? doc.featurePolicy;
    if (!policy?.allowsFeature(permission)) return false;
    window.sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
