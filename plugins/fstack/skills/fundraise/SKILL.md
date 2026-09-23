---
name: fundraise
description: Founder Stack /capital entry point. Use when the founder wants to raise against a share of their company's cash flow, or check the status of their Cash Flow Rights issuances. Lists the founder's issuances via the fstack MCP server.
---

# fundraise (placeholder)

Placeholder for the `/fstack:fundraise` router + status skill (full flow lands in a later task).

## Steps

1. Call the MCP tool `fundraise_list_issuances` (no arguments).
2. If it returns an error:
   - `status: 401` → tell the founder `FS_API_TOKEN` is missing or wrong, and stop.
   - `network_error` → tell the founder the Founder Stack API is not reachable at the shown `apiUrl` (is `pnpm dev` running?), and stop.
3. Otherwise print the issuances as a table: **Issuer**, **Symbol**, **Rights (% of DCF)** (`poolPercentage` × 100), **Frequency**, **Next record date**, **Participants**, **Distributions**.
   If the list is empty, say "No issuances yet" and that launching one comes next.

## Rules

- Do not compute prices, yields or allocations yourself. Show what the API returns.
- Say "distribution", never "dividend". Never call token market cap a "valuation".
