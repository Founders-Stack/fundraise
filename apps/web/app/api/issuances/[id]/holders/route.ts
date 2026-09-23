import { isIssuer } from "@/lib/auth";
import { json } from "@/lib/json";
import { handle } from "@/lib/server/http";
import { getHoldersView } from "@/lib/server/market";

export const dynamic = "force-dynamic";

// GET /api/issuances/:id/holders — PUBLIC (chain balances + classification).
// Display names and the participant list are only included for the issuer principal.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    return json(await getHoldersView(id, isIssuer(req)));
  });
}
