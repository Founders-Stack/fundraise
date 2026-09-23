# Tasks: Founder Stack Cash Flow Rights (Stocklana)

Source of truth: [SPEC.md](SPEC.md). **Core feature:** `/fstack:fundraise` skill family + `fstack` MCP server, so founders operate from Claude Code / Codex (SPEC section 0). Hours are relative to T0 = kickoff. Deadline Sep 25, 4:00pm ET.

**Legend:**
- 🤖 = agent task (can run in its own git worktree).
- 👤 = you.
- **Deps** = tasks that must finish first.

---

## Wave 0: you, before agents start (T0 → T+1h)

| ID | 👤 Task | Why agents can't |
|---|---|---|
| U1 | Register the team on hackathons.solana.com/hackathons/stocklana (if not done) | Account creation |
| U2 | Create the GitHub repo, `git init` here, push an empty main | Your account |
| U3 | Get a devnet RPC key (Helius or similar) and put it in `.env.local` as `NEXT_PUBLIC_RPC_URL` / `RPC_URL` | Secrets / signup |
| U4 | Install Phantom (or Backpack) and create 3 devnet accounts: Alice, Bob, Carol | Wallet UI; you'll record with these |
| U5 | Fund the FS authority + issuer keypairs with devnet SOL (faucet.solana.com, which may need a captcha) | Captcha |
| U6 | Make sure **Codex CLI** is installed and logged in next to Claude Code | Your login |

---

## Wave 1: parallel foundations (T+1 → T+6h)

| ID | 🤖 Task | Deliverable | Deps | Validates |
|---|---|---|---|---|
| A1 | **Scaffold.** Monorepo per SPEC section 3: `apps/web` (Next.js App Router, TS, Tailwind, shadcn, wallet adapter devnet, Prisma + SQLite, data model), `packages/fstack-mcp` (empty MCP server, zod, `FS_API_URL`/`FS_API_TOKEN`), `plugins/fstack` (plugin.json, `.mcp.json`, empty `skills/`), `.agents/skills` symlinks. API bearer-token auth middleware | `pnpm dev` runs; MCP server starts; plugin loads in Claude Code | U2 | — |
| A2 | **DBC hook spike.** SPL mock USDC + faucet script. DBC config + pool via `createConfigAndPoolWithTransferHook` with a no-op hook; one `swap2WithTransferHook` buy + sell on devnet | `scripts/spike-dbc-hook.ts`, `docs/spike-results.md` with sigs + PASS/FAIL | U3, U5 | **H1, H3** |
| A3 | **`fs_allowlist` program.** Anchor Token-2022 hook per SPEC section 4; local tests allowed ✅ / not ❌; deploy to devnet | `programs/fs_allowlist`, program ID, tests green | toolchain | **H2** (partial) |
| A4 | **`lib/monetization`.** `toDbcFeeParams`, `projectEconomics`, validation; tests incl. DEMO→{50,96}, SOFTWARE→{50,100}, "only config changes" test | Module + tests | — | — |
| A5 | **`lib/distribution` math.** R1/R5/R7 pure functions; tests with the Q3/Q4 demo numbers | Module + tests | — | — |
| A6 | **Agreement + copy.** Cash Flow Participation Agreement template, `agreementHash`, UI + skill microcopy per SPEC section 13 | `lib/rights/agreement.ts` | — | — |
| A7 | **Two-agent spike.** Hello-world `fundraise` skill + a stub `fundraise_list_issuances` tool. Verify it works in Claude Code (`/fstack:fundraise`) **and** Codex (`.agents/skills` + `[mcp_servers.fstack]` in `~/.codex/config.toml`). Document exact install steps for both | `docs/agent-install.md` + PASS/FAIL | A1 | **H9** |

**⏱ T+6h checkpoint 👤 (U7):** read `docs/spike-results.md`, A3 tests, and A7 results, then decide:
- **Hook GO / NO-GO:** if NO-GO, fall back to plain Token-2022 with eligibility enforced at snapshot (R4).
- **H3 fallback:** if the mock USDC mint is rejected, use Circle devnet USDC.
- **Codex:** in the demo, or Claude Code only.

---

## Wave 2: issuance, API + agent first (T+6 → T+14h)

| ID | 🤖 Task | Deliverable | Deps | Validates |
|---|---|---|---|---|
| A8 | **Hook × DBC integration.** Pool created with `fs_allowlist`; pool authority allowlisted; allowlisted buy ✅, other buy ❌ `NotEligible`, sell ✅ | Script + sigs | A2, A3, U7 | **H2** |
| A9 | **`lib/meteora`.** `buildConfig` (yield derivation), `createIssuancePool`, `getMarketState`, `buildBuyTx`/`buildSellTx` + `quote`. Normalized types only | Module + devnet pool at ≈ $1.00 | A2, A4 | **H4, H8** |
| A10 | **Issuance API.** `GET /api/issuances`, `POST /api/issuances/preview` (returns `previewId`, derived price, economics, agreement hash), `POST /api/issuances` (requires `previewId`; creates agreement + mint + hook + pool with server-side devnet keys), `GET /api/issuances/:id/market`. If create takes > 30s, make it async with a `jobId` | Routes + tests | A6, A9 | **H10** |
| A11 | **MCP tools, issuance.** `fundraise_list_issuances`, `fundraise_preview_issuance`, `fundraise_create_issuance`, `fundraise_get_market`. Thin, zod-typed, 1:1 with the API. README tool table in Founder Stack MCP style | Tools + tests against a local API | A7, A10 | — |
| A12 | **Skill `fundraise-launch`.** Interview → defaults → preview shown as a table (price derivation, 48/2/50, 50/50, agreement summary/hash) → explicit "yes" → create → return market URL + investor link. Follow the `founder-stack-onboarding` style (steps, trust rules, stop on auth error) | `plugins/fstack/skills/fundraise-launch/SKILL.md` | A11 | Launch works from Claude Code and Codex |

