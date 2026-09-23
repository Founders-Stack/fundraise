# Founder Stack `/capital`: Cash Flow Rights (Stocklana build spec)

**Deadline:** Sep 25, 2026, 4:00pm ET. **Target:** Main track + Meteora DBC bounty.
**Not targeting:** Clawpump (requires stock-paired pool via clawpump), PreStocks / Tessera (partner tokens only), Pyth.

> Founder Stack lets cash-generating businesses raise against a share of their future distributable cash flow, **straight from Claude Code or Codex** (`/fstack:fundraise`): an agreement defines the claim, a Token-2022 token with an allowlist hook represents participation units, Meteora DBC provides distribution, price discovery and liquidity, and every reporting period current holders are paid in USDC.

What judges score:
- **Main track:** "could this be a real app that people will actually use?" (real user and problem, working end-to-end demo, why Solana, execution).
- **Meteora bounty:** originality of the DBC configuration or use case, technical soundness, and life after the hackathon. Meteora also states: "Working code on mainnet beats slides."

**Why Cash Flow only:** recurring payouts make the core loop demoable twice in 3 minutes (period 1, trade, period 2), yield is a real market metric, and the user is concrete: profitable small businesses that want non-dilutive capital (a revenue-based-financing-style market with onchain secondary liquidity). Venture Rights reuse the same engine later (section 15).

**Terminology:** the UI and pitch say **"distribution"**, never "dividend". Dividends imply equity, and this instrument is contractual.

---

## 0. Core feature: fundraise from your coding agent

**Founders run the whole issuer side from Claude Code or Codex.** They launch, report periods, distribute and check status in conversation through the `/fstack:fundraise` skill family. Investors use the web app (onboard, trade, see yield). This follows the existing Founder Stack pattern (`founder-stack-onboarding` / `founder-stack-review`): chat-first skills that mirror web pages, a thin MCP server, and all logic server-side.

**Why it matters for judges:** founders already live in their agent. "Raise from your customers without leaving Claude Code" is the "real user" answer. The agent can also read the founder's own finance export (`./finance/q3.csv`) to prepare the cash-flow report, which no web form can do.

### 0.1 Layers

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

Rules (inherited from Founder Stack `CONTEXT.md`):
- **Skills are the conversation, the MCP server is the hands, the API is the brain.** Every derivation (price from yield, fee params, allocations) is computed server-side and returned for display. A skill never does the money math itself.
- **Every mutating tool needs a preview and an explicit go-ahead.** Tools that move money or create on-chain state (`create_issuance`, `execute_distribution`) require a preview call first. The skill shows exact amounts and waits for a clear "yes".
- **Same tools, both agents.** One `SKILL.md` set and one MCP server serve Claude Code (plugin) and Codex (`.agents/skills` + `config.toml`).

### 0.2 Skill family: `fstack` plugin, `fundraise*` skills

```
plugins/fstack/
  .claude-plugin/plugin.json          { "name": "fstack", ... }
  .mcp.json                           registers the fstack MCP server
  skills/
    fundraise/SKILL.md                /fstack:fundraise           router + status
    fundraise-launch/SKILL.md         /fstack:fundraise-launch    create issuance
    fundraise-report/SKILL.md         /fstack:fundraise-report    close a period
    fundraise-distribute/SKILL.md     /fstack:fundraise-distribute snapshot + pay
    fundraise-investors/SKILL.md      /fstack:fundraise-investors holders, revoke
.agents/skills/fstack-fundraise*      → symlinks to the same SKILL.md files (Codex)
```

| Skill | Flow | MCP tools used |
|---|---|---|
| `fundraise` (entry) | Calls `list_issuances` + `get_market`, then routes by state: no issuance → launch; period due → report; report drafted → distribute; otherwise show status (price, DBC progress, holders, yield, next record date, accrued fees) | `fundraise_list_issuances`, `fundraise_get_market` |
| `fundraise-launch` | Interviews the founder (business, expected annual DCF, rights %, target yield, frequency, supply, symbol). Suggests defaults, shows the preview (derived $/token, graduation cap, 48/2/50, 50/50, agreement summary + hash), gets confirmation, creates the issuance. Returns the market URL + investor onboarding link to share | `fundraise_preview_issuance`, `fundraise_create_issuance` |
| `fundraise-report` | Asks for the period and DCF. **Can read a local finance file** (CSV/XLSX export) to propose DCF with its working shown; the founder confirms the number. Creates a DRAFT distribution with `reportHash` | `fundraise_report_period` |
| `fundraise-distribute` | Takes the snapshot, shows the allocation table (holders, tokens, payout, unallocated, issuer USDC balance check), requires a typed confirmation with the total, then executes and prints signatures + explorer links | `fundraise_snapshot`, `fundraise_execute_distribution` |
| `fundraise-investors` | Lists participants and on-chain holders, flags mismatches. Revoke only with confirmation (P1) | `fundraise_list_holders`, `fundraise_set_participant_status` |

