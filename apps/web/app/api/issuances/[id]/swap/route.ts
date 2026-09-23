import { json } from "@/lib/json";
import { handle, parseBaseUnits, readJson } from "@/lib/server/http";
import { swapView } from "@/lib/server/market";

export const dynamic = "force-dynamic";

// POST /api/issuances/:id/swap { owner, side, amountIn, minAmountOut } — PUBLIC.
// Returns an unsigned base64 transaction for the investor's wallet plus the full fee breakdown.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const body = await readJson(req);
    const amountIn = parseBaseUnits(body.amountIn, "amountIn");
    const minAmountOut = parseBaseUnits(body.minAmountOut ?? "0", "minAmountOut");
    return json(await swapView(id, body, amountIn, minAmountOut));
  });
}
