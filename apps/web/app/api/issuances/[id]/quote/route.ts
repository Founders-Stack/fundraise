import { json } from "@/lib/json";
import { handle, parseBaseUnits } from "@/lib/server/http";
import { quoteView } from "@/lib/server/market";

export const dynamic = "force-dynamic";

// GET /api/issuances/:id/quote?side=BUY|SELL&amountIn=<base units> — PUBLIC.
// BUY amountIn = USDC base units; SELL amountIn = token base units (6 dp).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const amountIn = parseBaseUnits(url.searchParams.get("amountIn"), "amountIn");
    return json(await quoteView(id, url.searchParams.get("side"), amountIn));
  });
}