The family is designed to grow: `fundraise-venture` (section 15), `fundraise-claim-fees`, and the existing marketing skills can later join the same `fstack` plugin.

### 0.3 MCP tools (`packages/fstack-mcp`)

Thin, typed (zod), one-to-one with API routes. Auth is `FS_API_TOKEN` (bearer) and `FS_API_URL`.

| Tool | API | Mutates |
|---|---|---|
| `fundraise_list_issuances` | `GET /api/issuances` | — |
| `fundraise_preview_issuance` | `POST /api/issuances/preview` | — |
| `fundraise_create_issuance` | `POST /api/issuances` (requires `previewId`) | ✅ on-chain |
| `fundraise_get_market` | `GET /api/issuances/:id/market` | — |
| `fundraise_list_holders` | `GET /api/issuances/:id/holders` | — |
| `fundraise_report_period` | `POST /api/issuances/:id/distributions` | DB |
| `fundraise_snapshot` | `POST /api/distributions/:id/snapshot` | DB |
| `fundraise_execute_distribution` | `POST /api/distributions/:id/execute` (requires `confirmTotal` = previewed total) | ✅ USDC |
| `fundraise_set_participant_status` (P1) | `PATCH /api/participants/:id` | ✅ on-chain |

`requires previewId` / `confirmTotal` is enforced **server-side**, so an agent can't skip the preview even if the skill text is ignored.

### 0.4 Signing (decision)

- **P0 (devnet demo):** the API holds the issuer and Founder Stack authority keypairs (devnet only, env vars) and signs server-side. The UI and skills label this "Demo custody (devnet)".
- **P1 (production path):** mutating tools return a `signUrl` (`/sign/[requestId]`). The founder opens it and signs with their wallet, the same "open this URL in your own browser" pattern as the OAuth step in `founder-stack-onboarding`.

---

## 1. Scope

| In (P0) | P1 (only if P0 is done) | Out (this build) |
|---|---|---|
| **`/fstack:fundraise` skill family (5 skills) for Claude Code + Codex** | `/sign/[requestId]` wallet-signing links | Venture Rights (section 15) |
| **`fstack` MCP server (8 tools) + API routes** | `fundraise_set_participant_status` (revoke) | |
| Cash Flow Rights issuance, end to end | Issuer-funded escrow + Merkle claim | |
| Token-2022 allowlist transfer hook | Graduation to DAMM v2 (see H5) | SOFTWARE/REGULATED runtime modes |
| DBC pool whose curve is derived from cash-flow inputs | Price chart | Real KYC, e-sign, jurisdictions |
| Buy/sell with mock USDC | Mainnet pool (closed allowlist) | Accounting / bank integrations |
| Simulated onboarding + agreement hash | Hash of issuer report committed on-chain (memo) | Standalone indexer service |
| Live holder registry from chain | | Automatic scheduled distributions |
| Periodic distribution: report → snapshot → allocations → USDC transfers | | |
| Yield metrics + distribution history (≥ 2 periods) | | |
| Economics panel (48/2/50, 50/50), sourced from pool config | | |

---

## 2. Economic rules (fixed decisions)

**R1: Fixed per-token entitlement.** 1 token = 1 / `tokenSupply` of each period's rights pool.
```
rightsPool      = distributableCashFlow × poolPercentage
perToken        = rightsPool / tokenSupply
holderPayout    = floor(holderTokens × perToken)      // USDC base units
unallocated     = rightsPool − Σ holderPayout          // stays with issuer
```
Tokens in DBC vaults, DAMM pools, LP positions or unregistered wallets are **unallocated**. Their share is not redistributed. The UI shows it as "Unallocated (retained by issuer)".

