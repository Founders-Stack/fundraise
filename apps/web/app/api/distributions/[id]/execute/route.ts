import { requireIssuer } from "@/lib/auth";
import { json } from "@/lib/json";
import { handle, readJson } from "@/lib/server/http";
import { executeDistribution } from "@/lib/server/distribution";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/distributions/:id/execute — body { confirmTotal } (USDC decimal string the founder typed).
// Moves USDC. Server-enforced: confirmTotal must equal the snapshot total exactly.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireIssuer(req);
  if (denied) return denied;
  return handle(async () => {
    const { id } = await ctx.params;
    return json(await executeDistribution(id, await readJson(req)));
  });
}
