---
name: fundraise
description: Fundraise / Cash Flow Rights status and router for Founder Stack /capital. Use when the founder wants to raise money against a share of their company's cash flow, asks "how is my fundraise / raise / token / market doing", or wants to know what to do next (launch, report a period, distribute). Shows price, graduation progress, holders, yield, next record date and accrued fees, and routes to fundraise-launch, fundraise-report, fundraise-distribute or fundraise-investors. Explicit invocation - /fstack:fundraise (Claude Code) or $fstack-fundraise (Codex).
---

# fundraise: router + status

Entry point of the `fundraise*` skill family. It reads state and either shows status or hands off
to the right skill. It never creates anything itself.

Skills are the conversation, the MCP server is the hands, the API is the brain: **every number you
show comes from a tool result.** Do not compute prices, yields, fees or payouts yourself.

## Step 1: Load issuances

Call `fundraise_list_issuances` (no arguments).

If it returns an error, stop and explain. Do not retry or work around it:
- `status: 401` → API key missing or wrong. Run "Auth setup" below, then repeat Step 1 once.
- `network_error` → "The Founder Stack API is not reachable at `<apiUrl>`. Is the web app running
  (`cd apps/web && pnpm dev`)?" Stop.

## Auth setup (on 401)

The founder never touches the shell. You do the file work; they only copy one key from the browser.

1. Write `.fstack.env` in the current project directory with the Write tool (skip if it exists; then
   just tell them to replace the value):
   ```
   FS_API_TOKEN=
   ```
   Add `.fstack.env` to `.gitignore` if the project is a git repo and it is not already listed.
2. Tell the founder, in this order: open https://f-stack.ai/fundraise/connect, connect a wallet, sign the
   free message (no transaction), copy the `fsk_…` key (shown once), paste it after `FS_API_TOKEN=` in
   `.fstack.env`, save, and say "done". Give the absolute path of the file.
3. Never ask for the key in chat and never echo it. When they say done, repeat the failed call; the MCP
   server re-reads the file on every request, so no restart is needed. If it still returns 401, the key
   is wrong or revoked: send them back to the connect page for a new one.

(`FS_API_TOKEN` in the shell env still wins if set; `~/.fstack/env` is a per-user fallback.)

## Step 2: Route

- **No issuances** → say "No Cash Flow Rights issuance yet." Offer to launch one and, if the founder
  agrees, follow the `fundraise-launch` skill (`/fstack:fundraise-launch`, `$fstack-fundraise-launch`).
- **Several issuances** → show a short table (Issuer, Symbol, Rights, Frequency, Next record date,
  Status) and ask which one, unless the founder already named it. Default to the most recent.
- For the chosen issuance call `fundraise_get_market` with its `id`. Then:
  - `pendingDistributions` contains a `DRAFT` or `SNAPSHOTTED` entry → a distribution for
    `<periodLabel>` is in progress. Show the status (Step 3), then hand off to the `fundraise-distribute`
    skill (`/fstack:fundraise-distribute`, `$fstack-fundraise-distribute`), which uses
    `fundraise_snapshot` and `fundraise_execute_distribution`.
  - `distributionDue: true` (the record date `nextRecordDate` has passed) → period `nextPeriod.label` is
    due. Show the status, then hand off to the `fundraise-report` skill (`/fstack:fundraise-report`,
    `$fstack-fundraise-report`) to report its Distributable Cash Flow (`fundraise_report_period`).
  - Otherwise → show the status (Step 3). For past distributions the founder can ask for details
    (`fundraise_list_distributions`, `fundraise_get_distribution`, both read-only).
- Founder asks about investors/holders → follow `fundraise-investors` (`/fstack:fundraise-investors`).

## Step 3: Status

Print exactly the API values (`display` strings):

**`<issuerName>` · `<symbol>`** (`chainMode`: fake / devnet)

| | |
|---|---|
| Price | `price.display` per token |
| Token market cap | `tokenMarketCap.display` (say: "Token market cap — not company valuation") |
| Graduation progress | `progress.bar` (`progress.quoteReserve.display` of `progress.migrationQuoteThreshold.display`) |
| Holders | `holders.count` (`holders.participants` registered; flag `holders.unregistered` if > 0) |
| Distribution yield | `yield.trailingYield` trailing, `yield.annualizedYield` annualized (`yield.annualizedNote`), or "No distributions yet" when `yield.periodsExecuted` is 0 |
| Next record date | `nextRecordDate` (date only), for period `nextPeriod.label` |
| Accrued trading fees | Startup `accruedTradingFees.startup.display`, Founder Stack `accruedTradingFees.founderStack.display` |
| Market | `marketUrl` |

Put the progress bar in a code span so it renders monospaced. Below the table add the yield label
from `yield.label` in one line, and the investor onboarding link `onboardUrl` ("share this with
investors").

End with one suggested next action (launch / report / distribute / check investors).

## Rules

- Say "distribution", never "dividend". Never call token market cap a "valuation". Never say shares,
  equity or guaranteed yield. The rights are contractual cash-flow participation; distributions are
  based on issuer-reported Distributable Cash Flow.
- This skill is read-only. Mutating steps live in `fundraise-launch`, `fundraise-report`,
  `fundraise-distribute`, each of which previews and waits for an explicit yes.
