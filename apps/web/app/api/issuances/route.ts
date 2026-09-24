import { requireIssuer } from "@/lib/auth";
import { json } from "@/lib/json";
import { handle, readJson } from "@/lib/server/http";
import { createIssuance, publicIssuanceView } from "@/lib/server/issuance";
import { listIssuances } from "@/lib/server/issuance-record";

export const dynamic = "force-dynamic";

// GET /api/issuances — list issuances (issuer principal; used by fundraise_list_issuances).
export async function GET(req: Request) {
  const denied = requireIssuer(req);
  if (denied) return denied;
  return handle(async () => {
    const issuances = await listIssuances();
    return json({
      issuances: issuances.map(({ record, participantCount, distributionCount }) => {
        const { agreement, ...view } = publicIssuanceView(record);
        return {
          ...view,
          agreement: { version: agreement.version, hash: agreement.hash },
          participantCount,
          distributionCount,
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
