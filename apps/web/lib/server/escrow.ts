// Holder claims against a funded distribution escrow (SPEC section 7, P1).
//
//   issuer funds escrow (execute, payoutMode "escrow") → merkleRoot fixed on the distribution
//   holder: GET  /api/distributions/:id/proof?wallet=W  → { payout, proof, root, claimMessage }
//   holder: POST /api/distributions/:id/claim { wallet, signature, proof? } → escrow → wallet
//
// Safety: the payout only ever goes to the wallet in the leaf, and only for the snapshot amount.
// The holder signs `claimMessage` with that wallet (required off the fake chain) so nobody triggers a
// claim for someone else. Each allocation is claimed under an atomic row lock (`claimingUntil`), and
// the release signature is persisted right after the transfer, so a wallet is never paid twice.
import bs58 from "bs58";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { verifyClaimProof } from "@fstack/core";
import { prisma } from "@/lib/db";
import { getChain } from "@/lib/chain";
import { explorerTxUrl } from "./distribution-views";
import { claimTreeOf, loadOr404 } from "./distribution";
import { HttpError } from "./http";
import { usdc } from "./money";

/** How long one claim holds its allocation row (longer than a confirmed transfer takes). */
export const CLAIM_LOCK_MS = 120_000;

/** Exact text the holder signs to claim. */
export const claimMessage = (distributionId: string, wallet: string) =>
  `Founder Stack claim\nDistribution: ${distributionId}\nWallet: ${wallet}\nSend my payout from the escrow to this wallet.`;

/** On-chain memo on every escrow release. */
export const claimMemo = (reportHash: string) => `fstack:claim:${reportHash}`;

function parseWallet(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  try {
    if (s) return new PublicKey(s).toBase58();
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "invalid_wallet", "wallet must be a base58 Solana address");
}

async function loadFunded(id: string) {
  const d = await loadOr404(id);
  if (d.payoutMode !== "ESCROW" || !d.escrowFundSignature || !d.merkleRoot) {
    throw new HttpError(409, "not_escrowed", d.status === "EXECUTED" ? "this distribution was paid directly; there is nothing to claim" : "the issuer has not funded the claim escrow yet");
  }
  // Integrity: the stored root must still match the allocation table.
  const tree = claimTreeOf(d);
  if (tree.root !== d.merkleRoot) throw new HttpError(500, "merkle_root_mismatch", "allocations no longer match the funded Merkle root");
  return { d, tree };
}

/** GET /api/distributions/:id/proof?wallet= — public. */
export async function getClaimProof(id: string, walletRaw: unknown) {
  const wallet = parseWallet(walletRaw);
  const { d, tree } = await loadFunded(id);
  const a = d.allocations.find((x) => x.wallet === wallet && x.payout > 0n);
  if (!a) throw new HttpError(404, "no_allocation", "this wallet has no payout in this distribution's snapshot");
  const chain = await getChain();
  return {
    distributionId: d.id,
    wallet,
    payout: usdc(a.payout),
    leaf: { distributionId: d.id, wallet, payout: a.payout.toString() },
    proof: tree.proofs.get(wallet)!,
    merkleRoot: d.merkleRoot,
    claimed: Boolean(a.txSignature),
    txSignature: a.txSignature,
    explorerUrl: a.txSignature ? explorerTxUrl(a.txSignature, chain.mode) : null,
    claimMessage: claimMessage(d.id, wallet),
  };
}

function verifyOwnership(id: string, wallet: string, signature: unknown, chainMode: "fake" | "devnet") {
  if (signature === undefined || signature === null || signature === "") {
    if (chainMode === "fake") return; // fake chain: no real wallet to sign with
    throw new HttpError(400, "signature_required", "sign claimMessage with the claiming wallet and pass it as signature (base58)");
  }
  let sig: Uint8Array;
  try {
    sig = bs58.decode(String(signature));
  } catch {
    throw new HttpError(400, "invalid_signature", "signature must be base58");
  }
  const ok =
    sig.length === 64 &&
    nacl.sign.detached.verify(new TextEncoder().encode(claimMessage(id, wallet)), sig, new PublicKey(wallet).toBytes());
  if (!ok) throw new HttpError(403, "invalid_signature", "signature does not verify for this wallet and distribution");
}

/** POST /api/distributions/:id/claim — public; the wallet signature is the authorization. */
export async function claimDistribution(id: string, input: unknown) {
  const body = (input ?? {}) as { wallet?: unknown; signature?: unknown; proof?: unknown };
  const wallet = parseWallet(body.wallet);
  const chain = await getChain();
  verifyOwnership(id, wallet, body.signature, chain.mode);

  const { d } = await loadFunded(id);
  const a = d.allocations.find((x) => x.wallet === wallet && x.payout > 0n);
  if (!a) throw new HttpError(404, "no_allocation", "this wallet has no payout in this distribution's snapshot");
  if (body.proof !== undefined) {
    const proof = body.proof;
    if (!Array.isArray(proof) || proof.some((p) => typeof p !== "string") || !verifyClaimProof({ distributionId: d.id, wallet, payout: a.payout }, proof as string[], d.merkleRoot!)) {
      throw new HttpError(400, "invalid_proof", "proof does not verify against the distribution's Merkle root");
    }
  }
  const done = () => ({
    distributionId: d.id,
    wallet,
    payout: usdc(a.payout),
    alreadyClaimed: true,
    txSignature: a.txSignature,
    explorerUrl: a.txSignature ? explorerTxUrl(a.txSignature, chain.mode) : null,
  });
  if (a.txSignature) return done();

  const now = new Date();
  const until = new Date(now.getTime() + CLAIM_LOCK_MS);
  const locked = await prisma.allocation.updateMany({
    where: { id: a.id, txSignature: null, OR: [{ claimingUntil: null }, { claimingUntil: { lt: now } }] },
    data: { claimingUntil: until },
  });
  if (locked.count === 0) {
    const fresh = await prisma.allocation.findUniqueOrThrow({ where: { id: a.id } });
    if (fresh.txSignature) return { ...done(), txSignature: fresh.txSignature, explorerUrl: explorerTxUrl(fresh.txSignature, chain.mode) };
    throw new HttpError(409, "claim_in_progress", "a claim for this wallet is already being processed; try again in a minute");
  }

  try {
    const bal = await chain.escrow.getBalance();
    if (bal < a.payout) {
      throw new HttpError(409, "escrow_insufficient", "the escrow holds less than this payout; contact the issuer", {
        escrowAddress: chain.escrow.address(),
        balance: usdc(bal),
        required: usdc(a.payout),
      });
    }
    let signature: string;
    try {
      ({ signature } = await chain.escrow.release([{ wallet, amount: a.payout }], { memo: claimMemo(d.reportHash) }));
    } catch (e) {
      throw new HttpError(502, "claim_failed", `escrow release failed: ${e instanceof Error ? e.message : String(e)}. Nothing was recorded; try again.`);
    }
    await prisma.allocation.update({ where: { id: a.id }, data: { txSignature: signature, claimedAt: new Date(), claimingUntil: null } });
    return {
      distributionId: d.id,
      wallet,
      payout: usdc(a.payout),
      alreadyClaimed: false,
      txSignature: signature,
      explorerUrl: explorerTxUrl(signature, chain.mode),
      note: chain.mode === "fake" ? "CHAIN_MODE=fake: simulated transfer, nothing moved on devnet." : "USDC sent from the escrow to your wallet.",
    };
  } finally {
    await prisma.allocation.updateMany({ where: { id: a.id, claimingUntil: until }, data: { claimingUntil: null } });
  }
}
