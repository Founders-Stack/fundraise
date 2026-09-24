import { requireIssuer } from "@/lib/auth";
import { json } from "@/lib/json";
import { handle, readJson } from "@/lib/server/http";
import { listDistributions, reportPeriod } from "@/lib/server/distribution";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/issuances/:id/distributions — PUBLIC history + allocations + signatures + yield (R7).
export async function GET(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const { id } = await ctx.params;
    return json(await listDistributions(id));
  });
}

// POST /api/issuances/:id/distributions — issuer reports a period (DRAFT). Body: { periodLabel, dcf, reportUrl? }.
export async function POST(req: Request, ctx: Ctx) {
  const denied = requireIssuer(req);
  if (denied) return denied;
  return handle(async () => {
    const { id } = await ctx.params;
    return json(await reportPeriod(id, await readJson(req)), { status: 201 });
  });
}
