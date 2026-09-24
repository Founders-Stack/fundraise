// Seeds demo data through the public/issuer API (CHAIN_MODE=fake only: uses /api/dev/fake-swap).
//   pnpm --filter web exec tsx scripts/seed-demo.ts [baseUrl]
// Story (SPEC section 10): Acme SaaS launches, Alice onboards + buys 100k, Q3 is distributed,
// Bob onboards, Alice sells 40k and Bob buys 40k, Q4 is distributed. A second issuance is
// launched so the home page lists more than one market.
import nacl from "tweetnacl";
import bs58 from "bs58";

const BASE = (process.argv[2] ?? process.env.SEED_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const TOKEN = process.env.FS_API_TOKEN ?? "dev-local-token";
const U = 1_000_000n; // 6 dp

async function call(method: string, path: string, body?: unknown, auth = false) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data as Record<string, any>;
}

function wallet(name: string) {
  const kp = nacl.sign.keyPair();
  return { name, kp, address: bs58.encode(kp.publicKey) };
}

async function launch(terms: Record<string, unknown>) {
  const preview = await call("POST", "/api/issuances/preview", terms, true);
  const created = await call("POST", "/api/issuances", { previewId: preview.previewId }, true);
  return created as { issuanceId: string; agreementHash: string };
}

async function onboard(id: string, agreementHash: string, w: ReturnType<typeof wallet>) {
  const msg = `Founder Stack: I accept the Cash Flow Participation Agreement ${agreementHash} for issuance ${id}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(msg), w.kp.secretKey);
  return call("POST", `/api/issuances/${id}/participants`, {
    wallet: w.address,
    displayName: w.name,
    verified: true,
    eligible: true,
    agreementHash,
    signature: bs58.encode(sig),
  });
}

const swap = (issuanceId: string, owner: string, side: "BUY" | "SELL", whole: bigint) =>
  call("POST", "/api/dev/fake-swap", { issuanceId, owner, side, tokens: (whole * U).toString() });

async function distribute(id: string, periodLabel: string, dcf: string) {
  const r = await call("POST", `/api/issuances/${id}/distributions`, { periodLabel, dcf, reportUrl: `https://acme.example/reports/${periodLabel}.json` }, true);
  const distId = r.distribution.id as string;
  const snap = await call("POST", `/api/distributions/${distId}/snapshot`, {}, true);
  const total = snap.confirmTotal ?? snap.totalAllocated?.usdc ?? snap.distribution?.totalAllocated?.usdc ?? snap.totals?.allocated;
  const ex = await call("POST", `/api/distributions/${distId}/execute`, { confirmTotal: String(typeof total === "object" ? total.usdc : total) }, true);
  return { distId, ex };
}

async function main() {
  const acme = await launch({
    issuerName: "Acme SaaS",
    symbol: "ACME",
    tokenName: "Acme SaaS Cash Flow Participation Unit",
    poolPercentageBps: 1000,
    expectedAnnualDcf: "1600000",
    targetInitialYieldBps: 1600,
    distributionFrequency: "QUARTERLY",
  });
  const id = acme.issuanceId;
  console.log("ACME issuance", id);

  const alice = wallet("Alice");
  const bob = wallet("Bob");
  const carol = wallet("Carol");

  await onboard(id, acme.agreementHash, alice);
  await swap(id, alice.address, "BUY", 100_000n);
  try {
    await swap(id, carol.address, "BUY", 1_000n);
  } catch (e) {
    console.log("Carol blocked as expected:", (e as Error).message.slice(0, 80));
  }
  const q3 = await distribute(id, "2026-Q3", "400000");
  console.log("Q3 executed", q3.distId);

  await onboard(id, acme.agreementHash, bob);
  await swap(id, alice.address, "SELL", 40_000n);
  await swap(id, bob.address, "BUY", 40_000n);
  const q4 = await distribute(id, "2026-Q4", "450000");
  console.log("Q4 executed", q4.distId);

  const nw = await launch({
    issuerName: "Northwind Analytics",
    symbol: "NWND",
    poolPercentageBps: 800,
    expectedAnnualDcf: "900000",
    targetInitialYieldBps: 1400,
    distributionFrequency: "QUARTERLY",
  });
  const dave = wallet("Dave");
  await onboard(nw.issuanceId, nw.agreementHash, dave);
  await swap(nw.issuanceId, dave.address, "BUY", 25_000n);
  console.log("NWND issuance", nw.issuanceId);

  console.log(JSON.stringify({ acme: id, northwind: nw.issuanceId, wallets: { alice: alice.address, bob: bob.address, carol: carol.address } }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
