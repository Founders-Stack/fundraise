import { getPrincipal } from "@/lib/auth";
import { json } from "@/lib/json";
import { HttpError, handle } from "@/lib/server/http";
import { listKeys, revokeKey } from "@/lib/server/wallet-auth";

export const dynamic = "force-dynamic";

// GET /api/auth/me — who this bearer token is, plus the wallet's active keys.
export async function GET(req: Request) {
  return handle(async () => {
    const p = await getPrincipal(req);
    if (p.kind === "public") throw new HttpError(401, "unauthorized", "Missing or invalid bearer token");
    if (p.kind === "admin") return json({ kind: "admin" });
    return json({ kind: "issuer", wallet: p.wallet, currentKeyId: p.keyId, keys: await listKeys(p.wallet) });
  });
}

// DELETE /api/auth/me?keyId=… — revoke one of this wallet's keys (default: the key used for this call).
export async function DELETE(req: Request) {
  return handle(async () => {
    const p = await getPrincipal(req);
    if (p.kind !== "issuer") throw new HttpError(401, "unauthorized", "A wallet API key is required");
    const keyId = new URL(req.url).searchParams.get("keyId") ?? p.keyId;
    await revokeKey(p.wallet, keyId);
    return json({ revoked: keyId });
  });
}
