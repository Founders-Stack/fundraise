// Merkle claim tree for escrowed distributions (SPEC section 7, P1).
// Built off-chain over the immutable snapshot allocations; the root is stored with the distribution
// and printed on the public page, so any holder can check their proof against it.
//
//   leaf  = sha256(0x00 || "fstack-claim-v1|" || distributionId || "|" || wallet || "|" || payout)
//   node  = sha256(0x01 || min(a, b) || max(a, b))   (sorted pairs: proofs carry no left/right bits)
//
// Domain-separated leaf/node prefixes prevent a node from being passed off as a leaf.
// An odd node at the end of a level is promoted unchanged.
import { createHash } from "node:crypto";

export interface ClaimLeafInput {
  distributionId: string;
  wallet: string;
  /** USDC base units. */
  payout: bigint;
}

const sha = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();

export function claimLeaf(l: ClaimLeafInput): Buffer {
  if (l.payout < 0n) throw new Error("claimLeaf: negative payout");
  return sha(Buffer.from([0]), Buffer.from(`fstack-claim-v1|${l.distributionId}|${l.wallet}|${l.payout.toString()}`, "utf8"));
}

function hashPair(a: Buffer, b: Buffer): Buffer {
  return Buffer.compare(a, b) <= 0 ? sha(Buffer.from([1]), a, b) : sha(Buffer.from([1]), b, a);
}

export interface ClaimTree {
  /** Hex root; empty-tree root is sha256 of nothing (never matches a proof). */
  root: string;
  /** Hex proof per wallet. */
  proofs: Map<string, string[]>;
}

/** Builds the tree. Wallets must be unique (the allocation table guarantees it). */
export function buildClaimTree(rows: ClaimLeafInput[]): ClaimTree {
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.wallet)) throw new Error(`buildClaimTree: duplicate wallet ${r.wallet}`);
    seen.add(r.wallet);
  }
  // Deterministic order regardless of input order.
  const sorted = [...rows].sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
  const proofs = new Map<string, string[]>(sorted.map((r) => [r.wallet, []]));
  if (sorted.length === 0) return { root: sha().toString("hex"), proofs };

  // Track which original leaves sit under each node of the current level.
  let level = sorted.map((r) => ({ hash: claimLeaf(r), wallets: [r.wallet] }));
  while (level.length > 1) {
    const next: typeof level = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1];
      if (!b) {
        next.push(a);
        continue;
      }
      for (const w of a.wallets) proofs.get(w)!.push(b.hash.toString("hex"));
      for (const w of b.wallets) proofs.get(w)!.push(a.hash.toString("hex"));
      next.push({ hash: hashPair(a.hash, b.hash), wallets: [...a.wallets, ...b.wallets] });
    }
    level = next;
  }
  return { root: level[0].hash.toString("hex"), proofs };
}

/** True when `proof` connects the leaf to `root`. */
export function verifyClaimProof(leaf: ClaimLeafInput, proof: string[], root: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(root) || proof.some((p) => !/^[0-9a-f]{64}$/.test(p))) return false;
  let h = claimLeaf(leaf);
  for (const p of proof) h = hashPair(h, Buffer.from(p, "hex"));
  return h.toString("hex") === root;
}
