import { json } from "@/lib/json";
import { handle } from "@/lib/server/http";
import { getIssuanceOr404, publicIssuanceView } from "@/lib/server/issuance";

export const dynamic = "force-dynamic";

// GET /api/issuances/:id — PUBLIC. Terms, agreement text + hash, mints, pool, fees, next record date.
// Also the token metadata URI.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    return json(publicIssuanceView(await getIssuanceOr404(id)));
  });
}
