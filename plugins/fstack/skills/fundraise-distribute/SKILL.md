---
name: fundraise-distribute
description: Distribute a reported period's cash flow to Cash Flow Rights holders ("distribute", "pay holders", "run the distribution", "snapshot holders"). Takes the holder snapshot, shows the payout table, unallocated amount and issuer USDC balance check, then executes the USDC transfers only after the founder types the exact total, and prints the transaction signatures.
---

# fundraise-distribute

Snapshot → preview → founder types the total → execute → signatures. This skill **moves USDC**.

## Steps

1. **Find the distribution.** Call `fundraise_list_issuances` (ask which issuance if more than one), then
   `fundraise_list_distributions` with its `issuanceId`. Use the one with status `DRAFT` or `SNAPSHOTTED`.
   If none is open, say the period must be reported first (`/fstack:fundraise-report`, Codex
   `$fstack-fundraise-report`) and stop. If the founder named a period, make sure it matches.
2. **Snapshot.** Call `fundraise_snapshot` with the `distributionId`. It reads holders on-chain now and
   stores an immutable snapshot (re-running replaces the preview until execution).
3. **Show the preview** exactly as returned:
   - Header: period, DCF, rights pool (`distribution.rightsPool`), per unit (`totals.perToken`), snapshot slot.
   - Payout table from `rows`: **Holder** (`displayName`, else short wallet), **Wallet**, **Units** (`tokens`),
     **% of supply** (`pctOfSupply`), **Payout (USDC)** (`payoutDisplay`).
   - Excluded holders from `excluded` (e.g. "Market (DBC pool)", unregistered wallets) with their units.
   - **Unallocated (retained by issuer)**: `unallocated.totalDisplay`, with the breakdown (market pool,
     unregistered, unsold, rounding dust).
   - **Total to pay**: `totals.totalAllocatedDisplay` to `totals.payees` holders.
   - **Balance check**: issuer wallet `balance.balanceDisplay` vs required `balance.requiredDisplay`. If
     `balance.sufficient` is false, show `balance.shortfall`, tell the founder to fund the issuer wallet
     (`balance.issuerAddress`), and stop.
   - Any `warnings`.
4. **Ask the founder to type the total.** Say: "To send these payouts, type the exact total: **<confirmTotal>**
   USDC." Do not proceed on "yes", "ok" or "go"; the founder must type the number. Never type or fill it in
   yourself. If what they type doesn't match, show the preview total again and ask again.
5. **Execute.** Call `fundraise_execute_distribution` with `distributionId` and `confirmTotal` = the founder's
   typed string, verbatim.
6. **Report the result**: status EXECUTED, each signature from `signatures` with its `explorerUrl` and the
   wallets it paid, the new `nextRecordDate`. If `chainMode` is `fake` (or `fake: true` on a signature), say the
   signatures are simulated (fake chain mode) and nothing moved on devnet. Point investors to the market page.

## Errors

- `400 confirm_total_mismatch`: the typed total differs from the snapshot; re-show the preview, ask again.
- `409 insufficient_balance`: show `balance`, `required`, `shortfall`; the founder funds the wallet, then retry.
- `502 partial_execution`: some batches were paid and recorded. Show `newSignatures`, then retry
  `fundraise_execute_distribution` with the **same** confirmTotal; only unpaid holders are paid.
- `409 not_snapshotted`: run step 2. `409 already_executed` on snapshot: the period is done; show history.
- Calling execute again after success is a no-op (`alreadyExecuted: true`); nothing is paid twice.

## Rules

- Never compute payouts, totals or balances yourself; show what the API returns.
- Say "distribution" and "payout", never "dividend". Never call token market cap a "valuation".
- Unallocated amounts are "retained by issuer", not paid to anyone.
