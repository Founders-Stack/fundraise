# Chain spike results (W2-chain, devnet, 2026-09-24)

All signatures are on devnet: `https://explorer.solana.com/tx/<sig>?cluster=devnet`.

## Addresses

| What | Address |
|---|---|
| `fs_allowlist` program | `3gfXWxgHN8tjJzxXGeAEiZWaixDe7ZMxXQGnpvHkQZu7` (deploy sig `4nby58hxp5LMNuoGzRikNn7LYQJNPzLrpprwwGA2yQLsgvHc5Z22cLRbEdCj7cQbZ9TFLRwKm3AhX9crFNwDmbp1`) |
| Founder Stack authority (`FS_AUTHORITY` in the program) | `947L5j9d55jFGNyCSwguX8PHTDb5VNyidvRhy7UPDtUB` |
| Issuer (DBC pool creator, payout source) | `AjP5FHjJtnV5uuM8YyGh2RP7gJUSzyZPmqQA6ZmQXf2R` |
| Mock USDC (`QUOTE_MINT`, SPL Token, 6 dp, mint authority = FS authority) | `CQSAP5ezqscP1ifB2Ha4m5kbUDp6jZHr2CFDoZi2vGw` (create sig `353KPTCW5oS41NUE3Vu3Mus3ocbN8KxjDa5BLbxQSPXhqf2t5SGzRF97UYzKQfXiYfjR9Yn4qMaFojgjawiGkhTy`) |
| DBC pool authority (owns base vault, allowlisted per mint) | `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` |
| alice / carol / bob | `CY9edAkSphwpAUjJK9kj5izDCY2MkZ6rnzyJ4G4Bw5SU` / `HYk254Co5mbxSkebxQdoLVrP4b73GPSsw36TfouWEX5p` / `MVeZzqbbQGZupM3RL8RsnWS7CxxVERFcPMwaPiYF5zH` |

Faucet: issuer 10,000,000 USDC (`hgghkdeaxQdhPyzDZxKSGdYc2nVSLgpjAaoaocMEzULny9XApkXuujJWtBa7WoR4vDH1S9ozdCtTaa1mL4FVPTd`), alice 200,000, carol 1,000.

## How DBC uses a transfer hook (from the DBC program and SDK source, SDK 1.5.12)

- `initialize_virtual_pool_with_token2022_transfer_hook` creates the base mint with
  `TransferHook { program_id: fs_allowlist, authority: DBC pool authority }` and **mints** the
  whole supply into the base vault. MintTo does not invoke the hook. DBC never CPIs into the hook
  program at creation time, so it never calls `InitializeExtraAccountMetaList`.
  → H12 (A27): `createHookPool` sends DBC `createConfig` first (no mint yet, nothing to front-run), then ONE atomic tx
  `[DBC create pool (mints hook-enabled mint), fs_allowlist.initialize (signed by FS_AUTHORITY), add_allow(pool authority)]`.
  The mint never exists without its allowlist Config. All four ixs in one legacy tx would be 1380 bytes (> 1232 limit),
  hence the config split; pool + hook init is ~1044 bytes. Devnet proof: config `5XYLJgKap7p5vaMb1wUrbSa7CY9uu5QKmNhKChXz7eUL5JGxF4n7THPSRRwkso4bd3FXPAo5F2HVtyzUmvmd7psd`,
  atomic pool+initialize+add_allow `4gEBMWrhVw8PdUXP3KUDrxhaQi34XN1Ch6ckGs15oztWQVdQUwzyozd4aUJDPcsccXpUHYu8LLW5a6co1W9qPJNq` (pool `AGQRHrpKQ9xeAo4DMz5zsKHehMshGUqDwXxejek22Dmn`); the spike's buy/sell/NotEligible checks passed on that pool.
  `FS_AUTHORITY` is a compile-time constant (devnet default; mainnet: `FS_AUTHORITY_MAINNET=<pubkey> anchor build -- --features mainnet`).
