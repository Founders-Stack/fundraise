---
name: fundraise-report
description: Report cash flow for a closed period of a Cash Flow Rights issuance ("period closed", "Q3 numbers are in", "report cash flow", "report DCF"). Reads a finance export the founder points to (CSV/XLSX), proposes the Distributable Cash Flow with its working per the agreement's DCF definition, and after the founder confirms, records the period via the fstack MCP server so it can be distributed.
---

# fundraise-report

Turns "Q3 closed, numbers are in ./finance/q3.csv" into a recorded period (DRAFT distribution) with a
rights pool and per-unit amount computed by the API. No money moves here; `fundraise-distribute` does that.

## Steps

1. **Pick the issuance.** Call `fundraise_list_issuances`. If there is exactly one, use it; otherwise ask
   which one. Keep its `id`.
2. **Read the agreement terms.** Call `fundraise_list_distributions` with the `issuanceId`. From the response
   take `issuance.dcfDefinition` (the agreement's DCF definition), `issuance.poolPercentage`,
   `issuance.tokenSupply`, `issuance.distributionFrequency`, and the existing `distributions` (period labels
   already used, and whether one is still open, i.e. status `DRAFT` or `SNAPSHOTTED`).
   - If a distribution is still open, stop and tell the founder to finish it with `fundraise-distribute` first.
3. **Get the period label.** Use what the founder said ("Q3" in 2026 → `2026-Q3`; monthly → `2026-09`).
   If the year or period is unclear, ask. Never reuse a label that already exists.
4. **Get the DCF.** Either:
   - The founder gives a number: repeat it back as USDC and ask them to confirm; or
   - The founder points to a file: read it (`Read` for CSV; for XLSX, read it with any available tool or ask
     for a CSV export). Then **propose** a DCF with the working shown, applying `dcfDefinition` literally:
     - Include only rows dated inside the period. Say which rows you dropped for being out of period.
     - **Cash receipts from operations**: customer payments (net of refunds). If the payouts are already net
       of processor fees, don't subtract the fees again.
     - **Not receipts**: loan drawdowns, equity raises, transfers between the company's own accounts, opening/
       closing balance rows.
     - **Subtract**: cash operating expenses, taxes paid, debt service (principal + interest), capital
       expenditures, and reserves the definition allows (e.g. a board-approved transfer to a reserve account).
     - **Ignore non-cash items**: depreciation, amortization, stock-based compensation, accrual "operating
       income" lines.
     - In P&L-style files with subtotal rows ("Total ..."), use either the subtotals or the line items, never
       both. Use the period total column, not the monthly columns plus the total.
     - Show the working as a short table: category → amount, then receipts total, deductions total, **DCF**.
       List every judgment call (excluded rows and why).
     - If a row is ambiguous under the definition (e.g. an unlabeled large transfer, interest income, an
       owner draw), **ask the founder** instead of guessing. Never invent or plug numbers to reach a round total.
5. **Founder confirms.** Ask: "Record 2026-Q3 with DCF = 400,000.00 USDC?" (their numbers). Wait for an explicit
   yes. If they correct the number, use theirs. Optionally ask for a public report URL (`reportUrl`).
6. **Record it.** Call `fundraise_report_period` with `issuanceId`, `periodLabel`, `dcf` as a USDC decimal
   string (e.g. `"400000"`, never base units) and `reportUrl` if given.
7. **Show the API's result** together with the DCF working table from step 4 (so the founder can verify it
   in the same message), not your own math for the pool: period, DCF (`display.dcf`), pool percentage, **rights pool**
   (`display.rightsPool`), **per unit** (`display.perToken`), `reportHash`, status DRAFT, and the
   `distribution.id`. Then offer the next step: "Run `/fstack:fundraise-distribute` (Codex:
   `$fstack-fundraise-distribute`) to snapshot holders and preview payouts."

## Errors

- `409 duplicate_period`: that label was already reported; show its status and ask for a different label.
- `409 open_distribution_exists`: finish the open one with `fundraise-distribute` first.
- `400 invalid_dcf`: the amount wasn't a plain USDC decimal; resend as e.g. `"400000.00"`.
- `401`: `FS_API_TOKEN` is missing or wrong. `network_error`: the API isn't running at the shown URL.

## Rules

- The founder's confirmed number is the DCF. You only propose; the founder decides.
- Never compute the rights pool, per-unit amount or payouts yourself; show what the API returns.
- DCF is issuer-reported and not audited by Founder Stack; don't describe it as verified.
- Say "distribution", never "dividend". Never call token market cap a "valuation".
