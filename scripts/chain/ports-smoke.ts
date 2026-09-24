// End-to-end smoke of createDevnetPorts() on devnet:
// create pool -> allow alice -> quote + buildSwapTx (alice signs) -> carol NotEligible -> market state
// -> getBalances -> payout 1 USDC to alice.     scripts/chain/run.sh ports-smoke.ts
import { createDevnetPorts } from "../../apps/web/lib/chain/real";
import {
  ACME_DEMO_TERMS,
  DEMO_PROTOCOL_CONFIG,
  Transaction,
  demoKeypair,
  deriveLaunchPricing,
  devnetEnv,
  explorerTx,
  toDbcFeeParams,
  tokenBalance,
  usdcAta,
} from "../../apps/web/lib/chain/devnet";

const j = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);

async function signAndSend(b64: string, signer: ReturnType<typeof demoKeypair>) {
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
  const alice = demoKeypair("alice");
  const carol = demoKeypair("carol");
  const pricing = deriveLaunchPricing(ACME_DEMO_TERMS, 3);

  let t = Date.now();
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
  console.log(`createIssuancePool ${Date.now() - t}ms`, j({ ...pool, dbcParams: undefined }));

  t = Date.now();
  const a1 = await ports.registry.allowWallet(pool.baseMint, alice.publicKey.toBase58());
  const a2 = await ports.registry.allowWallet(pool.baseMint, alice.publicKey.toBase58());
  console.log(`allowWallet ${Date.now() - t}ms`, a1.signature, "| second call:", a2.signature);

  const m0 = await ports.market.getMarketState(pool.dbcPool);
  console.log("marketState(start)", j(m0));

  const buyIn = 500_000_000n; // 500 USDC
  const q = await ports.market.quote(pool.dbcPool, "BUY", buyIn);
  console.log("quote BUY 500 USDC", j(q));
  const { tx } = await ports.market.buildSwapTx(pool.dbcPool, alice.publicKey.toBase58(), "BUY", buyIn, (q.amountOut * 97n) / 100n);
  console.log("buildSwapTx base64 length", tx.length);
  const buySig = await signAndSend(tx, alice);
  console.log("alice BUY", explorerTx(buySig));

  try {
    const c = await ports.market.buildSwapTx(pool.dbcPool, carol.publicKey.toBase58(), "BUY", 10_000_000n, 0n);
    const s = await signAndSend(c.tx, carol);
    console.log("carol BUY UNEXPECTED SUCCESS", s);
  } catch (e) {
    const err = e as Error & { logs?: string[] };
    const line = [err.message, ...(err.logs ?? [])].find((l) => /NotEligible/.test(l));
    console.log("carol BUY rejected:", line ?? err.message.slice(0, 300));
  }

  const qs = await ports.market.quote(pool.dbcPool, "SELL", 10_000_000n); // 10 tokens
  console.log("quote SELL 10 tokens", j(qs));

  const m1 = await ports.market.getMarketState(pool.dbcPool);
  console.log("marketState(after buy)", j(m1));

  t = Date.now();
  const h = await ports.registry.getBalances(pool.baseMint, pool.poolOwners);
  console.log(`getBalances ${Date.now() - t}ms`, j(h));

  const before = await tokenBalance(env.connection, usdcAta(env.quoteMint, alice.publicKey));
  const issuerBal = await ports.payout.getIssuerQuoteBalance();
  t = Date.now();
  const pay = await ports.payout.transferBatch([{ wallet: alice.publicKey.toBase58(), amount: 1_000_000n }]);
  const after = await tokenBalance(env.connection, usdcAta(env.quoteMint, alice.publicKey));
  console.log(`payout ${Date.now() - t}ms`, explorerTx(pay.signature), "alice delta", (after - before).toString(), "issuer before", issuerBal.toString());

  console.log("\nSMOKE_OK", j({ pool: pool.dbcPool, baseMint: pool.baseMint, buySig, paySig: pay.signature }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
