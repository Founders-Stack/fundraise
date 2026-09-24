# Founder Stack `/capital`: Cash Flow Rights (Stocklana build spec)

**Deadline:** Sep 25, 2026, 4:00pm ET. **Target:** Main track + Meteora DBC bounty.
**Network:** the submitted build runs on **Solana mainnet** as a closed pilot with real USDC (section 14). Devnet is for development, CI and rehearsal only.
**Not targeting:** Clawpump (requires stock-paired pool via clawpump), PreStocks / Tessera (partner tokens only), Pyth.

> Founder Stack lets cash-generating businesses raise against a share of their future distributable cash flow, **straight from Claude Code or Codex** (`/fstack:fundraise`): an agreement defines the claim, a Token-2022 token with an allowlist hook represents participation units, Meteora DBC provides distribution, price discovery and liquidity, and every reporting period current holders are paid in USDC.

What judges score:
- **Main track:** "could this be a real app that people will actually use?" (real user and problem, working end-to-end demo, why Solana, execution).
- **Meteora bounty:** originality of the DBC configuration or use case, technical soundness, and life after the hackathon. Meteora also states: "Working code on mainnet beats slides."

**Why Cash Flow only:** recurring payouts make the core loop demoable twice in 3 minutes (period 1, trade, period 2), yield is a real market metric, and the user is concrete: profitable small businesses that want **equity-free capital** (no shares, no cap-table change), in a revenue-based-financing-style market with onchain secondary liquidity. It is not free: the business pays for it with a share of cash flow (section 13.1). Venture Rights reuse the same engine later (section 15).

**Terminology:** the UI and pitch say **"distribution"**, never "dividend". Dividends imply equity, and this instrument is contractual. Say "equity-free" or "non-dilutive to ownership", never a bare "non-dilutive" (section 13.1).

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
                                               Solana mainnet (final) / devnet (dev):
                                               Token-2022 + fs_allowlist hook
                                               + Meteora DBC + USDC (mock on devnet)
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
| `fundraise-launch` | Asks only for business name and expected annual DCF (proposed from a local finance file if there is one) and confirms rights % (default 10%). Everything else is a default shown in the preview (section 5). The preview shows derived $/token, graduation cap, "What you give up" (section 13.1), 48/2/50, 50/50 and the agreement summary + hash. Gets confirmation, creates the issuance, and returns the market URL + investor invite link to share | `fundraise_preview_issuance`, `fundraise_create_issuance` |
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

- **P0 (team custody, closed mainnet pilot):** the API holds the issuer and Founder Stack authority keypairs as deployment secrets (never in the repo) and signs server-side. The demo issuer (Acme) is team-controlled, so no third party's funds sit in these keys. Hot-wallet balances are capped (section 14). The UI and skills label this "Team custody (closed pilot)". On devnet the same code runs with throwaway keys.
- **P1 (production path):** mutating tools return a `signUrl` (`/sign/[requestId]`). The founder opens it and signs with their wallet, the same "open this URL in your own browser" pattern as the OAuth step in `founder-stack-onboarding`. Required before any issuer other than the team uses the product.

---

## 1. Scope

| In (P0) | P1 (only if P0 is done) | Out (this build) |
|---|---|---|
| **`/fstack:fundraise` skill family (5 skills) for Claude Code + Codex** | `/sign/[requestId]` wallet-signing links | Venture Rights (section 15) |
| **`fstack` MCP server (8 tools) + API routes** | `fundraise_set_participant_status` (revoke) | Stripe / revenue verification (section 16, research only) |
| Cash Flow Rights issuance, end to end | Issuer-funded escrow + Merkle claim | Maturity / repayment cap on the rights (section 13.1) |
| Token-2022 allowlist transfer hook | Graduation to DAMM v2 (see H5) | SOFTWARE/REGULATED runtime modes |
| DBC pool whose curve is derived from cash-flow inputs | Price chart | Real KYC, e-sign, jurisdictions |
| Buy/sell with USDC (mock USDC on devnet) | Hash of issuer report committed on-chain (memo) | Accounting / bank integrations |
| **Mainnet closed pilot** with real USDC at demo scale (section 14) | Embedded wallets / email login for investors | Standalone indexer service |
| One-signature investor onboarding + agreement hash (section 6) | | Automatic scheduled distributions |
| Live holder registry from chain | | Fiat on/off-ramp |
| Periodic distribution: report → snapshot → allocations → USDC transfers | | Other chains, L2s, bridges |
| Yield metrics + distribution history (≥ 2 periods) | | |
| Economics panel (48/2/50, 50/50), sourced from pool config | | |
| **Landing page**, built last (section 9.1) | | |

**Out of scope means out.** The build is the core loop (launch → onboard → trade → distribute) on one chain, plus the agent surface. Every layer around that core is out for this build, even if it would make the product more "real":
- **Compliance:** real KYC/AML, e-signature, jurisdiction checks, securities licensing. Onboarding is self-attested (section 6).
- **Financial data:** Stripe, accounting and bank integrations. DCF stays issuer-reported (R2). Stripe is researched in section 16 but not built.
- **Infrastructure:** standalone indexer, job schedulers, automatic distributions. The chain is read directly (section 6).
- **Other rails:** fiat ramps, other chains, L2s, bridges.
- **Other instruments:** Venture Rights and SOFTWARE/REGULATED runtime modes keep their extension points only.

