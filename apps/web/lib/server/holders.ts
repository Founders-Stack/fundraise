// Classified holders for an issuance: chain balances are the source of truth,
// the DB only adds identity (SPEC section 6). Shared by the holders API and the
// distribution snapshot, so both see exactly the same classification.
import type { HolderBalance } from "@fstack/core";
import { prisma } from "@/lib/db";
import { getChain } from "@/lib/chain";

export interface ClassifiedHolders {
  slot: number;
  tokenSupply: bigint; // base units
  holders: HolderBalance[];
  /** Non-pool holders that are not registered participants (possible only without the hook). */
  unregisteredCount: number;
}

/** Pool owners are stored in Issuance.dbcConfig JSON as `poolOwners: string[]`. */
export function poolOwnersOf(dbcConfigJson: string | null): string[] {
  if (!dbcConfigJson) return [];
  try {
    const cfg = JSON.parse(dbcConfigJson) as { poolOwners?: string[] };
    return cfg.poolOwners ?? [];
  } catch {
    return [];
  }
}

export async function getClassifiedHolders(issuanceId: string): Promise<ClassifiedHolders> {
  const issuance = await prisma.issuance.findUniqueOrThrow({
    where: { id: issuanceId },
    include: { participants: true },
  });
  if (!issuance.baseMint) throw new Error(`issuance ${issuanceId} has no baseMint yet`);

  const chain = await getChain();
  const { slot, holders } = await chain.registry.getHolders(issuance.baseMint, poolOwnersOf(issuance.dbcConfig));

  const byWallet = new Map(issuance.participants.map((p) => [p.wallet, p]));
  const classified = holders.map((h): HolderBalance => {
    if (h.kind === "POOL") return h;
    const p = byWallet.get(h.owner);
    // A participant counts only once they accepted the agreement and were allowlisted.
    if (p && p.agreementAcceptedAt) return { ...h, kind: "PARTICIPANT", participantId: p.id };
    return { ...h, kind: "UNREGISTERED" };
  });

  const decimals = 6n; // rights token decimals (SPEC section 5)
  return {
    slot,
    tokenSupply: issuance.tokenSupply * 10n ** decimals,
    holders: classified,
    unregisteredCount: classified.filter((h) => h.kind === "UNREGISTERED").length,
  };
}
