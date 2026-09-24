#!/usr/bin/env node
// fstack MCP server: thin, typed tools that map 1:1 onto the Founder Stack API.
// Skills are the conversation, this server is the hands, the API is the brain.
// Tools live in tools/*.ts, one file per workstream, to avoid merge conflicts.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FS_API_URL } from "./client.js";
import { registerIssuanceTools } from "./tools/issuance.js";
import { registerDistributionTools } from "./tools/distribution.js";
import { registerSigningTools } from "./tools/signing.js";

const server = new McpServer({ name: "fstack", version: "0.1.0" });

registerIssuanceTools(server);
registerDistributionTools(server);
registerSigningTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`fstack MCP server running on stdio (API: ${FS_API_URL})`);
