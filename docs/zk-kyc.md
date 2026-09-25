# ZK-KYC (Rarimo ZK passport) for the allowlist

A wallet proves **"over `min_age` and not a citizen of a blocked country"** with a zero-knowledge proof
made on the user's phone (RariMe app, passport read over NFC). The `fs_allowlist` Solana program verifies
the proof **on-chain** and lets the wallet allowlist itself. The Token-2022 transfer hook is unchanged: it
still only reads `AllowEntry`.

```
phone (RariMe) ──Groth16 proof──▶ Rarimo verificator ──▶ web server ──unsigned tx──▶ investor wallet
                                                                                        │ submit_kyc_proof
   Rarimo L2 PoseidonSMT ──idStateRoot──▶ root relayer ──push_kyc_root──▶ fs_allowlist ◀┘ add_allow_kyc
```

## What is proven (Rarimo `queryIdentity`, circom Groth16 / BN254, 23 public signals)

The program rebuilds all 23 public signals itself, so a proof only verifies if it was made for exactly this policy:

| Signal | Enforced value |
|---|---|
| `selector` | `0b1000000000100001` = nullifier + citizenship reveal + `birthDate < upper bound` |
| `eventID` | `KycConfig.event_id` (`sha256("fs-allowlist-kyc-v1")[..31]`) |
| `eventData` | 31 bytes of `sha256(wallet pubkey)` → the proof is bound to the signing wallet |
| `idStateRoot` | one of the roots relayed from Rarimo (`KycConfig.roots`) |
| `birthDateUpperbound` | at least as strict as *today − min_age years* (same century rule as the circuit) |
| `currentDate` | cluster date ±1 day |
| `citizenship` | revealed, must not be in `KycConfig.blocked` |
| nullifier | one wallet per passport identity (`NullifierRecord` PDA) |

Only the citizenship (alpha-3) and a per-event nullifier become public. Name, number, birth date stay private.

## Accounts and instructions (fs_allowlist)

| Instruction | Signer | Effect |
|---|---|---|
| `init_kyc_config(admin, event_id, min_age, ttl, blocked)` | FS authority | global policy PDA `["kyc-config"]` |
| `set_kyc_policy(min_age, ttl, blocked)` | kyc admin | change policy, no new trusted setup needed |
| `push_kyc_root(root)` | kyc admin (root relayer) | accept a Rarimo identity-state root (newest 8 kept) |
| `enable_kyc()` | mint's allowlist admin | mint accepts KYC self-onboarding (`["kyc-policy", mint]`) |
| `submit_kyc_proof(...)` | the wallet | verifies Groth16 (~232k CU), writes `KycAttestation ["kyc", wallet]` with a TTL |
| `add_allow_kyc()` | the wallet | activates its own `AllowEntry` for a KYC-enabled mint |
| `revoke_kyc_allow(wallet)` | anyone (crank) | deactivates the entry once the attestation expired or the country became blocked |

The hook itself does **not** check expiry: enforcement of TTL/blocklist changes is the crank's job.

## Operations

```bash
# once per cluster (FS authority signs init, kyc admin signs the rest)
export SOLANA_RPC=https://api.devnet.solana.com FS_AUTHORITY_KEYPAIR=keys/fs-authority.json KYC_ADMIN_KEYPAIR=keys/kyc-admin.json
node programs/fs_allowlist/scripts/kyc-admin.mjs init --admin <kyc-admin pubkey> --min-age 18 --ttl 2592000 --blocked RUS,IRN,PRK,SYR,CUB
node programs/fs_allowlist/scripts/kyc-admin.mjs policy --blocked RUS,IRN,PRK,SYR,CUB,BLR
node programs/fs_allowlist/scripts/kyc-admin.mjs root watch 60     # keep this running: Rarimo keeps superseded roots valid ~1h
node programs/fs_allowlist/scripts/kyc-admin.mjs root proof public.json   # push the root of a given proof (checked with Rarimo first)
```

Web server (`apps/web`) env: `KYC_ENABLED=1`, `KYC_ADMIN_KEYPAIR` (relays a proof's root on demand),
optional `RARIMO_API_URL` (default `https://api.app.rarime.com`), `RARIMO_RPC` (default `https://l2.rarimo.com`),
`RARIMO_SMT`. New pools call `enable_kyc` automatically when `KYC_ENABLED=1`. Investor flow: onboarding gate →
"Verify with RariMe" → QR → proof → one wallet transaction (`submit_kyc_proof` + `add_allow_kyc`) → agreement signature.
API: `POST/GET /api/issuances/:id/kyc`, `kyc` block in `GET /api/issuances/:id/wallets/:wallet`,
`{ kyc: true, kycTx }` on `POST /participants` (replaces the invite code).

Tests: `programs/fs_allowlist/tests/kyc.ts` (needs a real proof, see below), `apps/web/tests/kyc.test.ts`,
`cargo test -p fs_allowlist`. Devnet end to end (real Meteora DBC pool): `scripts/chain/run.sh kyc-e2e.ts`.

Generating a proof for tests/e2e: `scripts/kyc-proof-request.mjs` (needs the RariMe app with a registered passport).

## Trust model and limits

- The **identity-state root** is relayed by an admin key (Rarimo publishes it on its own chain). This is the one trusted
  component; the proof itself is verified fully on-chain.
- The vkey is the one shipped in the RariMe app (Rarimo's trusted setup), extracted with
  `snarkjs zkey export verificationkey circuit_query_zkey.zkey` and converted by
  `programs/fs_allowlist/scripts/kyc-fixture/convert_snarkjs.py`.
- Meteora DBC **removes the transfer hook at graduation**: after migration the allowlist (and this gate) no longer restricts
  transfers; distributions still go only to registered participants.
- Identity counter / timestamp bounds are not enforced, so one passport can create more than one Rarimo identity (each with
  its own nullifier). Add selector bits 10/11 to close that.
- The blocklist is a policy input, not legal advice; sanctions-list name matching is out of scope.
