import { json } from "@/lib/json";
import { handle, readJson } from "@/lib/server/http";
import { createChallenge } from "@/lib/server/wallet-auth";

export const dynamic = "force-dynamic";

// POST /api/auth/challenge { wallet } — PUBLIC. Returns the message the wallet must sign (valid 5 min, one use).
export async function POST(req: Request) {
  return handle(async () => json(await createChallenge(await readJson(req)), { status: 201 }));
}
