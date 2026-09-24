// Signing mode + SignRequest store (SPEC 0.4).
//
//   custody (default, P0): the API signs with server-held keys, as before.
//   wallet  (P1):          mutating calls return a `signUrl` (/sign/[requestId]); the founder opens
//                          it, connects their wallet, signs, and the API verifies + broadcasts.
//
// The mode comes from the request body (`signingMode`) or FS_SIGNING_MODE; default "custody" so
// the demo (scripts/demo-e2e.ts) and existing tests are unchanged.
import type { SignRequest } from "@prisma/client";
import type { UnsignedTx } from "@/lib/chain";
import { prisma } from "@/lib/db";
import { HttpError, appUrl } from "./http";

export type SigningMode = "custody" | "wallet";
export type SignPurpose = "ISSUANCE_CREATE" | "DISTRIBUTION_EXECUTE";
export type SignStatus = "PENDING" | "COMPLETED" | "FAILED" | "EXPIRED";

/** How long a sign link stays valid. Txs are built when the page asks, so blockhashes stay fresh. */
export const SIGN_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export function signingMode(override?: unknown): SigningMode {
  const raw = override ?? process.env.FS_SIGNING_MODE ?? "custody";
  if (raw === "custody" || raw === "wallet") return raw;
  throw new HttpError(400, "invalid_signing_mode", 'signingMode must be "custody" or "wallet"');
}

/** What the sign page shows before the founder signs. Every number is already formatted. */
export interface SignSummary {
  title: string;
  action: string;
  lines: { label: string; value: string }[];
  warning?: string;
  /** Where to go once it's done. */
  doneUrl?: string;
  /** Machine data the flow needs later (e.g. the confirmed total). Not rendered. */
  meta?: Record<string, string>;
}

/** Prepared transactions, stored between build and submit. */
export interface SignPayload {
  txs: UnsignedTx[];
  /** Purpose-specific data (e.g. allocation ids per tx, pool addresses). JSON-safe. */
  data: Record<string, unknown>;
}

const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export const signUrl = (id: string) => `${appUrl()}/sign/${id}`;

/** Returns the open request for this subject, or creates one. */
export async function openSignRequest(purpose: SignPurpose, subjectId: string, summary: SignSummary): Promise<SignRequest> {
  const now = new Date();
  const existing = await prisma.signRequest.findFirst({
    where: { purpose, subjectId, status: "PENDING", expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return prisma.signRequest.update({ where: { id: existing.id }, data: { summaryJson: toJson(summary) } });
  }
  return prisma.signRequest.create({
    data: { purpose, subjectId, summaryJson: toJson(summary), expiresAt: new Date(now.getTime() + SIGN_REQUEST_TTL_MS) },
  });
}

export async function loadSignRequest(id: string): Promise<SignRequest> {
  const row = await prisma.signRequest.findUnique({ where: { id } });
  if (!row) throw new HttpError(404, "not_found", `sign request ${id} not found`);
  if (row.status === "PENDING" && row.expiresAt.getTime() <= Date.now()) {
    return prisma.signRequest.update({ where: { id }, data: { status: "EXPIRED" } });
  }
  return row;
}

export function requirePending(row: SignRequest) {
  if (row.status === "COMPLETED") throw new HttpError(409, "already_completed", "this request was already signed");
  if (row.status === "EXPIRED") throw new HttpError(410, "expired", "this sign link expired; ask your agent for a new one");
  if (row.status !== "PENDING") throw new HttpError(409, "invalid_status", `sign request is ${row.status}`);
}

export const parsePayload = (row: SignRequest): SignPayload | null => (row.payloadJson ? JSON.parse(row.payloadJson) : null);

export async function savePayload(id: string, signer: string, payload: SignPayload) {
  await prisma.signRequest.update({ where: { id }, data: { signer, payloadJson: toJson(payload) } });
}

export async function recordSignatures(id: string, add: string[]) {
  const row = await prisma.signRequest.findUniqueOrThrow({ where: { id } });
  const sigs = [...(JSON.parse(row.signatures) as string[]), ...add];
  await prisma.signRequest.update({ where: { id }, data: { signatures: JSON.stringify(sigs) } });
}

export async function completeSignRequest(id: string, result: unknown) {
  return prisma.signRequest.update({
    where: { id },
    data: { status: "COMPLETED", completedAt: new Date(), resultJson: toJson(result), error: null },
  });
}

export async function failSignRequest(id: string, error: string) {
  await prisma.signRequest.update({ where: { id }, data: { error } });
}

/** Public view (GET /api/sign/:id): no secrets; the id itself is the capability. */
export function signRequestView(row: SignRequest, chainMode: "fake" | "devnet") {
  return {
    id: row.id,
    purpose: row.purpose as SignPurpose,
    subjectId: row.subjectId,
    status: row.status as SignStatus,
    summary: JSON.parse(row.summaryJson) as SignSummary,
    signer: row.signer,
    signatures: JSON.parse(row.signatures) as string[],
    result: row.resultJson ? JSON.parse(row.resultJson) : null,
    error: row.error,
    expiresAt: row.expiresAt,
    completedAt: row.completedAt,
    chainMode,
    signUrl: signUrl(row.id),
  };
}

/** Shape the mutating endpoints return in wallet mode. */
export function awaitingSignature(row: SignRequest, extra: Record<string, unknown>) {
  return {
    ...extra,
    status: "AWAITING_SIGNATURE",
    signingMode: "wallet" as const,
    signRequestId: row.id,
    signUrl: signUrl(row.id),
    expiresAt: row.expiresAt,
    nextStep:
      "Nothing has happened on-chain yet. Ask the founder to open signUrl in their own browser, connect their wallet, " +
      "review the summary and sign. Then check progress with fundraise_get_sign_request.",
  };
}
