import { prisma } from "@/lib/db";
import { requireIssuer } from "@/lib/auth";
import { json } from "@/lib/json";
import { handle, readJson } from "@/lib/server/http";
import { createIssuance, publicIssuanceView } from "@/lib/server/issuance";

export const dynamic = "force-dynamic";

// GET /api/issuances — list issuances (issuer principal; used by fundraise_list_issuances).
export async function GET(req: Request) {
  const denied = requireIssuer(req);
  if (denied) return denied;
  return handle(async () => {
    const issuances = await prisma.issuance.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { participants: true, distributions: true } } },
    });
    return json({
      issuances: issuances.map((i) => {
        const { agreement, ...view } = publicIssuanceView(i);
        return {
          ...view,
          agreement: { version: agreement.version, hash: agreement.hash },
          participantCount: i._count.participants,
          distributionCount: i._count.distributions,
        };
      }),
    });
  });
}

// POST /api/issuances { previewId } (issuer) — server-side confirmation gate: the previewId must
// exist and be unused. Creates the Issuance + Token-2022 mint + Meteora DBC pool (on-chain).
export async function POST(req: Request) {
  const denied = requireIssuer(req);
  if (denied) return denied;
  return handle(async () => {
    const body = await readJson(req);
    return json(await createIssuance(body.previewId), { status: 201 });
  });
}
