# Founder Stack `/capital`: Cash Flow Rights

Cash-generating businesses raise against a share of their future distributable cash flow, **straight
from Claude Code or Codex** (`/fstack:fundraise`): an agreement defines the claim, a Token-2022 token
with an allowlist transfer hook represents participation units, Meteora DBC provides distribution,
price discovery and liquidity, and every reporting period current holders are paid in USDC.

Built for the Stocklana hackathon (Main track + Meteora DBC bounty). Full spec: [`SPEC.md`](SPEC.md).
Build plan and task tracking: [`TASKS.md`](TASKS.md).

Say **"distribution"**, never "dividend" — this is a contractual cash-flow claim, not equity.

## Why

Profitable small businesses (SaaS, e-commerce, franchises) want non-dilutive capital without bank debt
or a priced round. Investors want recurring USDC yield tied to a real business, with a secondary market
that revenue-based financing doesn't offer. Founders already live in their coding agent, so the whole
issuer side — launch, report a period, distribute, check status — happens in conversation. The agent can
read the founder's own finance export (`./finance/q3.csv`) to propose a cash-flow number, which no web
form can do.

## Layers

```
Founder (Claude Code / Codex)                      Investor (browser)
        │                                                  │
  /fstack:fundraise  skill family                    Next.js web app
  (conversation, sequencing, confirmations;          /market /onboard
   NO business logic, NO prompts server-side         /distributions (read-only)
   needed)                                                 │
        │                                                  │
  fstack MCP server  (thin typed tools, forwards  ───►  API routes  ◄───┘
   bearer token; owns no logic)                        lib/rights, registry,
                                                       meteora, distribution,
                                                       monetization
                                                            │
                                               Solana devnet: Token-2022 + fs_allowlist
                                               hook + Meteora DBC + mock USDC
```

- **Skills are the conversation, the MCP server is the hands, the API is the brain.** Every derivation
  (price from yield, fee params, allocations) is computed server-side and returned for display.
- **Every mutating tool needs a preview and an explicit go-ahead.** `create_issuance` and
  `execute_distribution` require a preview call first, enforced server-side (`previewId` /
  `confirmTotal`) so an agent can't skip it even if it ignores the skill text.
- **Same tools, both agents.** One `SKILL.md` set and one MCP server serve Claude Code (plugin) and
  Codex (`.agents/skills` + `config.toml`) unchanged.

## Repo layout

| Path | What |
|---|---|
| `apps/web` | Next.js app: issuance/distribution API routes, Prisma + SQLite, `/market`, `/onboard`, `/distributions` pages |
| `packages/core` | Pure logic: `lib/rights` (agreement + copy), `lib/distribution` (R1/R5/R7 math), `lib/monetization` (fee params) |
| `packages/fstack-mcp` | Thin MCP server, one-to-one with the API (see its [README](packages/fstack-mcp/README.md)) |
| `plugins/fstack` | The `fstack` Claude Code plugin: `fundraise`, `fundraise-launch`, `fundraise-report`, `fundraise-distribute`, `fundraise-investors` skills |
| `.agents/skills` | Symlinks to the same `SKILL.md` files, for Codex |
| `programs/fs_allowlist` | Anchor Token-2022 transfer-hook program enforcing the buy/sell allowlist |
| `scripts/chain` | Devnet spike/ops scripts (faucet, pool creation, holders, market state) |
| `scripts/agent-smoke` | Cross-agent smoke test (same skill + MCP server in Claude Code and Codex) |
| `demo/finance` | Sample finance exports the `fundraise-report` skill parses |
| `docs` | `agent-install.md`, `spike-results.md` (verified on-chain facts) |

## Quickstart

```bash
pnpm install
pnpm build                     # builds packages/fstack-mcp/dist/index.js
cp .env.example apps/web/.env.local   # CHAIN_MODE=fake needs no Solana secrets
cd apps/web && pnpm dev        # web app + API on http://localhost:3000
```

`CHAIN_MODE=fake` (the default) runs the whole flow — issuance, buy/sell, holders, distributions —
against an in-memory chain port with no devnet keys required. Set `CHAIN_MODE=devnet` and the env vars
in `.env.example` (RPC URL, `FS_AUTHORITY_KEYPAIR`, `ISSUER_KEYPAIR`, `QUOTE_MINT`,
`FS_ALLOWLIST_PROGRAM_ID`) to run against real Solana devnet.

Run the test suite: `pnpm test` (`packages/core` unit tests + `apps/web` API/distribution tests, all
against `CHAIN_MODE=fake`).

## Running it from your agent

