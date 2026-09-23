// H1/H2/H3/H4/H6/H8 spike: DBC transfer-hook pool with fs_allowlist on devnet.
//   scripts/chain/run.sh spike-dbc-hook.ts
// Wallets: alice (allowlisted), carol (not). Both need SOL + mock USDC (faucet.ts).
import {
  ACME_DEMO_TERMS,
  DBC_POOL_AUTHORITY,
  DEMO_PROTOCOL_CONFIG,
  PublicKey,
  TOKEN_2022_PROGRAM_ID,
  Transaction,
  addAllowIx,
  buildSwapTransaction,
  createHookPool,
  demoKeypair,
  deriveLaunchPricing,
  devnetEnv,
  explorerTx,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferHook,
  listHolders,
  quoteSwap,
  readPool,
  sendTx,
  toDbcFeeParams,
  tokenBalance,
  usdcAta,
} from "../../apps/web/lib/chain/devnet";

async function main() {
const env = devnetEnv();
const { connection, fsAuthority, allowlistProgram, quoteMint } = env;
const alice = demoKeypair("alice");
const carol = demoKeypair("carol");
const out: Record<string, unknown> = {};
const log = (k: string, v: unknown) => {
  out[k] = v;
  console.log(`${k}:`, typeof v === "string" ? v : JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));
};

const pricing = deriveLaunchPricing(ACME_DEMO_TERMS, 3);
const fees = toDbcFeeParams(DEMO_PROTOCOL_CONFIG);
log("pricing", pricing);
log("fees", fees);

// ---- H1 + H3: config + pool with transfer hook, mock USDC quote (no token badge)
const t0 = Date.now();
const created = await createHookPool(
  env,
  { name: ACME_DEMO_TERMS.tokenName, symbol: ACME_DEMO_TERMS.symbol, uri: "https://founderstack.dev/acme-cf.json" },
  {
    tokenSupply: ACME_DEMO_TERMS.tokenSupply,
    tokenDecimals: ACME_DEMO_TERMS.tokenDecimals,
    startingMarketCap: pricing.startingMarketCap,
    graduationMarketCap: pricing.graduationMarketCap,
    fees,
    creatorLockedLiquidityPercentage: 100,
  },
);
log("createMs", Date.now() - t0);
log("pool", {
  baseMint: created.baseMint.toBase58(),
  config: created.config.toBase58(),
  pool: created.pool.toBase58(),
  signatures: created.signatures.map(explorerTx),
});
log("dbcParams", created.dbcParams);

const mintInfo = await getMint(connection, created.baseMint, "confirmed", TOKEN_2022_PROGRAM_ID);
const hook = getTransferHook(mintInfo);
log("mintTransferHook", {
  programId: hook?.programId.toBase58(),
  authority: hook?.authority.toBase58(),
  dbcPoolAuthority: DBC_POOL_AUTHORITY.toBase58(),
  supply: mintInfo.supply.toString(),
});

// ---- H8: start price
const s0 = await readPool(env, created.pool);
log("H8_startPrice_usdcBaseUnits", s0.price.toString());
const dev = Number(s0.price - pricing.startingPricePerToken) / Number(pricing.startingPricePerToken);
log("H8_deviation_pct", (dev * 100).toFixed(4));
const tiny = await quoteSwap(env, created.pool, "BUY", 1_000_000n); // 1 USDC
log("H8_tinyBuyQuote_1USDC", tiny);

// ---- H2: allowlist alice
const allowTx = new Transaction().add(
  addAllowIx({ program: allowlistProgram, admin: fsAuthority.publicKey, mint: created.baseMint, wallet: alice.publicKey }),
);
log("allowAlice", explorerTx(await sendTx(connection, allowTx, [fsAuthority], "add_allow(alice)")));

// alice buy 1,000 USDC
const buyAmt = 1_000_000_000n;
const q = await quoteSwap(env, created.pool, "BUY", buyAmt);
const buyTx = await buildSwapTransaction(env, created.pool, alice.publicKey, "BUY", buyAmt, (q.amountOut * 95n) / 100n);
log("aliceBuy", explorerTx(await sendTx(connection, buyTx, [alice], "alice buy")));
const aliceAta = getAssociatedTokenAddressSync(created.baseMint, alice.publicKey, false, TOKEN_2022_PROGRAM_ID);
const aliceTokens = await tokenBalance(connection, aliceAta);
log("aliceTokens", aliceTokens.toString());

// carol buy -> NotEligible
try {
  const carolTx = await buildSwapTransaction(env, created.pool, carol.publicKey, "BUY", 100_000_000n, 0n);
  const sig = await sendTx(connection, carolTx, [carol], "carol buy");
  log("carolBuy_UNEXPECTED_SUCCESS", explorerTx(sig));
} catch (e) {
  const err = e as Error & { logs?: string[] };
  const logs = err.logs ?? [];
  const hit = [err.message, ...logs].find((l) => /NotEligible|not eligible/i.test(l));
  log("carolBuy_rejected", { notEligible: !!hit, line: hit ?? err.message.slice(0, 400) });
}

// alice sell half
const sellAmt = aliceTokens / 2n;
const qs = await quoteSwap(env, created.pool, "SELL", sellAmt);
const sellTx = await buildSwapTransaction(env, created.pool, alice.publicKey, "SELL", sellAmt, (qs.amountOut * 95n) / 100n);
log("aliceSell", explorerTx(await sendTx(connection, sellTx, [alice], "alice sell")));
log("aliceTokensAfterSell", (await tokenBalance(connection, aliceAta)).toString());
log("aliceUsdc", (await tokenBalance(connection, usdcAta(quoteMint, alice.publicKey))).toString());

// ---- H4: state reads
const s1 = await readPool(env, created.pool);
log("H4_state", {
  price: s1.price,
  quoteReserve: s1.quoteReserve,
  baseReserve: s1.baseReserve,
  migrationQuoteThreshold: s1.migrationQuoteThreshold,
  progressBps: Number((s1.quoteReserve * 10_000n) / s1.migrationQuoteThreshold),
  isMigrated: s1.isMigrated,
  creatorQuoteFee: s1.creatorQuoteFee,
  partnerQuoteFee: s1.partnerQuoteFee,
});

// ---- H6: holders
const h0 = Date.now();
const holders = await listHolders(connection, created.baseMint, { allowlistProgram, extraOwners: [DBC_POOL_AUTHORITY.toBase58()] });
log("H6_holders", { ms: Date.now() - h0, method: holders.method, slot: holders.slot, holders: holders.holders });

console.log("\nSPIKE_JSON=" + JSON.stringify(out, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
void PublicKey;

}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
