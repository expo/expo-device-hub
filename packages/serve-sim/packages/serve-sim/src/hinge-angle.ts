export const HINGE_POSITIONS = [
  { name: "fold", label: "Fold", angle: 0 },
  { name: "half", label: "Half Fold", angle: 90 },
  { name: "unfold", label: "Unfold", angle: 180 },
] as const;

export function isHingeAngle(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 180;
}

export function parseHingeAngle(value: string): number | undefined {
  const normalized = value.trim().toLowerCase();
  const position = HINGE_POSITIONS.find((p) => p.name === normalized);
  if (position) return position.angle;
  if (!normalized) return undefined;
  const angle = Number(normalized);
  return isHingeAngle(angle) ? angle : undefined;
}

export type HingeAngleResult = {
  ok: boolean;
  angle?: number;
  error?: string;
};
