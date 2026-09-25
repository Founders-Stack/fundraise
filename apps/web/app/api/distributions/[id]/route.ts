import { assertOwnsDistribution, requireIssuer } from "@/lib/auth";
import { json } from "@/lib/json";
import { handle } from "@/lib/server/http";
import { getDistribution } from "@/lib/server/distribution";

export const dynamic = "force-dynamic";

// GET /api/distributions/:id — issuer detail: allocations, excluded, unallocated, balance check, sigs.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireIssuer(req);
  if (auth instanceof Response) return auth;
  return handle(async () => {
    const { id } = await ctx.params;
    await assertOwnsDistribution(auth, id);
    return json(await getDistribution(id));
  });
}
