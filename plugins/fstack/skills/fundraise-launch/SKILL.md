---
name: fundraise-launch
description: Fundraise launch - create a Cash Flow Rights issuance (token + Meteora market) priced from the company's cash flow. Use when the founder wants to launch, start or set up a raise against a share of future Distributable Cash Flow. Interviews for terms with defaults, shows the full preview (price derivation, economics, fees, agreement hash), and creates only after an explicit yes. Explicit invocation - /fstack:fundraise-launch (Claude Code) or $fstack-fundraise-launch (Codex).
---

# fundraise-launch: create a Cash Flow Rights issuance

Launches a Cash Flow Rights issuance: a Token-2022 participation unit with an allowlist transfer hook,
sold through a Meteora Dynamic Bonding Curve pool whose starting price is derived from the company's
expected cash flow and the target yield.

Skills are the conversation, the MCP server is the hands, the API is the brain. **Never compute money
yourself**: prices, market caps, economics and the agreement hash all come from
`fundraise_preview_issuance`. Show the API's `display` strings as-is.

Announce the plan in one short message first:

> I'll collect your terms (with defaults), show you the full preview (price, economics, fees,
> agreement), and only create the token and market after you say yes.

If any tool returns an error: `status: 401` → API key missing or wrong, follow "Auth setup" in the `fundraise` skill (`/fstack:fundraise`), then retry the call once; `network_error` →
the API is not reachable at `apiUrl` (is `pnpm dev` running?). Stop and say so. Do not work around auth.
A `400 invalid_terms` lists `details.errors`: show them, ask for corrected values, preview again.

## Step 1 / 4: Terms

Collect these. Skip any the founder already gave (including in the first message); propose the
default for the rest and let them accept all defaults in one reply.

| Term | Tool field | Default |
|---|---|---|
| Company name | `issuerName` | ask (required) |
| Token symbol | `symbol` | ask; suggest one from the name (e.g. ACME) |
| Expected annual Distributable Cash Flow (USD) | `expectedAnnualDcf` | ask (required). Send as a decimal string: $1.6M → `"1600000"` |
| Share of DCF for holders | `poolPercentageBps` | 10% → `1000` |
| Target initial yield | `targetInitialYieldBps` | 16% → `1600` |
| Distribution frequency | `distributionFrequency` | `QUARTERLY` (or `MONTHLY`) |
| Token supply | `tokenSupply` | `"1000000"` |
| Graduation multiple | `graduationMultiple` | `3` (graduation token market cap = 3× starting) |

Converting "10%" to `1000` bps is unit conversion, not money math, and is fine. If the founder
mentions a finance export (e.g. `./finance/*.csv`), you may read it to help them state expected annual
DCF, but show your working and let them confirm the number.

## Step 2 / 4: Preview

Call `fundraise_preview_issuance` with the terms. Keep the returned `previewId`.

Write the whole preview below as visible text (the tables, not a summary). Show:

**How the price is derived** (from `pricing.derivation`: one row per step)

| Step | Formula | Result |
|---|---|---|

Then: starting price `pricing.startingPricePerToken.display`, graduation price
`pricing.graduationPricePerToken.display`, and the label `pricing.marketCapLabel`
("Token market cap — not company valuation").

**Illustrative protocol economics** (heading = `projectedGraduation.label`), at graduation:

| | Share | Amount (estimate) |
|---|---|---|
| Startup | `split.issuerPct`% | `issuer.display` |
| Founder Stack | `split.platformPct`% | `founderStack.display` |
| Market liquidity | `split.liquidityPct`% | `liquidity.display` |

Add `projectedGraduation.note` in one line.

**Trading fees**: Startup `fees.tradingFeeSplit.startupPct`% / Founder Stack
`fees.tradingFeeSplit.founderStackPct`% of the pool trading fee (mode `fees.mode`).

**Agreement** (`agreement.version`): the `agreement.summary` bullets, then
`Agreement hash: <agreement.hash>`. Offer to print the full `agreement.text` if they want to read it.

**Custody**: `custody` ("Demo custody (devnet)"): the server signs with devnet keys; nothing has real
monetary value. (If the server runs in wallet signing mode, creating returns a sign link instead and the
founder signs with their own wallet; see Step 4.) First record date if launched now: `nextRecordDateIfLaunchedNow` (date only).

## Step 3 / 4: Confirm

Ask exactly one question:

> This will create the `<symbol>` token and its Meteora market on-chain (Demo custody, devnet).
> Create it? (yes / change something)

- **End your turn here and wait for the founder's reply.** A "yes" written before the founder has seen
  this preview (e.g. "launch it, yes" in the first message) does not count: the founder has not seen
  the derived price, economics or agreement hash yet. Say "You said yes upfront; please confirm now that
  you've seen the numbers."
- Only a clear yes given after the preview ("yes", "go", "create it") proceeds. Anything else: ask what to change, go back to Step 1, preview again.
- If the founder changes any term, you must call `fundraise_preview_issuance` again and use the new
  `previewId`. Never reuse a previewId for different terms.

## Step 4 / 4: Create and share

Call `fundraise_create_issuance` with `{ previewId }`.

- `409 preview_already_used` → this preview already created issuance `details.issuanceId`; show that
  instead of creating another.
- `400 preview_not_found` → preview again (Step 2) and re-confirm.
- `502 chain_error` → the market was not created; the preview can be retried. Ask before retrying.

**If the response has `status: "AWAITING_SIGNATURE"`** (wallet signing mode), nothing is on-chain yet.
Tell the founder, then end your turn:

> Open this link in your own browser, connect your wallet, check the summary and sign:
> `<signUrl>`
> Your wallet creates the `<symbol>` token and market and pays the network fees. I never see your keys.
> The link expires `<expiresAt>`. Tell me when you've signed.

When they say they've signed (or ask for status), call `fundraise_get_sign_request` with
`signRequestId`. `COMPLETED` → use its `result` as the success payload below. `PENDING` with an `error`
→ show the error and ask them to open the link again. `EXPIRED` → offer a fresh preview + link. Never ask
the founder for a private key or seed phrase, and never try to sign for them.

On success print:

| | |
|---|---|
| Issuance | `issuanceId` |
| Token mint | `baseMint` |
| Meteora DBC pool | `dbcPool` |
| Transactions | `signatures` (one per line; in `chainMode: devnet` also as `https://explorer.solana.com/tx/<sig>?cluster=devnet`) |
| First record date | `nextRecordDate` (date only) |
| Agreement hash | `agreementHash` |

Then the two links to share:
- **Market** (price, buy/sell, yield): `marketUrl`
- **Investor invite link** (one checkbox + one wallet signature, then the wallet is allowlisted): `onboardUrl`.
  It carries the invite code, so share it only with the investors you invite. Only onboarded wallets can
  hold the token.

Close with next steps: share the onboarding link; run `/fstack:fundraise` any time for status; when the
period ends, `/fstack:fundraise-report` reports its Distributable Cash Flow.

## Rules

- Never call `fundraise_create_issuance` without having shown this preview and received an explicit yes.
  The server also enforces the `previewId` gate.
- Say "distribution", never "dividend". Never "valuation", "shares", "equity" or "guaranteed yield".
  Use: "Contractual cash-flow participation rights. The agreement creates the claim, and the token
  represents participation units."
- The 48/2/50 split is "Illustrative protocol economics", never a production fee model.
