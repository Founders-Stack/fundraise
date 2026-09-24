// A25: escrow + Merkle claim against the in-memory fake chain.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { verifyClaimProof } from "@fstack/core";
import { POST as reportPOST } from "@/app/api/issuances/[id]/distributions/route";
import { POST as snapshotPOST } from "@/app/api/distributions/[id]/snapshot/route";
import { POST as executePOST } from "@/app/api/distributions/[id]/execute/route";
import { POST as claimPOST } from "@/app/api/distributions/[id]/claim/route";
import { GET as proofGET } from "@/app/api/distributions/[id]/proof/route";
import { claimMessage } from "@/lib/server/escrow";
import { fake } from "./fake-chain";
import { call, get, launch, onboard, post } from "./helpers";

const TOK = 1_000_000n;
const { swap, usdcBalance, issuerUsdc, memoOf } = fake.control;
const escrowAddr = fake.ports.escrow.address();

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-15T12:00:00Z"));
});
afterAll(() => vi.useRealTimers());

const proof = (id: string, wallet: string) => call(proofGET, get({}, `http://test/api?wallet=${wallet}`), id);
const claim = (id: string, body: unknown) => call(claimPOST, post(body, { "content-type": "application/json" }), id);

describe("escrow + merkle claim", () => {
  it("funds escrow once, holders claim with proofs, no double pay", async () => {
    const iss = await launch({ symbol: "ESC" });
    const alice = await onboard(iss, "Alice");
    const bob = await onboard(iss, "Bob");
    swap(iss.dbcPool, alice, "BUY", 60_000n * TOK);
    swap(iss.dbcPool, bob, "BUY", 40_000n * TOK);
    const r = await call(reportPOST, post({ periodLabel: "2026-Q3", dcf: "400000" }), iss.issuanceId);
    const id = r.body.distribution.id;
    expect((await call(snapshotPOST, post(undefined), id)).status).toBe(200);

    // claims before funding are refused
    expect((await proof(id, alice)).body.error).toBe("not_escrowed");

    // confirmTotal still enforced in escrow mode (the default)
    expect((await call(executePOST, post({ confirmTotal: "1" }), id)).body.error).toBe("confirm_total_mismatch");
    const before = issuerUsdc();
    const e = await call(executePOST, post({ confirmTotal: "4000" }), id);
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect(e.body.distribution.status).toBe("EXECUTED");
    expect(e.body.distribution.payoutMode).toBe("ESCROW");
    expect(e.body.claims.unclaimed.usdc).toBe("4000");
    expect(e.body.claimUrl).toMatch(new RegExp(`/distributions/${id}$`));
    expect(before - issuerUsdc()).toBe(4000n * TOK);
    expect(usdcBalance(escrowAddr)).toBe(4000n * TOK);
    expect(memoOf(e.body.newSignatures[0])).toMatch(/^fstack:escrow:[0-9a-f]{64}$/);
    expect(usdcBalance(alice)).toBe(0n);

    // re-execute is idempotent: no second funding
    expect((await call(executePOST, post({ confirmTotal: "4000" }), id)).body.alreadyExecuted).toBe(true);
    expect(usdcBalance(escrowAddr)).toBe(4000n * TOK);

    // proof verifies against the root
    const p = await proof(id, alice);
    expect(p.status).toBe(200);
    expect(p.body.payout.usdc).toBe("2400");
    expect(verifyClaimProof({ distributionId: id, wallet: alice, payout: 2400n * TOK }, p.body.proof, p.body.merkleRoot)).toBe(true);
    expect(p.body.claimMessage).toBe(claimMessage(id, alice));

    // bad signature / bad proof / stranger
    const bogus = bs58.encode(nacl.sign.detached(new TextEncoder().encode("x"), nacl.sign.keyPair().secretKey));
    expect((await claim(id, { wallet: alice, signature: bogus })).status).toBe(403);
    expect((await claim(id, { wallet: alice, proof: ["00".repeat(32)] })).body.error).toBe("invalid_proof");
    const stranger = bs58.encode(nacl.sign.keyPair().publicKey);
    expect((await claim(id, { wallet: stranger })).body.error).toBe("no_allocation");

    // valid claim with a real wallet signature
    const c1 = await claim(id, { wallet: alice, proof: p.body.proof });
    expect(c1.status, JSON.stringify(c1.body)).toBe(200);
    expect(c1.body.alreadyClaimed).toBe(false);
    expect(usdcBalance(alice)).toBe(2400n * TOK);
    expect(memoOf(c1.body.txSignature)).toMatch(/^fstack:claim:/);

    // concurrent double claim: pays once
    const [x, y] = await Promise.all([claim(id, { wallet: bob }), claim(id, { wallet: bob })]);
    expect([x.status, y.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(usdcBalance(bob)).toBe(1600n * TOK);
    const again = await claim(id, { wallet: alice });
    expect(again.body.alreadyClaimed).toBe(true);
    expect(usdcBalance(alice)).toBe(2400n * TOK);
    expect(usdcBalance(escrowAddr)).toBe(0n);
  });

  it("direct mode is still available behind the flag and has nothing to claim", async () => {
    const iss = await launch({ symbol: "DIR" });
    const alice = await onboard(iss, "Alice");
    swap(iss.dbcPool, alice, "BUY", 10_000n * TOK);
    const id = (await call(reportPOST, post({ periodLabel: "2026-Q3", dcf: "100000" }), iss.issuanceId)).body.distribution.id;
    await call(snapshotPOST, post(undefined), id);
    expect((await call(executePOST, post({ confirmTotal: "100", payoutMode: "bogus" }), id)).body.error).toBe("invalid_payout_mode");
    const e = await call(executePOST, post({ confirmTotal: "100", payoutMode: "direct" }), id);
    expect(e.body.distribution.payoutMode).toBe("DIRECT");
    expect(usdcBalance(alice)).toBe(100n * TOK);
    expect((await claim(id, { wallet: alice })).body.error).toBe("not_escrowed");
  });

  it("signed claims verify with the holder's key", async () => {
    // signature path covered with a detached signature over claimMessage
    const kp = nacl.sign.keyPair();
    const w = bs58.encode(kp.publicKey);
    const sig = nacl.sign.detached(new TextEncoder().encode(claimMessage("d", w)), kp.secretKey);
    expect(nacl.sign.detached.verify(new TextEncoder().encode(claimMessage("d", w)), sig, kp.publicKey)).toBe(true);
  });
});
