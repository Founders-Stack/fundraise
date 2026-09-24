// Issuance + market + holders tools. OWNED BY the W2-issuance workstream.
// Thin: each tool maps one-to-one onto an API route and forwards its JSON. No money math here.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { forward } from "./forward.js";
import { signingMode } from "./signing.js";

const issuanceId = z.string().min(1).describe("Issuance id (from fundraise_list_issuances or fundraise_create_issuance)");

export function registerIssuanceTools(server: McpServer) {
  server.registerTool(
    "fundraise_list_issuances",
    {
      title: "List issuances",
      description:
        "List the founder's Cash Flow Rights issuances (GET /api/issuances). Read-only. Returns id, issuer, symbol, terms (rights %, frequency, pricing), mints, pool, next record date, market/onboarding URLs, and participant/distribution counts.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => forward(() => api("GET", "/issuances")),
  );

  server.registerTool(
    "fundraise_preview_issuance",
    {
      title: "Preview a Cash Flow Rights issuance",
      description:
        "Validate launch terms and get the full preview (POST /api/issuances/preview): price derivation, token market caps, DBC fee params, illustrative graduation economics (48/2/50), trading fee split (50/50), agreement summary + text + hash. Creates nothing on-chain; stores a one-time previewId needed by fundraise_create_issuance. Show the preview to the founder before creating.",
      inputSchema: {
        issuerName: z.string().min(1).describe("Company name, e.g. 'Acme SaaS'"),
        symbol: z.string().min(1).max(10).describe("Token symbol, e.g. 'ACME'"),
        tokenName: z.string().optional().describe("Token name (default '<issuer> Cash Flow Participation Unit')"),
        poolPercentageBps: z.number().int().describe("Share of Distributable Cash Flow shared with holders, in basis points (1000 = 10%)"),
        expectedAnnualDcf: z
          .string()
          .describe("Expected annual Distributable Cash Flow in USDC as a DECIMAL string, e.g. '1600000' for $1.6M (not base units)"),
        targetInitialYieldBps: z.number().int().describe("Target initial yield in basis points (1600 = 16%); sets the starting price"),
        distributionFrequency: z.enum(["QUARTERLY", "MONTHLY"]).default("QUARTERLY"),
        tokenSupply: z.string().optional().describe("Whole tokens, default '1000000'"),
        graduationMultiple: z.number().optional().describe("Graduation token market cap = starting × this (default 3)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => forward(() => api("POST", "/issuances/preview", args)),
  );

  server.registerTool(
    "fundraise_create_issuance",
    {
      title: "Create the issuance (on-chain)",
      description:
        "CREATES ON-CHAIN STATE (POST /api/issuances): Token-2022 mint with the allowlist transfer hook + Meteora DBC pool. Requires a previewId from fundraise_preview_issuance; each previewId works once. Only call after showing the preview and receiving the founder's explicit confirmation. " +
        "Custody mode: signed by the server (closed pilot) and returns issuanceId, mint, pool, signatures, marketUrl and onboardUrl. " +
        "Wallet mode: returns status AWAITING_SIGNATURE with a signUrl; nothing is on-chain until the founder opens signUrl in their own browser and signs with their wallet. Then poll fundraise_get_sign_request; its `result` has the market details.",
      inputSchema: {
        previewId: z.string().min(1).describe("previewId returned by fundraise_preview_issuance"),
        signingMode,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ previewId, signingMode }) => forward(() => api("POST", "/issuances", { previewId, signingMode })),
  );

  server.registerTool(
    "fundraise_get_market",
    {
      title: "Get market status",
      description:
        "Market status for an issuance (GET /api/issuances/:id/market). Read-only. Price, token market cap (not company valuation), graduation progress bar, accrued trading fees, trailing/annualized distribution yield, holder counts, pending distributions, next record date, distributionDue, illustrative economics, market URL.",
      inputSchema: { issuanceId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ issuanceId }) => forward(() => api("GET", `/issuances/${encodeURIComponent(issuanceId)}/market`)),
  );

  server.registerTool(
    "fundraise_list_holders",
    {
      title: "List holders and participants",
      description:
        "On-chain holders (classified POOL / PARTICIPANT / UNREGISTERED) and registered participants for an issuance (GET /api/issuances/:id/holders). Read-only. Unregistered holders are flagged and count as unallocated.",
      inputSchema: { issuanceId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ issuanceId }) => forward(() => api("GET", `/issuances/${encodeURIComponent(issuanceId)}/holders`)),
  );
}
