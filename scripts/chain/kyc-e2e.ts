// ZK-KYC end-to-end on devnet, through the real Meteora DBC pool + Token-2022 hook:
//   create hook pool -> enable_kyc(mint) -> KYC wallet's BUY fails with NotEligible
//   -> submit_kyc_proof (Rarimo query proof verified on-chain) -> add_allow_kyc -> BUY succeeds.
//
// Prereqs (once): program upgraded on devnet; `node programs/fs_allowlist/scripts/kyc-admin.mjs init ...`;
// a Rarimo proof for the test wallet (refs/rarimo-proof-request/request.mjs) whose idStateRoot was pushed with
//   node programs/fs_allowlist/scripts/kyc-admin.mjs root proof <public.json>
//
//   KYC_PROOF_DIR=/path/to/rarimo-proof-request scripts/chain/run.sh kyc-e2e.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { createDevnetPorts } from "../../apps/web/lib/chain/real";
import {
  ACME_DEMO_TERMS,
  DEMO_PROTOCOL_CONFIG,
  Keypair,
  PublicKey,
  SystemProgram,
  TOKEN_2022_PROGRAM_ID,
  Transaction,
  addAllowKycIx,
  deriveLaunchPricing,
  devnetEnv,
  enableKycIx,
  explorerTx,
  faucet,
  getAssociatedTokenAddressSync,
  kycArgsFromSnarkjs,
  kycAttestationPda,
  kycComputeBudgetIx,
  decodeKycAttestation,
  submitKycProofIx,
  toDbcFeeParams,
  tokenBalance,
  usdcAta,
} from "../../apps/web/lib/chain/devnet";
import { sendTx } from "../../apps/web/lib/chain/devnet/env";

const PROOF_DIR = process.env.KYC_PROOF_DIR ?? "/Users/kastet/FS-Stocklana-refs/rarimo-proof-request";
const j = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const readJson = (f: string) => JSON.parse(readFileSync(path.join(PROOF_DIR, f), "utf8"));

async function signAndSend(b64: string, signer: Keypair) {
  const { connection } = devnetEnv();
  const tx = Transaction.from(Buffer.from(b64, "base64"));
  tx.partialSign(signer);
  const sig = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
  const res = await connection.confirmTransaction(
    { signature: sig, blockhash: tx.recentBlockhash!, lastValidBlockHeight: tx.lastValidBlockHeight ?? (await connection.getBlockHeight()) + 150 },
    "confirmed",
  );
  if (res.value.err) throw new Error(`swap failed ${sig} ${j(res.value.err)}`);
  return sig;
}

async function main() {
  const ports = await createDevnetPorts();
  const env = devnetEnv();
  const { connection, fsAuthority, allowlistProgram: program } = env;
  const wallet = Keypair.fromSecretKey(Uint8Array.from(readJson("test-wallet.json")));
  const proof = readJson("proof.json");
  const pub: string[] = readJson("public.json");
  console.log("KYC wallet", wallet.publicKey.toBase58(), "| proof citizenship", Buffer.from(BigInt(pub[6]).toString(16).padStart(6, "0"), "hex").toString());

  // fund the wallet: SOL for fees/rent + mock USDC for the buy
  if ((await connection.getBalance(wallet.publicKey)) < 0.15e9) {
    await sendTx(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: fsAuthority.publicKey, toPubkey: wallet.publicKey, lamports: 0.2e9 })), [fsAuthority], "fund kyc wallet");
  }
  if ((await tokenBalance(connection, usdcAta(env.quoteMint, wallet.publicKey))) < 100_000_000n) {
    await faucet(connection, env.quoteMint, fsAuthority, wallet.publicKey, 200_000_000n);
  }

  // 1. hook pool (allowlist admin = FS authority)
  const pricing = deriveLaunchPricing(ACME_DEMO_TERMS, 3);
  const pool = await ports.market.createIssuancePool({
    name: ACME_DEMO_TERMS.tokenName,
    symbol: ACME_DEMO_TERMS.symbol,
    uri: "https://founderstack.dev/acme-cf.json",
    tokenSupply: ACME_DEMO_TERMS.tokenSupply,
    tokenDecimals: ACME_DEMO_TERMS.tokenDecimals,
    startingMarketCap: pricing.startingMarketCap,
    graduationMarketCap: pricing.graduationMarketCap,
    fees: toDbcFeeParams(DEMO_PROTOCOL_CONFIG),
    creatorLockedLiquidityPercentage: 100,
  });
  const mint = new PublicKey(pool.baseMint);
  console.log("pool", pool.dbcPool, "baseMint", pool.baseMint);

  // 2. the mint admin opts the mint in to KYC self-onboarding
  const en = await sendTx(connection, new Transaction().add(await enableKycIx({ program, admin: fsAuthority.publicKey, mint })), [fsAuthority], "enable_kyc");
  console.log("enable_kyc", explorerTx(en));

  const buyIn = 10_000_000n; // 10 USDC
  const buy = async () => {
    const q = await ports.market.quote(pool.dbcPool, "BUY", buyIn);
    const { tx } = await ports.market.buildSwapTx(pool.dbcPool, wallet.publicKey.toBase58(), "BUY", buyIn, (q.amountOut * 90n) / 100n);
    return signAndSend(tx, wallet);
  };

  // 3. before KYC: rejected by the transfer hook
  try {
    await buy();
    throw new Error("UNEXPECTED: buy succeeded before KYC");
  } catch (e) {
    const err = e as Error & { logs?: string[] };
    const line = [err.message, ...(err.logs ?? [])].find((l) => /NotEligible/.test(l));
    if (!line) throw e;
    console.log("BEFORE KYC  ->", "rejected:", line.slice(0, 160));
  }

  // 4. Rarimo proof verified on-chain, then self-allow
  const sub = await sendTx(
    connection,
    new Transaction().add(kycComputeBudgetIx(), await submitKycProofIx({ program, wallet: wallet.publicKey, args: kycArgsFromSnarkjs(proof, pub) })),
    [wallet],
    "submit_kyc_proof",
  );
  console.log("submit_kyc_proof", explorerTx(sub));
  const att = decodeKycAttestation((await connection.getAccountInfo(kycAttestationPda(program, wallet.publicKey)))!.data);
  console.log("attestation", j({ citizenship: att.citizenship, expiresAt: new Date(att.expiresAt * 1000).toISOString() }));
  const aa = await sendTx(connection, new Transaction().add(await addAllowKycIx({ program, wallet: wallet.publicKey, mint })), [wallet], "add_allow_kyc");
  console.log("add_allow_kyc", explorerTx(aa));

  // 5. after KYC: the same buy goes through the DBC pool
  const baseAta = getAssociatedTokenAddressSync(mint, wallet.publicKey, true, TOKEN_2022_PROGRAM_ID);
  const before = await tokenBalance(connection, baseAta);
  const buySig = await buy();
  const after = await tokenBalance(connection, baseAta);
  console.log("AFTER KYC   ->", "BUY ok", explorerTx(buySig), "tokens received:", (after - before).toString());
  console.log("\nKYC_E2E_OK", j({ pool: pool.dbcPool, baseMint: pool.baseMint, submit: sub, allow: aa, buy: buySig }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
