# fstack MCP server

Thin MCP server for Founder Stack `/capital` (Cash Flow Rights). It exposes typed tools
(zod) that map **one-to-one** onto the Founder Stack API. It owns **no business logic**:
every derivation (price from yield, fee params, allocations) happens server-side, and
the server just **forwards your bearer token** and returns the API's JSON.

> Skills are the conversation, the MCP server is the hands, the API is the brain.

## Quick start (npx)

```bash
FS_API_URL=https://<your-deployment>.vercel.app/api FS_API_TOKEN=<token> npx -y fstack-mcp
```

Claude Code:

```bash
claude mcp add fstack -e FS_API_URL=https://<your-deployment>.vercel.app/api -e FS_API_TOKEN=<token> -- npx -y fstack-mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.fstack]
command = "npx"
args = ["-y", "fstack-mcp"]
env = { FS_API_URL = "https://<your-deployment>.vercel.app/api", FS_API_TOKEN = "..." }
```

The server speaks MCP over stdio; it prints nothing else to stdout.

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `FS_API_URL` | `http://localhost:3000/api` | Base URL of the Founder Stack API |
| `FS_API_TOKEN` | — | Sent as `Authorization: Bearer <token>`; identifies the issuer principal |

## Tools

| Tool | API | Mutates |
|---|---|---|
| `fundraise_list_issuances` | `GET /api/issuances` | — |
| `fundraise_preview_issuance` | `POST /api/issuances/preview` | — (stores a one-time `previewId`) |
| `fundraise_create_issuance` | `POST /api/issuances` `{ previewId }` | ✅ on-chain (mint + hook + DBC pool) |
| `fundraise_get_market` | `GET /api/issuances/:id/market` | — |
| `fundraise_list_holders` | `GET /api/issuances/:id/holders` | — |
| `fundraise_report_period` | `POST /api/issuances/:id/distributions` `{ periodLabel, dcf, reportUrl? }` | DB (DRAFT) |
| `fundraise_list_distributions` | `GET /api/issuances/:id/distributions` (public) | — |
| `fundraise_snapshot` | `POST /api/distributions/:id/snapshot` | DB (preview + `confirmTotal`) |
| `fundraise_execute_distribution` | `POST /api/distributions/:id/execute` `{ confirmTotal, payoutMode? }` (default `escrow`: fund the claim escrow; `direct`: pay holders) | ✅ USDC |
| `fundraise_get_claim_proof` | `GET /api/distributions/:id/proof?wallet=` | — |
| `fundraise_get_distribution` | `GET /api/distributions/:id` | — |
| `fundraise_get_sign_request` | `GET /api/sign/:id` | — |

**Signing (SPEC 0.4).** `fundraise_create_issuance` and `fundraise_execute_distribution` take an optional
`signingMode`: `"custody"` (the server signs; closed pilot) or `"wallet"`. Omitted, the server default applies
(`FS_SIGNING_MODE`, else `custody`). In wallet mode nothing happens on-chain yet: the response is
`{ status: "AWAITING_SIGNATURE", signUrl, signRequestId }`. The founder opens `signUrl` (`/sign/[requestId]`)
in their own browser, connects their wallet, reviews the summary and signs; the API verifies the signed
transactions match what it prepared, broadcasts them and applies the result. Poll
`fundraise_get_sign_request` until `status` is `COMPLETED` (its `result` is what the custody call returns).

Distribution amounts (`dcf`, `confirmTotal`) are USDC **decimal strings** (`"400000"`, `"4,000.00"`), never
base units. `confirmTotal` must be the exact total the founder typed; the API rejects any mismatch, so an
agent can't skip the preview. Executing twice is a no-op; retrying after a partial failure pays only unpaid rows.

Read tools carry `readOnlyHint: true`. `fundraise_preview_issuance` takes `expectedAnnualDcf` as a USDC
**decimal string** (`"1600000"` = $1.6M) and rates in basis points (`poolPercentageBps: 1000` = 10%).
`fundraise_create_issuance` is gated server-side: a missing/unknown `previewId` → `400`, a reused one → `409`.
Every response uses the same amount shapes: USDC is `{ baseUnits, usdc, display }` (6 dp, `display` exact,
e.g. `"$0.045"`), token amounts are `{ baseUnits, amount, display }`, percentages are strings (`"10%"`).
Errors are `{ error, message, details }`.

Errors come back as `isError: true` with `{ error, status, body }` so the calling skill can
stop and show the message (e.g. `401` → check `FS_API_TOKEN`).

## Build and run

```bash
pnpm --filter fstack-mcp build
FS_API_URL=http://localhost:3000/api FS_API_TOKEN=... node packages/fstack-mcp/dist/index.js
```

### Claude Code

Registered by the `fstack` plugin (`plugins/fstack/.mcp.json`) as server `plugin:fstack:fstack`, so tool
names are `mcp__plugin_fstack_fstack__<tool>` (allowlist `mcp__plugin_fstack_fstack__*`, not `mcp__fstack__*`).

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.fstack]
command = "node"
args = ["/absolute/path/to/FS-Stocklana/packages/fstack-mcp/dist/index.js"]
env = { FS_API_URL = "http://localhost:3000/api", FS_API_TOKEN = "..." }
```

Per-invocation alternative (no config edit): see `docs/agent-install.md`. Both agents are smoke-tested by
`scripts/agent-smoke/run.sh`.
