import { json } from "@/lib/json";
import { handle, readJson } from "@/lib/server/http";
import { registerParticipant } from "@/lib/server/market";

export const dynamic = "force-dynamic";

// POST /api/issuances/:id/participants — PUBLIC investor onboarding.
// Body: { wallet, displayName?, verified: true, eligible: true, agreementHash, signature }
// signature = ed25519 signMessage (base58 or base64) over exactly
//   `Founder Stack: I accept the Cash Flow Participation Agreement ${agreementHash} for issuance ${id}`
// (see lib/server/agreement-message.ts). On success the wallet is allowlisted on the transfer hook.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    return json(await registerParticipant(id, await readJson(req)));
  });
}