---

## Wave 3: investor web + remaining skills (T+14 → T+36h)

| ID | 🤖 Task | Deliverable | Deps | Validates |
|---|---|---|---|---|
| A13 | **`lib/registry` + holders API.** `getHolders(mint)` (Token-2022 memcmp, pool labels), `allowWallet`; `GET /api/issuances/:id/holders`; MCP `fundraise_list_holders` | Module + route + tool | A1, A3, A11 | **H6** |
| A14 | **`/market/[id]`.** Terms, price, yield block, DBC progress, economics panel, buy/sell + preview (all fees shown), holders table (poll + refresh on confirm), history | Page | A9, A13 | — |
| A15 | **`/onboard/[id]`.** Connect → verify (simulated) → eligibility → `signMessage(agreementHash)` → `allowWallet` → "Trading enabled" | Page | A6, A13 | — |
| A16 | **Skill `fundraise` (router + status)** and **`fundraise-investors`.** The router picks launch / report / distribute / status from state. Status prints price, progress, holders, yield, next record date, accrued fees | 2 SKILL.md files | A11, A13 | — |
| A17 | **Distribution API + MCP.** `POST /api/issuances/:id/distributions` (period, DCF, reportUrl → `reportHash`), `POST /api/distributions/:id/snapshot`, `POST /api/distributions/:id/execute` (requires `confirmTotal` = snapshot total; checks issuer USDC balance; batched transfers; stores sigs; advances `nextRecordDate`). MCP `fundraise_report_period`, `fundraise_snapshot`, `fundraise_execute_distribution` | Routes + tools + tests | A5, A13 | **H7** |
| A18 | **Skills `fundraise-report` + `fundraise-distribute`.** Report: can read a local CSV/XLSX and propose DCF with its working shown; the founder confirms. Distribute: allocation table → the founder types the total → execute → sigs + explorer links. Include 3 sample finance exports in `demo/finance/` | 2 SKILL.md + sample files | A17 | **H11** |
| A19 | **`/distributions/[id]`** read-only history + sigs; `/` page with the Claude Code / Codex install block | Pages | A17 | — |
| A20 | **E2E demo script.** Headless SPEC section 10 run: launch via API → Carol fails → Alice buys 100k → Q3 → trade 40k → Q4. Asserts 4,000 / 2,700 / 1,800 USDC. Also resets state for recording | `scripts/demo-e2e.ts` | A8–A19 | full loop |

**⏱ T+36h 👤 (U8): submit a draft.** Repo + rough screen capture. Edits are allowed until the deadline.

---

## Wave 4: ship (T+36 → T+50h)

| ID | Task | Deps |
|---|---|---|
| A21 🤖 | Code review + QA: web pages, and a dry run of every skill in both agents (no skipped confirmations, no "dividend"/"valuation" wording, fees visible) | A20 |
| A22 🤖 | README: one-liner, layer diagram (SPEC section 0.1), install for Claude Code + Codex, verified-facts table, program IDs, demo sigs | A20 |
| A23 🤖 | Deploy the web/API to Vercel (devnet). Point the MCP `FS_API_URL` at it and publish `fstack-mcp` for `npx` | A20, U9 |
| A24 🤖 **P1** | `/sign/[requestId]` wallet-signing links replacing server custody for mutating tools | A20 green |
| A25 🤖 **P1** | Escrow + Merkle claim; `fundraise-distribute` switches to "fund escrow → holders claim" | A20 green |
| A26 🤖 **P1** | `/issuance/new` web fallback; report-hash memo; price chart; H5 migration test (1h, report only) | A20 green |

| ID | 👤 Task | When |
|---|---|---|
| U9 | Vercel project + env vars (RPC, program IDs, devnet issuer/authority secrets; keep them out of the repo) | T+36h |
| U10 | DM 5 profitable founders with the P1 question (SPEC section 11); answers go in `docs/evidence.md`. Bonus: ask whether they'd rather do this from Claude Code / Codex | Anytime, early |
| U11 | Review the agreement template, positioning, and the skill confirmation wording | After A6 / A12 |
| U12 | Decide on mainnet (SPEC section 14). Default is no | T+44h |
| U13 | Record the ≤ 3-min split-screen video (terminal \| browser, SPEC section 10). Reset with A20 first. Rehearse the agent prompts so the takes are short | T+44–50h |
| U14 | Final submission: repo, live URL, video, description, agent install snippet | Before Sep 25, 4:00pm ET |

---

## Critical path

```
U2 → A1 → A7 (H9) ───────────────┐
U3,U5 → A2 ─┐                    │
        A3 ─┴→ U7 (T+6) → A8     │
              A9 → A10 → A11 → A12 (launch from agent)
                          A13 → A14, A15, A16
                  A5 → A17 → A18 ────→ A20 → U8 (T+36) → U13 → U14
```

Parallel-safe from T0: **A1, A3, A4, A5, A6**. A2 starts when U3 + U5 are done. A7 starts right after A1.
