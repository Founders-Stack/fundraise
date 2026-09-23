import { timingSafeEqual } from "node:crypto";

/**
 * Bearer-token auth for API routes.
 * A request with `Authorization: Bearer <FS_API_TOKEN>` is the issuer/admin
 * principal (used by the fstack MCP server / skills). Anything else is public.
 */
export type Principal = { kind: "issuer" } | { kind: "public" };

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function getPrincipal(req: Request): Principal {
  const expected = process.env.FS_API_TOKEN;
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (expected && match && safeEqual(match[1], expected)) return { kind: "issuer" };
  return { kind: "public" };
}

export function isIssuer(req: Request): boolean {
  return getPrincipal(req).kind === "issuer";
}

/** Returns a 401 Response if the request is not the issuer principal, else null. */
export function requireIssuer(req: Request): Response | null {
  if (!process.env.FS_API_TOKEN) {
    return Response.json({ error: "server_misconfigured", message: "FS_API_TOKEN is not set" }, { status: 500 });
  }
  if (isIssuer(req)) return null;
  return Response.json(
    { error: "unauthorized", message: "Missing or invalid bearer token" },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="fstack"' } },
  );
}
