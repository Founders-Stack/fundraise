// H5 (P1, optional): tiny-threshold transfer-hook pool -> fill the curve -> migrateToDammV2.
//   scripts/chain/run.sh h5-migrate.ts
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DBC_POOL_AUTHORITY,
  DEMO_PROTOCOL_CONFIG,
  DynamicBondingCurveClient,
  TOKEN_2022_PROGRAM_ID,
  Transaction,
  addAllowIx,
  buildSwapTransaction,
  createHookPool,
  demoKeypair,
  devnetEnv,
  explorerTx,
  getMint,
  getTransferHook,
  readPool,
  sendTx,
  toDbcFeeParams,
} from "../../apps/web/lib/chain/devnet";

async function main() {
  const env = devnetEnv();
  const { connection, fsAuthority, allowlistProgram } = env;
  const alice = demoKeypair("alice");
  const created = await createHookPool(
    env,
    { name: "H5 Tiny Test", symbol: "H5T", uri: "https://founderstack.dev/h5.json" },
    {
      tokenSupply: 1_000n,
      tokenDecimals: 6,
      startingMarketCap: 100_000_000n, // $100
      graduationMarketCap: 300_000_000n, // $300
      fees: toDbcFeeParams(DEMO_PROTOCOL_CONFIG),
      creatorLockedLiquidityPercentage: 100,
      feeSchedule: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDurationSec: 0 },
    },
  );
  console.log("pool", created.pool.toBase58(), "mint", created.baseMint.toBase58(), created.signatures.map(explorerTx));
  const s0 = await readPool(env, created.pool);
  console.log("threshold", s0.migrationQuoteThreshold.toString());

  await sendTx(
    connection,
    new Transaction().add(addAllowIx({ program: allowlistProgram, admin: fsAuthority.publicKey, mint: created.baseMint, wallet: alice.publicKey })),
    [fsAuthority],
    "allow alice",
  );
  const fill = (s0.migrationQuoteThreshold * 13n) / 10n;
  const buy = await buildSwapTransaction(env, created.pool, alice.publicKey, "BUY", fill, 0n, { partialFill: true });
  console.log("fill buy", explorerTx(await sendTx(connection, buy, [alice], "fill buy")));
  const s1 = await readPool(env, created.pool);
  console.log("after fill: quoteReserve", s1.quoteReserve.toString(), "threshold", s1.migrationQuoteThreshold.toString());
  const hook = getTransferHook(await getMint(connection, created.baseMint, "confirmed", TOKEN_2022_PROGRAM_ID));
  console.log("hook after completion:", hook?.programId.toBase58(), "authority:", hook?.authority.toBase58(), "(pool authority", DBC_POOL_AUTHORITY.toBase58() + ")");

  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[6];
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await client.migration.migrateToDammV2({
    payer: fsAuthority.publicKey,
    pool: created.pool,
    dammConfig,
  });
  const sig = await sendTx(connection, transaction, [fsAuthority, firstPositionNftKeypair, secondPositionNftKeypair], "migrateToDammV2");
  console.log("migrate", explorerTx(sig));
  const s2 = await readPool(env, created.pool);
  console.log("isMigrated", s2.isMigrated);
}

main().catch((e) => {
  console.error(String((e as Error).message ?? e).slice(0, 4000));
  process.exit(1);
});
