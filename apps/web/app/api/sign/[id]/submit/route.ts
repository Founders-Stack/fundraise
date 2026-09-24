import { json } from "@/lib/json";
import { handle, readJson } from "@/lib/server/http";
import { submitSignRequest } from "@/lib/server/sign-flows";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/sign/:id/submit { wallet, signedTxs } — the wallet-signed tx(s). The server checks each
// is exactly the prepared tx plus the signer's valid signature, broadcasts, waits for confirmation
// and applies the result (market attached / payouts recorded). Public: only the signer's own
// signature can authorize it.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    return json(await submitSignRequest(id, await readJson(req)));
  });
}
