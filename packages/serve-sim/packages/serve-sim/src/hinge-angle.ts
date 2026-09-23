export const HINGE_POSITIONS = [
  { label: "Fold", angle: 0 },
  { label: "Half Fold", angle: 90 },
  { label: "Unfold", angle: 180 },
] as const;

export function isHingeAngle(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 180;
}

export function parseHingeAngle(value: string): number | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "fold") return 0;
  if (normalized === "half") return 90;
  if (normalized === "unfold") return 180;
  if (!normalized) return undefined;
  const angle = Number(normalized);
  return isHingeAngle(angle) ? angle : undefined;
}

export type HingeAngleResult = {
  ok: boolean;
  angle?: number;
  error?: string;
};