**R2: Distributable Cash Flow (DCF) is issuer-reported** per period. The report stores:
- the period label (e.g. `2026-Q3`);
- the DCF amount;
- an optional supporting document URL;
- a `reportHash` (sha256 of the report JSON), displayed publicly. P1: post `reportHash` as an on-chain memo.

**R3: Record date.**
- Each issuance has a `distributionFrequency` (quarterly for the demo). The "Next record date" is shown on the market page.
- The snapshot is taken at execution time and stores `slot` plus the full holder list. It is immutable once created, because RPC can't return historical balances.

**R4: Eligibility.**
- Only allowlisted wallets can receive tokens (enforced by the hook, section 4). The DBC pool authority is allowlisted as infrastructure and treated as unallocated.
- If the hook is dropped (fallback), unregistered holders count as unallocated and the UI flags them.

**R5: Rounding.** Floor to USDC base units (6 dp). Dust goes to unallocated.

**R6: Token market cap is not company valuation.** Never label it "valuation".

**R7: Yield is informational.**
```
ttmPerToken    = Σ perToken over periods in last 12 months
trailingYield  = ttmPerToken / currentPrice
annualizedRun  = lastPerToken × periodsPerYear             // shown only until 4 periods exist
```
Label it "Trailing distribution yield (informational, based on issuer-reported cash flow)". With fewer than 4 periods, show "annualized from N periods".

---

## 3. Architecture

One repo:

```
plugins/fstack/     Claude Code plugin: skills/fundraise*/SKILL.md, .mcp.json (section 0.2)
.agents/skills/     Codex symlinks → plugins/fstack/skills/*
packages/fstack-mcp MCP server: thin typed tools over the API (section 0.3)
apps/web            Next.js (App Router) + wallet adapter + API routes (the brain)
  lib/rights/       cash-flow terms, agreement text + hash
  lib/registry/     participants, allowlist admin, live holders (RPC)
  lib/meteora/      business inputs → DBC params; pool reads; swap tx builders
  lib/distribution/ report → snapshot → allocations → execute; yield metrics
  lib/monetization/ pure functions over MonetizationConfig (no I/O)
programs/fs_allowlist   Anchor Token-2022 transfer-hook program
prisma/             SQLite (Postgres if deployed)
scripts/            devnet setup: mock USDC mint, faucet, demo wallets
```

`lib/monetization` is the only place Founder Stack revenue is computed. `lib/meteora` receives fee params as input and never decides them.

### Data model (minimum)

```ts
Issuance     { id, issuerName, rightsType: "CASH_FLOW",        // enum kept for future VENTURE_EXIT
               poolPercentage, tokenSupply, symbol, name,
               distributionFrequency: "QUARTERLY"|"MONTHLY",
               nextRecordDate,
               expectedAnnualDcf, targetInitialYield,          // curve inputs (section 5)
               agreementVersion, agreementHash, agreementText,
               startingMarketCap, graduationMarketCap,         // derived, stored
               quoteMint, baseMint, dbcConfig, dbcPool, dammPool?,
               monetization: MonetizationConfig, createdAt }

Participant  { id, issuanceId, wallet, displayName,
               verifiedAt, eligibleAt, agreementAcceptedAt, agreementSig,
               allowlistTx }

Distribution { id, issuanceId, periodLabel, dcf, reportUrl?, reportHash,
               poolPercentage, rightsPool, perToken,
               status: DRAFT|SNAPSHOTTED|EXECUTED,
               snapshotSlot?, totalAllocated?, unallocated?, executedAt? }

Allocation   { distributionId, wallet, participantId?, tokens,
               payout, txSignature? }
```

No transfer-log tables. Current holders are read from chain (section 6).

---

## 4. On-chain: `fs_allowlist` transfer hook

Token-2022 transfer-hook program (Anchor, ~150 LOC).

- `initialize_extra_account_meta_list(mint)`: registers one extra account, an `AllowEntry` PDA with seeds `["allow", mint, destination_owner]`. `destination_owner` comes from destination token account data (offset 32, len 32) via `Seed::AccountData`.
- `add_allow(mint, wallet)` / `remove_allow(mint, wallet)`: admin-only (Founder Stack authority).
- `execute`: passes if the `AllowEntry` PDA exists and is active. Otherwise it fails with `NotEligible`.
- At pool creation the DBC pool authority is allowlisted, so sells into the pool work.

