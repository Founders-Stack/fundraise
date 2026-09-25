import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/server/http";

/**
 * Bearer-token auth for API routes. `Authorization: Bearer <token>` resolves to:
 *  - admin:  the FS_API_TOKEN env token (the team; sees and manages every issuance)
 *  - issuer: a wallet API key (`fsk_…`, minted by wallet login); manages only issuances its wallet owns
 *  - public: anything else
 */
export type Principal = { kind: "admin" } | { kind: "issuer"; wallet: string; keyId: string } | { kind: "public" };

export const API_KEY_PREFIX = "fsk_";

export const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function getPrincipal(req: Request): Promise<Principal> {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return { kind: "public" };
  const token = match[1];

  const admin = process.env.FS_API_TOKEN;
  if (admin && safeEqual(token, admin)) return { kind: "admin" };

  if (token.startsWith(API_KEY_PREFIX)) {
    const key = await prisma.apiKey.findUnique({ where: { tokenHash: hashApiKey(token) } });
    if (key && !key.revokedAt) {
      // Best effort: a failed touch must not fail the request.
      prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
      return { kind: "issuer", wallet: key.wallet, keyId: key.id };
    }
  }
  return { kind: "public" };
}

/** True for admin and wallet-key callers (used to gate issuer-only views). */
export async function isIssuer(req: Request): Promise<boolean> {
  return (await getPrincipal(req)).kind !== "public";
}

const UNAUTHORIZED = () =>
  Response.json(
    { error: "unauthorized", message: "Missing or invalid bearer token" },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="fstack"' } },
  );

/** The authenticated principal, or a 401 Response (`if (auth instanceof Response) return auth;`). */
export async function requireIssuer(req: Request): Promise<Exclude<Principal, { kind: "public" }> | Response> {
  const principal = await getPrincipal(req);
  return principal.kind === "public" ? UNAUTHORIZED() : principal;
}

/** Prisma `where` fragment limiting an issuance query to what the principal may manage. */
export function ownerScope(principal: Principal): { ownerWallet?: string } {
  if (principal.kind === "issuer") return { ownerWallet: principal.wallet };
  if (principal.kind === "admin") return {};
  return { ownerWallet: "" }; // matches nothing: real owners are never the empty string
}

export function canManage(principal: Principal, ownerWallet: string | null): boolean {
  if (principal.kind === "admin") return true;
  return principal.kind === "issuer" && ownerWallet !== null && ownerWallet === principal.wallet;
}

/** Throws 403 unless the principal owns the issuance (admin always may). */
export async function assertOwnsIssuance(principal: Principal, issuanceId: string): Promise<void> {
  const row = await prisma.issuance.findUnique({ where: { id: issuanceId }, select: { ownerWallet: true } });
  if (!row) throw new HttpError(404, "issuance_not_found", `No issuance ${issuanceId}`);
  if (!canManage(principal, row.ownerWallet)) {
    throw new HttpError(403, "not_owner", "This issuance belongs to a different wallet");
  }
}

/** Same check, starting from a distribution id. */
export async function assertOwnsDistribution(principal: Principal, distributionId: string): Promise<void> {
  const row = await prisma.distribution.findUnique({ where: { id: distributionId }, select: { issuanceId: true } });
  if (!row) throw new HttpError(404, "distribution_not_found", `No distribution ${distributionId}`);
  await assertOwnsIssuance(principal, row.issuanceId);
}
