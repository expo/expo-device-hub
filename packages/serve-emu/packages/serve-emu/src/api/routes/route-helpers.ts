import { ApiError } from "../api-error.ts";
import { readJsonBody } from "../body.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function invalid(message: string, cause?: unknown): never {
  throw new ApiError(400, "invalid_request", message, { cause });
}

export async function readObject(
  request: Request,
  label: string,
  maxBytes?: number,
): Promise<Record<string, unknown>> {
  const value = await readJsonBody(request, maxBytes);
  if (!isRecord(value)) invalid(`${label} must be an object`);
  return value;
}

export function parseInput<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    invalid(error instanceof Error ? error.message : "invalid request", error);
  }
}

export async function downstream<T>(
  operation: string,
  action: () => T | Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      502,
      "downstream_failure",
      `${operation} failed`,
      { cause: error },
    );
  }
}

export function shouldRecord(value: unknown): boolean {
  return !isRecord(value) || value.record !== false;
}

export function requiredString(
  value: unknown,
  name: string,
  maxLength = 512,
): string {
  if (typeof value !== "string" || !value.trim()) invalid(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) invalid(`${name} is too long`);
  return normalized;
}