The DBC SDK creates the mint with the hook through `client.partner.createConfigAndPoolWithTransferHook`. Swaps use `client.pool.swap2WithTransferHook`. Fee claims use `claimPartnerTradingFee2` / `claimCreatorTradingFee2`.

**Demo beat:** an unverified wallet's buy fails with `NotEligible`. After onboarding, the same wallet's buy succeeds. Eligibility is enforced by the token, not by our database.

---

## 5. DBC configuration: a curve priced from cash flow (Meteora showcase)

The founder never sees DBC knobs. They enter business terms, and `lib/meteora/buildConfig.ts` derives the curve.

**Founder inputs:**
- rights: % of DCF, e.g. 10%;
- expected annual DCF, e.g. $1.6M;
- target initial yield, e.g. 16%;
- graduation multiple, e.g. 3×;
- token supply;
- frequency.

**Derivation:**
```
expectedAnnualRightsPool = expectedAnnualDcf × poolPercentage          // $160k
startingMarketCap        = expectedAnnualRightsPool / targetInitialYield  // $1.0M → $1.00/token
graduationMarketCap      = startingMarketCap × graduationMultiple       // $3.0M
```

Market cap here means token supply × token price, not company value (R6).

| Derived / fixed | DBC param | Value |
|---|---|---|
| Supply | `totalTokenSupply`, `tokenBaseDecimal` | 1,000,000, 6 dp |
| — | `tokenType` | `Token2022` (required for hook) |
| startingMarketCap | `initialMarketCap` (`buildCurveWithMarketCap`) | $1.0M |
| graduationMarketCap | `migrationMarketCap` | $3.0M |
| Quote | `quoteMint` | Mock USDC (SPL, 6 dp); faucet mints freely so realistic numbers work on devnet |
| — | `migrationOption` | DAMM v2 |
| `MonetizationConfig.graduation` | `migrationFeeOption` = 6 (Customizable), `migrationFee.{feePercentage, creatorFeePercentage}` | DEMO_PROTOCOL → 50 / 96 ⇒ 48% issuer, 2% FS, 50% liquidity |
| `MonetizationConfig.dbcTradingFees` | `creatorTradingFeePercentage` | 50 |
| Post-graduation LP | `creatorLockedLiquidityPercentage` | 100 (issuer LP locked; FS owns none) |
| Launch protection | base fee scheduler (decaying) | high start fee decaying over minutes, anti-sniper |

**Originality pitch to Meteora:**
1. The bonding curve starts at a yield-implied price, not an arbitrary memecoin market cap.
2. A Token-2022 allowlist hook makes it a permissioned DBC for an equity-like instrument.
3. Graduation proceeds split through `migrationFee`, so the business receives capital at graduation.
4. Issuer LP is 100% locked as a commitment signal.

---

## 6. Registry and holders

- **Onboarding** (`/onboard/[issuanceId]`): connect wallet, then 3 steps:
  - "Verify identity" (simulated, sets `verifiedAt`);
  - "Confirm eligibility" (checkbox);
  - "Accept agreement" (wallet `signMessage` over `agreementHash`, signature stored).
  
  The server then sends `add_allow`, and the page shows "Trading enabled".
- **Live holders:** `getProgramAccounts(TOKEN_2022_PROGRAM_ID, memcmp mint)` joined with `Participant` by owner. Pool-owned accounts are labeled "Market (DBC pool)". Refresh after each confirmed swap and on a 5s poll.
- **Reconciliation** = the snapshot step: chain balances are the source of truth, and the DB adds identity. A non-pool holder who isn't a participant (possible only without the hook) triggers a warning and counts as unallocated.

---

## 7. Distribution engine

```
issuer reports period (label, DCF, report URL) → reportHash
→ rightsPool = DCF × pool%, perToken
→ snapshot: read holders at current slot, store immutable
→ allocations per R1/R5, unallocated shown
→ issuer preview (table + totals + required USDC balance check)
→ execute: batched mock-USDC transfers from issuer wallet (≤ 10 per tx), store sigs
→ EXECUTED → market metrics recompute (R7), nextRecordDate advances one period
```

