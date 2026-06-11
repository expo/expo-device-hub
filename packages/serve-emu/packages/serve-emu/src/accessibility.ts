import { spawnSync } from "node:child_process";

export type AccessibilityNode = {
  id: string;
  text: string;
  contentDescription: string;
  resourceId: string;
  className: string;
  packageName: string;
  clickable: boolean;
  enabled: boolean;
  bounds: { left: number; top: number; right: number; bottom: number };
};

export type AccessibilitySnapshot = {
  ok: true;
  capturedAt: string;
  nodes: AccessibilityNode[];
};

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attrsFor(node: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of node.matchAll(/\s([a-zA-Z0-9_-]+)="([^"]*)"/g)) {
    attrs[match[1]!] = decodeXml(match[2] ?? "");
  }
  return attrs;
}

function parseBounds(value: string | undefined) {
  const match = value?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return null;
  return {
    left: Number(match[1]),
    top: Number(match[2]),
    right: Number(match[3]),
    bottom: Number(match[4]),
  };
}

function boolAttr(value: string | undefined): boolean {
  return value === "true";
}

function dumpXml(serial: string): string {
  const path = `/sdcard/window-${Date.now()}.xml`;
  const command = `uiautomator dump ${path} >/dev/null && cat ${path} && rm ${path}`;
  const result = spawnSync("adb", ["-s", serial, "shell", "sh", "-c", command], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 8_000,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "uiautomator dump failed").trim());
  }
  return result.stdout;
}

export function getAccessibilitySnapshot(serial: string): AccessibilitySnapshot {
  const xml = dumpXml(serial);
  const nodes: AccessibilityNode[] = [];
  let index = 0;
  for (const match of xml.matchAll(/<node\b[^>]*>/g)) {
    const attrs = attrsFor(match[0]);
    const bounds = parseBounds(attrs.bounds);
    if (!bounds || bounds.right <= bounds.left || bounds.bottom <= bounds.top) continue;
    nodes.push({
      id: `${index++}`,
      text: attrs.text ?? "",
      contentDescription: attrs["content-desc"] ?? "",
      resourceId: attrs["resource-id"] ?? "",
      className: attrs.class ?? "",
      packageName: attrs.package ?? "",
      clickable: boolAttr(attrs.clickable),
      enabled: boolAttr(attrs.enabled),
      bounds,
    });
  }
  return { ok: true, capturedAt: new Date().toISOString(), nodes };
}
