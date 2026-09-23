# Demo finance exports (Acme SaaS)

Sample period exports the `fundraise-report` skill reads to **propose** a DCF for the founder to confirm
(SPEC H11). Every file applies the default agreement definition: cash receipts from operations, less cash
operating expenses, taxes paid, debt service and capital expenditures, less board-approved reserves.

| File | Shape | Period | Intended DCF (USDC) | Traps the agent must handle |
|---|---|---|---|---|
| `q3-2026.csv` | Stripe-like ledger (one row per txn, signed `amount`) | 2026-Q3 | **400,000** | Depreciation row is a non-cash memo: exclude it |
| `q3-2026-bank.csv` | Messy bank statement (title rows, Debit/Credit columns, quoted "1,234.00") | 2026-Q3 | **400,000** | Rows dated 06/30 and 10/01 are out of period; BEGINNING/ENDING BALANCE rows; the $25,000 transfer from savings and $100,000 loan drawdown are not operating receipts; Stripe payouts are already net of fees/refunds |
| `q4-2026.csv` | Monthly P&L with subtotals | 2026-Q4 | **450,000** | Use the `q4_2026_total` column only; don't double-count "Total ..." subtotal rows; exclude D&A and stock-based comp (non-cash) and the accrual "Operating income" line |

## Working

**q3-2026.csv**: receipts 1,275,000 subscriptions + 85,000 prepayments − 12,500 refunds = 1,347,500;
less opex 878,000 (processing 37,500, payroll 540,000, payroll taxes 63,000, hosting 84,000, software 19,500,
rent 36,000, marketing 83,000, professional 15,000), tax 30,000, debt service 9,500, capex 12,000, reserve 18,000
→ **400,000**.

**q3-2026-bank.csv**: in-period operating credits 1,225,000 Stripe net payouts + 85,000 wires = 1,310,000;
less debits 910,000 (payroll 603,000, AWS 84,000, software 19,500, rent 36,000, ads 83,000, legal/accounting
15,000, IRS 30,000, loan P+I 9,500, capex 12,000, reserve 18,000) → **400,000**.

**q4-2026.csv**: total cash receipts 1,510,000 − total operating expenses 941,500 − total other cash outflows
118,500 (tax 35,000, debt service 9,500, capex 24,000, reserve 50,000) → **450,000**.

With 10% of DCF and 1,000,000 units: Q3 rights pool 40,000 (0.04 / unit), Q4 rights pool 45,000 (0.045 / unit).

## H11 run (2026-09-24, CHAIN_MODE=fake, Claude Code `-p`)

`cd apps/web && pnpm exec tsx ../../demo/finance/seed-h11.ts` creates three fresh Acme issuances; then, per file:
`claude -p --plugin-dir ./plugins/fstack --allowedTools="mcp__plugin_fstack_fstack__*,Read" -- "/fstack:fundraise-report Use issuance id <id>. <period> closed; the numbers are in ./demo/finance/<file>. ..."`

| File | Proposed DCF | Match | Recorded rights pool / per unit |
|---|---|---|---|
| `q3-2026.csv` | 400,000 | yes (2/2 runs) | 40,000 / 0.04 |
| `q3-2026-bank.csv` | 400,000 | yes (2/2 runs) | 40,000 / 0.04 |
| `q4-2026.csv` | 450,000 | yes (2/2 runs) | 45,000 / 0.045 |
