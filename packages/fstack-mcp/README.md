# fstack MCP server

Thin MCP server for Founder Stack `/capital` (Cash Flow Rights). It exposes typed tools
(zod) that map **one-to-one** onto the Founder Stack API. It owns **no business logic**:
every derivation (price from yield, fee params, allocations) happens server-side, and
the server just **forwards your bearer token** and returns the API's JSON.

> Skills are the conversation, the MCP server is the hands, the API is the brain.

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `FS_API_URL` | `http://localhost:3000/api` | Base URL of the Founder Stack API |
| `FS_API_TOKEN` | — | Sent as `Authorization: Bearer <token>`; identifies the issuer principal |

## Tools

| Tool | API | Mutates |
|---|---|---|
| `fundraise_list_issuances` | `GET /api/issuances` | — |

More tools (preview/create issuance, market, holders, report, snapshot, execute) land in
later tasks; see SPEC section 0.3.

Errors come back as `isError: true` with `{ error, status, body }` so the calling skill can
stop and show the message (e.g. `401` → check `FS_API_TOKEN`).

## Build and run

```bash
pnpm --filter @fstack/mcp build
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
