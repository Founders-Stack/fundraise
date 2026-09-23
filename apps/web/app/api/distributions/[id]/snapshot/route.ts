import { requireIssuer } from "@/lib/auth";
import { json } from "@/lib/json";
import { snapshotDistribution } from "@/lib/server/distribution";

export const dynamic = "force-dynamic";

// POST /api/distributions/:id/snapshot — read holders from chain, store immutable snapshot, allocate.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireIssuer(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const r = await snapshotDistribution(id);
  return json(r.body, { status: r.status });
}
