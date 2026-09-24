import { setTimeout as sleep } from "node:timers/promises";
import { isEmulatorSerial } from "./device-capabilities.ts";
import {
  EmulatorGrpcClient,
  ensureEmulatorGrpcEndpoint,
  findLiveEmulatorGrpcEndpoint,
  type GrpcEndpoint,
} from "./emulator-grpc.ts";
import type { FoldPosture, FoldStatus } from "./shared/api-contracts.ts";

const POSTURES: Record<number, FoldPosture> = {
  1: "closed",
  2: "half_opened",
  3: "opened",
  4: "flipped",
  5: "tent",
};

type FoldClient = Pick<EmulatorGrpcClient, "getPhysicalModel" | "setPosture" | "close">;
const activatedEndpoints = new Map<string, GrpcEndpoint>();

async function createReadClient(serial: string): Promise<FoldClient> {
  const endpoint = await findLiveEmulatorGrpcEndpoint(
    serial,
    undefined,
    {},
    activatedEndpoints.get(serial),
  );
  if (!endpoint) {
    activatedEndpoints.delete(serial);
    throw new Error("Fold status requires an active emulator gRPC endpoint");
  }
  activatedEndpoints.set(serial, endpoint);
  return new EmulatorGrpcClient(endpoint);
}

async function createWriteClient(serial: string): Promise<FoldClient> {
  const endpoint = await ensureEmulatorGrpcEndpoint(serial);
  activatedEndpoints.set(serial, endpoint);
  return new EmulatorGrpcClient(endpoint);
}

async function withClient<T>(
  serial: string,
  action: (client: FoldClient) => Promise<T>,
  createClient: (serial: string) => Promise<FoldClient> = createReadClient,
): Promise<T> {
  if (!isEmulatorSerial(serial)) throw new Error("Fold controls require an Android emulator");
  const client = await createClient(serial);
  try {
    return await action(client);
  } finally {
    client.close();
  }
}

async function readFoldStatus(client: FoldClient): Promise<FoldStatus> {
  const [posture, hinge] = await Promise.all([
    client.getPhysicalModel(16),
    client.getPhysicalModel(10),
  ]);
  const postureValue = posture.status === 0 && posture.value !== null
    ? POSTURES[posture.value] ?? null
    : null;
  const hingeAngle = hinge.status === 0 && hinge.value !== null && Number.isFinite(hinge.value)
    ? hinge.value
    : null;
  return {
    supported: hingeAngle !== null,
    posture: hingeAngle !== null ? postureValue : null,
    hingeAngle,
  };
}

export async function getFoldStatus(
  serial: string,
  createClient?: (serial: string) => Promise<FoldClient>,
): Promise<FoldStatus> {
  if (!isEmulatorSerial(serial)) {
    return { supported: false, posture: null, hingeAngle: null };
  }
  return withClient(serial, readFoldStatus, createClient);
}

export async function setFoldPosture(
  serial: string,
  posture: "closed" | "opened",
  createClient?: (serial: string) => Promise<FoldClient>,
): Promise<FoldStatus> {
  return withClient(serial, async (client) => {
    const current = await readFoldStatus(client);
    if (!current.supported) throw new Error("Selected emulator does not support folding");
    await client.setPosture(posture === "closed" ? 1 : 3);
    const deadline = Date.now() + 2_000;
    let status = await readFoldStatus(client);
    while (status.posture !== posture && Date.now() < deadline) {
      await sleep(50);
      status = await readFoldStatus(client);
    }
    if (status.posture !== posture) throw new Error(`Emulator did not confirm ${posture} posture`);
    return status;
  }, createClient ?? createWriteClient);
}
