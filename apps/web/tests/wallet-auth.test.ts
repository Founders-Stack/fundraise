import nacl from "tweetnacl";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { POST as challengePOST } from "@/app/api/auth/challenge/route";
import { POST as verifyPOST } from "@/app/api/auth/verify/route";
import { DELETE as meDELETE, GET as meGET } from "@/app/api/auth/me/route";
import { GET as listGET, POST as createPOST } from "@/app/api/issuances/route";
import { POST as previewPOST } from "@/app/api/issuances/preview/route";
import { POST as reportPOST } from "@/app/api/issuances/[id]/distributions/route";
import { GET as marketGET } from "@/app/api/issuances/[id]/market/route";
import { ACME, AUTH, call, get, post, type Json } from "./helpers";

const bearer = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

/** Full wallet login: challenge → sign → API key. */
async function login(kp = nacl.sign.keyPair()) {
  const wallet = bs58.encode(kp.publicKey);
  const c = await call(challengePOST, post({ wallet }, {}));
  expect(c.status).toBe(201);
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(c.body.message), kp.secretKey));
  const v = await call(verifyPOST, post({ wallet, nonce: c.body.nonce, signature, label: "test" }, {}));
  return { kp, wallet, challenge: c.body as Json, signature, verify: v };
}

async function launchAs(headers: Record<string, string>) {
  const p = await call(previewPOST, post(ACME, headers));
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const c = await call(createPOST, post({ previewId: p.body.previewId }, headers));
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  return c.body.issuanceId as string;
}

describe("wallet login", () => {
  it("mints an fsk_ key from a signed challenge and identifies the wallet", async () => {
    const a = await login();
    expect(a.verify.status).toBe(201);
    expect(a.verify.body.apiKey).toMatch(/^fsk_/);
    const me = await call(meGET, get(bearer(a.verify.body.apiKey)));
    expect(me.body).toMatchObject({ kind: "issuer", wallet: a.wallet });
  });

  it("rejects a bad signature, a wrong wallet, and a replayed challenge", async () => {
    const a = await login();
    const other = nacl.sign.keyPair();
    const bad = bs58.encode(nacl.sign.detached(new TextEncoder().encode(a.challenge.message), other.secretKey));
    const c = await call(challengePOST, post({ wallet: a.wallet }, {}));
    const forged = await call(verifyPOST, post({ wallet: a.wallet, nonce: c.body.nonce, signature: bad }, {}));
    expect(forged.status).toBe(401);
    expect(forged.body.error).toBe("invalid_signature");

    const replay = await call(verifyPOST, post({ wallet: a.wallet, nonce: a.challenge.nonce, signature: a.signature }, {}));
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe("challenge_used");

    const stolen = await call(verifyPOST, post({ wallet: bs58.encode(other.publicKey), nonce: c.body.nonce, signature: bad }, {}));
    expect(stolen.status).toBe(400);
  });

  it("rejects an invalid wallet address", async () => {
    const r = await call(challengePOST, post({ wallet: "not-a-wallet" }, {}));
    expect(r.status).toBe(400);
  });

  it("revoking a key stops it working", async () => {
    const a = await login();
    const key = a.verify.body.apiKey as string;
    expect((await call(meDELETE, new Request("http://test/api/auth/me", { method: "DELETE", headers: bearer(key) }))).status).toBe(200);
    expect((await call(listGET, get(bearer(key)))).status).toBe(401);
  });
});

describe("issuance ownership", () => {
  it("a wallet key sees and manages only its own issuances", async () => {
    const a = await login();
    const b = await login();
    const keyA = bearer(a.verify.body.apiKey);
    const keyB = bearer(b.verify.body.apiKey);

    const idA = await launchAs(keyA);

    const listA = await call(listGET, get(keyA));
    expect(listA.body.issuances.map((i: Json) => i.id)).toContain(idA);
    const listB = await call(listGET, get(keyB));
    expect(listB.body.issuances.map((i: Json) => i.id)).not.toContain(idA);
    const listAdmin = await call(listGET, get(AUTH));
    expect(listAdmin.body.issuances.map((i: Json) => i.id)).toContain(idA);

    const report = { periodLabel: "2026-Q3", dcf: "100000" };
    expect((await call(reportPOST, post(report, keyB), idA)).status).toBe(403);
    expect((await call(reportPOST, post(report, keyA), idA)).status).toBe(201);
  });

  it("the invite link is shown only to the owner and admin", async () => {
    const a = await login();
    const b = await login();
    const idA = await launchAs(bearer(a.verify.body.apiKey));
    const market = (h: Record<string, string>) => call(marketGET, get(h), idA);
    expect((await market(bearer(a.verify.body.apiKey))).body.onboardUrl).toContain("invite=");
    expect((await market(AUTH)).body.onboardUrl).toContain("invite=");
    expect((await market(bearer(b.verify.body.apiKey))).body.onboardUrl).not.toContain("invite=");
    expect((await market({})).body.onboardUrl).not.toContain("invite=");
  });

  it("a wallet key cannot create from another wallet's preview", async () => {
    const a = await login();
    const b = await login();
    const p = await call(previewPOST, post(ACME, bearer(a.verify.body.apiKey)));
    const stolen = await call(createPOST, post({ previewId: p.body.previewId }, bearer(b.verify.body.apiKey)));
    expect(stolen.status).toBe(403);
    expect(stolen.body.error).toBe("not_owner");
  });

  it("admin-owned issuances are not manageable by wallet keys", async () => {
    const a = await login();
    const idAdmin = await launchAs(AUTH);
    const r = await call(reportPOST, post({ periodLabel: "2026-Q3", dcf: "1" }, bearer(a.verify.body.apiKey)), idAdmin);
    expect(r.status).toBe(403);
  });

  it("anonymous callers get 401 on issuer routes", async () => {
    expect((await call(listGET, get({}))).status).toBe(401);
    expect((await call(previewPOST, post(ACME, {}))).status).toBe(401);
  });
});
