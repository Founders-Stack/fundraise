// /sign/[requestId] flow (SPEC 0.4 P1): view → build (for the connected wallet) → submit (signed).
// Purpose-specific work lives next to its domain (issuance.ts / distribution.ts); this dispatches.
import { PublicKey } from "@solana/web3.js";
import { getChain } from "@/lib/chain";
import { HttpError } from "./http";
import { applyDistributionSigned, buildDistributionSignTxs } from "./distribution";
import { applyIssuanceSigned, buildIssuanceSignTxs } from "./issuance";
import {
  completeSignRequest,
  failSignRequest,
  loadSignRequest,
  parsePayload,
  recordSignatures,
  requirePending,
  savePayload,
  signRequestView,
  type SignSummary,
} from "./signing";

function parseWallet(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  try {
    if (s) return new PublicKey(s).toBase58();
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "invalid_wallet", "wallet must be a base58 Solana address");
}

export async function getSignRequest(id: string) {
  const chain = await getChain();
  return signRequestView(await loadSignRequest(id), chain.mode);
}

/** Builds fresh unsigned txs for `wallet`. The first wallet to build becomes the only allowed signer. */
export async function buildSignRequest(id: string, body: Record<string, unknown>) {
  const wallet = parseWallet(body.wallet);
  const row = await loadSignRequest(id);
  requirePending(row);
  if (row.signer && row.signer !== wallet) {
    throw new HttpError(403, "wrong_wallet", `this request is being signed by ${row.signer}; connect that wallet`);
  }
  const summary = JSON.parse(row.summaryJson) as SignSummary;
  const payload =
    row.purpose === "ISSUANCE_CREATE"
      ? await buildIssuanceSignTxs(row.subjectId, wallet)
      : await buildDistributionSignTxs(row.subjectId, wallet, summary.meta);
  if (payload.txs.length === 0) throw new HttpError(409, "nothing_to_sign", "nothing left to sign");
  await savePayload(id, wallet, payload);
  const chain = await getChain();
  return {
    id,
    wallet,
    chainMode: chain.mode,
    /** Fake chain only: nothing to sign with a wallet; submit these back unchanged. */
    simulated: chain.mode === "fake",
    txs: payload.txs.map((t) => ({ tx: t.tx, label: t.label, lastValidBlockHeight: t.lastValidBlockHeight })),
  };
}

/** Verifies + broadcasts the wallet-signed txs, applies the result, and completes the request. */
export async function submitSignRequest(id: string, body: Record<string, unknown>) {
  const wallet = parseWallet(body.wallet);
  const signedTxs = body.signedTxs;
  if (!Array.isArray(signedTxs) || signedTxs.some((t) => typeof t !== "string")) {
    throw new HttpError(400, "invalid_input", "signedTxs must be an array of base64 transactions");
  }
  const row = await loadSignRequest(id);
  requirePending(row);
  const payload = parsePayload(row);
  if (!payload || !row.signer) throw new HttpError(409, "not_built", "build the transactions first");
  if (row.signer !== wallet) throw new HttpError(403, "wrong_wallet", `only ${row.signer} can submit this request`);
  if (signedTxs.length !== payload.txs.length) {
    throw new HttpError(400, "invalid_input", `expected ${payload.txs.length} signed transaction(s), got ${signedTxs.length}`);
  }
  const summary = JSON.parse(row.summaryJson) as SignSummary;
  const onSignature = (sig: string) => recordSignatures(id, [sig]);
  try {
    const result =
      row.purpose === "ISSUANCE_CREATE"
        ? await applyIssuanceSigned(row.subjectId, wallet, payload, signedTxs as string[], onSignature)
        : await applyDistributionSigned(row.subjectId, wallet, summary.meta, payload, signedTxs as string[], onSignature);
    const done = await completeSignRequest(id, result);
    return { ...signRequestView(done, (await getChain()).mode), result };
  } catch (e) {
    await failSignRequest(id, e instanceof Error ? e.message : String(e));
    throw e;
  }
}
