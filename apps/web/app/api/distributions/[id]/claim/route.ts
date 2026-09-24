import { json } from "@/lib/json";
import { handle, readJson } from "@/lib/server/http";
import { claimDistribution } from "@/lib/server/escrow";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/distributions/:id/claim — body { wallet, signature, proof? }. Public: the holder's wallet
// signature over claimMessage is the authorization, and the payout only goes to that wallet.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    return json(await claimDistribution(id, await readJson(req)));
  });
}
