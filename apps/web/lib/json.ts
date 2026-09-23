/** JSON response that serializes BigInt (Prisma BigInt columns) as strings. */
export function json(data: unknown, init?: ResponseInit): Response {
  const body = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return new Response(body, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}
