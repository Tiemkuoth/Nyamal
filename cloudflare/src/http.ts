export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected a JSON object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid JSON");
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ detail: error.message }, error.status);
  console.error("Request failed", error);
  return json({ detail: "Internal server error" }, 500);
}

export function requiredString(
  value: unknown,
  name: string,
  minLength = 1,
  maxLength = 4000,
): string {
  if (typeof value !== "string" || value.trim().length < minLength || value.length > maxLength) {
    throw new HttpError(400, `${name} must be a string of ${minLength}..${maxLength} characters`);
  }
  return value.trim();
}

export function boundedInteger(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, `${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}
