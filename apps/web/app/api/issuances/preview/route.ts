import { requireIssuer } from "@/lib/auth";
import { json } from "@/lib/json";
import { handle, readJson } from "@/lib/server/http";
import { createPreview } from "@/lib/server/issuance";

export const dynamic = "force-dynamic";

// POST /api/issuances/preview (issuer) — validate terms, derive pricing/fees/economics/agreement,
// store an IssuancePreview. Nothing on-chain. expectedAnnualDcf is a USDC DECIMAL string ("1600000").
export async function POST(req: Request) {
  const auth = await requireIssuer(req);
  if (auth instanceof Response) return auth;
  const owner = auth.kind === "issuer" ? auth.wallet : null;
  return handle(async () => json(await createPreview(await readJson(req), owner), { status: 201 }));
}
