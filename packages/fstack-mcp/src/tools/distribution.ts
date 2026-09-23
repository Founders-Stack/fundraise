// Period report + snapshot + execute tools. OWNED BY the W2-distribution workstream.
// Thin 1:1 wrappers over the API: every amount is computed server-side and returned for display.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { forward } from "./forward.js";

const usdcAmount = z
  .string()
  .min(1)
  .describe('USDC amount as a decimal string, e.g. "400000" or "400000.50" (NOT base units)');

export function registerDistributionTools(server: McpServer) {
  server.registerTool(
    "fundraise_report_period",
    {
      title: "Report a period's distributable cash flow",
      description:
        "Report a closed period's Distributable Cash Flow (POST /api/issuances/:id/distributions). Creates a DRAFT " +
        "distribution and returns the rights pool, per-token amount and reportHash. Writes to the DB only (no money moves). " +
        "Only call with a DCF the founder has explicitly confirmed. Rejects a duplicate period or a second open distribution.",
      inputSchema: {
        issuanceId: z.string().min(1).describe("Issuance id (from fundraise_list_issuances)"),
        periodLabel: z.string().min(1).max(40).describe('Period label, e.g. "2026-Q3"'),
        dcf: usdcAmount.describe('Founder-confirmed DCF in USDC as a decimal string, e.g. "400000"'),
        reportUrl: z.string().url().optional().describe("Optional public URL of the supporting report"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ issuanceId, ...body }) =>
      forward(() => api("POST", `/issuances/${encodeURIComponent(issuanceId)}/distributions`, body)),
  );

  server.registerTool(
    "fundraise_list_distributions",
    {
      title: "List distributions",
      description:
        "Distribution history for an issuance (GET /api/issuances/:id/distributions). Read-only. Returns the agreement's " +
        "DCF definition, every period (status, DCF, rights pool, per token, reportHash, allocations, signatures) and " +
        "informational yield metrics over executed periods.",
      inputSchema: {
        issuanceId: z.string().min(1).describe("Issuance id (from fundraise_list_issuances)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ issuanceId }) => forward(() => api("GET", `/issuances/${encodeURIComponent(issuanceId)}/distributions`)),
  );

  server.registerTool(
    "fundraise_snapshot",
    {
      title: "Snapshot holders and preview allocations",
      description:
        "Take the holder snapshot for a reported period and compute allocations (POST /api/distributions/:id/snapshot). " +
        "Moves no money. Returns the full preview: per-holder payout table, excluded pool/unregistered holders, " +
        "unallocated breakdown, issuer USDC balance check, and `confirmTotal` — the exact total the founder must type " +
        "to execute. Re-running replaces the preview until the distribution is executed.",
      inputSchema: {
        distributionId: z.string().min(1).describe("Distribution id (from fundraise_report_period or fundraise_list_distributions)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ distributionId }) =>
      forward(() => api("POST", `/distributions/${encodeURIComponent(distributionId)}/snapshot`)),
  );

  server.registerTool(
    "fundraise_execute_distribution",
    {
      title: "Execute distribution (moves USDC on-chain)",
      description:
        "MOVES USDC ON-CHAIN from the issuer wallet to every holder in the snapshot (POST /api/distributions/:id/execute). " +
        "Requires `confirmTotal`: the exact total the FOUNDER typed in this conversation after seeing the fundraise_snapshot " +
        "preview. Never call this without the founder typing it; never fill it in yourself from the preview. The server " +
        "rejects any mismatch. Retrying after a partial failure pays only unpaid rows; calling it again after success is a no-op.",
      inputSchema: {
        distributionId: z.string().min(1).describe("Distribution id that was snapshotted"),
        confirmTotal: usdcAmount.describe(
          'The total the founder typed, verbatim, as a USDC decimal string (e.g. "4000" or "4,000.00"). Not base units.',
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ distributionId, confirmTotal }) =>
      forward(() => api("POST", `/distributions/${encodeURIComponent(distributionId)}/execute`, { confirmTotal })),
  );

  server.registerTool(
    "fundraise_get_distribution",
    {
      title: "Get distribution detail",
      description:
        "Full issuer view of one distribution (GET /api/distributions/:id): allocation table, payouts, excluded holders, " +
        "unallocated breakdown, live issuer balance check, signatures and explorer links. Read-only.",
      inputSchema: {
        distributionId: z.string().min(1).describe("Distribution id"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ distributionId }) => forward(() => api("GET", `/distributions/${encodeURIComponent(distributionId)}`)),
  );
}
