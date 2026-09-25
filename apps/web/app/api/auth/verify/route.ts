import { json } from "@/lib/json";
import { handle, readJson } from "@/lib/server/http";
import { verifyChallenge } from "@/lib/server/wallet-auth";

export const dynamic = "force-dynamic";

// POST /api/auth/verify { wallet, nonce, signature, label? } — PUBLIC. `signature` is the wallet's ed25519
// signature over the challenge message (base64 or base58). Returns a new API key, shown once.
export async function POST(req: Request) {
  return handle(async () => json(await verifyChallenge(await readJson(req)), { status: 201 }));
}
