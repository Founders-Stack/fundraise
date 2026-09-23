import { requireIssuer } from "@/lib/auth";
import { json } from "@/lib/json";
import { handle, readJson } from "@/lib/server/http";
import { createPreview } from "@/lib/server/issuance";

export const dynamic = "force-dynamic";

// POST /api/issuances/preview (issuer) — validate terms, derive pricing/fees/economics/agreement,
// store an IssuancePreview. Nothing on-chain. expectedAnnualDcf is a USDC DECIMAL string ("1600000").
export async function POST(req: Request) {
  const denied = requireIssuer(req);
  if (denied) return denied;
  return handle(async () => json(await createPreview(await readJson(req)), { status: 201 }));
}
