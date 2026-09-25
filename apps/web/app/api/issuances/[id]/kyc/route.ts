import { json } from "@/lib/json";
import { handle, readJson } from "@/lib/server/http";
import { pollKycProof, startKycProof } from "@/lib/server/market";

export const dynamic = "force-dynamic";

// ZK passport (Rarimo) onboarding, PUBLIC like the rest of investor onboarding.
// POST { wallet }        -> { link, minAge, blockedCitizenships }  RariMe deep link / QR for the proof request
// GET  ?wallet=<base58>  -> { status: "pending" } | { status: "verified", citizenship, tx }
//   tx = unsigned base64 transaction (fee payer = wallet): [submit_kyc_proof?, add_allow_kyc]. The wallet signs
//   and sends it; then POST /participants with { kyc: true, kycTx: <signature> } records the agreement.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    return json(await startKycProof(id, await readJson(req)));
  });
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const wallet = new URL(req.url).searchParams.get("wallet") ?? "";
    return json(await pollKycProof(id, wallet));
  });
}
