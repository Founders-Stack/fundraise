import { assertOwnsDistribution, requireIssuer } from "@/lib/auth";
import { json } from "@/lib/json";
import { handle } from "@/lib/server/http";
import { snapshotDistribution } from "@/lib/server/distribution";

export const dynamic = "force-dynamic";

// POST /api/distributions/:id/snapshot — read holders from chain, store immutable snapshot, allocate.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireIssuer(req);
  if (auth instanceof Response) return auth;
  return handle(async () => {
    const { id } = await ctx.params;
    await assertOwnsDistribution(auth, id);
    return json(await snapshotDistribution(id));
  });
}