P1 items start only after the P0 exit criteria for hour 36 are met (section 12).

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
- Before graduation, only allowlisted wallets can receive tokens (enforced by the hook, section 4). The DBC pool authority is allowlisted as infrastructure and treated as unallocated.
- DBC removes the transfer hook at graduation (V8). After that, anyone can hold tokens, and only registered participants are paid; everything else counts as unallocated.
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
  app/page.tsx      landing page + live issuances (section 9.1)
  lib/cluster/      one config per cluster: RPC, quote mint, program IDs, explorer links, banner copy
  lib/rights/       cash-flow terms, agreement text + hash
  lib/registry/     participants, allowlist admin, live holders (RPC)
  lib/meteora/      business inputs → DBC params; pool reads; swap tx builders
  lib/distribution/ report → snapshot → allocations → execute; yield metrics
  lib/monetization/ pure functions over MonetizationConfig (no I/O)
programs/fs_allowlist   Anchor Token-2022 transfer-hook program
prisma/             SQLite locally; Postgres for the deployed pilot (SQLite files don't persist on Vercel)
scripts/            devnet setup: mock USDC mint, faucet, demo wallets
                    mainnet pilot: program deploy, pool creation, wallet funding checklist
```

`lib/monetization` is the only place Founder Stack revenue is computed. `lib/meteora` receives fee params as input and never decides them.

`SOLANA_CLUSTER=devnet|mainnet-beta` selects the `lib/cluster` config. Nothing else in the code branches on the cluster, so the devnet rehearsal and the mainnet pilot run the same code paths.

### Data model (minimum)

```ts
Issuance     { id, issuerName, rightsType: "CASH_FLOW",        // enum kept for future VENTURE_EXIT
               poolPercentage, tokenSupply, symbol, name,
               distributionFrequency: "QUARTERLY"|"MONTHLY",
               nextRecordDate,
               expectedAnnualDcf, targetInitialYield,          // curve inputs (section 5)
               agreementVersion, agreementHash, agreementText,
               startingMarketCap, graduationMarketCap,         // derived, stored
               inviteCode,                                     // closed pilot: required to onboard (section 6)
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

- `initialize(mint, admin)`: creates the per-mint `Config` (admin) and the `ExtraAccountMetaList`, which registers one extra account: an `AllowEntry` PDA with seeds `["allow", mint, destination_owner]`. `destination_owner` comes from destination token account data (offset 32, len 32) via `Seed::AccountData`.
- `add_allow(mint, wallet)` / `remove_allow(mint, wallet)`: admin-only (Founder Stack authority).
- `execute`: passes if the `AllowEntry` PDA exists and is active. Otherwise it fails with `NotEligible`.
- At pool creation the DBC pool authority is allowlisted, so sells into the pool work.
- **`initialize` must not be front-runnable (mainnet blocker).** Today `initialize(mint, admin)` accepts any payer and takes `admin` as an argument, so whoever calls it first for a new mint controls that mint's allowlist. Fix before mainnet: put `initialize` in the same transaction as pool creation (the SDK's hook test bundles pool init + extra-meta init + first buy, V14), **and** gate it to the Founder Stack authority (a program constant or required signer).

The DBC SDK creates the mint with the hook through `client.partner.createConfigAndPoolWithTransferHook`. Swaps use `client.pool.swap2WithTransferHook`. Fee claims use `claimPartnerTradingFee2` / `claimCreatorTradingFee2`.

**The hook lasts until graduation, no longer (V8).** DBC sets the mint's transfer-hook authority to its pool authority. When a swap completes the curve, DBC sets both the hook program and the hook authority to `None`, permanently. After graduation the token transfers freely, and eligibility falls back to the snapshot rule (R4): unregistered holders count as unallocated. Consequences:
- The pilot never graduates: its migration threshold sits well above what the invited wallets will buy (section 14).
- In production, "permissioned" means "permissioned during the raise, registered-holders-only payouts after". The pitch says exactly that.

**Mint authority stays revoked.** Hook configs may hand mint authority to the creator or partner (`tokenUpdateAuthority` options, V9). We pick an option that keeps it revoked, so supply is fixed and R1's per-token entitlement can't be diluted by minting.

**Demo beat:** a wallet that hasn't onboarded fails to buy with `NotEligible`. After onboarding, the same wallet's buy succeeds. Eligibility is enforced by the token, not by our database.

---

## 5. DBC configuration: a curve priced from cash flow (Meteora showcase)

The founder never sees DBC knobs. They enter business terms, and `lib/meteora/buildConfig.ts` derives the curve.

**Founder inputs.** Only the first three are asked. The rest take defaults, which the preview shows and the founder can change before confirming (section 6.1):
- business name (the symbol is derived from it, e.g. `ACME-CF`);
- expected annual DCF, e.g. $1.6M (the agent can propose it from a local finance file, as in `fundraise-report`);
- rights: % of DCF, default 10%;
- target initial yield, default 16%;
- graduation multiple, default 3×;
- token supply, default 1,000,000 (1,000 in the mainnet pilot, section 10);
- frequency, default quarterly.

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
| Quote | `quoteMint` | **Mainnet:** USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`. **Devnet:** mock USDC (SPL, 6 dp, faucet). Both are legacy SPL mints, so no `tokenBadge` is needed (V10) |
| — | `migrationOption` | DAMM v2 (DAMM v1 is rejected for new configs, V12) |
| `MonetizationConfig.graduation` | `migrationFeeOption` = 6 (Customizable), `migrationFee.{feePercentage, creatorFeePercentage}` | DEMO_PROTOCOL → 50 / 96 ⇒ 48% issuer, 2% FS, 50% liquidity |
| `MonetizationConfig.dbcTradingFees` | `creatorTradingFeePercentage` | 50 |
| Post-graduation LP | `creatorPermanentLockedLiquidityPercentage` / `creatorLiquidityPercentage` / `partner*LiquidityPercentage` | 100 / 0 / 0 (issuer LP locked; FS owns none; DBC requires ≥ 10% locked at day 1) |
| Mint authority | `tokenUpdateAuthority` | An option that keeps mint authority revoked (V9) |
| Launch protection | base fee scheduler (`FeeSchedulerExponential`, decaying) | 3% at launch, decaying exponentially to 1% over 5 minutes (anti-sniper). Not `RateLimiter`, which is rejected for new configs (V12). Minimum base fee is 0.25% |

**Originality pitch to Meteora:**
1. The bonding curve starts at a yield-implied price, not an arbitrary memecoin market cap.
2. A Token-2022 allowlist hook makes the raise a permissioned DBC for a contractual cash-flow instrument. DBC revokes the hook at graduation (V8), and payouts stay registered-holders-only after that (R4).
3. Graduation proceeds split through `migrationFee`, so the business receives capital at graduation.
4. Issuer LP is 100% locked as a commitment signal.

---

## 6. Registry and holders

- **Onboarding: one screen, one signature.** The investor link returned by `fundraise-launch` is `/onboard/[issuanceId]?invite=<inviteCode>`. The same gate also opens inline when a not-yet-registered wallet presses Buy on `/market/[id]`.
  1. Connect wallet. A pre-flight check shows whether the wallet holds USDC and enough SOL for fees, so onboarding never ends in a buy that fails for lack of funds.
  2. One checkbox, "I confirm I'm eligible and accept the agreement", next to a 5-line agreement summary with a link to the full text and its hash.
  3. One `signMessage` over `{ issuanceId, wallet, agreementHash, eligibilityStatement }`. The server verifies the signature and the invite code, stores the signature, sets `verifiedAt`, `eligibleAt` and `agreementAcceptedAt` together, sends `add_allow`, and the page switches to the buy panel with "Trading enabled".

  Target: under 30 seconds and one wallet prompt, with no forms and no manual review.
- **Live holders:** `getProgramAccounts(TOKEN_2022_PROGRAM_ID, memcmp mint)` joined with `Participant` by owner. On mainnet, use the RPC provider's indexed by-mint token-account query (e.g. Helius DAS `getTokenAccounts`), because many providers throttle or refuse `getProgramAccounts` over Token-2022 (H6). Pool-owned accounts are labeled "Market (DBC pool)". Refresh after each confirmed swap and on a 5s poll.
- **Reconciliation** = the snapshot step: chain balances are the source of truth, and the DB adds identity. A non-pool holder who isn't a participant (possible only without the hook or after graduation, V8) triggers a warning and counts as unallocated.

### 6.1 Loosened for speed, and what stays strict

The first draft asked for more than it could check. Requirements that proved nothing were cut, so a founder or investor gets through quickly:

| Was | Now | Why it's safe to loosen |
|---|---|---|
| Separate "Verify identity" step (simulated) | Removed. `verifiedAt` means "self-attested", labeled "Self-attested (pilot)" | A simulated check proves nothing, and real KYC is out of scope (section 1) |
| 3 onboarding steps + separate eligibility screen | 1 checkbox + 1 signature, also inline on the market page | The signature over the agreement hash is the only step with evidential value, and it stays |
| Investor must find `/onboard` before buying | Buy on `/market/[id]` opens the gate inline | Same checks, fewer page hops |
| Manual approval before `add_allow` | Automatic once signature + invite code verify | The pilot is closed by the invite code, not by a review queue |
| Founder answers 7 launch questions | 3 answers (name, expected DCF, rights %); everything else is a visible default in the preview | The preview + explicit "yes" still gates creation |

**Not loosened (these are what make the demo credible):**
- The hook enforces eligibility on-chain before graduation. Carol's failed buy stays in the demo.
- Every accepted agreement has a stored wallet signature over its hash.
- Money-moving and chain-writing tools still require `previewId` / `confirmTotal` server-side (section 0.3).
- Mainnet onboarding requires the invite code (section 14).

---

## 7. Distribution engine

```
issuer reports period (label, DCF, report URL) → reportHash
→ rightsPool = DCF × pool%, perToken
→ snapshot: read holders at current slot, store immutable
→ allocations per R1/R5, unallocated shown
→ issuer preview (table + totals + required USDC balance check)
→ execute: batched USDC transfers from issuer wallet (≤ 10 per tx), store sigs
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
| `/` | Landing page (section 9.1) above the live issuances list + "Launch from Claude Code / Codex" install instructions |
| `/issuance/new` | **P1** web fallback for the launch flow (same `preview` → `create` API) |
| `/market/[id]` | Price, terms, **yield block** (last distribution / token, TTM or annualized, trailing yield, next record date), DBC progress, economics panel, fees, buy/sell with preview (pay, receive, price impact, pool fee, network fee), inline onboarding gate (section 6), holders table, distribution history |
| `/onboard/[id]` | Investor onboarding (section 6); shareable link with `?invite=` |
| `/distributions/[id]` | Read-only: history, allocations, signatures (execution happens via `fundraise-distribute`) |

### 9.1 Landing page (last deliverable)

A single page at `/`, built **last** (hours 48–52, in parallel with the final video) so it can link the recorded video and the mainnet sigs. It sits above the existing issuances list and changes no other route, so it can't break the demo. Timebox 3h. If it slips, the current `/` ships as is.

Sections, top to bottom:
1. **Hero:** "Raise against your cash flow, from your coding agent." Subline: equity-free capital, USDC distributions every period, on Solana. Two CTAs: "Install for Claude Code / Codex" (copyable snippet) and "See the live mainnet pilot" (market page).
2. **How it works,** 3 steps: launch from the agent → invited investors onboard with one signature and buy on a Meteora DBC curve priced from yield → every period, current holders are paid in USDC.
3. **For founders / for investors,** two short columns: what each side does and gives up (links section 13.1 wording).
4. **Live proof,** read from the public API: cluster, `fs_allowlist` program ID, pool address, last distribution with explorer links, the video.
5. **Why Solana + Meteora:** Token-2022 hook, yield-priced DBC curve, locked issuer LP.
6. **Honest framing:** "Closed mainnet pilot. Not an offer of securities." Distributions are based on issuer-reported cash flow, and yield is informational. The copy passes the `lintCopy` forbidden-terms check (section 13).
7. **Footer:** repo, video, hackathon link.

No new API routes, no auth, and the page works on mobile.

---

## 10. Demo (single video, ≤ 3 min)

Company: **Acme SaaS**, a demo issuer controlled by the team. Terms: 10% of quarterly DCF.

**Recorded on mainnet at pilot scale.** Real USDC comes out of the team's pocket, so supply and DCF are 1/1000 of the pitch example. Per-token prices, per-token payouts and yields are identical, so the pitch numbers and the on-chain numbers tell the same story:

| | Pitch example (landing page, pitch) | Mainnet pilot (video, on-chain) |
|---|---|---|
| Supply | 1,000,000 ACME-CF | 1,000 ACME-CF |
| Expected DCF | $1.6M / yr | $1,600 / yr |
| Start price (16% target yield) | $1.00 | $1.00 |
| Alice buys | 100,000 (~$100k + price impact) | 100 (~$100 + price impact) |
| Q3: DCF → pool → per token | $400k → $40k → $0.04 | $400 → $40 → $0.04 |
| Alice's Q3 payout | $4,000 | $4.00 |
| Q4: DCF → pool → per token | $450k → $45k → $0.045 | $450 → $45 → $0.045 |
| Q4 payouts, Alice (60%) / Bob (40%) | $2,700 / $1,800 | $2.70 / $1.80 |

The video shows the pilot numbers. The narration and landing page may quote the pitch example, labeled "illustrative". The devnet rehearsal (A20) runs the pitch example with mock USDC.

Split screen: **terminal (founder) | browser (investors)**.

1. **Launch, in Claude Code.** The founder types `/fstack:fundraise` "we're Acme SaaS, raise against 10% of quarterly cash flow". The skill asks only for expected DCF and shows defaults for the rest. The preview shows expected DCF $1,600/yr and 16% target yield → $1.00/token, what the business gives up (10% of DCF, section 13.1), 48/2/50, 50/50 and the agreement hash. The founder says "yes" and gets back the market URL + investor invite link. The skill always stops after the preview, and a "yes" given before the preview doesn't count, so this step always takes two turns.
2. **Hook moment, in the browser.** Carol (not onboarded) tries to buy and the transaction fails with `NotEligible`.
3. **Buy, in the browser.** Alice opens the invite link, checks one box, signs once, and buys 100 ACME-CF.
4. **Q3, in Codex** (same skills, second agent, ~10s). The founder runs `/fstack:fundraise` "Q3 closed, numbers are in ./finance/q3.csv". The agent reads the CSV and proposes $400 DCF with its working shown. The founder confirms, and `fundraise-distribute` previews a $40 pool, $0.04/token, Alice $4.00, the rest unallocated. The founder types the total and the mainnet signatures print.
5. **Trade, in the browser.** Bob onboards. Alice sells 40 into the pool and Bob buys 40. The holders table goes live: Alice 60, Bob 40.
6. **Q4, in Claude Code.** $450 gives a $45 pool: Alice $2.70, Bob $1.80. **"The units Alice sold now pay Bob."**
7. **Market page.** History shows 2 periods, annualized distribution / token and trailing yield vs price, with Solana Explorer links on mainnet. `/fstack:fundraise` status in the terminal shows the same numbers.
8. **Close.** "This ran on mainnet with real USDC." Then: wallet-signing links (P1), escrowed distributions (P1), Stripe-verified revenue (section 16), SOFTWARE mode as a one-config switch, `fundraise-venture` next, legal framing (section 13).

---

## 11. Hypotheses to validate

### Already verified from source

Re-checked 2026-09-23 against the SDK `MeteoraAg/dynamic-bonding-curve-sdk` @ `0c5e375` (v1.5.12) and the on-chain program `MeteoraAg/dynamic-bonding-curve` @ `f552f20` (v0.2.1). Source proves what the code does. It doesn't prove what is deployed on each cluster; that is H1.

| # | Hypothesis | Result |
|---|---|---|
| V1 | DBC supports Token-2022 base tokens | ✅ `tokenType: Token2022` |
| V2 | DBC supports transfer-hook mints | ✅ Program 0.2.0 / SDK 1.5.8 (2026-05-26): `createConfigWithTransferHook`, `createPoolWithTransferHook`, `swap2WithTransferHook`, `claim*TradingFee2` |
| V3 | 48/2/50 is expressible | ✅ `migrationFee.feePercentage` = % of migration quote threshold (0–99), `creatorFeePercentage` = creator share of that fee (0–100) → 50 / 96; needs `migrationFeeOption = 6` (DAMM v2 only) |
| V4 | 50/50 trading fees are expressible | ✅ `creatorTradingFeePercentage` 0–100 |
| V5 | Market-cap-driven curve building | ✅ `buildCurveWithMarketCap({ initialMarketCap, migrationMarketCap })` |
| V6 | Stock-paired pool requirement applies to us | ❌ Clawpump bounty only. USDC quote is fine for Meteora |
| V15 (H1–H4, H8) | Devnet DBC pool with Token-2022 + `fs_allowlist` hook; mock-USDC quote; allowlisted buy/sell OK; Carol's buy fails with `NotEligible`; start price $1.00 | ✅ Signatures in `docs/spike-results.md`. The SDK's `buildCurveWithMarketCap` fails for $1M→$3M with 6 decimals, so we use `buildCurveWithMarketCapRobust` (explicit prices). DBC doesn't call the hook at pool creation: we initialize the allowlist right after and pass the extra accounts explicitly |
| V16 (H6) | Holder listing via `getProgramAccounts` | ⚠️ The public devnet RPC excludes Token-2022. Fallback: read balances of allowlisted wallets + the pool vault. A Helius-type RPC restores the full scan |
| V17 (H5) | Hook pool migrates to DAMM v2 | ✅ Migration works, but **DBC strips the transfer hook at graduation**, so eligibility is enforced only before graduation. After that, non-registered holders are unallocated at snapshot (R4) |
| V7 (H9) | Same SKILL.md + MCP server work in Claude Code and Codex | ✅ Both pass (`scripts/agent-smoke/run.sh`). Claude tool names are `mcp__plugin_fstack_fstack__<tool>`; Codex invokes `$fstack-<name>` via `.agents/skills` symlinks. Rules in `docs/agent-install.md` |
| V8 | The allowlist hook stays active for the token's life | ❌ **New finding.** In program `process_swap.rs`, the swap that completes the curve calls `revoke_transfer_hook`, which sets the hook program and hook authority to `None` for good. The allowlist only holds until graduation (section 4) |
| V9 | We control the hook and mint authorities | ⚠️ Partly. The hook authority is the DBC pool authority, not us. Hook configs may give mint authority to the creator or partner via `tokenUpdateAuthority`, so we must choose an option that keeps it revoked (section 5) |
| V10 (H3) | Our quote mint needs no token badge | ✅ Program `is_supported_quote_mint`: any mint owned by the legacy SPL Token program is supported. Both mock USDC and mainnet USDC qualify. Badges (new in 0.2.1) apply only to Token-2022 quote mints with extra extensions |
| V11 | Devnet and mainnet use the same DBC program ID | ✅ SDK constant `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`, one ID for all clusters. Whether mainnet runs ≥ 0.2.0 (hook instructions) is H1 |
| V12 | Our config survives the 0.2.1 deprecations | ✅ `RateLimiter` base fee and DAMM v1 migration are now rejected for new configs. We use a fee scheduler and DAMM v2. Also enforced: base fee ≥ 0.25%, ≥ 10% of LP locked at day 1 (we lock 100%) |
| V13 (H4 API) | The SDK exposes the pool reads we need | ✅ `getPool`, `getPoolConfig`, `getPoolMigrationQuoteThreshold`, `getPoolQuoteTokenCurveProgress`, `getPoolFeeMetrics`. H4 now only checks the values |
| V14 | Hook extra accounts resolve without custom client code | ✅ `swap2WithTransferHook` resolves them. The SDK's own test bundles pool init + extra-meta init + first buy in one tx, which is how we make `fs_allowlist.initialize` atomic (section 4) |

### To validate in code (timeboxed, in order)

| # | Hypothesis | Test | Pass | Timebox | Fallback |
|---|---|---|---|---|---|
| H1 | The deployed DBC program on **devnet and mainnet** has the transfer-hook instructions (≥ 0.2.0) | Devnet: SDK hook flow with a no-op hook (config + pool + one swap). Mainnet: `createConfigWithTransferHook` alone, which is cheap and needs no pool | Both confirm | 2h (+30m mainnet) | Plain Token-2022 via `createConfig`. Eligibility enforced at snapshot (R4). Demo beat 2 becomes the "unregistered holder → unallocated" warning |
| H2 | Allowlist hook resolves `AllowEntry` from destination account data; pool authority allowlisted | Allowlisted buy ✅, non-allowlisted ❌, sell into pool ✅ | All three behave as expected | 4h | H1 fallback |
| H3 | Plain SPL quote mint accepted without a token badge | Closed by source (V10). Confirm in passing: the H1 config tx succeeds with no `tokenBadge` | Tx succeeds | 0 (during H1) | Devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` + Circle faucet |
| H4 | Pool reads return correct quote reserve, threshold, progress and accrued fees | Compare the V13 reads with the swaps performed | Values match | 1h | Compute progress client-side |
| H5 | A transfer-hook pool can migrate to DAMM v2 | Tiny-threshold pool, fill, `migrateToDammV2` | DAMM v2 pool trades | 1h, **P1 only, devnet only** | Now **likely supported**: DBC revokes the hook when the curve completes, before migration (V8). The trade-off is that the allowlist ends at graduation. Show the projected split; don't block |
| H6 | Holder listing by mint works on our RPC, **mainnet included** | Devnet: `getProgramAccounts` + mint memcmp. Mainnet: provider's by-mint query (e.g. Helius DAS `getTokenAccounts`) | < 2s | 30m | `getTokenLargestAccounts` (top 20 holders, enough for the pilot) |
| H7 | Snapshot → allocations → batched transfers, run twice with a trade in between | 2 periods, 2 holders | Q4 split 60/40 as expected | 2h | Single-transfer loop |
| H8 | `buildCurveWithMarketCap` hits the derived starting price within ±2% | Create pool from the $1.0M / $3.0M inputs (pilot: $1k / $3k with 1,000 supply), quote a tiny buy | Price ≈ $1.00 | 1h | Use `buildCurveWithCustomSqrtPrices` with explicit start price |
| H9 | One `SKILL.md` set + one MCP server works unchanged in **both** Claude Code (plugin `/fstack:fundraise`) and Codex (`.agents/skills` + `[mcp_servers.fstack]` in `config.toml`) | Hello-world skill calling `fundraise_list_issuances` in each agent | Both list issuances | 1h | Codex-specific copies of the SKILL.md (same tools). If Codex fails entirely, demo Claude Code only and mention Codex as roadmap |
| H10 | On-chain tools finish inside MCP client timeouts (create issuance = several txs) | `fundraise_create_issuance` on devnet from Claude Code | < 60s, no client timeout | 1h | Make create async: return a `jobId` and poll it with `fundraise_get_market` |
| H11 | The agent reliably proposes DCF from a messy CSV and the founder can verify it | 3 sample exports (Stripe-like, bank-like, P&L) | Correct DCF with working shown in 3/3 | 1h | The skill asks for the number directly and just displays the file |
| H12 | `fs_allowlist.initialize` can't be front-run | Gate `initialize` to the FS authority and bundle it into the pool-creation tx. Test: a non-authority `initialize` fails; pool creation + `initialize` land atomically | Both hold | 1h, **before any mainnet deploy** | Deploy only the gated version. There is no mainnet fallback for this one |
| H13 | The whole loop runs on **mainnet** at pilot scale (section 10) | Deploy `fs_allowlist`, create the Acme pool with real USDC, then Carol ❌, Alice ✅, Q3, trade, Q4 | All sigs visible on Solana Explorer; payouts 4.00 / 2.70 / 1.80 USDC | 4h | Record the video on devnet, link whatever mainnet steps passed as proof, and state plainly in the submission which steps ran on mainnet |

**Checkpoint:** H1–H3 decided by **hour 6** (the mainnet half of H1 too, since it costs minutes). If H1 or H2 fails, take the fallback immediately. H12 must pass before hour 40. H13 is decided by hour 44.

### Product hypotheses (pitch, not build)

| # | Hypothesis | Cheapest evidence before submission |
|---|---|---|
| P1 | Profitable small businesses (SaaS, e-commerce, franchises) want equity-free capital without bank debt or a priced round, and will share 5–15% of cash flow for it | DM 5 profitable founders: "Would you sell 10% of quarterly distributable cash flow to your customers/community for upfront capital?" Also ask whether an open-ended share or a capped / fixed-term one would change their answer (section 13.1). Quote answers in pitch |
| P2 | Investors want recurring USDC yield tied to real businesses, with an exit via a secondary market (which revenue-based financing lacks) | Cite RBF / tokenized T-bill yield demand as comparable; one line |
| P3 | The main objection is "issuer-reported numbers + issuer might not pay" | Pitch answer: on-chain allowlist, locked issuer LP, report hash, escrowed distributions (P1) |

---

## 12. Timeline (~55h)

| Hours | Deliverable | Exit criteria |
|---|---|---|
| 0–6 | Scaffold (Next.js, Prisma, wallet adapter, MCP package, plugin skeleton), `lib/cluster`. Mock USDC + faucet. H1 (devnet + mainnet config check), H3, H9 spikes. Start `fs_allowlist` | H1/H3/H9 decided |
| 6–14 | Hook done (H2). `buildConfig` with yield derivation (H8). Issuance API (`preview`/`create`) + MCP tools + `fundraise-launch` skill (3 questions + defaults) | Pool created **from Claude Code** at ~$1.00 (H10) |
| 14–22 | `/market/[id]`: buy/sell + preview, progress, economics panel (H4). `fundraise` router/status skill | Swap from UI; status in the terminal matches |
| 22–28 | One-signature onboarding (`/onboard/[id]` + inline gate on the market page), invite code, allowlist, live holders (H6). `fundraise-investors` | Carol ❌ / Alice ✅, Alice onboarded in < 30s |
| 28–36 | Distribution API (H7) + `fundraise-report` (H11) + `fundraise-distribute`, yield block, history | Two-period flow works from the agent (devnet) |
| **36** | **Submit a draft** (repo + rough devnet video). Edits are allowed until the deadline | Submitted |
| 36–40 | Polish, monetization unit test, README. `initialize` gating (H12). Deploy the web app with Postgres | Live URL (devnet); H12 green |
| 40–44 | **Mainnet cutover:** deploy `fs_allowlist`, switch `SOLANA_CLUSTER`, fund capped hot wallets, run the pilot loop once (H13) | Mainnet sigs for every demo step |
| 44–50 | Final video **on mainnet**. P1 if green: escrow + claim first, then report-hash memo, then H5 (devnet) | Video uploaded |
| 48–52 | **Landing page** (section 9.1), in parallel with the video; links the video and mainnet sigs | Landing page live |
| 52–55 | Buffer + final submission | Submitted |

---

## 13. Positioning

Use:
- "Contractual cash-flow participation rights. The agreement creates the claim, and the token represents participation units."
- "Distributions are based on issuer-reported Distributable Cash Flow."
- "Eligibility is enforced at the token level by a Token-2022 transfer hook."
- "Meteora DBC provides distribution, price discovery and liquidity."
- "Protocol economics shown are illustrative. The production model is software fees (one config switch)."
- "Equity-free capital: no shares, no cap-table change, no board seat. The business pays for it with a share of distributable cash flow."
- "Closed mainnet pilot with real USDC. Not an offer of securities."

Don't say: dividends, shares, equity (as a description of what holders get; "equity-free" is fine), "token = legal right", "market cap = company valuation", "guaranteed yield", a bare "non-dilutive", "free capital", or that the 2% fee is a production-compliant model.

### 13.1 "Non-dilutive": what we claim and what we don't

**The objection:** the business hands 10% of its distributable cash flow to token holders, so how is that non-dilutive?

**The answer, in four parts:**
- **What stays untouched:** ownership, the cap table, voting, board seats, liquidation preference and exit proceeds. Holders get no shares and no say (agreement section 7). This is the sense in which revenue-based financing and debt are called "non-dilutive", and it's the only sense we claim.
- **What the business gives up:** X% of each period's DCF for as long as the agreement runs. That is a real, cash-paid cost of capital, and the implied rate is the target yield. It is not a dividend. A dividend is a discretionary equity payout declared to shareholders. This is a contractual payment computed from reported DCF. Shareholders' dividend rights are legally untouched, but the cash paid to holders isn't available to them, just as with interest on a loan.
- **Where the claim is weakest:** the P0 agreement has no maturity (it runs until the issuer winds up, agreement section 10). An open-ended share of cash flow behaves economically like a non-voting profit share. That is exactly why a bare "non-dilutive" overclaims, and why the wording rules above require a qualifier.
- **How the product shows it:** the launch preview has a "What you give up" line: "10% of quarterly DCF, ~$160k/yr at your expected DCF (pilot: ~$160/yr), for as long as the agreement runs. No equity." The founder confirms with that line on screen.

**Production fix (not in this build):** bound the claim the way RBF does, with a repayment cap (rights end once holders have received N× the capital raised) or a fixed term plus an issuer buyback at a preset price. Either makes "non-dilutive" clean. The curve would then need cap- or term-aware pricing instead of the perpetuity math in section 5 (`startingMarketCap = annualPool / yield`), so this is a deliberate follow-up, not a copy tweak.

---

## 14. Decision: the final build runs on mainnet

**Decided 2026-09-23.** The submitted build runs on **Solana mainnet** as a closed pilot with real USDC. Devnet stays for development, CI and the rehearsal run (A20). Reasons: Meteora scores "working code on mainnet" above slides, and a live pool paying real USDC distributions is the strongest answer to "could this be a real app?".

| | Devnet (dev, rehearsal) | Mainnet (final) |
|---|---|---|
| Quote mint | Mock USDC (SPL, faucet) | USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (SPL, no badge, V10) |
| DBC program | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | Same ID (V11); hook support confirmed by H1 |
| `fs_allowlist` | Devnet deploy | Mainnet deploy of the **gated** build only (H12). Budget ≈ 2–4 SOL of program rent (estimate from typical Anchor program size), recoverable by closing the program afterwards |
| Scale | Pitch example (1,000,000 supply) | Pilot (1,000 supply, section 10) |
| RPC | Any | Paid mainnet RPC with an indexed by-mint token query (H6) |
| Keys | Throwaway | Deployment secrets, capped hot wallets |
| DB | SQLite | Postgres |
| Banner / agreement copy | "Devnet prototype, no monetary value" | "Closed mainnet pilot. Not an offer of securities. Participants are the team and invited testers." |

**Guardrails (all required):**
- **Closed allowlist.** `add_allow` runs only for a valid `inviteCode` (section 6), and invite links go only to the team and named testers. The pool is not promoted. It may still appear on Meteora or aggregators, but any non-allowlisted buy fails at the hook.
- **No graduation in the pilot.** Graduation revokes the hook for good (V8) and would open trading to anyone. The pilot's `migrationQuoteThreshold` sits far above what the invited wallets will buy.
- **Capped hot wallets.** The issuer wallet holds ≤ $200 USDC (buys are made from the investor wallets; payouts are $8.50 in total). The FS authority holds ≤ 1 SOL after deploy.
- **Kill switch.** `remove_allow` on every participant blocks new buys and wallet-to-wallet transfers. Sells into the pool still work (the pool authority stays allowlisted), so nobody is trapped.
- **Copy.** All cluster-specific wording comes from `lib/cluster`, so no "devnet" string ships on mainnet and no "mainnet" claim appears on devnet.
- **Honesty about capital.** The issuer receives capital at graduation (48% of the migration threshold, section 5). The pilot never graduates, so the pitch says the pilot proves the loop (launch, hook, trade, two distributions), not that Acme raised money.
- **Fallback (H13).** If the mainnet loop isn't green by hour 44, record on devnet and state plainly which steps ran on mainnet.

---

## 15. Future: Venture Rights (not in this build)

The same engine with a different base. Keep these extension points, but build none of the UI:
- `Issuance.rightsType` enum stays (`CASH_FLOW` now, `VENTURE_EXIT` later).
- `lib/distribution` takes a `distributableBase` input. Venture computes it as `grossExitValue − deductions` from a one-time `EXIT` event instead of a periodic report.
- The curve derivation in `buildConfig` is per template. Venture has no yield input, so it would use issuer-set start / graduation market caps.
- Metrics differ: no yield block; show "Economic rights: X% of Net Exit Proceeds" and "exposure per token".

---

## 16. Future: Stripe-verified revenue (research only, not in this build)

**This build is crypto-only:** USDC on Solana, issuer-reported DCF (R2), no fiat data sources. Nothing in this section gets built before the deadline. This section is the feasibility research; the pitch close mentions it as the next step.

**Why:** issuer-reported DCF is the weakest link (P3). Read-only access to the business's Stripe account would let Founder Stack:
1. **Screen issuers before launch:** e.g. ≥ 12 months of history and trailing-12-month net revenue above a threshold, as a "Stripe-verified revenue" badge on the market page.
2. **Cross-check each period:** show "Stripe net revenue this period: $Y; reported DCF: $Z (implied margin N%)" next to every distribution, so outliers are visible to investors.

**The limit:** Stripe knows revenue, not costs. It can verify that a business earns money, not that it is profitable or that its DCF figure is right. Verifying profit needs accounting data, which stays out of scope.

**Access options.** From Stripe's public docs and help pages, checked 2026-09-23; re-check before building:

| Option | How it works | Read-only? | Fit |
|---|---|---|---|
| Connect OAuth (Standard accounts) | Founder clicks "Connect Stripe" | **No.** Since mid-2021, platforms can request only read-write access. Read-only is reserved for extensions, and Stripe no longer recommends OAuth for new platforms | Poor: far more access than a verifier should hold |
| Restricted API key (`rk_live_…`) | Founder creates a key with Read on balance transactions, charges, refunds, disputes and payouts, and pastes it once into `fundraise-launch`. The API stores it encrypted, server-side | Yes, per resource (Read / Write / None) | **Fastest path:** no Stripe review, least privilege. Costs: key handling, and the founder can revoke at any time (revocation is visible and flips the badge off) |
| Stripe App (Marketplace) | Founder installs our app, which declares read permissions such as `balance_transaction_source_read` and `charge_read` | Yes | Best UX and trust signal, but needs Stripe's app review, so post-hackathon |
| zkTLS attestation of a Stripe dashboard figure | Founder proves a number without sharing a key | n/a | Trust-minimized; Stripe-specific maturity unverified. Research only |

**Not a verification path:** the founder's own agent can read Stripe (Stripe CLI or MCP) to *prepare* a report, like the CSV in `fundraise-report`. That improves accuracy, but it is founder-side data. Verification requires Founder Stack's own server-side read access.

**What we'd compute:** net revenue per period from balance transactions (charges − refunds − disputes − Stripe fees), monthly trend, payout history, account age.

**Extension points:** none needed now. When built, add `Issuance.revenueVerification?` (source, verifiedAt, ttmNetRevenue) and `Distribution.revenueCrossCheck?` (periodNetRevenue), plus a `fundraise-verify` skill in the same family.

**Open questions for the feasibility note:** Stripe terms on using restricted keys for third-party attestation; multi-account businesses; revenue outside Stripe (Shopify, Paddle, bank transfers); how investors see revocation.

**Estimate:** restricted-key path ≈ 1–2 days after the hackathon; Stripe App path adds Stripe's review time.