- Swaps (`swap2_with_transfer_hook`) forward the remaining accounts to Token-2022, which resolves the extra-account-meta list on-chain.
  The SDK's client-side resolver passes `PublicKey.default` as the destination, so it **cannot** resolve our `AccountData` seed (destination owner) and throws.
  → `lib/chain/devnet/dbc.ts` overrides the resolver with `[AllowEntry(dest owner), fs_allowlist, ExtraAccountMetaList]`. The destination owner is the buyer on a BUY and the DBC pool authority on a SELL.
- At curve completion DBC **revokes the hook** (program id and authority set to `None`) so the pool can migrate. Allowlist enforcement ends at graduation (confirmed on-chain in H5).

## Results

| # | Result | Evidence |
|---|---|---|
| H1: devnet DBC supports hook pools | **PASS** | `createConfigAndPoolWithTransferHook` `3WcA1kVtK8Kzft6GY1AH8t1cYnU3VYduMJTWYCqaneRuvB4YivHpdhpGuW723fnKc2BPrwGZXggy1zFJahFCev96`; fs_allowlist init + allow(pool authority) `26EHUv4ai5pjA53LGtsidVRiD7kTaEs1qmtqYPaV3uqkE1LGcymiUq35akKoT7PDwyoWhPwnMaJMmqWGiySbvcxQ`. Pool `FasBGFcGwSJDiTPHRevPqdb5r6AZno7xgRxgYFbTsGVq`, mint `FXkHNJKpZMsUYmkp7eYWub7Vs3niaZzMoz1CUb4wp3na`. The mint's hook program = fs_allowlist and its authority = the DBC pool authority. |
| H2: allowlist hook with DBC | **PASS** | allow(alice) `49Cg17Q2E9jVCkik5aqbTyHC2CW7Fiay8Jv9GA1KkTahxgn2RRHxL9UE2Dba2DewspwoQ5T2kN3FiyTrCFrJpvRb`; alice buys 1,000 USDC `2ZutM4NdnDvo8nMrdeVrWtRFCsetdgwceCfW9Bzb65WiNMF79am1xX1BSubtKTwthZ85SAka2WXEKsbTWnx4LbJa`; carol's buy is rejected in preflight: `Error Code: NotEligible. Error Number: 6000` (fs_allowlist lib.rs:156); alice sells half into the pool `6521tUsop4jMdJHjVNXxTT68deG6ZzC1MZqatLkiJGCu6928yLUM3ASUt5tAbPTU5s9tvpxJ5NzQNzvPuqMc34Gq` |
| H3: plain SPL mock USDC as quote, no token badge | **PASS** | same tx as H1. The DBC `is_supported_quote_mint` accepts any SPL-Token (non-2022) mint |
| H4: pool reads | **PASS** | After buy+sell: quoteReserve 449.889735, threshold 1,344,055.432132, progress 3 bps, creator fee 58.004411, partner fee 58.004411 (USDC). These are from `client.state.getPool/getPoolConfig` |
| H6: holder listing | **FAIL on public RPC → fallback PASS** | `api.devnet.solana.com`: `getProgramAccounts(Token-2022)` fails with "excluded from account secondary indexes"; `getTokenLargestAccounts` returns 429 (~47 s). Fallback used in `real.ts`: `getProgramAccounts(fs_allowlist, mint memcmp)` returns the AllowEntries (~200 ms), then we read their Token-2022 ATAs plus the DBC base vault. Result: alice 449.779517 + pool 999,550.220483 = the full 1,000,000 supply. Primary gPA path is kept for a Helius-type RPC. Limits: misses non-ATA token accounts and holders after graduation (hook revoked). |
| H8: start price | **PASS (0.00 %)** | pool price at creation = 1,000,000 base units = $1.000000. A 1 USDC buy quote → 0.899999 token (10% launch fee). **Note:** SDK `buildCurveWithMarketCap` throws `Not enough liquidity … amountLeft ~357` for $1M→$3M with a 6-dp base token (precision issue; the same inputs with 9 dp work). `buildCurveWithMarketCapRobust` falls back to `buildCurveWithCustomSqrtPrices` with start and migration prices taken from the 9-dp build. The threshold differs by 0.0057 USDC. |
| H5: hook pool → DAMM v2 | **PASS (migration only)** | Tiny pool `4PP4duUFgNs3trTQwQNZvstWcQJ5uzHXF1UY6onZ4Hpt` ($100→$300, threshold 134.405542 USDC). Fill with a partial-fill buy `h8vyqc9k21FpaoJXvm6P8Qt8pHFzVVTXzmytG2n7phJuuKbQzDPosc5K5Cs2it6nfCd4uvsnhvNSp8SewCv3nhj`. After this, the mint's hook is `11111111111111111111111111111111` (revoked). `migrateToDammV2` (config `DAMM_V2_MIGRATION_FEE_ADDRESS[6]`) `61VorSrsQnLiTdEZzYeEhGpj8p6GpqvJRAjxNFXogeRKkAMugcWQxaFLRrfXnEXD6Si4waneLvqrf74f4Cxmqgy4`; DAMM v2 pool `fPxp64BdEoZZAsFJqkZF4aNCYvL2XL5SmVnxVrfiexP` exists. Trading on DAMM v2 was not exercised. |

