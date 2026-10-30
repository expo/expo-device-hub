import { isAbsolute } from "node:path";
import { z } from "zod";

const absolutePath = z.string().refine(isAbsolute, "expected an absolute path");

export const simulatorBootIdentitySchema = z.object({
  pid: z.number().int().safe().gt(1),
  startedAt: z.string().regex(/^\d+:\d{1,6}$/),
});

const enrollmentSchema = z
  .object({
    name: z.literal("egressGuard"),
    scope: z.literal("allProcesses"),
    loadPhase: z.literal("startup"),
    dylib: absolutePath,
    bundleId: z.string().nullable().optional(),
    ownerPid: z.null().optional(),
    ownerPids: z.array(z.never()).optional(),
    env: z
      .record(z.string(), z.string())
      .and(z.object({ SERVE_SIM_EGRESS_POLICY_FILE: absolutePath })),
    resident: z.object({
      boot: simulatorBootIdentitySchema.nullable(),
      warmupPolicy: z.enum(["passthrough", "block"]),
      assets: z
        .object({
          hashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
          pageIdentity: z.string().regex(/^\d+:\d+$/),
        })
        .optional(),
    }),
  })
  .refine((record) => record.ownerPid === null || record.ownerPids !== undefined, {
    path: ["ownerPid"],
    message: "requires ownerPid: null or ownerPids: []",
  });

export type ResidentEgressRecord = z.infer<typeof enrollmentSchema> & {
  ownerPid: null;
  bundleId: string | null;
};

// @ref LLP 0007.000#enrollment-and-policy — generic state updates must never discard malformed resident evidence
export function parseResidentEgressRecord(
  key: string,
  value: unknown,
  file: string,
): ResidentEgressRecord {
  if (key !== "egressGuard")
    throw new Error(`Invalid resident egress enrollment in ${file}: capability name ${key}`);
  const result = enrollmentSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(
      `Invalid resident egress enrollment in ${file}: ${issue.path.join(".")} (${issue.message}); preserve its files before repair.`,
    );
  }
  return { ...result.data, ownerPid: null, bundleId: result.data.bundleId ?? null };
}
