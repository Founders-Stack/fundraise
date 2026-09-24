import { json } from "@/lib/json";
import { handle } from "@/lib/server/http";
import { parseSwapAmount, quoteView } from "@/lib/server/market";

export const dynamic = "force-dynamic";

// GET /api/issuances/:id/quote?side=BUY|SELL&amountIn=<base units> — PUBLIC.
// BUY amountIn = USDC base units; SELL amountIn = token base units (6 dp).
// Exact output: ?side=BUY&amountOut=<token base units> (optionally &mode=EXACT_OUT) quotes the USDC
// needed (incl. fees) to receive exactly amountOut. SELL amountOut = USDC base units.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const q = new URL(req.url).searchParams;
    const { mode, amount } = parseSwapAmount({ amountIn: q.get("amountIn"), amountOut: q.get("amountOut"), mode: q.get("mode") });
    return json(await quoteView(id, q.get("side"), amount, mode));
  });
}
