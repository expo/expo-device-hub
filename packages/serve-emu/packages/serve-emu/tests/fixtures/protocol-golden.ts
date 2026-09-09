export const GOLDEN_SCRCPY_VERSION = "4.0";
export const SCRCPY_VERSION_DOC_MARKER =
  `<!-- scrcpy-server-version: ${GOLDEN_SCRCPY_VERSION} -->`;

/** Exact compact byte examples mirrored by docs/protocol.md. */
export const PROTOCOL_GOLDEN_HEX = {
  "v3-preamble-tail": "683236340000043800000780",
  "v4-preamble-tail": "68323634800000000000043800000780",
  "v3-key-header": "400000000000002a00000004",
  "v4-key-header": "200000000000002a00000004",
  "v4-resize": "800000010000043800000780",
  "semu-v1": "53454d5501010000000000000000002a",
  "semu-v2": "53454d5502010000000000000000002a00000000000f4240",
} as const;

export type ProtocolGoldenName = keyof typeof PROTOCOL_GOLDEN_HEX;

export function goldenBytes(name: ProtocolGoldenName): Uint8Array {
  const hex = PROTOCOL_GOLDEN_HEX[name];
  const bytes = new Uint8Array(hex.length / 2);
  for (let offset = 0; offset < hex.length; offset += 2) {
    bytes[offset / 2] = Number.parseInt(hex.slice(offset, offset + 2), 16);
  }
  return bytes;
}
