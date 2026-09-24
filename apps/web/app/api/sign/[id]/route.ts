import { json } from "@/lib/json";
import { handle } from "@/lib/server/http";
import { getSignRequest } from "@/lib/server/sign-flows";

export const dynamic = "force-dynamic";

// GET /api/sign/:id — public view of a wallet-signing request (SPEC 0.4 P1): summary, status,
// signatures, result. The unguessable id is the capability; nothing here can move funds.
// Also used by fundraise_get_sign_request to poll progress.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    return json(await getSignRequest(id));
  });
}
