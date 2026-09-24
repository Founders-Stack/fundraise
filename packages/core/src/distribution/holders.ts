// Holder classification (SPEC R4, section 6): who a token balance belongs to for distributions.
// The only place a holder's kind is decided. Chain adapters report raw balances; the registry
// (participants) adds identity. Pure.
import type { HolderBalance } from "./index";

/** A raw token balance as read from chain, before classification. */
export interface TokenBalance {
  owner: string;
  tokenAccount: string;
  amount: bigint;
}

export interface ParticipantStatus {
  id: string;
  wallet: string;
  /** Signed the Cash Flow Participation Agreement. */
  agreementAccepted: boolean;
  /** Has an active AllowEntry on the transfer hook. */
  allowlisted: boolean;
}

/**
 * - POOL: owned by market infrastructure (`poolOwners`, e.g. the DBC pool authority). Unallocated.
 * - PARTICIPANT: owned by an Eligible Holder, i.e. a participant who accepted the agreement AND is
 *   on the allowlist (agreement section 2). Paid.
 * - UNREGISTERED: anyone else, including onboarding that never reached the allowlist. Unallocated.
 */
export function classifyHolders(
  balances: TokenBalance[],
  poolOwners: string[],
  participants: ParticipantStatus[],
): HolderBalance[] {
  const pools = new Set(poolOwners);
  const eligible = new Map(participants.filter((p) => p.agreementAccepted && p.allowlisted).map((p) => [p.wallet, p.id]));
  return balances.map((b): HolderBalance => {
    if (pools.has(b.owner)) return { ...b, kind: "POOL" };
    const participantId = eligible.get(b.owner);
    return participantId ? { ...b, kind: "PARTICIPANT", participantId } : { ...b, kind: "UNREGISTERED" };
  });
}