- **Issuer balance check:** if the issuer wallet holds less than `totalAllocated`, execution is disabled and the UI shows the shortfall.
- **P1: escrow + Merkle claim.** The issuer deposits `rightsPool` into a program escrow before the record date, and holders claim with a Merkle proof. It is the strongest answer to "what if the issuer doesn't pay?", so it is the first P1 item.

---

## 8. Monetization (config, not a service)

```ts
type MonetizationConfig = {
  mode: "DEMO_PROTOCOL" | "SOFTWARE"
  graduation: { issuerPct: number; platformPct: number; liquidityPct: number } // sums to 100
  dbcTradingFees: { creatorPct: number; partnerPct: number }                  // sums to 100
  software?: { setupFee: number; monthlyFee: number; perDistributionFee: number } // display only
}

toDbcFeeParams(cfg) → { migrationFee: { feePercentage, creatorFeePercentage }, creatorTradingFeePercentage }
projectEconomics(cfg, migrationQuoteThreshold) → { issuer, platform, liquidity }
```

- `feePercentage = issuerPct + platformPct`, and `creatorFeePercentage = issuerPct / feePercentage × 100`, which must be an exact integer. Splits that don't produce one (e.g. 49/2) fail validation.
- DEMO_PROTOCOL `{48, 2, 50}` → `{50, 96}`. SOFTWARE `{50, 0, 50}` → `{50, 100}`.
- **Acceptance test:** switching DEMO_PROTOCOL → SOFTWARE changes only the config object. The rights, hook, registry, distribution and UI code paths are untouched (unit test).
- Displayed amounts are read from the pool config (`getPoolMigrationQuoteThreshold`, fee fields). The panel is labeled "Illustrative protocol economics".

---

## 9. Routes

Issuer actions (launch, report, distribute) happen in the agent (section 0). The web app serves investors and gives read-only issuer views that the skills link to.

| Route | Content |
|---|---|
| `/` | Issuances list + "Launch from Claude Code / Codex" install instructions |
| `/issuance/new` | **P1** web fallback for the launch flow (same `preview` → `create` API) |
| `/market/[id]` | Price, terms, **yield block** (last distribution / token, TTM or annualized, trailing yield, next record date), DBC progress, economics panel, fees, buy/sell with preview (pay, receive, price impact, pool fee, network fee), holders table, distribution history |
| `/onboard/[id]` | Investor onboarding (section 6) |
| `/distributions/[id]` | Read-only: history, allocations, signatures (execution happens via `fundraise-distribute`) |

---

## 10. Demo (single video, ≤ 3 min)

Company: **Acme SaaS**. Terms: 10% of quarterly DCF, 1,000,000 ACME-CF.

Split screen: **terminal (founder) | browser (investors)**.

1. **Launch, in Claude Code.** The founder types `/fstack:fundraise` "we're Acme SaaS, raise against 10% of quarterly cash flow". The skill interviews them. The preview shows expected DCF $1.6M/yr and 16% target yield → $1.00/token, 48/2/50, 50/50 and the agreement hash. The founder says "yes" and gets back the market URL + investor link. The skill always stops after the preview, and a "yes" given before the preview doesn't count, so this step always takes two turns.
2. **Hook moment, in the browser.** Carol (not onboarded) tries to buy and the transaction fails with `NotEligible`.
3. **Buy, in the browser.** Alice onboards and buys 100k ACME-CF.
4. **Q3, in Codex** (same skills, second agent, ~10s). The founder runs `/fstack:fundraise` "Q3 closed, numbers are in ./finance/q3.csv". The agent reads the CSV and proposes $400k DCF with its working shown. The founder confirms, and `fundraise-distribute` previews a $40k pool, $0.04/token, Alice $4,000, the rest unallocated. The founder types the total and the signatures print.
5. **Trade, in the browser.** Bob onboards. Alice sells 40k into the pool and Bob buys 40k. The holders table goes live: Alice 60k, Bob 40k.
6. **Q4, in Claude Code.** $450k gives a $45k pool: Alice $2,700, Bob $1,800. **"The units Alice sold now pay Bob."**
7. **Market page.** History shows 2 periods, annualized distribution / token and trailing yield vs price. `/fstack:fundraise` status in the terminal shows the same numbers.
8. **Close.** Wallet-signing links (P1), escrowed distributions (P1), SOFTWARE mode as a one-config switch, `fundraise-venture` next, legal framing (section 13).

