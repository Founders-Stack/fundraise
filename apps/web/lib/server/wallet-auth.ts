// Wallet login: the founder signs a one-time challenge with their wallet and receives an API key
// for the MCP server / skills (`FS_API_TOKEN`). The key is shown once; only its sha256 is stored.
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import { API_KEY_PREFIX, hashApiKey } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { HttpError, appUrl } from "./http";
import { verifyAcceptanceSignature } from "./market";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_ACTIVE_KEYS_PER_WALLET = 10;

function parseWallet(v: unknown): string {
  if (typeof v === "string") {
    try {
      if (bs58.decode(v.trim()).length === 32) return v.trim();
    } catch {
      /* fall through */
    }
  }
  throw new HttpError(400, "invalid_wallet", "wallet must be a base58 Solana address");
}

export function loginMessage(p: { wallet: string; nonce: string; issuedAt: Date; expiresAt: Date }): string {
  return [
    "Founder Stack sign-in",
    `Site: ${appUrl()}`,
    `Wallet: ${p.wallet}`,
    `Nonce: ${p.nonce}`,
    `Issued: ${p.issuedAt.toISOString()}`,
    `Expires: ${p.expiresAt.toISOString()}`,
    "",
    "Signing creates an API key for your Founder Stack agent. It costs nothing and moves no funds.",
  ].join("\n");
}

export async function createChallenge(body: Record<string, unknown>) {
  const wallet = parseWallet(body.wallet);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
  const nonce = randomBytes(16).toString("hex");
  const message = loginMessage({ wallet, nonce, issuedAt, expiresAt });
  await prisma.authChallenge.deleteMany({ where: { expiresAt: { lt: new Date(issuedAt.getTime() - 60 * 60 * 1000) } } });
  await prisma.authChallenge.create({ data: { nonce, wallet, message, expiresAt } });
  return { nonce, message, expiresAt: expiresAt.toISOString() };
}

export async function verifyChallenge(body: Record<string, unknown>) {
  const wallet = parseWallet(body.wallet);
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 60) || null : null;

  const challenge = await prisma.authChallenge.findUnique({ where: { nonce } });
  if (!challenge || challenge.wallet !== wallet) {
    throw new HttpError(400, "challenge_not_found", "Unknown challenge: request a new one");
  }
  if (challenge.usedAt) throw new HttpError(409, "challenge_used", "This challenge was already used: request a new one");
  if (challenge.expiresAt < new Date()) throw new HttpError(410, "challenge_expired", "Challenge expired: request a new one");
  if (!verifyAcceptanceSignature(wallet, challenge.message, signature)) {
    throw new HttpError(401, "invalid_signature", "Signature does not match the wallet and challenge");
  }

  // Consume atomically so one signature can mint exactly one key.
  const claimed = await prisma.authChallenge.updateMany({ where: { nonce, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count === 0) throw new HttpError(409, "challenge_used", "This challenge was already used: request a new one");

  const active = await prisma.apiKey.count({ where: { wallet, revokedAt: null } });
  if (active >= MAX_ACTIVE_KEYS_PER_WALLET) {
    throw new HttpError(409, "too_many_keys", `This wallet already has ${MAX_ACTIVE_KEYS_PER_WALLET} active keys: revoke one first`);
  }

  const apiKey = API_KEY_PREFIX + randomBytes(32).toString("base64url");
  const row = await prisma.apiKey.create({ data: { wallet, tokenHash: hashApiKey(apiKey), label } });
  return {
    apiKey,
    keyId: row.id,
    wallet,
    note: "Store this key now: it is not shown again. Set it as FS_API_TOKEN for the fstack MCP server.",
  };
}

/** Revokes a key owned by `wallet` (by id, or the caller's current key). */
export async function revokeKey(wallet: string, keyId: string) {
  const res = await prisma.apiKey.updateMany({ where: { id: keyId, wallet, revokedAt: null }, data: { revokedAt: new Date() } });
  if (res.count === 0) throw new HttpError(404, "key_not_found", "No active key with that id for this wallet");
}

export async function listKeys(wallet: string) {
  const rows = await prisma.apiKey.findMany({ where: { wallet, revokedAt: null }, orderBy: { createdAt: "desc" } });
  return rows.map((k) => ({ id: k.id, label: k.label, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt }));
}
