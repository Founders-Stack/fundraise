---
name: fundraise-investors
description: Fundraise investors - list holders and registered participants of a Cash Flow Rights issuance and flag mismatches. Use when the founder asks who holds their token, who has onboarded, how many investors they have, or whether any holder is unregistered. Read-only. Explicit invocation - /fstack:fundraise-investors (Claude Code) or $fstack-fundraise-investors (Codex).
---

# fundraise-investors: holders and participants

Read-only view of who holds the issuance's participation units (from chain balances) and who has
onboarded (verified, eligible, accepted the agreement, allowlisted). Every number comes from the tool.

## Step 1: Pick the issuance

If the founder did not name one, call `fundraise_list_issuances`. None → suggest
`/fstack:fundraise-launch` and stop. Several → ask which (default: most recent).

Errors: `status: 401` → `FS_API_TOKEN` missing or wrong; `network_error` → API not reachable at `apiUrl`.
Stop and say so.

## Step 2: Load holders

Call `fundraise_list_holders` with `issuanceId`.

## Step 3: Show

**On-chain holders** (snapshot at slot `slot`), from `holders`, largest first:

| Holder | Wallet | Type | Tokens | % of supply |
|---|---|---|---|---|
| `displayName` or "—" | `wallet` (shorten to first 4…last 4) | `label` | `tokens.display` | `pctOfSupply` |

The `POOL` row is the Meteora market's inventory: say it is unallocated for distributions.

**Registered participants** (`participants`):

| Name | Wallet | Onboarded | Allowlist tx | Holds tokens |
|---|---|---|---|---|
| `displayName` | `wallet` | `agreementAcceptedAt` (date) | `allowlistTx` (shortened) | `holdsTokens` yes/no |

## Step 4: Flag mismatches

- Any holder with `kind: "UNREGISTERED"` (`unregisteredCount` > 0): flag it. Their units count as
  unallocated (retained by issuer) and receive no distribution. With the transfer hook active this
  should not happen, so mention it as worth investigating.
- Participants with `holdsTokens: false`: onboarded but not yet bought. Normal; list them as "onboarded,
  no position".
- No participants yet → suggest sharing the onboarding link (`onboardUrl` from `fundraise_get_market`
  or `fundraise_list_issuances`).

## Revoking a participant

Revoking (`fundraise_set_participant_status`) is a P1 feature and is not available in this build. If
asked, say so; do not try to revoke any other way.

## Rules

- Read-only skill. Say "distribution", never "dividend"; never "shares" or "equity".