```bash
export FS_API_URL=http://localhost:3000/api FS_API_TOKEN=dev-local-token
claude --plugin-dir ./plugins/fstack      # Claude Code
> /fstack:fundraise
```

```bash
# Codex — add to ~/.codex/config.toml, then run `codex` and type $fstack-fundraise
[mcp_servers.fstack]
command = "node"
args = ["/absolute/path/to/fundraise/packages/fstack-mcp/dist/index.js"]
env = { FS_API_URL = "http://localhost:3000/api", FS_API_TOKEN = "dev-local-token" }
```

Full install steps, tool-naming quirks and known limitations for both agents: [`docs/agent-install.md`](docs/agent-install.md).
Reproduce the cross-agent smoke test with `scripts/agent-smoke/run.sh`.

## Verified on devnet

All chain hypotheses (H1–H11, SPEC section 11) were validated against real devnet transactions —
see [`docs/spike-results.md`](docs/spike-results.md) for full signatures. Summary:

| Fact | Result |
|---|---|
| DBC pool with a Token-2022 transfer-hook base mint | ✅ `initialize_virtual_pool_with_token2022_transfer_hook` |
| `fs_allowlist` hook enforced on buy/sell | ✅ allowlisted buy/sell succeed; non-allowlisted buy fails `NotEligible` (error 6000) |
| Plain SPL mock USDC accepted as DBC quote (no token badge) | ✅ |
| Pool reads (reserves, threshold, progress, accrued fees) match swaps performed | ✅ |
| Holder listing on Token-2022 via `getProgramAccounts` | ⚠️ excluded on the public devnet RPC; fallback via `fs_allowlist` `AllowEntry` accounts + Token-2022 ATAs works (~200ms) |
| Curve start price from market-cap inputs | ✅ within 0%, via `buildCurveWithMarketCapRobust` (explicit sqrt prices; the SDK's own `buildCurveWithMarketCap` hits a precision bug at 6dp) |
| Hook pool migrates to DAMM v2 | ✅ migration only — DBC revokes the transfer hook at graduation, so allowlist enforcement ends there |
| One `SKILL.md` + one MCP server works unchanged in Claude Code and Codex | ✅ `scripts/agent-smoke/run.sh` |
| Agent proposes correct DCF from 3 messy sample finance exports | ✅ 3/3, see [`demo/finance/README.md`](demo/finance/README.md) |
| Two-period distribution math (Q3/Q4 demo numbers) | ✅ `pnpm test`; the sold-then-bought unit correctly pays the new holder |

### Program / addresses (devnet)

| What | Address |
|---|---|
| `fs_allowlist` program | `3gfXWxgHN8tjJzxXGeAEiZWaixDe7ZMxXQGnpvHkQZu7` |
| Founder Stack authority | `947L5j9d55jFGNyCSwguX8PHTDb5VNyidvRhy7UPDtUB` |
| Mock USDC (`QUOTE_MINT`, SPL Token, 6dp) | `CQSAP5ezqscP1ifB2Ha4m5kbUDp6jZHr2CFDoZi2vGw` |
| DBC pool authority | `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` |

## Demo (SPEC section 10)

**Acme SaaS**, 10% of quarterly DCF, 1,000,000 `ACME-CF` units. Launch in Claude Code → Carol (not
onboarded) fails to buy → Alice onboards and buys 100k → Q3 closes at $400k DCF, Alice gets $4,000 →
Alice sells 40k to Bob → Q4 closes at $450k DCF, **the units Alice sold now pay Bob**: Alice $2,700,
Bob $1,800. Headless reproduction of this exact flow via the HTTP API: `scripts/demo-e2e.ts`.

## Positioning

Say: "Contractual cash-flow participation rights", "distributions are based on issuer-reported
Distributable Cash Flow", "eligibility is enforced at the token level by a Token-2022 transfer hook",
"Meteora DBC provides distribution, price discovery and liquidity", "protocol economics shown are
illustrative — the production model is software fees, one config switch."

Don't say: dividends, shares, equity, "token = legal right", "market cap = company valuation",
"guaranteed yield", or that the demo's 2% fee is a production-compliant model.

## Status / roadmap

P0 (this build): full issuance → onboarding → trading → distribution loop on devnet, from both agents.
P1 (not in this build, see `SPEC.md` sections 1 and 15): `/sign/[requestId]` wallet-signing links in
place of server custody, issuer-funded escrow + Merkle claim, a price chart, an on-chain report-hash
memo, and Venture Rights (the same engine against a one-time exit event instead of periodic cash flow).
