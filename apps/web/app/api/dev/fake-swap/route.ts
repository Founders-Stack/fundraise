import { json } from "@/lib/json";
import { HttpError, handle, parseBaseUnits, readJson } from "@/lib/server/http";
import { loadIssuance, requireMarket } from "@/lib/server/issuance-record";

export const dynamic = "force-dynamic";

// POST /api/dev/fake-swap { issuanceId, owner, side, tokens } — DEV ONLY (CHAIN_MODE=fake).
// Simulates a confirmed swap on the in-process fake chain so the web buy/sell flow can be
// exercised end to end without a real transaction. 404 in any other chain mode.
// `tokens` is token base units (6 dp).
export async function POST(req: Request) {
  if ((process.env.CHAIN_MODE ?? "fake") !== "fake") {
    return json({ error: "not_found", message: "Not found" }, { status: 404 });
  }
  return handle(async () => {
    const body = await readJson(req);
    const issuanceId = typeof body.issuanceId === "string" ? body.issuanceId : "";
    const owner = typeof body.owner === "string" ? body.owner.trim() : "";
    const side = typeof body.side === "string" ? body.side.toUpperCase() : "";
    if (!issuanceId || !owner) throw new HttpError(400, "invalid_input", "issuanceId and owner are required");
    if (side !== "BUY" && side !== "SELL") throw new HttpError(400, "invalid_input", "side must be BUY or SELL");
    const tokens = parseBaseUnits(body.tokens, "tokens");
    if (tokens <= 0n) throw new HttpError(400, "invalid_input", "tokens must be > 0");

    const { dbcPool } = requireMarket(await loadIssuance(issuanceId));

    // File-backed fake chain: the same .fake-chain.json the server's fake ports read.
    const { createFakeChain } = await import("@/lib/chain/fake");
    try {
      const { signature } = createFakeChain().control.swap(dbcPool, owner, side, tokens);
      return json({ signature, fake: true, side, tokens });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "NotEligible") {
        throw new HttpError(403, "NotEligible", "This wallet isn't an eligible participant yet (Token-2022 transfer hook)");
      }
      throw new HttpError(400, "swap_failed", msg);
    }
  });
}
