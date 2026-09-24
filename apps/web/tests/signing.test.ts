// Wallet-signing links (SPEC 0.4 P1, A24): mutating calls in wallet mode return a signUrl instead
// of signing with server keys; /api/sign/:id builds, verifies and applies the founder's signed txs.
import { afterEach, describe, expect, it } from "vitest";
import { POST as createPOST } from "@/app/api/issuances/route";
import { GET as issuanceGET } from "@/app/api/issuances/[id]/route";
import { POST as reportPOST } from "@/app/api/issuances/[id]/distributions/route";
import { POST as snapshotPOST } from "@/app/api/distributions/[id]/snapshot/route";
import { POST as executePOST } from "@/app/api/distributions/[id]/execute/route";
import { GET as signGET } from "@/app/api/sign/[id]/route";
import { POST as buildPOST } from "@/app/api/sign/[id]/build/route";
import { POST as submitPOST } from "@/app/api/sign/[id]/submit/route";
import { fake } from "./fake-chain";
import { ACME, call, get, launch, onboard, post, preview, signer } from "./helpers";

const TOK = 1_000_000n;
const founder = () => signer("x", "y").wallet;

const build = (id: string, wallet: string) => call(buildPOST, post({ wallet }, {}), id);
const submit = (id: string, wallet: string, signedTxs: string[]) => call(submitPOST, post({ wallet, signedTxs }, {}), id);
const view = (id: string) => call(signGET, get(), id);

afterEach(() => {
  delete process.env.FS_SIGNING_MODE;
});

describe("wallet signing: issuance create", () => {
  it("returns a sign URL, creates nothing until the founder signs, then goes LIVE", async () => {
    const p = await preview({ ...ACME, symbol: "SIGN1" });
    const c = await call(createPOST, post({ previewId: p.body.previewId, signingMode: "wallet" }));
    expect(c.status, JSON.stringify(c.body)).toBe(202);
    expect(c.body.status).toBe("AWAITING_SIGNATURE");
    expect(c.body.signUrl).toBe(`http://localhost:3000/sign/${c.body.signRequestId}`);
    const issuanceId = c.body.issuanceId;
    expect((await call(issuanceGET, get(), issuanceId)).body.status).toBe("PENDING");

    // the public view has a human-readable summary
    const v = await view(c.body.signRequestId);
    expect(v.status).toBe(200);
    expect(v.body.status).toBe("PENDING");
    expect(v.body.purpose).toBe("ISSUANCE_CREATE");
    expect(v.body.summary.title).toBe("Launch SIGN1");
    expect(v.body.summary.lines.map((l: { label: string }) => l.label)).toContain("Starting token market cap");

    // submit before build is rejected; bad wallet rejected
    const me = founder();
    expect((await submit(c.body.signRequestId, me, ["x"])).body.error).toBe("not_built");
    expect((await build(c.body.signRequestId, "not a wallet")).body.error).toBe("invalid_wallet");

    const b = await build(c.body.signRequestId, me);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body.simulated).toBe(true);
    expect(b.body.txs).toHaveLength(1);

    // another wallet can't hijack it; a tampered tx is rejected and the request stays open
    const other = founder();
    expect((await build(c.body.signRequestId, other)).body.error).toBe("wrong_wallet");
    expect((await submit(c.body.signRequestId, other, [b.body.txs[0].tx])).body.error).toBe("wrong_wallet");
    const bad = await submit(c.body.signRequestId, me, ["dGFtcGVyZWQ="]);
    expect(bad.status).toBe(502);
    expect((await view(c.body.signRequestId)).body.status).toBe("PENDING");

    const s = await submit(c.body.signRequestId, me, b.body.txs.map((t: { tx: string }) => t.tx));
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.status).toBe("COMPLETED");
    expect(s.body.result.status).toBe("LIVE");
    expect(s.body.result.custody).toMatch(/Founder wallet/);
    expect(s.body.signatures).toHaveLength(1);

    const live = (await call(issuanceGET, get(), issuanceId)).body;
    expect(live.status).toBe("LIVE");
    expect(live.chain.dbcPool).toBe(s.body.result.dbcPool);
    // the market works: the pool exists on the (fake) chain
    expect(s.body.result.inviteCode).toBeTruthy();
    const w = await onboard({ issuanceId, agreementHash: live.agreement.hash, inviteCode: s.body.result.inviteCode }, "Alice");
    fake.control.swap(live.chain.dbcPool, w, "BUY", 1_000n * TOK);

    // done: no second submit
    expect((await submit(c.body.signRequestId, me, b.body.txs.map((t: { tx: string }) => t.tx))).body.error).toBe("already_completed");
    expect((await view("nope")).status).toBe(404);
  });

  it("FS_SIGNING_MODE=wallet makes wallet mode the default; custody stays the default otherwise", async () => {
    process.env.FS_SIGNING_MODE = "wallet";
    const p = await preview({ ...ACME, symbol: "SIGN2" });
    const c = await call(createPOST, post({ previewId: p.body.previewId }));
    expect(c.status).toBe(202);
    delete process.env.FS_SIGNING_MODE;
    const iss = await launch({ symbol: "SIGN3" });
    expect(iss.dbcPool).toBeTruthy();
    const p2 = await preview({ ...ACME, symbol: "SIGN4" });
    expect((await call(createPOST, post({ previewId: p2.body.previewId, signingMode: "hsm" }))).body.error).toBe("invalid_signing_mode");
  });
});

describe("wallet signing: distribution execute", () => {
  it("confirmTotal is still enforced, then the founder's wallet pays every holder", async () => {
    const iss = await launch({ symbol: "SIGND" });
    const holders = [];
    for (let i = 0; i < 7; i++) {
      const w = await onboard(iss, `H${i}`);
      fake.control.swap(iss.dbcPool, w, "BUY", 10_000n * TOK);
      holders.push(w);
    }
    const r = await call(reportPOST, post({ periodLabel: "2026-Q3", dcf: "400000" }), iss.issuanceId);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.distribution.id;
    const snap = await call(snapshotPOST, post(undefined), id);
    expect(snap.status).toBe(200);
    const total: string = snap.body.totals.totalAllocated.usdc;

    // mismatch still rejected in wallet mode
    expect((await call(executePOST, post({ confirmTotal: "1", signingMode: "wallet" }), id)).body.error).toBe("confirm_total_mismatch");

    const e = await call(executePOST, post({ confirmTotal: total, signingMode: "wallet" }), id);
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect(e.body.status).toBe("AWAITING_SIGNATURE");
    expect(e.body.holders).toBe(7);
    // asking again reuses the same open request
    const again = await call(executePOST, post({ confirmTotal: total, signingMode: "wallet" }), id);
    expect(again.body.signRequestId).toBe(e.body.signRequestId);

    const me = founder();
    const b = await build(e.body.signRequestId, me);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body.txs).toHaveLength(2); // 7 holders, ≤ 5 per wallet-signed tx

    const before = holders.map((w) => fake.control.usdcBalance(w));
    const s = await submit(e.body.signRequestId, me, b.body.txs.map((t: { tx: string }) => t.tx));
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.result.distribution.status).toBe("EXECUTED");
    expect(s.body.signatures).toHaveLength(2);
    holders.forEach((w, i) => expect(fake.control.usdcBalance(w)).toBeGreaterThan(before[i]));

    // custody execute afterwards is a no-op
    const after = await call(executePOST, post({ confirmTotal: total }), id);
    expect(after.body.alreadyExecuted).toBe(true);
  });
});
