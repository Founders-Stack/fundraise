import { canManage, getPrincipal } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { json } from "@/lib/json";
import { handle } from "@/lib/server/http";
import { getMarketView } from "@/lib/server/market";

export const dynamic = "force-dynamic";

// GET /api/issuances/:id/market — PUBLIC. Price, token market cap, graduation progress,
// trailing/annualized yield over EXECUTED distributions, holder counts, economics.
// For the issuance's owner (or admin), `onboardUrl` carries the invite code (the link to share with investors).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const owner = await prisma.issuance.findUnique({ where: { id }, select: { ownerWallet: true } });
    const isOwner = canManage(await getPrincipal(req), owner?.ownerWallet ?? null);
    return json(await getMarketView(id, { isIssuer: isOwner }));
  });
}
