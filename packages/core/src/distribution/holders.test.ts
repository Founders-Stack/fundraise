import { describe, expect, it } from "vitest";
import { classifyHolders, type ParticipantStatus, type TokenBalance } from "./holders";

const bal = (owner: string, amount = 1n): TokenBalance => ({ owner, tokenAccount: `${owner}-ata`, amount });
const participant = (wallet: string, agreementAccepted = true, allowlisted = true): ParticipantStatus => ({
  id: `p-${wallet}`,
  wallet,
  agreementAccepted,
  allowlisted,
});

describe("classifyHolders", () => {
  it("classifies pool owners, eligible participants and everyone else", () => {
    const out = classifyHolders(
      [bal("pool"), bal("alice"), bal("carol"), bal("dave"), bal("erin")],
      ["pool"],
      [participant("alice"), participant("carol", true, false), participant("dave", false, true)],
    );
    expect(out.map((h) => [h.owner, h.kind, h.participantId])).toEqual([
      ["pool", "POOL", undefined],
      ["alice", "PARTICIPANT", "p-alice"],
      // accepted the agreement but never reached the allowlist: not an Eligible Holder
      ["carol", "UNREGISTERED", undefined],
      ["dave", "UNREGISTERED", undefined],
      ["erin", "UNREGISTERED", undefined],
    ]);
  });

  it("puts a pool owner in POOL even if the wallet also onboarded", () => {
    expect(classifyHolders([bal("pool")], ["pool"], [participant("pool")])[0].kind).toBe("POOL");
  });

  it("keeps balances and token accounts as read", () => {
    const [h] = classifyHolders([bal("alice", 42n)], [], [participant("alice")]);
    expect(h).toEqual({ owner: "alice", tokenAccount: "alice-ata", amount: 42n, kind: "PARTICIPANT", participantId: "p-alice" });
  });
});
