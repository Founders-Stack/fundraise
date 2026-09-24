// Classified holders for an issuance: chain balances are the source of truth, the registry adds
// identity, and core `classifyHolders` decides each holder's kind (SPEC section 6, R4). Shared by
// the holders API, the market view and the distribution snapshot, so all see the same classification.
import { classifyHolders, type HolderBalance } from "@fstack/core";
import type { Participant } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getChain } from "@/lib/chain";
import { requireMarket, type IssuanceRecord } from "./issuance-record";

export interface ClassifiedHolders {
  slot: number;
  tokenSupply: bigint; // base units
  holders: HolderBalance[];
  /** Non-pool holders that are not eligible participants (possible only without the hook, or after graduation). */
  unregisteredCount: number;
}

export async function getClassifiedHolders(issuance: IssuanceRecord, participants?: Participant[]): Promise<ClassifiedHolders> {
  const { baseMint, poolOwners } = requireMarket(issuance);
  const registry = participants ?? (await prisma.participant.findMany({ where: { issuanceId: issuance.id } }));

  const chain = await getChain();
  const { slot, balances } = await chain.registry.getBalances(baseMint, poolOwners);
  const holders = classifyHolders(
    balances,
    poolOwners,
    registry.map((p) => ({
      id: p.id,
      wallet: p.wallet,
      agreementAccepted: p.agreementAcceptedAt !== null,
      allowlisted: p.allowlistTx !== null,
    })),
  );

  return {
    slot,
    tokenSupply: issuance.supplyBaseUnits,
    holders,
    unregisteredCount: holders.filter((h) => h.kind === "UNREGISTERED").length,
  };
}
