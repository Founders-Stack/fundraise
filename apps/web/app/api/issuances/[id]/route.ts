import { json } from "@/lib/json";
import { handle } from "@/lib/server/http";
import { getIssuanceOr404, getLaunchTerms, publicIssuanceView } from "@/lib/server/issuance";

export const dynamic = "force-dynamic";

// GET /api/issuances/:id — PUBLIC. Terms, agreement text + hash, mints, pool, fees, next record date.
// Also the token metadata URI.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const issuance = await getIssuanceOr404(id);
    return json(publicIssuanceView(issuance, await getLaunchTerms(id)));
  });
}