---

## 11. Hypotheses to validate

### Already verified (SDK source, `MeteoraAg/dynamic-bonding-curve-sdk` @ `0c5e375`, 2026-09-21)

| # | Hypothesis | Result |
|---|---|---|
| V1 | DBC supports Token-2022 base tokens | ✅ `tokenType: Token2022` |
| V2 | DBC supports transfer-hook mints | ✅ Added in SDK 1.5.8 (2026-05-26): `createConfigWithTransferHook`, `createPoolWithTransferHook`, `swap2WithTransferHook`, `claim*TradingFee2` |
| V3 | 48/2/50 is expressible | ✅ `migrationFee.feePercentage` = % of migration quote threshold (0–99), `creatorFeePercentage` = creator share of that fee (0–100) → 50 / 96; needs `migrationFeeOption = 6` (DAMM v2 only) |
| V4 | 50/50 trading fees are expressible | ✅ `creatorTradingFeePercentage` 0–100 |
| V5 | Market-cap-driven curve building | ✅ `buildCurveWithMarketCap({ initialMarketCap, migrationMarketCap })` |
| V6 | Stock-paired pool requirement applies to us | ❌ Clawpump bounty only. USDC quote is fine for Meteora |
| V7 (H9) | Same SKILL.md + MCP server work in Claude Code and Codex | ✅ Both pass (`scripts/agent-smoke/run.sh`). Claude tool names are `mcp__plugin_fstack_fstack__<tool>`; Codex invokes `$fstack-<name>` via `.agents/skills` symlinks. Rules in `docs/agent-install.md` |

### To validate in code (timeboxed, in order)

