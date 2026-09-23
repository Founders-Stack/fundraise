// Small HTTP helpers shared by the issuance routes.
import { json } from "@/lib/json";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Runs a route body; HttpError → structured JSON error, anything else → 500. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.code, message: err.message, details: err.details }, { status: err.status });
    }
    console.error(err);
    return json({ error: "internal_error", message: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object");
  }
}

export function appUrl(): string {
  return (process.env.PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
}

export function parseBaseUnits(v: unknown, field: string): bigint {
  const s = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== "string" || !/^\d+$/.test(s)) {
    throw new HttpError(400, "invalid_input", `${field} must be a non-negative integer string (base units)`);
  }
  return BigInt(s);
}
