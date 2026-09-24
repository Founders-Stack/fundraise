// Wallet-signing links (SPEC 0.4 P1). In wallet mode the mutating tools return a `signUrl`
// (/sign/[requestId]) instead of signing with server keys; the founder opens it in their own
// browser and signs with their wallet. This tool polls the outcome.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { forward } from "./forward.js";

/** Shared input for the mutating tools. Omit to use the server default (FS_SIGNING_MODE, else custody). */
export const signingMode = z
  .enum(["custody", "wallet"])
  .optional()
  .describe(
    'Who signs. "wallet": nothing happens on-chain yet; the result has status AWAITING_SIGNATURE and a signUrl the ' +
      'founder must open in their own browser to sign with their wallet. "custody": the server signs (closed pilot). ' +
      "Omit to use the server default.",
  );

export function registerSigningTools(server: McpServer) {
  server.registerTool(
    "fundraise_get_sign_request",
    {
      title: "Check a wallet-signing link",
      description:
        "Status of a /sign/[requestId] link returned by fundraise_create_issuance or fundraise_execute_distribution in " +
        "wallet mode (GET /api/sign/:id). Read-only. status: PENDING (founder has not signed yet; `error` shows a failed " +
        "attempt), COMPLETED (`result` holds the same payload the custody call would have returned, `signatures` the " +
        "confirmed txs), EXPIRED (call the mutating tool again for a new link).",
      inputSchema: {
        signRequestId: z.string().min(1).describe("signRequestId from the AWAITING_SIGNATURE response"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ signRequestId }) => forward(() => api("GET", `/sign/${encodeURIComponent(signRequestId)}`)),
  );
}
