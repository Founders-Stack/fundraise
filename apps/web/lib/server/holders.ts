// Classified holders for an issuance: chain balances are the source of truth,
// the DB only adds identity (SPEC section 6). Shared by the holders API and the
// distribution snapshot, so both see exactly the same classification.
import type { HolderBalance } from "@fstack/core";
import { prisma } from "@/lib/db";
import { getChain } from "@/lib/chain";
import { requireMarket, type IssuanceRecord } from "./issuance-record";

export interface ClassifiedHolders {
  slot: number;
  tokenSupply: bigint; // base units
  holders: HolderBalance[];
  /** Non-pool holders that are not registered participants (possible only without the hook). */
  unregisteredCount: number;
}

export async function getClassifiedHolders(issuance: IssuanceRecord): Promise<ClassifiedHolders> {
  const { baseMint, poolOwners } = requireMarket(issuance);
  const participants = await prisma.participant.findMany({ where: { issuanceId: issuance.id } });

  const chain = await getChain();
  const { slot, holders } = await chain.registry.getHolders(baseMint, poolOwners);

  const byWallet = new Map(participants.map((p) => [p.wallet, p]));
  const classified = holders.map((h): HolderBalance => {
    if (h.kind === "POOL") return h;
    const p = byWallet.get(h.owner);
    // A participant counts only once they accepted the agreement and were allowlisted.
    if (p && p.agreementAcceptedAt) return { ...h, kind: "PARTICIPANT", participantId: p.id };
    return { ...h, kind: "UNREGISTERED" };
  });

  return {
    slot,
    tokenSupply: issuance.supplyBaseUnits,
    holders: classified,
    unregisteredCount: classified.filter((h) => h.kind === "UNREGISTERED").length,
  };
}
