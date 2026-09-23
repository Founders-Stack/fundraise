// Tiny fetch client for the Founder Stack API. Owns no logic: it forwards the
// bearer token and returns the API's JSON (or a structured error).

export const FS_API_URL = (process.env.FS_API_URL || "http://localhost:3000/api").replace(/\/+$/, "");
const FS_API_TOKEN = process.env.FS_API_TOKEN || "";

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`FS API ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
}

export async function api<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (FS_API_TOKEN) headers.authorization = `Bearer ${FS_API_TOKEN}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(`${FS_API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw text */
  }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed as T;
}
