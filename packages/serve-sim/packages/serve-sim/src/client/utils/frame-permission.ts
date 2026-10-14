type FramePermission = "clipboard-read";

type PermissionsPolicy = { allowsFeature(feature: string): boolean };
type PolicyDocument = Document & { permissionsPolicy?: PermissionsPolicy; featurePolicy?: PermissionsPolicy };

function framePolicy(): PermissionsPolicy | undefined {
  const doc: PolicyDocument = document;
  return doc.permissionsPolicy ?? doc.featurePolicy;
}

/**
 * After a failed clipboard read in a frame, true when the browser has `readText` and the frame
 * policy lacks clipboard-read, or the browser has no policy API to check it. Without `readText`,
 * a grant cannot help, so the embedding page would reload the frame for nothing.
 */
export function shouldAskFrameForClipboardRead(): boolean {
  if (window.parent === window) return false;
  if (typeof navigator.clipboard?.readText !== "function") return false;
  const policy = framePolicy();
  return !policy || !policy.allowsFeature("clipboard-read");
}

const REQUESTED_KEY = "serve-sim:frame-permission-requested:";

/**
 * Asks the embedding page, which ignores questions it has answered and reloads this frame when it grants.
 * @ref LLP 0010#framed-previews — why the embedding page, not the preview, grants clipboard-read
 */
export function requestFramePermission(permission: FramePermission): void {
  try {
    window.sessionStorage.setItem(`${REQUESTED_KEY}${permission}`, "1");
  } catch {}
  // The request carries no data, so any target origin is safe.
  window.parent.postMessage({ type: "serve-sim:permission-request", permission }, "*");
}

/**
 * On a later load in the same tab, after this page asked the embedding page for a permission:
 * "allowed" when the frame policy now has it, "unknown" when the browser has no policy API to check it.
 */
export function takeFramePermissionGrant(permission: FramePermission): "allowed" | "unknown" | null {
  try {
    const key = `${REQUESTED_KEY}${permission}`;
    if (!window.sessionStorage.getItem(key)) return null;
    if (window.parent === window) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    const policy = framePolicy();
    if (policy && !policy.allowsFeature(permission)) return null;
    window.sessionStorage.removeItem(key);
    return policy ? "allowed" : "unknown";
  } catch {
    return null;
  }
}

/** A frame grant does not lift a denial that the browser has recorded for this page. */
export async function browserMayAllow(permission: FramePermission): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: permission as PermissionName });
    return status.state !== "denied";
  } catch {
    return true;
  }
}
