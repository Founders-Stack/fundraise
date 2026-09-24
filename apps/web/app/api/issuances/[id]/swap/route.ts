import { json } from "@/lib/json";
import { handle, parseBaseUnits, readJson } from "@/lib/server/http";
import { parseSwapAmount, swapView } from "@/lib/server/market";

export const dynamic = "force-dynamic";

// POST /api/issuances/:id/swap — PUBLIC. Returns an unsigned base64 transaction for the investor's
// wallet plus the full fee breakdown.
//   Exact input (default): { owner, side, amountIn, minAmountOut? }
//   Exact output: { owner, side, amountOut, maxAmountIn?, slippageBps? } (optionally mode: "EXACT_OUT").
//   The tx receives exactly amountOut (BUY: token base units) and pays at most maxAmountIn
//   (default: quoted input + slippageBps, default 1%).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const body = await readJson(req);
    const { mode, amount } = parseSwapAmount(body);
    if (mode === "EXACT_OUT") {
      const maxAmountIn = parseBaseUnits(body.maxAmountIn ?? "0", "maxAmountIn");
      return json(await swapView(id, body, maxAmountIn, amount, "EXACT_OUT"));
    }
    const minAmountOut = parseBaseUnits(body.minAmountOut ?? "0", "minAmountOut");
    return json(await swapView(id, body, amount, minAmountOut));
  });
}
