import { json } from "@/lib/json";
import { handle } from "@/lib/server/http";
import { getClaimProof } from "@/lib/server/escrow";

export const dynamic = "force-dynamic";

// GET /api/distributions/:id/proof?wallet=W — public Merkle proof + the message to sign for a claim.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    return json(await getClaimProof(id, new URL(req.url).searchParams.get("wallet")));
  });
}
