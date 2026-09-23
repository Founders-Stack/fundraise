#!/usr/bin/env node
// fstack MCP server: thin, typed tools that map 1:1 onto the Founder Stack API.
// Skills are the conversation, this server is the hands, the API is the brain.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { api, ApiError, FS_API_URL } from "./client.js";

const server = new McpServer({ name: "fstack", version: "0.1.0" });

async function forward(call: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await call();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    const message =
      err instanceof ApiError
        ? JSON.stringify({ error: "api_error", status: err.status, body: err.body })
        : JSON.stringify({ error: "network_error", apiUrl: FS_API_URL, message: String(err) });
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`fstack MCP server running on stdio (API: ${FS_API_URL})`);
