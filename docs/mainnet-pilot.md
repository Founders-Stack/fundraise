# Mainnet pilot runbook (A29, SPEC section 14)

Closed mainnet pilot with real USDC. Follow the steps in order. Every step before step 5 is read-only.
If the loop isn't green by hour 44, use the H13 fallback: record on devnet and say plainly which steps ran on mainnet.

## Caps and guardrails (SPEC 14)

| Item | Cap / rule |
|---|---|
| Quote mint | USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| DBC program | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` (must have `create_config_with_transfer_hook`) |
| fs_allowlist | **Gated** build only (H12). Deploy rent about 2–4 SOL, recoverable with `solana program close` |
| FS authority wallet | ≥ 2 SOL before deploy, **≤ 1 SOL after deploy** (sweep the rest) |
| Issuer wallet | **≤ $200 USDC**. Needs ≥ $8.50 for payouts ($4.00 + $2.70 + $1.80) and ≥ 0.02 SOL |
| Alice / Bob (investor wallets) | about $110 / $45 USDC and ≥ 0.02 SOL each |
| Scale | `DEMO_SCALE=0.001`: 1,000 ACME-CF supply, $1,600/yr DCF, start price $1.00 |
| Graduation | Never. `migrationQuoteThreshold` about $1,344 (graduationMultiple 3) vs about $140 of pilot buys |
| Invites | Team and named testers only. The pool is not promoted |
| Kill switch | `remove_allow` on every participant. Sells into the pool still work |
| DB / RPC | Postgres. A paid mainnet RPC with an indexed by-mint Token-2022 query (H6) |

## 0. Environment (Vercel + local `.env.mainnet`, never committed)

```
SOLANA_CLUSTER=mainnet-beta
NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta
CHAIN_MODE=devnet                # the real-chain adapter. The cluster comes from SOLANA_CLUSTER
RPC_URL=<paid mainnet RPC>
NEXT_PUBLIC_RPC_URL=<browser-safe mainnet RPC>
# QUOTE_MINT: leave unset (the cluster default is USDC) or set it to EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
FS_ALLOWLIST_PROGRAM_ID=<from step 2>
FS_AUTHORITY_KEYPAIR=/abs/path/keys-mainnet/fs-authority.json
ISSUER_KEYPAIR=/abs/path/keys-mainnet/issuer.json
ALICE_PUBKEY=<tester wallet>     # read-only balance checks
BOB_PUBKEY=<tester wallet>
DATABASE_URL=postgres://...
FS_API_TOKEN=<new random token>
DISTRIBUTION_PAYOUT_MODE=direct  # batched transfers; escrow (A25) is not yet verified on-chain
```

Load it into your shell for the commands below: `set -a; . ./.env.mainnet; set +a`. (`scripts/chain/run.sh` always reads the repo `.env`, so the commands below call `tsx --env-file=.env.mainnet` directly. Variables you export in the shell take precedence over the file.)

## 1. Preflight before deploy (read-only)

```
cd apps/web && pnpm exec tsx --env-file=../../.env.mainnet ../../scripts/chain/mainnet-preflight.ts --pre-deploy; cd ../..
```
Expect PASS on the cluster, RPC genesis, USDC mint, DBC plus hook instruction, and FS authority ≥ 2 SOL. The fs_allowlist check is a WARN until step 2.

## 2. Deploy the gated fs_allowlist (A27 build)

```
cd programs/fs_allowlist
git log -1 --oneline                         # record the commit hash: it must be the gated build (H12)
FS_AUTHORITY_MAINNET=$(solana-keygen pubkey "$FS_AUTHORITY_KEYPAIR") \
  anchor build -- --features mainnet   # A27: bakes the mainnet FS authority into the gate
solana program deploy target/deploy/fs_allowlist.so \
  --url "$RPC_URL" --keypair "$FS_AUTHORITY_KEYPAIR" \
  --program-id target/deploy/fs_allowlist-keypair.json \
  --upgrade-authority "$FS_AUTHORITY_KEYPAIR"
solana program show <PROGRAM_ID> --url "$RPC_URL"
cd ../..
```
Then set `FS_ALLOWLIST_PROGRAM_ID` (in `.env.mainnet` and Vercel), and sweep the FS authority down to ≤ 1 SOL.

## 3. Full preflight (read-only, must be all PASS)

```
cd apps/web && pnpm exec tsx --env-file=../../.env.mainnet ../../scripts/chain/mainnet-preflight.ts; cd ../..
```

## 4. Pool dry run (builds and simulates, never sends)

```
DEMO_SCALE=0.001 apps/web/node_modules/.bin/tsx --env-file=.env.mainnet scripts/demo-e2e.ts --dry-run
```
Expect: start price $1, threshold ≥ 5x the pilot buys, tx1 ≤ 1232 bytes, **tx1 simulation succeeded** with `Instruction: CreateConfigWithTransferHook`. `AccountNotFound` means the FS authority is not funded.

Optional rehearsal of the whole HTTP flow at pilot numbers (fake chain, local):
`DEMO_SCALE=0.001 pnpm demo:e2e`

## 5. Go live (sends real transactions)

1. Deploy the web app with the mainnet env (Vercel), then `pnpm db:migrate` against Postgres.
2. Open `/` and check the banner reads "Closed mainnet pilot…" and that no page says "devnet".
3. Create the pool from Claude Code (the `fundraise` skill) or `POST /api/issuances/preview`, then `POST /api/issuances` with:
   `issuerName "Acme SaaS, Inc."`, `symbol ACME-CF`, `poolPercentageBps 1000`, `tokenSupply 1000`, `expectedAnnualDcf 1600`, `targetInitialYieldBps 1600`, `graduationMultiple 3`, `distributionFrequency QUARTERLY`.
   Check that the preview shows a $1.00 start price and a $3,000 graduation cap before you say yes.
4. Carol (not onboarded) tries to buy and fails with `NotEligible`.
5. Alice onboards with the invite link and buys 100 ACME-CF.
6. Q3: DCF $400. Snapshot, then execute with `confirmTotal 4`. Alice gets $4.00.
7. Alice sells 40 into the pool. Bob onboards and buys 40.
8. Q4: DCF $450. Snapshot, then execute with `confirmTotal 4.5`. Alice gets $2.70 and Bob gets $1.80.
9. Record every signature below. When done, run `remove_allow` for all participants (the kill switch).
10. Afterwards: run `solana program close <PROGRAM_ID> --bypass-warning` only when the pilot is over (it disables the hook, so trading stops for good).

## Record

| Item | Value |
|---|---|
| fs_allowlist program ID | |
| Program deploy commit (gated build) | |
| Deploy signature | |
| Upgrade authority | |
| DBC config | |
| Base mint (ACME-CF) | |
| DBC pool | |
| migrationQuoteThreshold | |

| Step | Signature | Explorer |
|---|---|---|
| createConfigAndPoolWithTransferHook | | |
| fs_allowlist initialize + add_allow(pool authority) | | |
| Carol buy (NotEligible, failed) | | |
| Alice add_allow | | |
| Alice buy 100 | | |
| Q3 payout Alice $4.00 | | |
| Alice sell 40 | | |
| Bob add_allow | | |
| Bob buy 40 | | |
| Q4 payout Alice $2.70 | | |
| Q4 payout Bob $1.80 | | |
| Kill switch remove_allow | | |