| # | Hypothesis | Test | Pass | Timebox | Fallback |
|---|---|---|---|---|---|
| H1 | DBC program on **devnet** supports the transfer-hook instructions | SDK hook flow with a no-op hook: config + pool + one swap on devnet | Swap confirms | 2h | Plain Token-2022 via `createConfig`. Eligibility enforced at snapshot (R4). Demo beat 2 becomes the "unregistered holder → unallocated" warning |
| H2 | Allowlist hook resolves `AllowEntry` from destination account data; pool authority allowlisted | Allowlisted buy ✅, non-allowlisted ❌, sell into pool ✅ | All three behave as expected | 4h | H1 fallback |
| H3 | Plain SPL mock-USDC accepted as quote without a token badge | Create config with our mock mint, no `tokenBadge` | Tx succeeds | during H1 | Devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` + Circle faucet (then demo amounts must be small) |
| H4 | Pool reads give quote reserve, threshold, progress, accrued fees | `client.state.getPool`, `getPoolConfig`, `getPoolMigrationQuoteThreshold` | Values match swaps performed | 1h | Compute progress client-side |
| H5 | A transfer-hook pool can migrate to DAMM v2 | Tiny-threshold pool, fill, `migrateToDammV2` | DAMM v2 pool trades | 1h, **P1 only** | Probably unsupported (SDK migration code has no hook handling). Show projected split; don't block |
| H6 | Holder listing by mint on Token-2022 works on our RPC | `getProgramAccounts` + mint memcmp | < 2s | 30m | `getTokenLargestAccounts` |
| H7 | Snapshot → allocations → batched transfers, run twice with a trade in between | 2 periods, 2 holders | Q4 split 60/40 as expected | 2h | Single-transfer loop |
| H8 | `buildCurveWithMarketCap` hits the derived starting price within ±2% | Create pool from the $1.0M / $3.0M inputs, quote a tiny buy | Price ≈ $1.00 | 1h | Use `buildCurveWithCustomSqrtPrices` with explicit start price |
| H9 | One `SKILL.md` set + one MCP server works unchanged in **both** Claude Code (plugin `/fstack:fundraise`) and Codex (`.agents/skills` + `[mcp_servers.fstack]` in `config.toml`) | Hello-world skill calling `fundraise_list_issuances` in each agent | Both list issuances | 1h | Codex-specific copies of the SKILL.md (same tools). If Codex fails entirely, demo Claude Code only and mention Codex as roadmap |
| H10 | On-chain tools finish inside MCP client timeouts (create issuance = several txs) | `fundraise_create_issuance` on devnet from Claude Code | < 60s, no client timeout | 1h | Make create async: return a `jobId` and poll it with `fundraise_get_market` |
| H11 | The agent reliably proposes DCF from a messy CSV and the founder can verify it | 3 sample exports (Stripe-like, bank-like, P&L) | Correct DCF with working shown in 3/3 | 1h | The skill asks for the number directly and just displays the file |

**Checkpoint:** H1–H3 decided by **hour 6**. If H1 or H2 fails, take the fallback immediately.

### Product hypotheses (pitch, not build)

| # | Hypothesis | Cheapest evidence before submission |
|---|---|---|
| P1 | Profitable small businesses (SaaS, e-commerce, franchises) want non-dilutive capital without bank debt or a priced round, and will share 5–15% of cash flow for it | DM 5 profitable founders: "Would you sell 10% of quarterly distributable cash flow to your customers/community for upfront capital?" Quote answers in pitch |
| P2 | Investors want recurring USDC yield tied to real businesses, with an exit via a secondary market (which revenue-based financing lacks) | Cite RBF / tokenized T-bill yield demand as comparable; one line |
| P3 | The main objection is "issuer-reported numbers + issuer might not pay" | Pitch answer: on-chain allowlist, locked issuer LP, report hash, escrowed distributions (P1) |

---

## 12. Timeline (~55h)

| Hours | Deliverable | Exit criteria |
|---|---|---|
| 0–6 | Scaffold (Next.js, Prisma, wallet adapter, MCP package, plugin skeleton). Mock USDC + faucet. H1, H3, H9 spikes. Start `fs_allowlist` | H1/H3/H9 decided |
| 6–14 | Hook done (H2). `buildConfig` with yield derivation (H8). Issuance API (`preview`/`create`) + MCP tools + `fundraise-launch` skill | Pool created **from Claude Code** at ~$1.00 (H10) |
| 14–22 | `/market/[id]`: buy/sell + preview, progress, economics panel (H4). `fundraise` router/status skill | Swap from UI; status in the terminal matches |
| 22–28 | `/onboard/[id]` + allowlist + live holders (H6). `fundraise-investors` | Carol ❌ / Alice ✅ |
| 28–36 | Distribution API (H7) + `fundraise-report` (H11) + `fundraise-distribute`, yield block, history | Two-period flow works from the agent |
| **36** | **Submit a draft** (repo + rough video). Edits are allowed until the deadline | Submitted |
| 36–44 | Polish, monetization unit test, README, deploy | Live demo URL |
| 44–50 | Final video. P1 if green: escrow + claim first, then report-hash memo, then H5 | Video uploaded |
| 50–55 | Buffer | — |

---

## 13. Positioning

Use:
- "Contractual cash-flow participation rights. The agreement creates the claim, and the token represents participation units."
- "Distributions are based on issuer-reported Distributable Cash Flow."
- "Eligibility is enforced at the token level by a Token-2022 transfer hook."
- "Meteora DBC provides distribution, price discovery and liquidity."
- "Protocol economics shown are illustrative. The production model is software fees (one config switch)."

Don't say: dividends, shares, equity, "token = legal right", "market cap = company valuation", "guaranteed yield", or that the 2% fee is a production-compliant model.

---

## 14. Open decision: mainnet

Meteora: "Working code on mainnet beats slides." A mainnet pool is technically the same code, but it is a real market for an instrument that pays holders from business cash flow. With the hook, only team-controlled allowlisted wallets can buy, which keeps it a closed test. **This is the team's call.** Default: devnet for the full demo, and mainnet only if hours 44–50 are free and the team accepts the exposure.

---

## 15. Future: Venture Rights (not in this build)

The same engine with a different base. Keep these extension points, but build none of the UI:
- `Issuance.rightsType` enum stays (`CASH_FLOW` now, `VENTURE_EXIT` later).
- `lib/distribution` takes a `distributableBase` input. Venture computes it as `grossExitValue − deductions` from a one-time `EXIT` event instead of a periodic report.
- The curve derivation in `buildConfig` is per template. Venture has no yield input, so it would use issuer-set start / graduation market caps.
- Metrics differ: no yield block; show "Economic rights: X% of Net Exit Proceeds" and "exposure per token".
