// Shared helpers for the API tests: call route handlers in-process like the MCP server would.
import nacl from "tweetnacl";
import bs58 from "bs58";
import { expect } from "vitest";
import { POST as previewPOST } from "@/app/api/issuances/preview/route";
import { POST as createPOST } from "@/app/api/issuances/route";
import { POST as participantsPOST } from "@/app/api/issuances/[id]/participants/route";
import { agreementAcceptanceMessage } from "@/lib/server/agreement-message";

export const AUTH = { authorization: "Bearer test-token", "content-type": "application/json" };

export const ACME = {
  issuerName: "Acme SaaS",
  symbol: "ACME",
  poolPercentageBps: 1000,
  expectedAnnualDcf: "1600000",
  targetInitialYieldBps: 1600,
  distributionFrequency: "QUARTERLY",
};

export const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

export const post = (body: unknown, headers: Record<string, string> = AUTH) =>
  new Request("http://test/api", { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });

export const get = (headers: Record<string, string> = {}, url = "http://test/api") => new Request(url, { headers });

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

/** Calls a route handler and returns { status, body } with the parsed JSON body. */
export async function call(handler: Handler, req: Request, id = ""): Promise<{ status: number; body: Json }> {
  const res = await handler(req, ctx(id));
  return { status: res.status, body: await res.json() };
}

export async function preview(body: unknown = ACME) {
  const res = await previewPOST(post(body));
  return { status: res.status, body: (await res.json()) as Json };
}

export async function create(previewId: unknown) {
  const res = await createPOST(post({ previewId }));
  return { status: res.status, body: (await res.json()) as Json };
}

/** Preview + create through the API. */
export async function launch(overrides: Record<string, unknown> = {}) {
  const p = await preview({ ...ACME, ...overrides });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const c = await create(p.body.previewId);
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  return c.body as {
    issuanceId: string;
    agreementHash: string;
    inviteCode: string;
    onboardUrl: string;
    dbcPool: string;
    baseMint: string;
    nextRecordDate: string;
  };
}

/** A fresh wallet that signs the agreement for this issuance. */
export function signer(issuanceId: string, agreementHash: string) {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const sign = (message: string) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
  return { wallet, signature: sign(agreementAcceptanceMessage({ issuanceId, wallet, agreementHash })), sign };
}

/** Full investor onboarding through the public participants API (invite, checkbox, one signature, allowlisted). */
export async function onboard(issuance: { issuanceId: string; agreementHash: string; inviteCode: string }, displayName: string) {
  const { wallet, signature } = signer(issuance.issuanceId, issuance.agreementHash);
  const r = await call(
    participantsPOST,
    post({ wallet, displayName, eligible: true, agreementHash: issuance.agreementHash, signature, invite: issuance.inviteCode }, {}),
    issuance.issuanceId,
  );
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return wallet;
}
