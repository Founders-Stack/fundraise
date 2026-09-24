import { json } from "@/lib/json";
import { handle, readJson } from "@/lib/server/http";
import { registerParticipant } from "@/lib/server/market";

export const dynamic = "force-dynamic";

// POST /api/issuances/:id/participants — PUBLIC investor onboarding (SPEC section 6: one screen, one signature).
// Body: { wallet, eligible: true, agreementHash, signature, invite, displayName? }
// invite = the issuance's invite code (from the ?invite= link); required when the issuance has one.
// signature = ed25519 signMessage (base58 or base64) over exactly
//   agreementAcceptanceMessage({ issuanceId, wallet, agreementHash }) (lib/server/agreement-message.ts),
// which includes the eligibility statement. On success the wallet is allowlisted on the transfer hook.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    return json(await registerParticipant(id, await readJson(req)));
  });
}
