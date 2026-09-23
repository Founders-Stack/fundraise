import { requireIssuer } from "@/lib/auth";
import { json } from "@/lib/json";
import { getDistribution } from "@/lib/server/distribution";

export const dynamic = "force-dynamic";

// GET /api/distributions/:id — issuer detail: allocations, excluded, unallocated, balance check, sigs.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireIssuer(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const r = await getDistribution(id);
  return json(r.body, { status: r.status });
}
