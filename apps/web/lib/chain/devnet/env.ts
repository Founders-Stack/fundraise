// Devnet environment: RPC connection, custody keypairs, program/mint ids.
// Demo custody (SPEC 0.4): the server holds the Founder Stack authority and issuer keys (devnet only).
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  type Commitment,
  type Signer,
  type Transaction,
  type TransactionSignature,
  ComputeBudgetProgram,
  SendTransactionError,
} from "@solana/web3.js";

import {
  clusterAllowlistProgramId,
  clusterQuoteMint,
  clusterRpcUrl,
  explorerAddressUrl,
  explorerTxUrl,
} from "../../cluster";

export const COMMITMENT: Commitment = "confirmed";

/** Repo root: env paths like `keys/x.json` are resolved from here (or from cwd/../.. for apps/web). */
function resolvePath(p: string): string {
  if (isAbsolute(p)) return p;
  const candidates = [resolve(process.cwd(), p), resolve(process.cwd(), "../..", p)];
  for (const c of candidates) {
    try {
      readFileSync(c);
      return c;
    } catch {
      /* try next */
    }
  }
  return candidates[0];
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (required for CHAIN_MODE=devnet)`);
  return v;
}

export function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(resolvePath(path), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export interface DevnetEnv {
  connection: Connection;
  rpcUrl: string;
  fsAuthority: Keypair;
  issuer: Keypair;
  quoteMint: PublicKey;
  allowlistProgram: PublicKey;
}

let cachedEnv: DevnetEnv | null = null;

export function devnetEnv(opts: { requireQuoteMint?: boolean } = {}): DevnetEnv {
  if (cachedEnv && (cachedEnv.quoteMint || !opts.requireQuoteMint)) return cachedEnv;
  const rpcUrl = clusterRpcUrl();
  const quote = clusterQuoteMint();
  if (opts.requireQuoteMint !== false && !quote) throw new Error("QUOTE_MINT is not set");
  const env: DevnetEnv = {
    connection: new Connection(rpcUrl, { commitment: COMMITMENT, disableRetryOnRateLimit: false }),
    rpcUrl,
    fsAuthority: loadKeypair(req("FS_AUTHORITY_KEYPAIR")),
    issuer: loadKeypair(req("ISSUER_KEYPAIR")),
    quoteMint: quote ? new PublicKey(quote) : PublicKey.default,
    allowlistProgram: new PublicKey(clusterAllowlistProgramId()),
  };
  if (quote) cachedEnv = env;
  return env;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries transient RPC failures (429 / fetch errors / blockhash) with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, label = "rpc", attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message ?? e);
      const transient =
        /429|Too Many Requests|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|503|502|Blockhash not found|block height exceeded|timed out|Unable to obtain a new blockhash/i.test(
          msg,
        );
      if (!transient || i === attempts - 1) throw e;
      await sleep(Math.min(8000, 500 * 2 ** i));
    }
  }
  throw lastErr;
}

export function computeBudgetIxs(units = 400_000, microLamports = 20_000) {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

/**
 * Thrown by `sendTx` when the outcome is certain. `landed` tells callers whether the
 * transaction was executed on-chain:
 *  - landed=false: it definitely did NOT execute (preflight rejected it, or its blockhash
 *    expired and the signature is unknown to the cluster) -> safe to retry / rebuild.
 *  - landed=true: it executed but failed (program error) -> no state change, safe to retry.
 * Any other thrown error means the outcome is UNKNOWN (should not happen: we poll until expiry).
 */
export class TxError extends Error {
  constructor(
    message: string,
    readonly landed: boolean,
    readonly signature?: string,
    readonly logs: string[] = [],
  ) {
    super(message);
    this.name = "TxError";
  }
  /** True when nothing was (or can be) applied on-chain for this attempt. */
}

export interface SendOpts {
  /** Re-sign with a fresh blockhash after a confirmed expiry. Default true. Payouts pass false. */
  retryOnExpiry?: boolean;
}

/**
 * Signs, sends and confirms a legacy transaction, double-send safe: each attempt uses ONE
 * blockhash; we poll the signature until it confirms or that blockhash's lastValidBlockHeight
 * has passed (after which it can never land), and only then (optionally) re-sign.
 * Program errors are thrown as TxError with logs (so `NotEligible` etc. are visible).
 */
export async function sendTx(
  connection: Connection,
  tx: Transaction,
  signers: Signer[],
  label = "tx",
  opts: SendOpts = {},
): Promise<TransactionSignature> {
  const retryOnExpiry = opts.retryOnExpiry ?? true;
  const feePayer = tx.feePayer ?? signers[0].publicKey;
  const maxAttempts = retryOnExpiry ? 3 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash(COMMITMENT));
    tx.recentBlockhash = blockhash;
    tx.feePayer = feePayer;
    tx.signatures = [];
    tx.sign(...dedupeSigners(signers));
    const raw = tx.serialize();
    const sig = encodeSig(tx.signature!);
    try {
      await connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: COMMITMENT, maxRetries: 5 });
    } catch (e) {
      const err = e as Error & { logs?: string[] };
      const msg = String(err?.message ?? e);
      if (e instanceof SendTransactionError || /failed to send transaction|simulation failed/i.test(msg)) {
        // Preflight rejected: never forwarded to the leader.
        throw new TxError(`${label} failed (preflight): ${msg}`, false, sig, err.logs ?? []);
      }
      // Network-level failure: the node may still have forwarded it -> fall through and poll.
    }
    const outcome = await pollUntilFinal(connection, sig, raw, lastValidBlockHeight);
    if (outcome.status === "confirmed") return sig;
    if (outcome.status === "failed") {
      const logs = await fetchLogs(connection, sig);
      throw new TxError(`${label} failed: ${JSON.stringify(outcome.err)} sig=${sig}\n${logs.join("\n")}`, true, sig, logs);
    }
    // expired and unknown -> definitely not landed
    if (attempt === maxAttempts - 1) {
      throw new TxError(`${label}: not landed (blockhash expired, signature unknown) sig=${sig}`, false, sig);
    }
  }
  throw new TxError(`${label}: not landed`, false);
}

async function pollUntilFinal(
  connection: Connection,
  sig: string,
  raw: Buffer | Uint8Array,
  lastValidBlockHeight: number,
): Promise<{ status: "confirmed" } | { status: "failed"; err: unknown } | { status: "expired" }> {
  let i = 0;
  const deadline = Date.now() + 4 * 60_000;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(
        `OUTCOME UNKNOWN for ${sig}: RPC unreachable while confirming. Check the signature on an explorer before retrying.`,
      );
    }
    await sleep(i < 5 ? 1500 : 3000);
    i++;
    const st = await withRetry(() => connection.getSignatureStatus(sig, { searchTransactionHistory: true })).catch(
      () => null,
    );
    const v = st?.value;
    if (v) {
      if (v.err) return { status: "failed", err: v.err };
      if (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized") return { status: "confirmed" };
      continue; // processed: keep polling
    }
    const height = await withRetry(() => connection.getBlockHeight(COMMITMENT)).catch(() => 0);
    if (height > lastValidBlockHeight) {
      // one last look (status may lag the block height)
      await sleep(2000);
      const last = await withRetry(() =>
        connection.getSignatureStatus(sig, { searchTransactionHistory: true }),
      ).catch(() => null);
      if (last?.value) {
        if (last.value.err) return { status: "failed", err: last.value.err };
        return { status: "confirmed" };
      }
      return { status: "expired" };
    }
    if (i % 4 === 0) {
      // rebroadcast the SAME signed bytes (idempotent: same signature)
      connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
    }
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeSig(bytes: Uint8Array): string {
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

function dedupeSigners(signers: Signer[]): Signer[] {
  const seen = new Set<string>();
  return signers.filter((s) => {
    const k = s.publicKey.toBase58();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function fetchLogs(connection: Connection, sig: string): Promise<string[]> {
  try {
    const t = await withRetry(() =>
      connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }),
    );
    return t?.meta?.logMessages ?? [];
  } catch {
    return [];
  }
}

export const explorerTx = (sig: string) => explorerTxUrl(sig);
export const explorerAddr = (a: string) => explorerAddressUrl(a);

/** Demo test wallets (alice/bob/carol/issuer/fs-authority) live next to FS_AUTHORITY_KEYPAIR. Scripts only. */
export function demoKeypair(name: string): Keypair {
  const dir = dirname(resolvePath(req("FS_AUTHORITY_KEYPAIR")));
  return loadKeypair(join(dir, `${name}.json`));
}
