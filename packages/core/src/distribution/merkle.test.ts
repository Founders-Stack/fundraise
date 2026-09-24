import { describe, expect, it } from "vitest";
import { buildClaimTree, verifyClaimProof } from "./merkle";

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ distributionId: "d1", wallet: `W${String(i).padStart(3, "0")}`, payout: BigInt(1000 + i) }));

describe("claim merkle tree", () => {
  it("every leaf verifies for tree sizes 1..17 (odd levels included)", () => {
    for (let n = 1; n <= 17; n++) {
      const rs = rows(n);
      const t = buildClaimTree(rs);
      for (const r of rs) expect(verifyClaimProof(r, t.proofs.get(r.wallet)!, t.root), `n=${n} ${r.wallet}`).toBe(true);
    }
  });

  it("is order independent and rejects tampered amounts, wallets, distributions and proofs", () => {
    const rs = rows(5);
    const t = buildClaimTree(rs);
    expect(buildClaimTree([...rs].reverse()).root).toBe(t.root);
    const p = t.proofs.get("W002")!;
    expect(verifyClaimProof({ ...rs[2], payout: rs[2].payout + 1n }, p, t.root)).toBe(false);
    expect(verifyClaimProof({ ...rs[2], wallet: "W003" }, p, t.root)).toBe(false);
    expect(verifyClaimProof({ ...rs[2], distributionId: "d2" }, p, t.root)).toBe(false);
    expect(verifyClaimProof(rs[2], [...p.slice(1)], t.root)).toBe(false);
    expect(verifyClaimProof(rs[2], ["zz"], t.root)).toBe(false);
  });

  it("rejects duplicate wallets", () => {
    expect(() => buildClaimTree([...rows(2), rows(1)[0]])).toThrow(/duplicate/);
  });
});
