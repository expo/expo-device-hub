import {
  STREAM_MODES,
  type StreamMode,
} from "./shared/api-contracts.ts";

const EMULATOR_SERIAL = /^emulator-(\d+)$/;

export type EmulatorSerial = {
  consolePort: string;
};

export function parseEmulatorSerial(serial: string): EmulatorSerial | null {
  const match = serial.match(EMULATOR_SERIAL);
  return match ? { consolePort: match[1]! } : null;
}

export function isEmulatorSerial(serial: string): boolean {
  return parseEmulatorSerial(serial) !== null;
}

export function availableStreamModesForSerial(serial: string): StreamMode[] {
  return isEmulatorSerial(serial) ? [...STREAM_MODES] : ["scrcpy"];
}
