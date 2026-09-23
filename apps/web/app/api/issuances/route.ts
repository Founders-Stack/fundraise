import { prisma } from "@/lib/db";
import { requireIssuer } from "@/lib/auth";
import { json } from "@/lib/json";

export const dynamic = "force-dynamic";

// GET /api/issuances — list issuances (issuer principal; used by fundraise_list_issuances).
export async function GET(req: Request) {
  const denied = requireIssuer(req);
  if (denied) return denied;

  const issuances = await prisma.issuance.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { participants: true, distributions: true } } },
  });

  return json({
    issuances: issuances.map(({ agreementText: _t, monetization, dbcConfig, ...rest }) => ({
      ...rest,
      monetization: monetization ? JSON.parse(monetization) : null,
      dbcConfig: dbcConfig ? JSON.parse(dbcConfig) : null,
    })),
  });
}
