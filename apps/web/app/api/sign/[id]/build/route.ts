import { json } from "@/lib/json";
import { handle, readJson } from "@/lib/server/http";
import { buildSignRequest } from "@/lib/server/sign-flows";

export const dynamic = "force-dynamic";

// POST /api/sign/:id/build { wallet } — fresh unsigned tx(s) for the connected wallet. The first
// wallet to build becomes the only one allowed to submit. Public: building moves nothing.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    return json(await buildSignRequest(id, await readJson(req)));
  });
}
