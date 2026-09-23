import { requireIssuer } from "@/lib/auth";
import { json } from "@/lib/json";
import { listDistributions, reportPeriod } from "@/lib/server/distribution";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/issuances/:id/distributions — PUBLIC history + allocations + signatures + yield (R7).
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const r = await listDistributions(id);
  return json(r.body, { status: r.status });
}

// POST /api/issuances/:id/distributions — issuer reports a period (DRAFT). Body: { periodLabel, dcf, reportUrl? }.
export async function POST(req: Request, ctx: Ctx) {
  const denied = requireIssuer(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: "invalid_json", message: "body must be JSON" }, { status: 400 });
  const r = await reportPeriod(id, body);
  return json(r.body, { status: r.status });
}
