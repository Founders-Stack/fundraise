import { canManage, getPrincipal } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { json } from "@/lib/json";
import { handle } from "@/lib/server/http";
import { getHoldersView } from "@/lib/server/market";

export const dynamic = "force-dynamic";

// GET /api/issuances/:id/holders — PUBLIC (chain balances + classification).
// Display names and the participant list are only included for the issuance's owner (or admin).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const owner = await prisma.issuance.findUnique({ where: { id }, select: { ownerWallet: true } });
    const isOwner = canManage(await getPrincipal(req), owner?.ownerWallet ?? null);
    return json(await getHoldersView(id, isOwner));
  });
}
