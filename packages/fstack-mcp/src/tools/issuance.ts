// Issuance + market + holders tools. OWNED BY the W2-issuance workstream.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { api } from "../client.js";
import { forward } from "./forward.js";

export function registerIssuanceTools(server: McpServer) {
  server.registerTool(
    "fundraise_list_issuances",
    {
      title: "List issuances",
      description:
        "List the founder's Cash Flow Rights issuances (GET /api/issuances). Read-only. Returns id, issuer, symbol, rights %, mints, pool, and counts of participants/distributions.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => forward(() => api("GET", "/issuances")),
  );
}
