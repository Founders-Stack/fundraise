import { json } from "@/lib/json";
import { handle } from "@/lib/server/http";
import { walletView } from "@/lib/server/market";

export const dynamic = "force-dynamic";

// GET /api/issuances/:id/wallets/:wallet — PUBLIC. Is this wallet onboarded, does it hold enough
// SOL and USDC to trade (pre-flight, SPEC section 6), and the exact message it would sign.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; wallet: string }> }) {
  return handle(async () => {
    const { id, wallet } = await ctx.params;
    return json(await walletView(id, wallet));
  });
}