## Ports smoke (`scripts/chain/ports-smoke.ts`, `createDevnetPorts()` end-to-end)

- `createIssuancePool` in **5.1 s** (2 txs): pool `2mMMkmRXqSE259tLrNGu3ZM1r8HkwEpypSdwrrhsyf3a`, mint `QhjeQDFjGGE4kvDAVRwSkAXSJihzeZQcXBmUuVBURJ7`. Sigs `2kGrVmwVfS48vykoNqMmSYAh5ZSH1ZST2zrypMVpYmT33ssLdk7gNjFFBhqfaeNZDojGuxUc6HJJh2YVsKuqUQ7s`, `56eLc9V87rikG4ZHPea1YQ8pfnW6PBZLQXZwt7Js7KMVho9gNRwDtCenitCbNzAuXbMCC3GXDp87Nge4iRD7THV5`. (The spike's create took 3.5 s.)
- `allowWallet(alice)` 1.6 s `34p2SNTQRq1XLnJN7SchWPQvsACV4FNQpUmcU6j5F2GPi9WCogd9woUrAtkUtr1byx9deoPmWgcJaiKhoBeN337f`. A second call returns `already-allowlisted` (idempotent).
- `quote BUY 500 USDC`: out 449.889728, price 1.000000, impact 4 bps, poolFee 50 USDC (10% launch fee).
- `buildSwapTx` → alice signs the base64 tx → `3pzVy5iJLdXyrdsWgUQ1KSxPp4gp8hJUjKdaSgzGSeaGU994VsV6ALvmo1KheLaVEaYbjksuvVsxXY8kCfKsVZbJ`. carol → `NotEligible`.
- `getHolders` 2.5 s (allowlist path): alice (UNREGISTERED until the API classifies her) and the pool (POOL).
- `transferBatch` of 1 USDC to alice `2zjPdiuKUZHKKda74QRVmCZh8jAk5RhsUgBRKnif8Gu6A5dF9o4TmYSgmWjWyuNd7HmPvPBzWaASDgnzfvD4Wt2g`: alice's balance went up by exactly 1,000,000.

## DBC config used (DEMO_PROTOCOL, ACME terms)

Token2022 with 1,000,000 supply at 6 dp, quote at 6 dp; market cap $1.0M → $3.0M; migrationQuoteThreshold 1,344,055.432132 USDC. Migration is DAMM v2 with migrationFeeOption 6 and migrationFee 50/96 (48% issuer, 2% FS, 50% liquidity). creatorTradingFeePercentage is 50. Base fee is an exponential scheduler from 10% to 1% over 300 s in 10 periods; collectFeeMode QuoteToken. The creator permanently locks 100% of liquidity; poolCreationFee 0; activation by timestamp.

## Scripts

`scripts/chain/run.sh <script> [args]` (uses `apps/web` deps + repo `.env`):
`setup-quote-mint.ts`, `faucet.ts <alice|bob|carol|issuer|wallet> <usdc>`, `spike-dbc-hook.ts`, `ports-smoke.ts`, `h5-migrate.ts`, `holders.ts <mint>`, `market-state.ts <pool>`.
