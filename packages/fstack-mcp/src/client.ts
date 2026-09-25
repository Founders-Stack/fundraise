// Tiny fetch client for the Founder Stack API. Owns no logic: it forwards the
// bearer token and returns the API's JSON (or a structured error).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FS_API_URL = (process.env.FS_API_URL || "http://localhost:3000/api").replace(/\/+$/, "");

// Token lookup order: shell env, then `.fstack.env` in the project dir, then `~/.fstack/env`.
// The files are re-read on every request, so an agent can write the key and continue without a restart.
function readTokenFile(path: string): string {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?FS_API_TOKEN\s*=\s*(.*?)\s*$/.exec(line);
      if (m) return m[1].replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch {
    /* file missing or unreadable */
  }
  return "";
}

function resolveToken(): string {
  return (
    process.env.FS_API_TOKEN ||
    readTokenFile(join(process.cwd(), ".fstack.env")) ||
    readTokenFile(join(homedir(), ".fstack", "env"))
  );
}

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
  const token = resolveToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  const timeoutMs = Number(process.env.FS_API_TIMEOUT_MS ?? 120_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("FS_API_TIMEOUT_MS must be a positive integer up to 2147483647");
  }
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${FS_API_URL}${path}`, {
      method,
      signal,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    text = await res.text();
  } catch (error) {
    if (signal.aborted) {
      throw new ApiError(504, {
        error: "api_timeout",
        message: `API request timed out after ${timeoutMs}ms. Its outcome is unknown. Check issuance/distribution status before retrying a mutation.`,
      });
    }
    throw error;
  }
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw text */
  }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed as T;
}
